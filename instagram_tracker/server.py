"""FastAPI server. Tiny request handlers; all logic lives in the modules above."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import alerts as alerts_mod
from . import diffs as diffs_mod
from . import filtering as filtering_mod
from . import followup as followup_mod
from . import ingest as ingest_mod
from . import queries as q
from . import tags as tags_mod
from . import watcher as watcher_mod
from .config import DB_PATH, STATIC_DIR
from .db import connect
from .parsers import normalize_account_input

app = FastAPI(title="Instagram Tracker", version="1.0.0")

# CORS allowlist for the companion browser extension. The local UI lives at
# 127.0.0.1 and is same-origin (no CORS needed), but the extension's content
# scripts run on instagram.com / accountscenter.instagram.com etc., so they
# need explicit permission to call this server. Only extension-origin schemes
# and the local UI itself are allowed — no wildcard for the open web.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://.*$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# In-process cache for the heavy read endpoints. Two version counters
# instead of one: `_snapshot_version` ticks on imports / snapshot deletes
# (anything that changes the underlying snapshot data); `_tag_version`
# ticks on tag toggles. Endpoints that don't read tags at all (timeline,
# activity-log) only depend on snapshot_version, so a tag click no longer
# invalidates them — saves ~hundreds of ms of cumulative-diff recompute
# per click.
_snapshot_version = 0
_tag_version = 0
_cache: dict[str, tuple[tuple[int, int], object]] = {}

# Each cached endpoint declares which version counters its result depends
# on. A "snapshot" dep means tag writes don't invalidate; "tag" means tag
# writes do. The cache key always stores the full (snap_v, tag_v) tuple
# but the comparison only checks the deps that matter.
_DEPS_SNAPSHOT_ONLY = ("snapshot",)
_DEPS_BOTH = ("snapshot", "tag")


def _bump_snapshot_version():
    global _snapshot_version
    _snapshot_version += 1
    _cache.clear()  # everything depends on snapshot, so wipe everything


def _bump_tag_version():
    global _tag_version
    _tag_version += 1
    # Selectively drop entries that depend on tags. Snapshot-only entries
    # (timeline, activity-log) survive intact.
    for k in list(_cache.keys()):
        if "tag" in _CACHE_DEPS.get(k, _DEPS_BOTH):
            _cache.pop(k, None)


# Static map of cache-key → deps. Set when an endpoint registers itself.
_CACHE_DEPS: dict[str, tuple[str, ...]] = {}


def _cached(key: str, compute, deps: tuple[str, ...] = _DEPS_BOTH):
    """Return the cached response for `key` if its stored version still
    matches the relevant counters, else compute, store, return."""
    _CACHE_DEPS[key] = deps
    entry = _cache.get(key)
    if entry is not None:
        cached_versions = entry[0]
        snap_match = "snapshot" not in deps or cached_versions[0] == _snapshot_version
        tag_match = "tag" not in deps or cached_versions[1] == _tag_version
        if snap_match and tag_match:
            return entry[1]
    result = compute()
    _cache[key] = ((_snapshot_version, _tag_version), result)
    return result


@app.on_event("startup")
def _start_background_watcher():
    """Auto-import zips that land in IG_WATCH_FOLDER. Disabled by default —
    only runs if the user opts in by setting IG_WATCH_POLL=1. The button-
    triggered /api/scan endpoint is cheaper and almost always the right
    choice when watching a large folder like the Drive root."""
    watcher_mod.start_watcher_thread()


@app.get("/api/scan-status")
def scan_status():
    """Tells the frontend whether a watch folder is configured, so the
    'Scan Drive folder' button can disable itself if not."""
    p = watcher_mod.get_watch_folder()
    return {"watch_folder": str(p) if p else None}


@app.post("/api/scan")
def scan_now():
    """Manually trigger a one-shot scan-and-import of the watch folder.
    Synchronous so the response carries the result; on a slow Drive root
    this can take a couple of minutes, but the user opted in by clicking."""
    result = watcher_mod.scan_once()
    if result.get("imported") or result.get("skipped"):
        _bump_snapshot_version()
    return result


@contextmanager
def db_conn():
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def _per_user_sid_chrono(
    conn,
    table: str,
    usernames,
    mode: str,
    extra_join_predicate: str = "",
) -> dict[str, int]:
    """For each username in `usernames`, return the snapshot_id where it
    appeared chronologically first (mode='first') or last (mode='last') in
    `table`. Replaces the older MIN/MAX(snapshot_id) queries — those returned
    the row with the smallest/largest id, which is no longer the same as
    chronological order once out-of-order imports are allowed.

    `extra_join_predicate` lets a caller require an additional condition on
    the same snapshot row (used for the mutuals query, where 'first' means
    'first snapshot they were in BOTH followers AND following')."""
    if not usernames:
        return {}
    direction = "ASC" if mode == "first" else "DESC"
    placeholders = ",".join("?" * len(usernames))
    rows = conn.execute(
        f"""
        SELECT username, snapshot_id FROM (
            SELECT t.username, t.snapshot_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY t.username
                       ORDER BY s.taken_at {direction}, s.id {direction}
                   ) AS rn
            FROM {table} t
            JOIN snapshots s ON s.id = t.snapshot_id
            {extra_join_predicate}
            WHERE t.username IN ({placeholders})
        ) AS x WHERE rn = 1
        """,
        list(usernames),
    ).fetchall()
    return {r["username"]: int(r["snapshot_id"]) for r in rows}


# ---------- error handling: surface ValueError as 400 instead of 500 ----------

@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------- health & summary ----------

@app.get("/api/health")
def health():
    return {"ok": True, "version": app.version}


@app.get("/api/home")
def home():
    """Single endpoint that powers the home screen. Cached on snapshot+tag versions."""
    return _cached("home", _home_compute)


def _home_compute():
    with db_conn() as conn:
        snaps = q.list_snapshots(conn)
        latest = q.latest_id(conn)
        previous = q.previous_id(conn, latest) if latest is not None else None

        summary = None
        if latest is not None:
            curr = q.snapshot_data(conn, latest)

            # Cumulative across all history. Walk by chronological order,
            # not by id — taken_at is what makes diffs adjacent in time even
            # when an older export was imported after a newer one.
            followers_by_sid = q.followers_by_snapshot(conn)
            following_by_sid = q.following_by_snapshot(conn)
            chrono = {
                int(r["id"]): i
                for i, r in enumerate(
                    conn.execute("SELECT id FROM snapshots ORDER BY taken_at ASC, id ASC").fetchall()
                )
            }
            ordered_sids = sorted(
                set(followers_by_sid) | set(following_by_sid),
                key=lambda sid: chrono.get(sid, sid),
            )
            ever_unfollowed_you: set[str] = set()
            ever_left_following: set[str] = set()
            for old_id, new_id in zip(ordered_sids[:-1], ordered_sids[1:]):
                ever_unfollowed_you |= followers_by_sid.get(old_id, set()) - followers_by_sid.get(new_id, set())
                ever_left_following |= following_by_sid.get(old_id, set()) - following_by_sid.get(new_id, set())
            ever_self = q.ever_self_unfollowed(conn)
            # IG-bounce filter applied to BOTH sides of the cumulative count:
            # accounts currently in pending or incoming_requests have an
            # active relationship state, so disappearances from followers
            # or following are likely IG-export quirks rather than real
            # unfollows or removals.
            ig_bounced = curr.pending | curr.incoming_requests
            ever_removed = ever_left_following - ever_self - ig_bounced
            ever_unfollowed_you -= ig_bounced

            # Strip rename chains so renames don't inflate "they unfollowed/removed you" counts.
            alias_map = q.username_alias_map(conn)
            def aliases_active(u: str, in_set: set[str]) -> bool:
                chain = alias_map.get(u)
                if not chain:
                    return False
                return any(a in in_set for a in chain if a != u)

            ever_unfollowed_you = {u for u in ever_unfollowed_you if not aliases_active(u, curr.followers)}
            ever_removed = {u for u in ever_removed if not aliases_active(u, curr.following)}

            # Strip disabled- and unavailable-tagged accounts from these counts too.
            suppressed_home = (
                {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
                | {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
                | {r["username"] for r in tags_mod.list_with_flag(conn, "random_request")}
            )
            ever_unfollowed_you -= suppressed_home
            ever_removed -= suppressed_home

            # Drop anyone who's now following you back — they re-followed, so
            # they're no longer "an unfollower you still follow". History is
            # still in the activity log.
            still_follow_them = (ever_unfollowed_you & curr.following) - curr.followers

            # Cumulative ever_incoming_requests: total inbound interest across
            # the full snapshot history. Defined as the union of:
            #   - every account ever observed in incoming_follow_requests
            #     (the small set IG actually exports — only currently-pending
            #     requests at the moment of each export)
            #   - every account ever observed in your followers across all
            #     snapshots (each of those followers requested to follow you
            #     at some point, even if that request resolved before we
            #     started snapshotting; IG just doesn't keep the request log
            #     once you accept)
            # This is the broadest approximation we can make from the export
            # data — IG only retains a few weeks of the request itself, but
            # the resulting follow is permanent in followers_*.json.
            ever_incoming_observed = {
                r["username"]
                for r in conn.execute("SELECT DISTINCT username FROM incoming_follow_requests").fetchall()
            }
            ever_followed_you = {
                r["username"]
                for r in conn.execute("SELECT DISTINCT username FROM followers").fetchall()
            }
            ever_incoming = ever_incoming_observed | ever_followed_you
            # Strict "incoming request rejected" — appeared in incoming at
            # some snapshot AND never made it into your followers across
            # any snapshot. Excluding ever_followed_you is what makes this
            # a real rejected list rather than "you accepted, then later
            # removed them as a follower".
            incoming_request_dropped = ever_incoming_observed - ever_followed_you - curr.incoming_requests

            ever_pending_observed = {
                r["username"]
                for r in conn.execute(
                    "SELECT DISTINCT username FROM pending_follow_requests "
                    "WHERE source_label IN ('pending_follow_requests', 'both')"
                ).fetchall()
            }
            ever_following = {
                r["username"]
                for r in conn.execute("SELECT DISTINCT username FROM following").fetchall()
            }
            # Cumulative outgoing requests across history. Union of every
            # observed pending request + every account ever in following
            # (each follow implies a request happened at some point — IG
            # only retains the request log a few weeks).
            ever_requested_outgoing = ever_pending_observed | ever_following
            # Strict "request fizzled" — sent a request that NEVER ended
            # up in the following set. Excluding ever_following is what
            # makes this a real "rejected" list rather than a "you
            # followed-then-unfollowed" list.
            request_dropped = ever_pending_observed - ever_following - curr.pending

            # Active-relationship counts: subtract suppressed_home so that
            # accounts the user has tagged disabled / unavailable / random
            # don't pad the "active" totals. Same rule the Lists view applies
            # to its non-bucket sections — keeps home and lists in sync.
            active_followers = curr.followers - suppressed_home
            active_following = curr.following - suppressed_home
            active_pending = curr.pending - suppressed_home
            active_incoming = curr.incoming_requests - suppressed_home

            summary = {
                "snapshot_id": latest,
                "followers": len(active_followers),
                "following": len(active_following),
                "mutuals": len(active_followers & active_following),
                "not_following_you_back": len(active_following - active_followers - active_incoming),
                "feeder_accounts": len(active_followers - active_following),
                "pending": len(active_pending),
                "incoming_requests": len(active_incoming),
                # Cumulative (ever) counts:
                "ever_unfollowed_you": len(ever_unfollowed_you),
                "ever_removed_you_as_follower": len(ever_removed),
                "ever_you_unfollowed": len(ever_self),
                "still_follow_after_drop": len(still_follow_them),
                "ever_incoming_requests": len(ever_incoming),
                "ever_requested_outgoing": len(ever_requested_outgoing),
                "incoming_request_dropped": len(incoming_request_dropped),
                "request_dropped": len(request_dropped),
                "disabled_tagged": len(tags_mod.list_with_flag(conn, "disabled")),
                "unavailable_tagged": len(tags_mod.list_with_flag(conn, "unavailable")),
                "random_request_tagged": len(tags_mod.list_with_flag(conn, "random_request")),
            }

        bucket_counts = {
            "favorites": len(tags_mod.list_with_flag(conn, "favorite")),
            "want_remove": len(tags_mod.list_with_flag(conn, "want_remove")),
            "watchlist": len(tags_mod.list_with_flag(conn, "watchlist")),
            "disabled": len(tags_mod.list_with_flag(conn, "disabled")),
            "unavailable": len(tags_mod.list_with_flag(conn, "unavailable")),
            "random_request": len(tags_mod.list_with_flag(conn, "random_request")),
        }

        return {
            "summary": summary,
            "alerts": alerts_mod.compute_alerts(conn),
            "bucket_counts": bucket_counts,
            "snapshot_count": len(snaps),
        }


# ---------- snapshots ----------

@app.get("/api/snapshots")
def get_snapshots():
    with db_conn() as conn:
        return [
            {
                "id": s.id,
                "label": s.label,
                "created_at": s.created_at,
                "source_path": s.source_path,
            }
            for s in q.list_snapshots(conn)
        ]


@app.delete("/api/snapshots/{snapshot_id}")
def delete_snapshot(snapshot_id: int):
    with db_conn() as conn:
        q.delete_snapshot(conn, snapshot_id)
    _bump_snapshot_version()
    return {"deleted": snapshot_id}


@app.get("/api/activity-log")
def get_activity_log():
    # Activity log doesn't read tags — only snapshot data. Tag writes
    # don't need to invalidate it.
    return _cached("activity_log", _activity_log_compute, deps=_DEPS_SNAPSHOT_ONLY)


def _activity_log_compute():
    """Flat chronological feed: one entry per (username × event), newest
    first. Each entry is a single thing that happened between two
    consecutive chronological snapshots.

    Two precision improvements over the snapshot-pair model:

    1. Creation events (someone started following you, you followed someone,
       you sent a request, they sent you a request) carry the EXACT IG
       export_timestamp from the underlying row, not just the snapshot's
       taken_at. Resolution events (unfollowed_you, you_unfollowed,
       removed_you, request resolutions) fall back to the curr snapshot's
       taken_at because the underlying data is gone.

    2. Resolution events split based on current state so the user sees what
       actually happened: 'they_accepted' vs 'pending_withdrawn',
       'you_accepted' vs 'incoming_withdrawn'.

    Also: skip incoming_request diffs when either side of the pair lacks
    incoming data — otherwise a snapshot from before incoming-parsing
    existed yields a phantom flood of 'every incoming resolved' events."""
    with db_conn() as conn:
        snaps = q.list_snapshots(conn)
        if len(snaps) < 2:
            return {"events": []}

        # Bulk maps: snapshot_id -> taken_at, and which snapshots actually
        # have incoming-request data populated (vs. data never collected).
        taken_at_by_id = {
            int(r["id"]): r["taken_at"]
            for r in conn.execute("SELECT id, taken_at FROM snapshots").fetchall()
        }
        snaps_with_incoming: set[int] = {
            int(r["snapshot_id"])
            for r in conn.execute(
                "SELECT DISTINCT snapshot_id FROM incoming_follow_requests"
            ).fetchall()
        }

        # Per-table username -> export_timestamp index, keyed by snapshot_id.
        # Used to give creation events the exact IG-recorded moment instead
        # of the snapshot's taken_at.
        def ts_index(table: str) -> dict[int, dict[str, int]]:
            out: dict[int, dict[str, int]] = {}
            for r in conn.execute(
                f"SELECT snapshot_id, username, export_timestamp FROM {table} "
                f"WHERE export_timestamp IS NOT NULL"
            ).fetchall():
                ts = int(r["export_timestamp"])
                out.setdefault(int(r["snapshot_id"]), {})[r["username"]] = ts
            return out

        ts_followers = ts_index("followers")
        ts_following = ts_index("following")
        ts_pending   = ts_index("pending_follow_requests")
        ts_incoming  = ts_index("incoming_follow_requests")

        # Latest-snapshot state used as a "ground truth" check for the
        # accept/withdraw split. IG's export sometimes shows a request
        # disappearing from incoming a snapshot before the user appears in
        # followers (or vice versa for pending → following). At the moment
        # of the gap, the per-snapshot diff would call it a withdrawal,
        # but if the user is currently a follower / followed account, the
        # truth is "you accepted, IG just split the transition across two
        # snapshots." Using the latest snapshot as the tiebreaker fixes
        # the false-withdrawal flood that produced ~20 phantom events for
        # accounts that are now mutuals.
        latest = q.latest_id(conn)
        if latest is not None:
            latest_sd = q.snapshot_data(conn, latest)
            latest_followers_set = latest_sd.followers
            latest_following_set = latest_sd.following
        else:
            latest_followers_set = set()
            latest_following_set = set()

        from datetime import datetime, timezone

        def epoch_to_iso(epoch: int | None) -> str | None:
            if epoch is None:
                return None
            try:
                return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            except (OSError, ValueError):
                return None

        def emit(events_list, kind, username, snapshot_id, fallback_ts, actual_epoch=None):
            actual_iso = epoch_to_iso(actual_epoch)
            events_list.append({
                # Sort/display timestamp prefers the precise IG-recorded
                # moment when we have one (creation events), otherwise
                # falls back to the snapshot's taken_at.
                "timestamp": actual_iso or fallback_ts,
                "snapshot_id": snapshot_id,
                "kind": kind,
                "username": username,
                # Surfacing both so the UI can render "(detected at #N <date>)"
                # for events whose actual time predates the snapshot.
                "snapshot_at": fallback_ts,
                "actual_event_at": actual_iso,
            })

        events: list[dict] = []
        prev_sd = None
        prev_id = None
        for s in snaps:
            curr_sd = q.snapshot_data(conn, s.id)
            curr_ts = taken_at_by_id.get(s.id) or s.created_at

            if prev_sd is not None:
                left_followers = prev_sd.followers - curr_sd.followers
                left_following = prev_sd.following - curr_sd.following

                # ---------- creation events: precise timestamps ----------
                for u in sorted(curr_sd.followers - prev_sd.followers):
                    emit(events, "new_follower", u, s.id, curr_ts,
                         (ts_followers.get(s.id, {})).get(u))
                for u in sorted(curr_sd.following - prev_sd.following):
                    emit(events, "you_followed", u, s.id, curr_ts,
                         (ts_following.get(s.id, {})).get(u))
                for u in sorted(curr_sd.pending - prev_sd.pending):
                    emit(events, "you_requested", u, s.id, curr_ts,
                         (ts_pending.get(s.id, {})).get(u))

                # ---------- pending resolutions: split by outcome ----------
                # An account leaving curr.pending could mean (a) they
                # accepted you and you now follow them, or (b) the request
                # was withdrawn / you cancelled / IG dropped it. Use BOTH
                # the snapshot-at-the-time state AND the latest snapshot
                # state, since IG sometimes splits the transition: you
                # accept at moment T, IG removes them from pending at
                # snapshot S, but doesn't add them to following until
                # snapshot S+1. Without the latest-snapshot fallback, S→S+1
                # gets labeled as a withdrawal even though you actually
                # accepted.
                pending_left = prev_sd.pending - curr_sd.pending
                for u in sorted(pending_left):
                    if u in curr_sd.following or u in latest_following_set:
                        emit(events, "they_accepted", u, s.id, curr_ts)
                    else:
                        emit(events, "pending_withdrawn", u, s.id, curr_ts)

                # ---------- incoming events: only if both sides have data ----------
                # Suppresses the phantom 'every request resolved' flood that
                # happens when one snapshot lacks parsed incoming-requests.
                if s.id in snaps_with_incoming and prev_id in snaps_with_incoming:
                    for u in sorted(curr_sd.incoming_requests - prev_sd.incoming_requests):
                        emit(events, "new_incoming_request", u, s.id, curr_ts,
                             (ts_incoming.get(s.id, {})).get(u))
                    incoming_left = prev_sd.incoming_requests - curr_sd.incoming_requests
                    for u in sorted(incoming_left):
                        # Same latest-snapshot fallback as the pending side —
                        # IG sometimes splits "you accepted" across two
                        # snapshots so the per-transition view sees a gap.
                        if u in curr_sd.followers or u in latest_followers_set:
                            emit(events, "you_accepted", u, s.id, curr_ts)
                        else:
                            emit(events, "incoming_withdrawn", u, s.id, curr_ts)

                # ---------- follower-side disappearances: snapshot-time ----------
                # Apply the same IG-bounce filter as alerts: don't emit
                # 'unfollowed_you' for an account currently in pending or
                # incoming_requests — those states mean IG just misfiled
                # them, not that they really unfollowed.
                ig_bounced_curr = curr_sd.pending | curr_sd.incoming_requests
                for u in sorted(left_followers - ig_bounced_curr):
                    emit(events, "unfollowed_you", u, s.id, curr_ts)
                for u in sorted(left_following & curr_sd.recently_unfollowed):
                    emit(events, "you_unfollowed", u, s.id, curr_ts)
                for u in sorted(left_following - curr_sd.recently_unfollowed - curr_sd.pending):
                    emit(events, "removed_you", u, s.id, curr_ts)

            prev_sd = curr_sd
            prev_id = s.id

        # Sort newest first by the precise timestamp; tiebreak by snapshot_id then username.
        events.sort(
            key=lambda e: (e["timestamp"] or "", e["snapshot_id"], e["username"]),
            reverse=True,
        )
        return {"events": events}


@app.get("/api/timeline")
def get_timeline():
    # Timeline is pure snapshot counts — no tag dependency.
    return _cached("timeline", _timeline_compute, deps=_DEPS_SNAPSHOT_ONLY)


def _timeline_compute():
    """Per-snapshot counts in chronological order, plus a cumulative
    'unfollowers' running total — distinct users who left your followers set
    at any transition up to and including this snapshot. Used by the History
    tab chart."""
    with db_conn() as conn:
        snaps = q.list_snapshots(conn)
        if not snaps:
            return {"snapshots": []}

        # Counts per snapshot. One pass per metric to keep the SQL simple.
        followers_count: dict[int, int] = {}
        following_count: dict[int, int] = {}
        pending_count: dict[int, int] = {}
        mutuals_count: dict[int, int] = {}
        incoming_count: dict[int, int] = {}
        for r in conn.execute(
            "SELECT snapshot_id, COUNT(*) AS c FROM followers GROUP BY snapshot_id"
        ).fetchall():
            followers_count[int(r["snapshot_id"])] = int(r["c"])
        for r in conn.execute(
            "SELECT snapshot_id, COUNT(*) AS c FROM following GROUP BY snapshot_id"
        ).fetchall():
            following_count[int(r["snapshot_id"])] = int(r["c"])
        for r in conn.execute(
            "SELECT snapshot_id, COUNT(*) AS c FROM pending_follow_requests "
            "WHERE source_label IN ('pending_follow_requests', 'both') GROUP BY snapshot_id"
        ).fetchall():
            pending_count[int(r["snapshot_id"])] = int(r["c"])
        for r in conn.execute(
            """
            SELECT f.snapshot_id AS sid, COUNT(*) AS c
            FROM followers f
            INNER JOIN following g ON f.snapshot_id = g.snapshot_id AND f.username = g.username
            GROUP BY f.snapshot_id
            """
        ).fetchall():
            mutuals_count[int(r["sid"])] = int(r["c"])
        for r in conn.execute(
            "SELECT snapshot_id, COUNT(*) AS c FROM incoming_follow_requests GROUP BY snapshot_id"
        ).fetchall():
            incoming_count[int(r["snapshot_id"])] = int(r["c"])

        # Cumulative unfollowers: walk chronologically, accumulate the set of
        # usernames who left your followers between any two consecutive
        # snapshots, and emit the running cardinality at each step.
        followers_by_sid: dict[int, set[str]] = {}
        for r in conn.execute("SELECT snapshot_id, username FROM followers").fetchall():
            followers_by_sid.setdefault(int(r["snapshot_id"]), set()).add(r["username"])

        cumulative_unfollowers: set[str] = set()
        prev_followers: set[str] | None = None
        cum_unfollowers_at: dict[int, int] = {}
        for s in snaps:
            curr_followers = followers_by_sid.get(s.id, set())
            if prev_followers is not None:
                cumulative_unfollowers |= prev_followers - curr_followers
            cum_unfollowers_at[s.id] = len(cumulative_unfollowers)
            prev_followers = curr_followers

        # Resolve each snapshot's taken_at from a single bulk query.
        taken_at_by_id = {
            int(r["id"]): r["taken_at"]
            for r in conn.execute("SELECT id, taken_at FROM snapshots").fetchall()
        }

        out = []
        for s in snaps:
            out.append({
                "snapshot_id": s.id,
                "label": s.label,
                "created_at": s.created_at,
                "taken_at": taken_at_by_id.get(s.id),
                "followers": followers_count.get(s.id, 0),
                "following": following_count.get(s.id, 0),
                "mutuals": mutuals_count.get(s.id, 0),
                "pending": pending_count.get(s.id, 0),
                "incoming": incoming_count.get(s.id, 0),
                "cumulative_unfollowers": cum_unfollowers_at.get(s.id, 0),
            })
        return {"snapshots": out}


# ---------- import ----------

@app.post("/api/import")
async def import_export(
    file: UploadFile | None = File(default=None),
    folder_path: str | None = Form(default=None),
    label: str | None = Form(default=None),
):
    """Either upload a zip (`file`) OR pass a server-local folder path (`folder_path`).

    Folder uploads from a browser cannot stream a directory, so the supported
    web flow is: zip the export folder, drop the zip. Power users can pass
    `folder_path` to point at a folder that's already on the Mac.
    """
    if file is None and not folder_path:
        raise HTTPException(status_code=400, detail="Provide a zip file or folder_path.")

    cleanup: Path | None = None
    try:
        if file is not None:
            tmp = Path(tempfile.mkdtemp(prefix="ig_upload_"))
            cleanup = tmp
            target = tmp / (file.filename or "upload.zip")
            with target.open("wb") as out:
                shutil.copyfileobj(file.file, out)
            import_target = target
        else:
            import_target = Path(folder_path).expanduser().resolve()

        with db_conn() as conn:
            run = ingest_mod.import_path(conn, import_target, label)
        if run.imports or run.skipped:
            _bump_snapshot_version()

        return {
            "imports": [
                {
                    "snapshot_id": r.snapshot_id,
                    "label": r.label,
                    "counts": r.counts,
                    "missing_files": r.missing_files,
                }
                for r in run.imports
            ],
            "skipped": [
                {
                    "label": s.label,
                    "reason": s.reason,
                    "message": s.message,
                    "existing_snapshot_id": s.existing_snapshot_id,
                    "existing_label": s.existing_label,
                }
                for s in run.skipped
            ],
        }
    finally:
        if cleanup is not None and cleanup.exists():
            shutil.rmtree(cleanup, ignore_errors=True)


# ---------- diffs & lists ----------

def _resolve(conn: sqlite3.Connection, snapshot_id: int | None) -> int:
    sid = snapshot_id or q.latest_id(conn)
    if sid is None:
        raise HTTPException(status_code=404, detail="No snapshots found.")
    return sid


@app.get("/api/diff")
def get_diff(old: int | None = None, new: int | None = None):
    with db_conn() as conn:
        new_id = _resolve(conn, new)
        old_id = old or q.previous_id(conn, new_id)
        if old_id is None:
            raise HTTPException(status_code=400, detail="No previous snapshot to compare against.")
        sections = diffs_mod.diff(
            q.snapshot_data(conn, old_id),
            q.snapshot_data(conn, new_id),
        )
        return {"old_snapshot_id": old_id, "new_snapshot_id": new_id, "sections": sections}


@app.get("/api/lists")
def get_lists(snapshot_id: int | None = None):
    """Default snapshot_id uses a two-phase cache: the heavy snapshot-derived
    data (helpers, chronological maps, non-bucket rows) is cached on
    snapshot_version; the cheap tag overlay (bucket sections, tag flags,
    suppression filter, sort) runs every request. A tag toggle invalidates
    only the overlay, so the next request stays in the few-tens-of-ms range
    instead of recomputing all 169 snapshots' worth of cumulative diffs."""
    if snapshot_id is None:
        pure = _cached("lists_pure", _lists_pure_compute_default, deps=_DEPS_SNAPSHOT_ONLY)
        return _lists_apply_overlay(pure)
    return _lists_compute(snapshot_id)


def _lists_compute_default():
    return _lists_compute(None)


def _lists_pure_compute_default():
    return _lists_pure_compute(None)


def _lists_pure_compute(snapshot_id: int | None):
    """Tag-independent half of the Lists computation. Returns a context dict
    with everything needed to assemble the final response, plus pre-built
    non-bucket rows (without tag fields). The overlay step applies tags."""
    return _lists_compute(snapshot_id, _pure_only=True)


def _lists_compute(snapshot_id: int | None, _pure_only: bool = False):
    """Single source of truth for the Lists endpoint. When _pure_only=True,
    skips tag-dependent work (bucket sections, suppressed_set filter, tag
    fields on rows, bucket priority sort) and returns a pure context dict
    that the overlay function can finalise on a per-request basis. When
    _pure_only=False, computes everything inline and returns the final
    response — used by the custom-snapshot-id codepath which is uncached
    and infrequent."""
    from datetime import datetime, timezone

    with db_conn() as conn:
        sid = _resolve(conn, snapshot_id)
        sd = q.snapshot_data(conn, sid)
        sections = diffs_mod.current_lists(sd)
        # Cumulative "everyone you've ever had any interaction with" — union
        # across every snapshot's followers, following, pending,
        # recently-unfollowed, and incoming-requests sets. Replaces the
        # earlier "current snapshot only" definition because you wanted to
        # be able to find anybody you've ever crossed paths with.
        all_seen: set[str] = set()
        for table in ("followers", "following", "pending_follow_requests",
                      "recently_unfollowed", "incoming_follow_requests"):
            for r in conn.execute(f"SELECT DISTINCT username FROM {table}").fetchall():
                all_seen.add(r["username"])
        sections["everyone"] = sorted(all_seen)

        prev_id = q.previous_id(conn, sid)
        if prev_id is not None:
            prev = q.snapshot_data(conn, prev_id)
            # Same-snapshot rule: a disappearance from `following` is "I unfollowed them"
            # only if Instagram logged it in this snapshot's recently_unfollowed list.
            left_followers = prev.followers - sd.followers
            left_following = prev.following - sd.following
            sections["they_unfollowed_you"] = sorted(left_followers)
            sections["unfollowers_you_still_follow"] = sorted(left_followers & sd.following)
            sections["you_unfollowed"] = sorted(left_following & sd.recently_unfollowed)
            # Suppress pending-bounces: an account currently in pending hasn't
            # really been removed — IG's export just flipped them from
            # following back to pending without a real relationship change.
            sections["they_removed_you_as_follower"] = sorted(
                left_following - sd.recently_unfollowed - sd.pending
            )
        else:
            sections["they_unfollowed_you"] = []
            sections["unfollowers_you_still_follow"] = []
            sections["you_unfollowed"] = []
            sections["they_removed_you_as_follower"] = []

        # Bucket lists. Skipped in pure mode — overlay rebuilds them from
        # current tags so a tag toggle doesn't invalidate the snapshot cache.
        if not _pure_only:
            for flag in ("favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"):
                sections[flag] = sorted(r["username"] for r in tags_mod.list_with_flag(conn, flag))

        # ---- Cumulative / historical lists across ALL snapshots ----
        followers_by_sid = q.followers_by_snapshot(conn)
        following_by_sid = q.following_by_snapshot(conn)
        chrono = {
            int(r["id"]): i
            for i, r in enumerate(
                conn.execute("SELECT id FROM snapshots ORDER BY taken_at ASC, id ASC").fetchall()
            )
        }
        ordered_sids = sorted(
            followers_by_sid.keys() | following_by_sid.keys(),
            key=lambda sid: chrono.get(sid, sid),
        )

        # Anyone who was a follower at some snapshot and not in the next.
        ever_unfollowed_you: set[str] = set()
        # Anyone who left your following at any transition.
        ever_left_following: set[str] = set()

        for old_id, new_id in zip(ordered_sids[:-1], ordered_sids[1:]):
            old_followers = followers_by_sid.get(old_id, set())
            new_followers = followers_by_sid.get(new_id, set())
            ever_unfollowed_you |= old_followers - new_followers

            old_following = following_by_sid.get(old_id, set())
            new_following = following_by_sid.get(new_id, set())
            ever_left_following |= old_following - new_following

        # Stricter rule for the cumulative "they removed you" set:
        # exclude anyone who EVER appeared in your recently_unfollowed at any snapshot.
        # This guards against Instagram's per-snapshot reporting lag (where a self-initiated
        # unfollow doesn't show up in recently_unfollowed until 1+ snapshots later).
        ever_self = q.ever_self_unfollowed(conn)
        # IG-bounce filter on both cumulative sets: an account currently in
        # pending or incoming_requests still has an active relationship,
        # so a disappearance from followers/following is probably an IG
        # export quirk, not a real unfollow/removal.
        ig_bounced = sd.pending | sd.incoming_requests
        ever_removed_you = ever_left_following - ever_self - ig_bounced
        ever_unfollowed_you = ever_unfollowed_you - ig_bounced

        # Also exclude usernames that are part of a detected rename chain whose CURRENT
        # alias is still in your following/followers — they didn't really leave.
        alias_map = q.username_alias_map(conn)
        def aliases_active(u: str, in_set: set[str]) -> bool:
            chain = alias_map.get(u)
            if not chain:
                return False
            return any(a in in_set for a in chain if a != u)

        ever_removed_you = {u for u in ever_removed_you if not aliases_active(u, sd.following)}
        ever_unfollowed_you = {u for u in ever_unfollowed_you if not aliases_active(u, sd.followers)}

        sections["ever_unfollowed_you"] = sorted(ever_unfollowed_you)
        sections["ever_removed_you_as_follower"] = sorted(ever_removed_you)
        # Subset of ever_unfollowed_you that you still follow AND who aren't
        # currently following you back. Once they re-follow (mutual again),
        # they fall off this list — the unfollow event itself stays in the
        # activity log, which is what preserves the history.
        sections["still_follow_after_drop"] = sorted(
            (ever_unfollowed_you & sd.following) - sd.followers
        )

        # Cumulative "you unfollowed" — anyone who ever appeared in your recently_unfollowed.
        sections["you_unfollowed_ever"] = sorted(ever_self)

        # Renamed accounts — show one row per chain, keyed by the latest username.
        chains = q.detect_renames(conn)
        sections["renamed"] = sorted({c["sequence"][-1] for c in chains})

        # Cumulative incoming follow requests: total inbound interest across
        # the full snapshot history. Union of observed incoming + every
        # account that has ever been a follower (since each follower
        # requested you at some point — IG just trims the request log
        # once it resolves into a follow).
        ever_incoming_observed = {
            r["username"]
            for r in conn.execute("SELECT DISTINCT username FROM incoming_follow_requests").fetchall()
        }
        ever_followed_you_set = {
            r["username"]
            for r in conn.execute("SELECT DISTINCT username FROM followers").fetchall()
        }
        sections["ever_incoming_requests"] = sorted(ever_incoming_observed | ever_followed_you_set)
        # "Real requests": everyone observed in incoming_follow_requests across
        # all snapshots, with random-request-tagged accounts removed downstream
        # by the suppressed_set filter. The complement of the random_request
        # bucket — what's left to triage once the noise is tagged out.
        sections["real_requests"] = sorted(ever_incoming_observed)
        # Strict "incoming rejected" — observed in incoming at some snapshot
        # AND never made it into followers across any snapshot. Without
        # excluding ever_followed_you_set, accounts you accepted and later
        # removed would appear here, which isn't what "rejected" means.
        sections["incoming_request_dropped"] = sorted(
            ever_incoming_observed - ever_followed_you_set - sd.incoming_requests
        )

        # Cumulative outgoing — mirror of ever_incoming. Union of every
        # pending request you've sent + every account you've ever followed
        # (each follow implies a request happened at some point).
        ever_pending_outgoing = {
            r["username"]
            for r in conn.execute(
                "SELECT DISTINCT username FROM pending_follow_requests "
                "WHERE source_label IN ('pending_follow_requests', 'both')"
            ).fetchall()
        }
        ever_following_set = {
            r["username"]
            for r in conn.execute("SELECT DISTINCT username FROM following").fetchall()
        }
        sections["ever_requested_outgoing"] = sorted(ever_pending_outgoing | ever_following_set)

        # Cumulative "you requested → never accepted": appeared in your
        # pending_follow_requests at some snapshot AND never made it into
        # the following set across any snapshot. Excluding ever_following
        # is what makes this a real rejected list — without it, anyone
        # you followed-and-then-unfollowed would show up here as if their
        # request had been rejected.
        sections["request_dropped"] = sorted(
            ever_pending_outgoing - ever_following_set - sd.pending
        )

        # Per-username exact timestamps from Instagram's export. IG records
        # the moment of every follow / request to the second; these maps let
        # rows render "you followed Apr 30 · 3:14 PM" instead of just the date,
        # and let chronological sorts break ties precisely.
        following_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM following WHERE snapshot_id = ?",
            (sid,),
        ).fetchall():
            following_ts[r["username"]] = r["export_timestamp"]

        followers_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM followers WHERE snapshot_id = ?",
            (sid,),
        ).fetchall():
            followers_ts[r["username"]] = r["export_timestamp"]

        pending_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM pending_follow_requests "
            "WHERE snapshot_id = ? AND source_label IN ('pending_follow_requests', 'both')",
            (sid,),
        ).fetchall():
            pending_ts[r["username"]] = r["export_timestamp"]

        incoming_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM incoming_follow_requests WHERE snapshot_id = ?",
            (sid,),
        ).fetchall():
            incoming_ts[r["username"]] = r["export_timestamp"]

        unfollowed_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM recently_unfollowed WHERE snapshot_id = ?",
            (sid,),
        ).fetchall():
            unfollowed_ts[r["username"]] = r["export_timestamp"]

        # Historical exact-ts maps populated below, after the chrono sid maps
        # are computed (they need first_in_followers_sid etc. as input).
        first_followed_you_ts: dict[str, int | None] = {}
        last_followed_you_ts:  dict[str, int | None] = {}
        last_unfollowed_ts:    dict[str, int | None] = {}

        now = datetime.now(timezone.utc)

        # Snapshot id -> label/created_at for resolving "when did <X> happen"
        snap_meta: dict[int, dict] = {}
        for s in q.list_snapshots(conn):
            snap_meta[s.id] = {"label": s.label, "created_at": s.created_at}

        def parse_label_date(label: str | None):
            if not label or len(label) < 10 or label[4] != "-":
                return None
            try:
                return datetime.strptime(label[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                return None

        def days_ago_for_sid(snap_id: int | None) -> tuple[str | None, int | None]:
            if snap_id is None:
                return (None, None)
            d = parse_label_date(snap_meta.get(snap_id, {}).get("label"))
            if not d:
                return (snap_meta.get(snap_id, {}).get("label"), None)
            return (d.date().isoformat(), (now - d).days)

        # For "not following you back" rows: when (if ever) did this account last follow you?
        nfb_set = set(sections.get("not_following_you_back", []))
        last_followers_sid = _per_user_sid_chrono(conn, "followers", nfb_set, "last")

        # For mutuals: when did they first appear in BOTH following and followers in the same snapshot?
        mutual_set = sd.followers & sd.following
        mutual_since_sid = _per_user_sid_chrono(
            conn,
            "following",
            mutual_set,
            "first",
            extra_join_predicate=(
                "JOIN followers fr ON fr.snapshot_id = t.snapshot_id "
                "AND fr.username = t.username"
            ),
        )

        # For currently-pending: when did the request first appear?
        pending_since_sid = _per_user_sid_chrono(
            conn, "pending_follow_requests", sd.pending, "first"
        )

        TIMED_KINDS = {
            "not_following_you_back",
            "unfollowers_you_still_follow",
            "mutuals",
            "all_following",
            "pending",
            "all_followers",
            "feeder_accounts",
        }
        BUCKET_KINDS = {"favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"}

        # Tag state — empty in pure mode so pre-built rows have tag fields = False;
        # overlay attaches the real values per request.
        flagged = {} if _pure_only else tags_mod.all_flagged_usernames(conn)

        reengaged = q.detect_reengagements(conn)

        # Privacy inference: union of every username that will appear in any section,
        # so each row can show a "likely private/public" hint. One bulk query, cached
        # for all build_row calls below.
        all_usernames: set[str] = set()
        for usernames in sections.values():
            all_usernames.update(usernames)
        privacy_map = q.privacy_status_bulk(conn, list(all_usernames))

        # Per-row chronological dates for history lists. Without these, lists like
        # "you_unfollowed_ever" had no date fields populated (the user isn't
        # currently in followers/following) so the chronological sort silently
        # collapsed to alphabetical. Compute three bulk sid maps once and let
        # build_row pick the right one per kind:
        #   last_in_followers_sid  -> when they were last seen following you
        #   first_in_followers_sid -> when they first started following you
        #   last_unfollow_sid      -> when you most recently unfollowed them
        last_in_followers_sid  = _per_user_sid_chrono(conn, "followers",            all_usernames, "last")
        first_in_followers_sid = _per_user_sid_chrono(conn, "followers",            all_usernames, "first")
        last_in_following_sid  = _per_user_sid_chrono(conn, "following",            all_usernames, "last")
        last_unfollow_sid      = _per_user_sid_chrono(conn, "recently_unfollowed",  all_usernames, "last")

        # Per-row exact timestamps from historical snapshots — sharpen the
        # "they first/last followed you" and "you unfollowed them" fields from
        # snapshot-label precision (a date) to per-row precision (the actual
        # second IG recorded). Bulk-fetch in one query per table to avoid the
        # per-username SELECT loop.
        def _bulk_exact_ts(table: str, sid_map: dict[str, int]) -> dict[str, int]:
            if not sid_map:
                return {}
            keys = list(sid_map.items())
            placeholders = ",".join("(?,?)" for _ in keys)
            params: list = []
            for u, sid_v in keys:
                params.extend([u, sid_v])
            rows = conn.execute(
                f"SELECT username, export_timestamp FROM {table} "
                f"WHERE (username, snapshot_id) IN (VALUES {placeholders}) "
                f"AND export_timestamp IS NOT NULL",
                params,
            ).fetchall()
            return {r["username"]: r["export_timestamp"] for r in rows}

        first_followed_you_ts = _bulk_exact_ts("followers",           first_in_followers_sid)
        last_followed_you_ts  = _bulk_exact_ts("followers",           last_in_followers_sid)
        last_unfollowed_ts    = _bulk_exact_ts("recently_unfollowed", last_unfollow_sid)

        # "Last followed you" date: kinds where the row is someone who used to
        # follow you and stopped. Pulls from last_in_followers_sid.
        LAST_FOLLOWED_YOU_KINDS = {
            "not_following_you_back",
            "they_unfollowed_you",
            "ever_unfollowed_you",
            "unfollowers_you_still_follow",
        }
        # "Last appeared in your following" date: kinds where they used to
        # appear in your following list and disappeared (i.e. they removed you,
        # so the entry vanished from your export). Pulls from last_in_following_sid.
        LAST_IN_FOLLOWING_KINDS = {
            "they_removed_you_as_follower",
            "ever_removed_you_as_follower",
        }
        # "When you unfollowed them" date: kinds populated from your
        # recently_unfollowed history.
        YOU_UNFOLLOWED_KINDS = {
            "you_unfollowed",
            "you_unfollowed_ever",
            "recently_unfollowed",
        }
        # "When they first started following you" date: kinds where the natural
        # chronological ordering is by their entry into your followers list.
        FIRST_FOLLOWED_YOU_KINDS = {
            "all_followers",
            "feeder_accounts",
            "mutuals",
        }

        def relationship(u: str) -> tuple[str, str]:
            in_fol = u in sd.following
            in_back = u in sd.followers
            in_pend = u in sd.pending
            in_inc = u in sd.incoming_requests
            if in_fol and in_back:
                return ("mutual", "good")
            if in_fol and in_inc:
                return ("requesting to follow back", "pending")
            if in_fol and not in_back:
                return ("doesn't follow back", "warn")
            if in_back and not in_fol:
                return ("follows you only", "info")
            if in_pend:
                return ("request pending", "info")
            return ("no current relation", "muted")

        def bucket_status(kind: str, u: str) -> tuple[str, str]:
            in_fol = u in sd.following
            in_back = u in sd.followers
            in_pend = u in sd.pending
            if kind == "watchlist":
                if not in_fol:
                    return ("you've unfollowed", "stopped")
                if in_back:
                    return ("now follows back ✓", "good")
                return ("still waiting", "pending")
            if kind == "want_remove":
                if not in_fol:
                    return ("already unfollowed ✓", "good")
                return ("still following", "action")
            if kind == "favorite":
                if not in_fol and not in_back:
                    return ("neither follows", "warn")
                if not in_fol:
                    return ("you don't follow them", "stopped")
                if not in_back:
                    return ("doesn't follow back", "warn")
                return ("mutual", "good")
            if kind == "disabled":
                # Anyone tagged disabled who shows up in any current relationship → reactivated.
                if in_fol or in_back or in_pend:
                    return ("⚠ BACK ONLINE", "action")
                return ("still gone", "good")
            if kind == "unavailable":
                # Same proof-of-life rule as disabled, but tied to "Instagram says
                # the page doesn't exist" rather than user's manual judgement.
                if in_fol or in_back or in_pend:
                    return ("✕ PAGE BACK", "action")
                return ("still gone", "good")
            if kind == "random_request":
                # If a random-request-tagged account became a real follower (you
                # accepted) or you ended up following them, they probably weren't
                # actually a random request — surface so you can clear the tag.
                if in_back or in_fol:
                    return ("now connected — tag stale", "warn")
                return ("flagged random request", "muted")
            return ("", "")

        def parse_label_date(label: str | None) -> datetime | None:
            if not label or len(label) < 10 or label[4] != "-":
                return None
            try:
                return datetime.strptime(label[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                return None

        def build_row(u: str, kind: str) -> dict:
            rel, rel_kind = relationship(u)
            row = {
                "username": u,
                "favorite": flagged.get(u, {}).get("favorite", False),
                "want_remove": flagged.get(u, {}).get("want_remove", False),
                "watchlist": flagged.get(u, {}).get("watchlist", False),
                "disabled": flagged.get(u, {}).get("disabled", False),
                "unavailable": flagged.get(u, {}).get("unavailable", False),
                "random_request": flagged.get(u, {}).get("random_request", False),
                "currently_following": u in sd.following,
                "currently_follower": u in sd.followers,
                "currently_pending": u in sd.pending,
                "relationship": rel,
                "relationship_kind": rel_kind,
            }
            if u in reengaged:
                row["history_status"] = "re-engaged"
            priv = privacy_map.get(u)
            if priv and priv != "unknown":
                row["privacy"] = priv  # "likely_private" | "likely_public"
            # Aliases (rename chain).
            chain = alias_map.get(u)
            if chain:
                row["aliases"] = chain
            # When you started following them (exact, from IG export).
            ts = following_ts.get(u)
            if ts:
                followed_at = datetime.fromtimestamp(ts, tz=timezone.utc)
                row["followed_ts"] = ts
                row["followed_at"] = followed_at.date().isoformat()
                row["days_since"] = (now - followed_at).days
            # When they followed you (exact, from current followers row).
            if u in followers_ts and followers_ts[u]:
                row["followers_ts"] = followers_ts[u]
            # When you sent the request (exact).
            if u in pending_ts and pending_ts[u]:
                row["pending_ts"] = pending_ts[u]
            # When they sent the request to you (exact).
            if u in incoming_ts and incoming_ts[u]:
                row["incoming_ts"] = incoming_ts[u]
            # When you unfollowed them (exact, from recently_unfollowed).
            if u in unfollowed_ts and unfollowed_ts[u]:
                row["unfollowed_ts"] = unfollowed_ts[u]
            # When you became mutual (first overlap — coarse, snapshot-bound).
            if u in mutual_since_sid:
                d, ago = days_ago_for_sid(mutual_since_sid[u])
                row["mutual_since_at"] = d
                row["mutual_since_days_ago"] = ago
            # When pending request first appeared (coarse).
            if u in pending_since_sid:
                d, ago = days_ago_for_sid(pending_since_sid[u])
                row["pending_since_at"] = d
                row["pending_since_days_ago"] = ago
            if kind in BUCKET_KINDS:
                row["currently_following"] = u in sd.following
                row["currently_follower"] = u in sd.followers
                text, severity = bucket_status(kind, u)
                row["bucket_status"] = text
                row["bucket_status_kind"] = severity
            if kind == "not_following_you_back":
                last_sid = last_followers_sid.get(u)
                if last_sid is None:
                    row["ever_followed_you"] = False
                    row["last_followed_you_at"] = None
                    row["last_followed_you_days_ago"] = None
                else:
                    # Prefer the per-row export timestamp (exact second IG
                    # recorded) over the snapshot label (date-precise).
                    exact_ts = last_followed_you_ts.get(u)
                    if exact_ts:
                        d = datetime.fromtimestamp(exact_ts, tz=timezone.utc)
                        row["last_followed_you_ts"] = exact_ts
                    else:
                        d = parse_label_date(snap_meta.get(last_sid, {}).get("label"))
                    row["ever_followed_you"] = True
                    row["last_followed_you_at"] = d.date().isoformat() if d else None
                    row["last_followed_you_days_ago"] = (now - d).days if d else None
                    row["last_followed_you_snapshot_id"] = last_sid

            # History-list dates: populate the chronological field that's actually
            # meaningful for the row's list, so the sort dropdown does the right
            # thing instead of falling back to alphabetical.
            if kind in LAST_FOLLOWED_YOU_KINDS and "last_followed_you_at" not in row:
                last_sid = last_in_followers_sid.get(u)
                if last_sid is not None:
                    exact_ts = last_followed_you_ts.get(u)
                    if exact_ts:
                        d = datetime.fromtimestamp(exact_ts, tz=timezone.utc)
                        row["last_followed_you_ts"] = exact_ts
                    else:
                        d = parse_label_date(snap_meta.get(last_sid, {}).get("label"))
                    if d:
                        row["last_followed_you_at"] = d.date().isoformat()
                        row["last_followed_you_days_ago"] = (now - d).days
            if kind in LAST_IN_FOLLOWING_KINDS:
                last_sid = last_in_following_sid.get(u)
                if last_sid is not None:
                    meta = snap_meta.get(last_sid, {})
                    d = parse_label_date(meta.get("label"))
                    row["removed_you_at"] = d.date().isoformat() if d else meta.get("label")
            if kind in YOU_UNFOLLOWED_KINDS:
                last_sid = last_unfollow_sid.get(u)
                if last_sid is not None:
                    exact_ts = last_unfollowed_ts.get(u)
                    if exact_ts:
                        d = datetime.fromtimestamp(exact_ts, tz=timezone.utc)
                        row["unfollowed_by_you_ts"] = exact_ts
                    else:
                        d = parse_label_date(snap_meta.get(last_sid, {}).get("label"))
                    if d:
                        row["unfollowed_by_you_at"] = d.date().isoformat()
                        row["unfollowed_by_you_days_ago"] = (now - d).days
            if kind in FIRST_FOLLOWED_YOU_KINDS:
                first_sid = first_in_followers_sid.get(u)
                if first_sid is not None:
                    exact_ts = first_followed_you_ts.get(u)
                    if exact_ts:
                        d = datetime.fromtimestamp(exact_ts, tz=timezone.utc)
                        row["first_followed_you_ts"] = exact_ts
                    else:
                        d = parse_label_date(snap_meta.get(first_sid, {}).get("label"))
                    if d:
                        row["first_followed_you_at"] = d.date().isoformat()

            return row

        if _pure_only:
            # Pre-build non-bucket rows with empty tag fields. Pack helpers
            # so the overlay can rebuild bucket rows on demand without
            # re-querying the snapshot data.
            non_bucket_rows: dict[str, dict[str, dict]] = {}
            for kind, usernames in sections.items():
                non_bucket_rows[kind] = {u: build_row(u, kind) for u in usernames}
            return {
                "_pure": True,
                "snapshot_id": sid,
                "prev_id": prev_id,
                "non_bucket_sections": dict(sections),
                "non_bucket_rows": non_bucket_rows,
                # build_row helpers — overlay calls a re-implementation that
                # pulls these fields. Sets are converted to frozensets at the
                # boundary so cache mutation is impossible.
                "ctx": {
                    "sd_followers": frozenset(sd.followers),
                    "sd_following": frozenset(sd.following),
                    "sd_pending": frozenset(sd.pending),
                    "sd_incoming_requests": frozenset(sd.incoming_requests),
                    "reengaged": frozenset(reengaged),
                    "privacy_map": privacy_map,
                    "alias_map": alias_map,
                    "snap_meta": snap_meta,
                    "following_ts": following_ts,
                    "followers_ts": followers_ts,
                    "pending_ts": pending_ts,
                    "incoming_ts": incoming_ts,
                    "unfollowed_ts": unfollowed_ts,
                    "mutual_since_sid": mutual_since_sid,
                    "pending_since_sid": pending_since_sid,
                    "last_followers_sid": last_followers_sid,
                    "last_in_followers_sid": last_in_followers_sid,
                    "first_in_followers_sid": first_in_followers_sid,
                    "last_in_following_sid": last_in_following_sid,
                    "last_unfollow_sid": last_unfollow_sid,
                    "last_followed_you_ts": last_followed_you_ts,
                    "first_followed_you_ts": first_followed_you_ts,
                    "last_unfollowed_ts": last_unfollowed_ts,
                    "now_iso": now.isoformat(),
                },
            }

        # Exclude disabled- or unavailable-tagged accounts from every non-bucket list.
        # Once you've tagged something as gone, you don't want to keep seeing it in
        # the follower / following / unfollow analyses — only in its bucket.
        suppressed_set = (
            {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "random_request")}
        )
        for kind in list(sections.keys()):
            if kind in BUCKET_KINDS:
                continue
            sections[kind] = [u for u in sections[kind] if u not in suppressed_set]

        annotated = {
            kind: [build_row(u, kind) for u in usernames]
            for kind, usernames in sections.items()
        }

        # Default sort for not_following_you_back: most-recent stop first, never-followed last.
        if "not_following_you_back" in annotated:
            def nfb_key(r):
                if not r.get("ever_followed_you"):
                    return (1, r["username"])
                days = r.get("last_followed_you_days_ago")
                return (0, days if days is not None else 1_000_000, r["username"])
            annotated["not_following_you_back"].sort(key=nfb_key)

        # Bucket lists: surface actionable rows first.
        BUCKET_PRIORITY = {"action": 0, "warn": 1, "pending": 2, "stopped": 3, "good": 4, "": 5}
        for bk in BUCKET_KINDS:
            if bk in annotated:
                annotated[bk].sort(
                    key=lambda r: (BUCKET_PRIORITY.get(r.get("bucket_status_kind", ""), 9), r["username"])
                )

        return {"snapshot_id": sid, "previous_snapshot_id": prev_id, "sections": annotated}


_TAG_FLAGS = ("favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request")
_BUCKET_KINDS_SET = {"favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"}
_BUCKET_PRIORITY = {"action": 0, "warn": 1, "pending": 2, "stopped": 3, "good": 4, "": 5}


def _build_bucket_row(ctx: dict, flagged: dict, u: str, kind: str) -> dict:
    """Re-implementation of build_row for bucket kinds, working from the
    cached pure context instead of closure variables. Bucket lists are small
    (typically <100 rows) so this runs once per bucket per request."""
    from datetime import datetime, timezone
    in_fol = u in ctx["sd_following"]
    in_back = u in ctx["sd_followers"]
    in_pend = u in ctx["sd_pending"]
    in_inc = u in ctx["sd_incoming_requests"]

    # Relationship label.
    if in_fol and in_back:
        rel, rel_kind = "mutual", "good"
    elif in_fol and in_inc:
        rel, rel_kind = "requesting to follow back", "pending"
    elif in_fol and not in_back:
        rel, rel_kind = "doesn't follow back", "warn"
    elif in_back and not in_fol:
        rel, rel_kind = "follows you only", "info"
    elif in_pend:
        rel, rel_kind = "request pending", "info"
    else:
        rel, rel_kind = "no current relation", "muted"

    # Bucket status.
    if kind == "watchlist":
        bs = ("you've unfollowed", "stopped") if not in_fol else (("now follows back ✓", "good") if in_back else ("still waiting", "pending"))
    elif kind == "want_remove":
        bs = ("already unfollowed ✓", "good") if not in_fol else ("still following", "action")
    elif kind == "favorite":
        if not in_fol and not in_back:
            bs = ("neither follows", "warn")
        elif not in_fol:
            bs = ("you don't follow them", "stopped")
        elif not in_back:
            bs = ("doesn't follow back", "warn")
        else:
            bs = ("mutual", "good")
    elif kind == "disabled":
        bs = ("⚠ BACK ONLINE", "action") if (in_fol or in_back or in_pend) else ("still gone", "good")
    elif kind == "unavailable":
        bs = ("✕ PAGE BACK", "action") if (in_fol or in_back or in_pend) else ("still gone", "good")
    elif kind == "random_request":
        bs = ("now connected — tag stale", "warn") if (in_back or in_fol) else ("flagged random request", "muted")
    else:
        bs = ("", "")

    row = {
        "username": u,
        "currently_following": in_fol,
        "currently_follower": in_back,
        "currently_pending": in_pend,
        "relationship": rel,
        "relationship_kind": rel_kind,
        "bucket_status": bs[0],
        "bucket_status_kind": bs[1],
    }
    # Tag flags from current state.
    for f in _TAG_FLAGS:
        row[f] = flagged.get(u, {}).get(f, False)
    # Optional context fields when present.
    if u in ctx["reengaged"]:
        row["history_status"] = "re-engaged"
    priv = ctx["privacy_map"].get(u)
    if priv and priv != "unknown":
        row["privacy"] = priv
    chain = ctx["alias_map"].get(u)
    if chain:
        row["aliases"] = chain
    ts = ctx["following_ts"].get(u)
    if ts:
        followed_at = datetime.fromtimestamp(ts, tz=timezone.utc)
        now = datetime.fromisoformat(ctx["now_iso"])
        row["followed_ts"] = ts
        row["followed_at"] = followed_at.date().isoformat()
        row["days_since"] = (now - followed_at).days
    if ctx["followers_ts"].get(u):
        row["followers_ts"] = ctx["followers_ts"][u]
    if ctx["pending_ts"].get(u):
        row["pending_ts"] = ctx["pending_ts"][u]
    if ctx["incoming_ts"].get(u):
        row["incoming_ts"] = ctx["incoming_ts"][u]
    if ctx["unfollowed_ts"].get(u):
        row["unfollowed_ts"] = ctx["unfollowed_ts"][u]
    return row


def _lists_apply_overlay(pure: dict) -> dict:
    """Tag overlay: filters non-bucket sections by current suppressed_set,
    attaches current tag flags to pre-built rows, builds bucket sections
    from current tags, sorts. Runs every request — must be cheap."""
    if not pure.get("_pure"):
        # Custom-snapshot path returns a fully-finalised response — pass through.
        return pure
    with db_conn() as conn:
        flagged = tags_mod.all_flagged_usernames(conn)
    suppressed = {
        u for u, t in flagged.items()
        if t.get("disabled") or t.get("unavailable") or t.get("random_request")
    }
    annotated: dict[str, list[dict]] = {}
    # Parallel "full" view that doesn't apply suppressed_set — used by the
    # frontend's cross-list intersection feature, where the user explicitly
    # wants to see suppressed-tagged users (e.g. "show me everyone I follow
    # who is tagged unavailable"). Same row data, but bucket-tagged accounts
    # remain in the non-bucket sections instead of being filtered out.
    sections_full: dict[str, list[dict]] = {}
    for kind, usernames in pure["non_bucket_sections"].items():
        rows_for_kind = pure["non_bucket_rows"].get(kind, {})
        out = []
        out_full = []
        for u in usernames:
            base = rows_for_kind.get(u)
            if base is None:
                continue
            row = dict(base)
            user_flags = flagged.get(u, {})
            for f in _TAG_FLAGS:
                row[f] = user_flags.get(f, False)
            out_full.append(row)
            if u not in suppressed:
                out.append(row)
        annotated[kind] = out
        sections_full[kind] = out_full
    # Bucket sections: rebuild from current tags using cached context.
    ctx = pure["ctx"]
    for flag in _TAG_FLAGS:
        usernames = sorted(u for u, t in flagged.items() if t.get(flag))
        bucket_rows = [_build_bucket_row(ctx, flagged, u, flag) for u in usernames]
        annotated[flag] = bucket_rows
        sections_full[flag] = bucket_rows
    # NFB sort.
    if "not_following_you_back" in annotated:
        def nfb_key(r):
            if not r.get("ever_followed_you"):
                return (1, r["username"])
            days = r.get("last_followed_you_days_ago")
            return (0, days if days is not None else 1_000_000, r["username"])
        annotated["not_following_you_back"].sort(key=nfb_key)
    # Bucket priority sort.
    for bk in _BUCKET_KINDS_SET:
        if bk in annotated:
            annotated[bk].sort(
                key=lambda r: (_BUCKET_PRIORITY.get(r.get("bucket_status_kind", ""), 9), r["username"])
            )
    return {
        "snapshot_id": pure["snapshot_id"],
        "previous_snapshot_id": pure["prev_id"],
        "sections": annotated,
        "sections_full": sections_full,
    }


# ---------- per-account lookup ----------

@app.get("/api/lookup")
def lookup(account: str):
    username, profile_url = normalize_account_input(account)
    return _cached(f"lookup:{username}", lambda: _lookup_compute(username, profile_url))


def _lookup_compute(username: str, profile_url: str):
    with db_conn() as conn:
        summary = q.ever_summary(conn, username)
        tags = tags_mod.get_tags(conn, username)
        aliases = q.username_alias_map(conn).get(username, [])
        privacy = q.privacy_status_bulk(conn, [username]).get(username, "unknown")

        # Current-snapshot relationship state — needed by the browser
        # extension overlay so it can render "mutual" / "doesn't follow back"
        # without making a second request.
        latest = q.latest_id(conn)
        currently_following = currently_follower = currently_pending = currently_incoming = False
        if latest is not None:
            sd = q.snapshot_data(conn, latest)
            currently_following = username in sd.following
            currently_follower = username in sd.followers
            currently_pending = username in sd.pending
            currently_incoming = username in sd.incoming_requests

        current_state = {
            "currently_following": currently_following,
            "currently_follower": currently_follower,
            "currently_pending": currently_pending,
            "currently_incoming_request": currently_incoming,
        }

        if summary is None:
            return {
                "username": username,
                "profile_url": profile_url,
                "found": False,
                "tags": tags,
                "aliases": aliases,
                "privacy": privacy,
                **current_state,
            }
        return {
            **summary,
            "found": True,
            "tags": tags,
            "aliases": aliases,
            "privacy": privacy,
            **current_state,
        }


@app.get("/api/renames")
def renames():
    with db_conn() as conn:
        return {"chains": q.detect_renames(conn)}


@app.get("/api/history")
def history(username: str):
    name, _ = normalize_account_input(username)
    with db_conn() as conn:
        return {
            "username": name,
            "profile_url": q.latest_profile_url(conn, name),
            "tags": tags_mod.get_tags(conn, name),
            "history": q.account_history_lines(conn, name),
        }


# ---------- filter list (replaces prune-ever-file) ----------

@app.post("/api/filter-list")
def filter_list(payload: dict = Body(...)):
    text = payload.get("text", "")
    save_to_queue = payload.get("save_to_queue", True)
    with db_conn() as conn:
        result = filtering_mod.analyze(conn, text)
        if save_to_queue and result.get("new"):
            added = followup_mod.add_many(conn, result["new"])
            result["queue_added"] = added
            result["queue_total"] = followup_mod.count(conn)
        return result


@app.get("/api/followup")
def followup_list():
    with db_conn() as conn:
        return {"items": followup_mod.list_all(conn)}


@app.post("/api/followup/add")
def followup_add(payload: dict = Body(...)):
    items = payload.get("items")
    if not items:
        username = payload.get("username")
        if not username:
            raise HTTPException(status_code=400, detail="Provide 'username' or 'items'")
        items = [{
            "username": username,
            "profile_url": payload.get("profile_url"),
            "input": payload.get("input") or username,
        }]
    with db_conn() as conn:
        added = followup_mod.add_many(conn, items)
        total = followup_mod.count(conn)
    return {"added": added, "total": total}


@app.post("/api/followup/done")
def followup_done(payload: dict = Body(...)):
    username = payload.get("username")
    if not username:
        raise HTTPException(status_code=400, detail="username required")
    with db_conn() as conn:
        followup_mod.remove(conn, username)
    return {"removed": username}


@app.delete("/api/followup")
def followup_clear():
    with db_conn() as conn:
        n = followup_mod.clear(conn)
    return {"cleared": n}


# ---------- tags ----------

@app.get("/api/tags/{flag}")
def list_tags(flag: str):
    with db_conn() as conn:
        return tags_mod.list_with_flag(conn, flag)


@app.post("/api/tags")
def update_tag(payload: dict = Body(...)):
    account = payload.get("account") or payload.get("username")
    flag = payload.get("flag")
    value = bool(payload.get("value"))
    if not account or flag not in tags_mod.VALID_FLAGS:
        valid = " | ".join(sorted(tags_mod.VALID_FLAGS))
        raise HTTPException(status_code=400, detail=f"Need account and a valid flag ({valid}).")
    username, profile_url = normalize_account_input(account)
    with db_conn() as conn:
        result = tags_mod.set_flag(conn, username, flag, value, profile_url)
    _bump_tag_version()
    return result


# ---------- static frontend ----------

class NoCacheStaticFiles(StaticFiles):
    """Serve static files with Cache-Control: no-store so browsers always pick
    up the latest JS/CSS after a code change. Local-only dev tool — no CDN
    edge to worry about, and the cost of re-fetching ~50KB on every page
    load is negligible. Without this, Safari/Chrome cache app.js aggressively
    and the user keeps seeing stale UI after an edit."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


_NO_CACHE = {"Cache-Control": "no-store, must-revalidate"}

app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_CACHE)


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(
        STATIC_DIR / "manifest.webmanifest",
        media_type="application/manifest+json",
        headers=_NO_CACHE,
    )
