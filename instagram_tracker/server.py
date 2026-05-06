"""FastAPI server. Tiny request handlers; all logic lives in the modules above."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import alerts as alerts_mod
from . import audit as audit_mod
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
# gzip the large JSON payloads (/api/lists is the biggest at ~18MB
# uncompressed, compresses to ~1-2MB). minimum_size=1000 means small
# responses pass through uncompressed (CPU not worth it).
app.add_middleware(GZipMiddleware, minimum_size=1000)


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
def scan_now(force: bool = False, since_ms: int | None = None):
    """Manually trigger a one-shot scan-and-import of the watch folder.
    Synchronous so the response carries the result; on a slow Drive root
    this can take a couple of minutes, but the user opted in by clicking.

    `force=true` bypasses the path-fingerprint dedup so every file is
    re-extracted and re-evaluated. Catches files that the fingerprint
    incorrectly skipped (Drive cache mismatches, etc.).

    `since_ms` (optional, unix-ms) is used by the extension's arrival
    poller. The response adds `new_files_since` — the number of files
    in the watch folder whose mtime is newer than `since_ms`. The
    arrival poller treats >0 as proof the export landed, regardless
    of whether it imported (duplicates of an existing snapshot still
    count as a successful Drive arrival from the bot's POV — the
    file showed up, we just chose not to keep it)."""
    result = watcher_mod.scan_once(force=force)
    if since_ms is not None:
        try:
            cutoff_s = float(since_ms) / 1000.0
            from pathlib import Path as _Path
            from os import scandir as _scandir
            wf = result.get("watch_folder")
            count = 0
            if wf:
                with _scandir(wf) as it:
                    for entry in it:
                        try:
                            if entry.stat().st_mtime > cutoff_s:
                                count += 1
                        except OSError:
                            continue
            result["new_files_since"] = count
            result["since_ms"] = int(since_ms)
        except (ValueError, TypeError):
            result["new_files_since"] = 0
    if result.get("imported") or result.get("skipped"):
        _bump_snapshot_version()
    # Audit summary + each error file's reason. Successful imports /
    # backfills are summarised in counts; only error rows get a per-
    # file audit entry so the log doesn't balloon on every scan.
    with db_conn() as conn:
        audit_mod.log(
            conn,
            "scan" if not force else "force_rescan",
            target=str(result.get("watch_folder", "")),
            ok=bool(result.get("ok", True)),
            scanned=result.get("scanned"),
            imported=result.get("imported"),
            skipped=result.get("skipped"),
            already_seen=result.get("already_seen"),
            errors=sum(1 for d in result.get("details", []) if d.get("outcome") == "error"),
        )
        for d in result.get("details", []) or []:
            if d.get("outcome") == "error":
                audit_mod.log(
                    conn,
                    "import_error",
                    target=d.get("file"),
                    ok=False,
                    message=(d.get("message") or "")[:500],
                )
    return result


@app.post("/api/reset-snapshots")
def reset_snapshots(rescan: bool = True):
    """Wipe all snapshot-derived data and (optionally) trigger a fresh
    scan. Tags, notes, follow-up queue, profile observations, and the
    auto-archived media folder are PRESERVED — those are user-authored
    or expensive to rebuild.

    Use this when the snapshot DB has gone funny (stuck errors that
    won't clear via re-scan, partial imports left ghost rows, etc.) and
    you want to start clean from the export files in Drive.

    Tables wiped: snapshots, followers, following,
    pending_follow_requests, recently_unfollowed,
    incoming_follow_requests. Plus the watcher's path-fingerprint cache
    so every file is re-evaluated on the next scan.

    Returns the post-reset row counts and (if rescan=true) the
    subsequent scan summary."""
    derived_tables = (
        "followers",
        "following",
        "pending_follow_requests",
        "recently_unfollowed",
        "incoming_follow_requests",
        "snapshots",
    )
    with db_conn() as conn:
        before = {t: conn.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"] for t in derived_tables}
        for t in derived_tables:
            conn.execute(f"DELETE FROM {t}")
        conn.commit()
        audit_mod.log(
            conn,
            "reset_snapshots",
            target="all derived tables",
            ok=True,
            wiped_counts=before,
        )
    # Clear the watcher's in-memory dedup so subsequent scans re-evaluate
    # every file. Without this, the fingerprint cache would skip files
    # it already processed before the wipe.
    try:
        watcher_mod.clear_seen_cache()
    except AttributeError:
        # Older watcher versions don't expose this; force=True on the
        # next scan is the fallback.
        pass
    _bump_snapshot_version()
    out = {"ok": True, "wiped": before}
    if rescan:
        result = watcher_mod.scan_once(force=True)
        out["scan"] = result
        with db_conn() as conn:
            audit_mod.log(
                conn,
                "post_reset_rescan",
                target=str(result.get("watch_folder", "")),
                ok=bool(result.get("ok", True)),
                scanned=result.get("scanned"),
                imported=result.get("imported"),
                skipped=result.get("skipped"),
                errors=sum(1 for d in result.get("details", []) if d.get("outcome") == "error"),
            )
            for d in result.get("details", []) or []:
                if d.get("outcome") == "error":
                    audit_mod.log(
                        conn,
                        "import_error",
                        target=d.get("file"),
                        ok=False,
                        message=(d.get("message") or "")[:500],
                    )
        if result.get("imported") or result.get("skipped"):
            _bump_snapshot_version()
    return out


@app.get("/api/audit-log")
def audit_log(limit: int = 200):
    """Return the most recent audit rows, newest first. Used by the
    Imports view to show a 'what's happened' panel without making the
    user trawl server stdout."""
    with db_conn() as conn:
        return {"entries": audit_mod.list_recent(conn, limit=max(1, min(limit, 1000)))}


# ---------- push notifications (iMessage / email / ntfy) ----------
#
# The extension and the watchdog don't need to know HOW pushes get
# delivered — they POST to /api/push and the server decides based on
# ~/.config/igtracker/push.json. This keeps the user's phone number /
# email / ntfy topic OUT of the extension and OUT of git.
#
# Config file format (JSON):
#   {
#     "method": "imessage",            // imessage | email | ntfy | none
#     "recipient": "+15551234567",     // phone for imessage, addr for email, topic for ntfy
#     "smtp": { ... }                  // optional, only for method=email
#   }
#
# iMessage path uses osascript → Messages.app. End-to-end encrypted by
# Apple, no third-party server, no new app install on the phone. The
# first invocation may prompt for "Allow Python to control Messages"
# in System Settings → Privacy & Security → Automation; user has to
# approve once.

_PUSH_CONFIG_PATH = (
    __import__("pathlib").Path.home() / ".config" / "igtracker" / "push.json"
)


def _read_push_config() -> dict:
    import json as _json
    if not _PUSH_CONFIG_PATH.exists():
        return {"method": "none"}
    try:
        with _PUSH_CONFIG_PATH.open() as f:
            return _json.load(f)
    except Exception as e:
        return {"method": "none", "error": str(e)}


def _send_reminder(title: str, body: str) -> tuple[bool, str]:
    """Create a Reminders.app reminder due in 5 seconds. iOS pushes a
    notification with sound when the due time hits — works for self-
    addressed alerts where iMessage's banner gets suppressed. Reminder
    syncs via iCloud so the user's iPhone gets it as long as Reminders
    is enabled in iCloud (Settings → Apple ID → iCloud → Reminders)."""
    import subprocess
    safe_title = (title or "IG Bot alert").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    safe_body = (body or "").replace("\\", "\\\\").replace('"', '\\"')
    script = (
        f'tell application "Reminders"\n'
        f'  set newRem to make new reminder with properties {{name:"{safe_title}", body:"{safe_body}", remind me date:((current date) + 5)}}\n'
        f'end tell'
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return True, "reminder created (fires in 5s)"
        return False, (result.stderr or result.stdout or "osascript failed").strip()
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_imessage(recipient: str, title: str, body: str) -> tuple[bool, str]:
    import subprocess
    text = f"{title}\n\n{body}" if title else body
    # AppleScript escaping: backslashes and quotes. Keep it conservative.
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    safe_recipient = recipient.replace('"', "")
    script = (
        f'tell application "Messages"\n'
        f'  set targetService to 1st service whose service type = iMessage\n'
        f'  set targetBuddy to buddy "{safe_recipient}" of targetService\n'
        f'  send "{escaped}" to targetBuddy\n'
        f'end tell'
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return True, "sent"
        return False, (result.stderr or result.stdout or "osascript failed").strip()
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_email(recipient: str, smtp: dict, title: str, body: str) -> tuple[bool, str]:
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = title or "(no subject)"
    msg["From"] = smtp.get("from") or smtp.get("user") or "igtracker@localhost"
    msg["To"] = recipient
    msg.set_content(body or "")
    try:
        host = smtp.get("host", "localhost")
        port = int(smtp.get("port", 587))
        with smtplib.SMTP(host, port, timeout=15) as s:
            if smtp.get("starttls", True):
                s.starttls()
            if smtp.get("user") and smtp.get("password"):
                s.login(smtp["user"], smtp["password"])
            s.send_message(msg)
        return True, "sent"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _send_ntfy(topic: str, title: str, body: str, priority: str) -> tuple[bool, str]:
    import urllib.request
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            data=(body or "").encode("utf-8"),
            method="POST",
            headers={
                "Title": title or "",
                "Priority": priority or "default",
                "Tags": "warning",
            },
        )
        with urllib.request.urlopen(req, timeout=10):
            return True, "sent"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


@app.post("/api/push")
def api_push(payload: dict = Body(...)):
    """Send a push via whatever method is configured in
    ~/.config/igtracker/push.json. Body: {title, message, priority}."""
    title = (payload.get("title") or "").strip()
    body = (payload.get("message") or "").strip()
    priority = (payload.get("priority") or "default").strip()
    cfg = _read_push_config()
    method = (cfg.get("method") or "none").lower()
    recipient = (cfg.get("recipient") or "").strip()
    if method == "none":
        return {"ok": False, "method": "none", "error": "push not configured (~/.config/igtracker/push.json)"}
    # Reminders doesn't need a recipient — it's local-to-iCloud.
    if method != "reminders" and not recipient:
        return {"ok": False, "method": method, "error": "no recipient configured"}
    if method == "imessage":
        ok, info = _send_imessage(recipient, title, body)
    elif method == "email":
        ok, info = _send_email(recipient, cfg.get("smtp") or {}, title, body)
    elif method == "ntfy":
        ok, info = _send_ntfy(recipient, title, body, priority)
    elif method == "reminders":
        ok, info = _send_reminder(title, body)
    else:
        return {"ok": False, "method": method, "error": f"unknown method: {method}"}
    return {"ok": ok, "method": method, "info": info}


@app.post("/api/bot-event")
def bot_event(payload: dict = Body(...)):
    """Extension reports the outcome of each scheduled export run.
    Stored in audit_log with op='bot_event' so the watchdog and the
    /api/bot-health endpoint can compute consecutive-failure counts
    without needing chrome.storage access."""
    status = (payload.get("status") or "").strip().lower()
    if status not in ("arrived", "no-arrival", "error", "stopped", "triggered"):
        raise HTTPException(status_code=400, detail="Invalid status.")
    with db_conn() as conn:
        audit_mod.log(
            conn,
            "bot_event",
            target=payload.get("kind") or "scheduled",
            ok=(status == "arrived"),
            status=status,
            elapsed_sec=payload.get("elapsedSec"),
            error=payload.get("error"),
            duplicate=bool(payload.get("duplicate")),
            extension_version=payload.get("extensionVersion"),
        )
    return {"ok": True}


@app.get("/api/bot-health")
def bot_health():
    """Aggregate the last bot run outcomes into a watchdog-friendly
    summary. The shell watchdog reads this every 30 min — if
    consecutive_failures >= 2 it triggers a Claude diagnosis."""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT ts, ok, details_json FROM audit_log "
            "WHERE op = 'bot_event' "
            "ORDER BY ts DESC LIMIT 50"
        ).fetchall()
    import json as _json
    events = []
    for r in rows:
        det = {}
        try:
            det = _json.loads(r["details_json"] or "{}")
        except Exception:
            pass
        events.append({
            "ts": r["ts"],
            "ok": bool(r["ok"]),
            "status": det.get("status"),
            "elapsed_sec": det.get("elapsed_sec"),
            "error": det.get("error"),
            "duplicate": det.get("duplicate"),
        })
    # Consecutive failures from the most-recent end. We count any
    # event whose status is in {error, no-arrival, stopped} — those
    # are the ones the user wants to be paged about. 'triggered' is
    # an in-flight marker (the run hasn't resolved yet) so it doesn't
    # break a streak in either direction.
    FAIL = {"error", "no-arrival", "stopped"}
    GOOD = {"arrived"}
    consecutive_failures = 0
    last_failure = None
    last_success = None
    for e in events:
        if e["status"] in GOOD:
            last_success = e
            break
        if e["status"] in FAIL:
            consecutive_failures += 1
            if last_failure is None:
                last_failure = e
        # 'triggered' (still in flight) — skip without breaking
    return {
        "consecutive_failures": consecutive_failures,
        "last_failure": last_failure,
        "last_success": last_success,
        "events": events[:20],
        "now": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }


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
            # Per-transition pending/incoming sets: used INSIDE the bounce
            # filter so we only strip the IG export quirk (a user
            # flickering following ↔ pending in the same transition is
            # the bounce; a user who later got re-requested is a real
            # past removal that the user themselves followed up on).
            # Previously this filter was applied post-hoc using the LATEST
            # snapshot's pending set, which incorrectly stripped real
            # removals where the user later re-requested the account.
            # Snapshot #904 trace: 9 lost followers, only 1 survived the
            # post-hoc filter — the other 6 were currently-pending re-
            # requests that the post-hoc filter wrongly classified as
            # bounces. Per-transition fix surfaces them as the real
            # removals they are.
            pending_by_sid: dict[int, set[str]] = {}
            for r in conn.execute(
                "SELECT snapshot_id, username FROM pending_follow_requests"
            ).fetchall():
                pending_by_sid.setdefault(int(r["snapshot_id"]), set()).add(r["username"])
            incoming_by_sid: dict[int, set[str]] = {}
            for r in conn.execute(
                "SELECT snapshot_id, username FROM incoming_follow_requests"
            ).fetchall():
                incoming_by_sid.setdefault(int(r["snapshot_id"]), set()).add(r["username"])

            ever_unfollowed_you: set[str] = set()
            ever_left_following: set[str] = set()
            for old_id, new_id in zip(ordered_sids[:-1], ordered_sids[1:]):
                old_followers = followers_by_sid.get(old_id, set())
                new_followers = followers_by_sid.get(new_id, set())
                old_following = following_by_sid.get(old_id, set())
                new_following = following_by_sid.get(new_id, set())
                old_pending  = pending_by_sid.get(old_id, set())
                new_pending  = pending_by_sid.get(new_id, set())
                old_incoming = incoming_by_sid.get(old_id, set())
                new_incoming = incoming_by_sid.get(new_id, set())
                # IG quirk bounce: a request that was NOT pending in the old
                # snapshot suddenly appears in pending in the new snapshot
                # AND the user simultaneously leaves following. That's the
                # flicker quirk to strip. If pending wasn't newly added
                # (e.g. IG carries a stale pending entry after a follow
                # was accepted, then later the follow is dropped), it's a
                # real removal and must NOT be stripped. Earlier version
                # used `new_pending` directly and was incorrectly stripping
                # real removals where the user already had a stale pending
                # row alongside a real follow.
                newly_pending  = new_pending  - old_pending
                newly_incoming = new_incoming - old_incoming
                followers_lost = old_followers - new_followers
                ever_unfollowed_you |= followers_lost - newly_incoming
                following_lost = old_following - new_following
                ever_left_following |= following_lost - newly_pending
            ever_self = q.ever_self_unfollowed(conn)
            # "Came back" filter: an account currently in following (or
            # followers) didn't remove you / didn't unfollow you — they had
            # a one-snapshot blip in some past export and reappeared. The
            # latest snapshot's pending/incoming sets are NOT subtracted
            # here — those are now handled per-transition above.
            ever_removed = ever_left_following - ever_self - curr.following
            # Split the inbound "they ended their following of me" set:
            #   ever_unfollowed_you (strict): they unfollowed, you didn't
            #     also unfollow — pure inbound action.
            #   mutual_breaks: both ends broke — they dropped AND you also
            #     unfollowed (or removed them as a follower).
            #
            # NOTE: previously these subtracted `curr.followers` to filter
            # out accounts that "came back" (returned to followers in a
            # later snapshot). That hid real historical events from view —
            # if 9 people unfollowed you in snapshot #904 and 8 of them
            # later sent a new request that you accepted, the cumulative
            # count showed only 1. The unfollow event still happened. The
            # row's per-account 'current relation' field already shows
            # whether they're back, so the user has the came-back signal
            # without having events erased from history.
            ever_unfollowed_you_inbound = ever_unfollowed_you - ever_self
            mutual_breaks = ever_unfollowed_you & ever_self

            # Strip rename chains so renames don't inflate "they unfollowed/removed you" counts.
            alias_map = q.username_alias_map(conn)
            def aliases_active(u: str, in_set: set[str]) -> bool:
                chain = alias_map.get(u)
                if not chain:
                    return False
                return any(a in in_set for a in chain if a != u)

            ever_unfollowed_you_inbound = {u for u in ever_unfollowed_you_inbound if not aliases_active(u, curr.followers)}
            mutual_breaks = {u for u in mutual_breaks if not aliases_active(u, curr.followers)}
            ever_removed = {u for u in ever_removed if not aliases_active(u, curr.following)}

            # NOTE: previously these three historical-event counters
            # subtracted `suppressed_home` (disabled/unavailable/random
            # tagged users). That's wrong for HISTORICAL counts —
            # users typically get tagged 'unavailable' BECAUSE they
            # unfollowed and went private/deactivated. Subtracting the
            # tag was hiding the very events the counter is supposed
            # to memorialise. Removed: ever_unfollowed_you_inbound 18
            # → 36, ever_removed 2 → 14. Active-relationship counts
            # below still use suppressed_home — that's appropriate
            # there because they describe current state.
            suppressed_home = (
                {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
                | {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
                | {r["username"] for r in tags_mod.list_with_flag(conn, "random_request")}
            )
            ever_unfollowed_you = ever_unfollowed_you_inbound | mutual_breaks
            mb_you_first_home, mb_they_first_home = q.split_mutual_breaks_by_initiator(conn, mutual_breaks)

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
            #
            # Treat the live extension scrape as a TIE-BREAKER, not a
            # blanket grace window. v1's grace window (last-seen-in-
            # pending within 35 days) collapsed the count from 67 → 7
            # because every recent snapshot has a thousand pending
            # users — far too aggressive. Just trust the export's
            # current pending state, then let extension observations
            # override on a per-user basis.
            ext_still_requested = {
                r["username"] for r in conn.execute(
                    "SELECT username FROM profile_observations "
                    "WHERE follow_button_state = 'requested'"
                ).fetchall()
            }
            request_dropped = ever_pending_observed - ever_following - curr.pending - ext_still_requested

            # Active-relationship counts: subtract suppressed_home so that
            # accounts the user has tagged disabled / unavailable / random
            # don't pad the "active" totals. Same rule the Lists view applies
            # to its non-bucket sections — keeps home and lists in sync.
            active_followers = curr.followers - suppressed_home
            active_following = curr.following - suppressed_home
            active_pending = curr.pending - suppressed_home
            active_incoming = curr.incoming_requests - suppressed_home

            # Extension-bridged pending/following: union in the rows the
            # extension recorded as "requested" / "following" but the
            # snapshot hasn't caught up to yet. Auto-clears once the next
            # export ingests them (they'll already be in active_pending).
            ext_bridged_pending = {
                r["username"] for r in conn.execute(
                    "SELECT username FROM profile_observations "
                    "WHERE follow_button_state = 'requested'"
                ).fetchall()
            } - suppressed_home - active_pending - active_following
            ext_bridged_following = {
                r["username"] for r in conn.execute(
                    "SELECT username FROM profile_observations "
                    "WHERE follow_button_state = 'following'"
                ).fetchall()
            } - suppressed_home - active_following
            active_pending = active_pending | ext_bridged_pending
            active_following = active_following | ext_bridged_following

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
                "ever_unfollowed_you": len(ever_unfollowed_you_inbound),
                "mutual_break_you_first": len(mb_you_first_home),
                "mutual_break_they_first": len(mb_they_first_home),
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
            "now_public": len(tags_mod.list_with_flag(conn, "now_public")),
            "need_archive": len(tags_mod.list_with_flag(conn, "need_archive")),
            "with_notes": conn.execute(
                "SELECT COUNT(*) AS c FROM profile_tags "
                "WHERE notes IS NOT NULL AND TRIM(notes) != ''"
            ).fetchone()["c"],
        }

        # Public-followback / private-accepted-no-followback breakdowns.
        # The dashboard's mutuals total includes both kinds — these
        # carve out the subsets so the user can see who's actually
        # reciprocating (public mutual = trivially mutual since neither
        # side gates on accept) vs. who let them in but didn't return
        # the follow (private account accepted the request but didn't
        # follow back). The latter is a useful "soft-rejection" signal
        # for follow-management.
        relbreak_users = sorted(
            (active_followers & active_following)
            | ((active_following - active_followers) & ever_pending_observed)
        )
        relbreak_priv = q.privacy_status_bulk(conn, relbreak_users)
        public_followed_back = sorted(
            u for u in (active_followers & active_following)
            if relbreak_priv.get(u, "unknown") in ("public", "likely_public")
        )
        private_accepted_no_follow_back = sorted(
            u for u in ((active_following - active_followers) & ever_pending_observed)
            if relbreak_priv.get(u, "unknown") in ("private", "likely_private")
        )
        # Cap previews at 50 each so the dashboard JSON stays bounded.
        # The full lists live in /api/dashboard sections (added below).
        bucket_counts["public_followed_back"] = len(public_followed_back)
        bucket_counts["private_accepted_no_follow_back"] = len(private_accepted_no_follow_back)
        # "Follow Request Rejected" — outbound requests that never made
        # it into the following set. `request_dropped` is computed
        # above (line ~438) inside the latest-snapshot branch; reuse
        # it here. Suppress users we've tagged as disabled / random /
        # unavailable so the home count matches the Lists view's
        # request_dropped section.
        request_rejected_home = sorted(set(request_dropped) - suppressed_home)
        bucket_counts["request_dropped"] = len(request_rejected_home)

        # Build per-username timestamp maps for the three home cards.
        # Each card shows TWO timestamps: the action you took, and
        # the action they took (or our best estimate of when their
        # action happened).
        #
        # `followers_ts_home`: when they started following you (current
        #   snapshot's followers row). IG records this exact second.
        # `following_ts_home`: when you started following them (current
        #   snapshot's following row). For private accepted, this
        #   doubles as the "they accepted" timestamp because IG only
        #   creates the following row at the moment of acceptance.
        # `pending_ts_home`: when you sent the request (MAX
        #   export_timestamp across all snapshot pending rows — IG
        #   records this once and it's stable across exports).
        # `last_pending_taken_at_home`: for users no longer in pending,
        #   the taken_at of the last snapshot we saw them in pending.
        #   Used as a "rejected/expired around or after this time"
        #   estimate for the Follow Request Rejected card.
        followers_ts_home = {
            r["username"]: r["export_timestamp"]
            for r in conn.execute(
                "SELECT username, export_timestamp FROM followers WHERE snapshot_id = ?",
                (latest,),
            ).fetchall()
        }
        following_ts_home = {
            r["username"]: r["export_timestamp"]
            for r in conn.execute(
                "SELECT username, export_timestamp FROM following WHERE snapshot_id = ?",
                (latest,),
            ).fetchall()
        }
        pending_ts_home = {
            r["username"]: r["ts"]
            for r in conn.execute(
                "SELECT username, MAX(export_timestamp) AS ts "
                "FROM pending_follow_requests "
                "WHERE source_label IN ('pending_follow_requests', 'both') "
                "GROUP BY username"
            ).fetchall()
        }
        # Last-seen-in-pending: for the Follow Request Rejected card,
        # the rejection happened sometime after this snapshot's
        # taken_at. Stored as ISO string from the snapshots table.
        last_pending_taken_at_home: dict[str, str | None] = {}
        for r in conn.execute(
            "SELECT pfr.username, MAX(s.taken_at) AS last_seen "
            "FROM pending_follow_requests pfr "
            "JOIN snapshots s ON s.id = pfr.snapshot_id "
            "WHERE pfr.source_label IN ('pending_follow_requests', 'both') "
            "GROUP BY pfr.username"
        ).fetchall():
            last_pending_taken_at_home[r["username"]] = r["last_seen"]
        # Sort each preview list by its relevant timestamp, newest
        # first, then take the top 50. Username fallback for users
        # without timestamps so they still appear (just at the bottom).
        def _by_ts_desc(users, ts_map):
            return sorted(users, key=lambda u: (-(ts_map.get(u) or 0), u))
        public_followed_back_preview = [
            {
                "username": u,
                "ts": followers_ts_home.get(u),
                "ts2": following_ts_home.get(u),
            }
            for u in _by_ts_desc(public_followed_back, followers_ts_home)[:50]
        ]
        private_accepted_preview = [
            {
                "username": u,
                "ts": pending_ts_home.get(u),
                "ts2": following_ts_home.get(u),
            }
            for u in _by_ts_desc(private_accepted_no_follow_back, pending_ts_home)[:50]
        ]
        request_dropped_preview = [
            {
                "username": u,
                "ts": pending_ts_home.get(u),
                # last-seen-in-pending is an ISO string (taken_at), not
                # an int — render as-is on the client.
                "ts2_iso": last_pending_taken_at_home.get(u),
            }
            for u in _by_ts_desc(request_rejected_home, pending_ts_home)[:50]
        ]

        # Inline preview of noted accounts so the home-page card can
        # show the actual usernames (and a note snippet) instead of
        # just a count. Cap at 50 entries to keep the JSON small;
        # the list view is the canonical full browser.
        noted_rows = conn.execute(
            "SELECT username, notes FROM profile_tags "
            "WHERE notes IS NOT NULL AND TRIM(notes) != '' "
            "ORDER BY updated_at DESC LIMIT 50"
        ).fetchall()
        noted_users = [
            {"username": r["username"], "note": r["notes"]}
            for r in noted_rows
        ]

        # Alert diff: compare current alert set to the set we cached
        # last time we saw a different snapshot. Anything new gets
        # is_new=True. Keys cleared since last time are returned as
        # `cleared` so the UI can show "X resolved since last export".
        # Cache stored as a JSON file at data/alerts_cache.json:
        # { snapshot_id: int, keys: [...this snapshot...], prev_keys: [...last snapshot...] }
        # Re-rendering the SAME snapshot reuses cached prev_keys (stable
        # diff). Importing a new snapshot rotates: current → prev_keys,
        # newly-computed → keys.
        alerts = alerts_mod.compute_alerts(conn)
        try:
            import json as _json
            from pathlib import Path as _Path
            cache_path = _Path("data/alerts_cache.json")
            cache = {}
            if cache_path.exists():
                try: cache = _json.loads(cache_path.read_text())
                except Exception: cache = {}
            curr_keys = set()
            for a in (alerts.get("stateful") or []) + (alerts.get("diff") or []):
                k = f"{a.get('kind')}:{a.get('username')}"
                curr_keys.add(k)
            if cache.get("snapshot_id") == latest:
                # Same snapshot re-render — stable diff against the
                # baseline captured when this snapshot first appeared.
                prev_keys = set(cache.get("prev_keys") or [])
            else:
                # New snapshot. The old `keys` becomes prev_keys; new
                # curr_keys becomes `keys`.
                prev_keys = set(cache.get("keys") or [])
                cache = {
                    "snapshot_id": latest,
                    "keys": sorted(curr_keys),
                    "prev_keys": sorted(prev_keys),
                }
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(_json.dumps(cache))
            # Annotate each current alert with is_new
            for a in (alerts.get("stateful") or []) + (alerts.get("diff") or []):
                k = f"{a.get('kind')}:{a.get('username')}"
                a["is_new"] = (k not in prev_keys)
            # Cleared count + sample
            cleared = prev_keys - curr_keys
            alerts["cleared_count"] = len(cleared)
            alerts["cleared_sample"] = sorted(cleared)[:10]
        except Exception as e:
            # Don't let diff failures break the home payload
            print(f"alerts diff failed: {e}")
        return {
            "summary": summary,
            "alerts": alerts,
            "bucket_counts": bucket_counts,
            "snapshot_count": len(snaps),
            "noted_users": noted_users,
            # Inline previews (capped) so the home cards can list the
            # actual usernames without a second round-trip. Full lists
            # live under /api/dashboard sections.
            "public_followed_back": public_followed_back_preview,
            "private_accepted_no_follow_back": private_accepted_preview,
            "request_dropped": request_dropped_preview,
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
    # Tag version is a dep now: the activity log filters out accounts
    # tagged unavailable/disabled/random_request, so a tag toggle should
    # invalidate the cached log.
    return _cached("activity_log", _activity_log_compute, deps=_DEPS_BOTH)


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
                # No bounce filter on the event log. The activity log is
                # an EVENT log — every transition where someone left
                # followers / following gets emitted, even if the next
                # snapshot has them flickering back to pending. Reasons:
                #   1. Matches the per-snapshot diff endpoint (which
                #      shows all unfollowers in 'They unfollowed you').
                #   2. The user can read the SURROUNDING entries to see
                #      if they re-requested (you_requested event) or if
                #      the account re-followed later (started_following
                #      event), so context is preserved.
                #   3. Filtering by "newly in pending this transition"
                #      hid 6 of 9 unfollowed_you events from snapshot
                #      #904 — exactly the cases the user was asking
                #      about, because they had re-requested those
                #      accounts in the same window.
                # The you_unfollowed / removed_you split still uses
                # recently_unfollowed (the ground truth for
                # user-initiated unfollows).
                for u in sorted(left_followers):
                    emit(events, "unfollowed_you", u, s.id, curr_ts)
                for u in sorted(left_following & curr_sd.recently_unfollowed):
                    emit(events, "you_unfollowed", u, s.id, curr_ts)
                for u in sorted(left_following - curr_sd.recently_unfollowed):
                    emit(events, "removed_you", u, s.id, curr_ts)

            prev_sd = curr_sd
            prev_id = s.id

        # Filter out events involving accounts the user has tagged as
        # ✕ unavailable, ⚠ disabled, or 🎲 random_request. The user has
        # already declared "this account is gone / spam," so surfacing
        # their inevitable unfollows / removals in the activity log is
        # noise that drowns out events from accounts the user actually
        # cares about.
        suppressed_users = {
            r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")
        } | {
            r["username"] for r in tags_mod.list_with_flag(conn, "disabled")
        } | {
            r["username"] for r in tags_mod.list_with_flag(conn, "random_request")
        }
        events = [e for e in events if e["username"] not in suppressed_users]

        # Self-unfollow filter for inbound events. If the user has ever
        # appeared in recently_unfollowed for this username, the user
        # was at some point the initiator of the breakup. Showing
        # 'unfollowed_you' or 'removed_you' for those accounts is
        # misleading — even when IG's recently_unfollowed window has
        # rolled over and the lag-based exclusion in the emit logic
        # missed them. ever_self captures the cumulative outbound log
        # so we can apply this filter retroactively.
        ever_self = q.ever_self_unfollowed(conn)
        INBOUND_KINDS = {"unfollowed_you", "removed_you"}
        events = [
            e for e in events
            if not (e["kind"] in INBOUND_KINDS and e["username"] in ever_self)
        ]

        # NOTE: previously this code applied a "came back" filter —
        # hiding unfollowed_you / removed_you events for accounts
        # currently back in followers / following. That was wrong for
        # an EVENT LOG. Per-snapshot diffs (the boxes at the top of
        # the History tab) showed the events correctly, but the
        # activity log feed below silently erased them, making it
        # look like only one person unfollowed when 9 actually did.
        # Came-back events are still visible IN CONTEXT — the user
        # can scroll the same timeline and see "started following
        # you" / "you accepted them" lines for the re-follow, which
        # tells them visually that the relationship was restored.

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
        # Pass ever_self_unfollowed so the diff distinguishes user-initiated
        # unfollows from "they removed you" — the recently_unfollowed log
        # has a 14-day window so without this, older self-unfollows look
        # like the other party removed you.
        ever_self = q.ever_self_unfollowed(conn)
        sections = diffs_mod.diff(
            q.snapshot_data(conn, old_id),
            q.snapshot_data(conn, new_id),
            ever_self_unfollowed=ever_self,
        )
        # Filter out users tagged as gone (unavailable / disabled / random):
        # they always show up in the unfollow / removal sections after the
        # user marks them, but the user has already declared "this account
        # is gone, stop bothering me about it."
        suppressed = (
            {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "random_request")}
        )
        # NOTE: previously this endpoint applied two extra filters that
        # we've now removed:
        #   1. A post-hoc ever_self subtraction on `they_unfollowed_you`.
        #      diffs.diff() now does the inbound split natively
        #      (you_removed_as_follower vs they_unfollowed_you), so the
        #      post-hoc filter would double-strip.
        #   2. A "came back" filter that hid any disappearance whose
        #      account is now in followers/following. That's appropriate
        #      for cumulative views (Lists, Home) but WRONG for the per-
        #      snapshot diff — if 6 followers left in a given transition
        #      and 5 came back later, the History view should still show
        #      "6 followers left this snapshot" and let the user see what
        #      actually happened in that moment. Hiding it because of
        #      future state was producing empty 'they unfollowed' / 'they
        #      removed' sections in History even though the snapshot
        #      header showed -6 followers.
        if suppressed:
            sections = {
                kind: [u for u in users if u not in suppressed]
                for kind, users in sections.items()
            }
        return {"old_snapshot_id": old_id, "new_snapshot_id": new_id, "sections": sections}


@app.get("/api/lists")
def get_lists(snapshot_id: int | None = None, kind: str | None = None):
    """Default snapshot_id uses a two-phase cache: the heavy snapshot-derived
    data (helpers, chronological maps, non-bucket rows) is cached on
    snapshot_version; the cheap tag overlay (bucket sections, tag flags,
    suppression filter, sort) runs every request.

    `kind` filter: when set, the response strips all sections except the
    requested one (and 'pill counts' kept for the UI's pill bar). Trims
    the response from ~18MB to typically <2MB and lets gzip cut it
    further. The compute itself isn't trimmed (the cumulative diff
    machinery is shared across all kinds), but skipping per-row
    enrichment + JSON encoding for unused sections is the main win."""
    if snapshot_id is None:
        pure = _cached("lists_pure", _lists_pure_compute_default, deps=_DEPS_SNAPSHOT_ONLY)
        full = _lists_apply_overlay(pure)
    else:
        full = _lists_compute(snapshot_id)

    if kind:
        return _filter_lists_response(full, kind)
    return full


def _filter_lists_response(resp: dict, kind: str) -> dict:
    """Strip everything except the requested kind from a /api/lists
    response. Keeps `sections` reduced to just `{kind: rows}`, and
    `sections_full` (used by the UI's intersection pill bar) reduced
    similarly. Pill-counts (per-kind length) are preserved as a
    lightweight `pill_counts` map so the UI can still render the
    visible-list-picker counts without the full payload."""
    sections = resp.get("sections") or {}
    sections_full = resp.get("sections_full") or {}
    pill_counts = {k: len(v) for k, v in sections.items()}
    pill_counts_full = {k: len(v) for k, v in sections_full.items()}
    return {
        "snapshot_id": resp.get("snapshot_id"),
        "previous_snapshot_id": resp.get("previous_snapshot_id"),
        "sections": {kind: sections.get(kind, [])},
        "sections_full": {kind: sections_full.get(kind, [])} if sections_full else {},
        "pill_counts": pill_counts,
        "pill_counts_full": pill_counts_full,
        "kind": kind,
    }


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
            for flag in ("favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request", "now_public", "need_archive"):
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

        # Per-transition pending / incoming sets — used inside the IG-
        # bounce filter so we only strip same-snapshot follower↔pending
        # flickers (the actual export quirk) and KEEP real past removals
        # where the user later re-requested the account. See the
        # matching block in _home_compute for the full reasoning.
        pending_by_sid: dict[int, set[str]] = {}
        for r in conn.execute(
            "SELECT snapshot_id, username FROM pending_follow_requests"
        ).fetchall():
            pending_by_sid.setdefault(int(r["snapshot_id"]), set()).add(r["username"])
        incoming_by_sid: dict[int, set[str]] = {}
        for r in conn.execute(
            "SELECT snapshot_id, username FROM incoming_follow_requests"
        ).fetchall():
            incoming_by_sid.setdefault(int(r["snapshot_id"]), set()).add(r["username"])

        # Anyone who was a follower at some snapshot and not in the next,
        # excluding same-transition flickers to incoming-requests.
        ever_unfollowed_you: set[str] = set()
        # Anyone who left your following at any transition, excluding
        # same-transition flickers to pending.
        ever_left_following: set[str] = set()

        for old_id, new_id in zip(ordered_sids[:-1], ordered_sids[1:]):
            old_followers = followers_by_sid.get(old_id, set())
            new_followers = followers_by_sid.get(new_id, set())
            old_following = following_by_sid.get(old_id, set())
            new_following = following_by_sid.get(new_id, set())
            old_pending = pending_by_sid.get(old_id, set())
            new_pending = pending_by_sid.get(new_id, set())
            old_incoming = incoming_by_sid.get(old_id, set())
            new_incoming = incoming_by_sid.get(new_id, set())
            # See the matching block in _home_compute for why the bounce
            # filter must use "newly pending/incoming" rather than the
            # raw new-snapshot set: stale pending rows persist alongside
            # follows (IG quirk), so subtracting `new_pending` directly
            # strips real removals where pending was already there.
            newly_pending = new_pending - old_pending
            newly_incoming = new_incoming - old_incoming
            ever_unfollowed_you |= (old_followers - new_followers) - newly_incoming
            ever_left_following |= (old_following - new_following) - newly_pending

        # Stricter rule for the cumulative "they removed you" set:
        # exclude anyone who EVER appeared in your recently_unfollowed at any snapshot.
        # This guards against Instagram's per-snapshot reporting lag (where a self-initiated
        # unfollow doesn't show up in recently_unfollowed until 1+ snapshots later).
        ever_self = q.ever_self_unfollowed(conn)
        # "Came back" filter: an account CURRENTLY in your following (or
        # followers) didn't remove you / didn't unfollow you — they had
        # a blip in some past export and reappeared. We do NOT subtract
        # the latest sd.pending / sd.incoming_requests here — that was
        # over-correcting and was hiding real removals where the user
        # later re-requested the account. Same-transition flickers (the
        # actual IG export quirk) are stripped per-transition above.
        ever_removed_you = ever_left_following - ever_self - sd.following
        # Capture the "raw" inbound set BEFORE the self-unfollow
        # exclusion, so we can split the population into:
        #   ever_unfollowed_you (strict): they unfollowed AND you didn't
        #     reciprocate — pure inbound action.
        #   mutual_breaks: both ends broke — they dropped from your
        #     followers AND you also unfollowed.
        # See the matching note in _home_compute. Came-back filter
        # (- sd.followers) deliberately removed: hiding events because
        # the account later returned was erasing real history.
        ever_unfollowed_you_inbound = ever_unfollowed_you - ever_self
        mutual_breaks = ever_unfollowed_you & ever_self

        # Also exclude usernames that are part of a detected rename chain whose CURRENT
        # alias is still in your following/followers — they didn't really leave.
        alias_map = q.username_alias_map(conn)
        def aliases_active(u: str, in_set: set[str]) -> bool:
            chain = alias_map.get(u)
            if not chain:
                return False
            return any(a in in_set for a in chain if a != u)

        ever_removed_you = {u for u in ever_removed_you if not aliases_active(u, sd.following)}
        ever_unfollowed_you_inbound = {u for u in ever_unfollowed_you_inbound if not aliases_active(u, sd.followers)}
        mutual_breaks = {u for u in mutual_breaks if not aliases_active(u, sd.followers)}

        # Split mutual breaks by who initiated. you_first = my unfollow
        # ts predates their last-as-follower snapshot (clear evidence I
        # acted first while they were still following). they_first =
        # everything else, which conservatively includes same-window
        # cases the snapshot cadence can't disambiguate.
        mb_you_first, mb_they_first = q.split_mutual_breaks_by_initiator(conn, mutual_breaks)
        sections["ever_unfollowed_you"] = sorted(ever_unfollowed_you_inbound)
        sections["mutual_break_you_first"] = sorted(mb_you_first)
        sections["mutual_break_they_first"] = sorted(mb_they_first)
        sections["ever_removed_you_as_follower"] = sorted(ever_removed_you)
        # Keep the original raw set name available for "still_follow_after_drop"
        # below — the user-still-follows logic should consider both pure
        # inbound unfollows AND mutual breaks (since the user re-following
        # someone post-mutual-break is still a "follow but no follow-back"
        # situation worth surfacing).
        ever_unfollowed_you = ever_unfollowed_you_inbound | mutual_breaks
        # Subset of ever_unfollowed_you that you still follow AND who aren't
        # currently following you back. Once they re-follow (mutual again),
        # they fall off this list — the unfollow event itself stays in the
        # activity log, which is what preserves the history.
        sections["still_follow_after_drop"] = sorted(
            (ever_unfollowed_you & sd.following) - sd.followers
        )

        # Cumulative "you unfollowed" — anyone who ever appeared in your recently_unfollowed.
        sections["you_unfollowed_ever"] = sorted(ever_self)

        # Public follow-backs and private accept-no-follow-back. Same
        # definitions as the home dashboard summary. The 'suppressed'
        # variable doesn't exist in this scope (it lives in
        # _activity_log_compute), so we recompute the suppress-set
        # locally — accounts the user has tagged disabled / unavailable
        # / random_request shouldn't pad these counts either.
        suppressed_lists = (
            {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "random_request")}
        )
        ever_pending_observed_lists = {
            r["username"] for r in conn.execute(
                "SELECT DISTINCT username FROM pending_follow_requests "
                "WHERE source_label IN ('pending_follow_requests', 'both')"
            ).fetchall()
        }
        relbreak_candidates_lists = (
            (sd.followers & sd.following)
            | ((sd.following - sd.followers) & ever_pending_observed_lists)
        ) - suppressed_lists
        rel_priv = q.privacy_status_bulk(conn, sorted(relbreak_candidates_lists))
        sections["public_followed_back"] = sorted(
            u for u in (sd.followers & sd.following) - suppressed_lists
            if rel_priv.get(u, "unknown") in ("public", "likely_public")
        )
        sections["private_accepted_no_follow_back"] = sorted(
            u for u in ((sd.following - sd.followers) & ever_pending_observed_lists) - suppressed_lists
            if rel_priv.get(u, "unknown") in ("private", "likely_private")
        )

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
        #
        # Extension-scrape override: anyone whose live follow button is
        # currently 'requested' is treated as still pending regardless
        # of whether they appear in the latest export.
        _ext_still_requested = {
            r["username"] for r in conn.execute(
                "SELECT username FROM profile_observations "
                "WHERE follow_button_state = 'requested'"
            ).fetchall()
        }
        sections["request_dropped"] = sorted(
            ever_pending_outgoing - ever_following_set - sd.pending - _ext_still_requested
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

        # Pending / incoming / unfollowed timestamps are pulled across ALL
        # snapshots, not just the current one. IG's export records the
        # original event time per row (request-sent / request-received /
        # unfollow), and that timestamp is stable across re-exports, so
        # MAX() is safe and gives us a non-null timestamp even after the
        # user disappears from the current snapshot's table.
        #
        # Without this, dropped requests (request_dropped list), rejected
        # incoming requests (incoming_request_dropped), and historical
        # unfollow events all rendered with no time at all once they
        # rolled out of the most recent export.
        pending_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, MAX(export_timestamp) AS ts "
            "FROM pending_follow_requests "
            "WHERE source_label IN ('pending_follow_requests', 'both') "
            "GROUP BY username"
        ).fetchall():
            pending_ts[r["username"]] = r["ts"]

        incoming_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, MAX(export_timestamp) AS ts "
            "FROM incoming_follow_requests GROUP BY username"
        ).fetchall():
            incoming_ts[r["username"]] = r["ts"]

        unfollowed_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, MAX(export_timestamp) AS ts "
            "FROM recently_unfollowed GROUP BY username"
        ).fetchall():
            unfollowed_ts[r["username"]] = r["ts"]

        # Historical exact-ts maps populated below, after the chrono sid maps
        # are computed (they need first_in_followers_sid etc. as input).
        first_followed_you_ts: dict[str, int | None] = {}
        last_followed_you_ts:  dict[str, int | None] = {}
        last_unfollowed_ts:    dict[str, int | None] = {}

        now = datetime.now(timezone.utc)

        # Snapshot id -> label/created_at/taken_at for resolving "when did <X>
        # happen". taken_at is the canonical chronological time (parsed from
        # the export's filename); created_at is when the import ran.
        snap_meta: dict[int, dict] = {}
        for s in q.list_snapshots(conn):
            snap_meta[s.id] = {"label": s.label, "created_at": s.created_at, "taken_at": s.taken_at}

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
            "public_mutuals",
            "all_following",
            "pending",
            "all_followers",
            "feeder_accounts",
        }
        BUCKET_KINDS = {"favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request", "now_public", "need_archive"}

        # Tag state — empty in pure mode so pre-built rows have tag fields = False;
        # overlay attaches the real values per request.
        flagged = {} if _pure_only else tags_mod.all_flagged_usernames(conn)

        # Set of usernames with at least one archived media file. Computed
        # once via a cheap directory scan rather than re-statting per row.
        # Used as a virtual tag (📦) on each row so the user can see at a
        # glance which accounts have local archive content.
        archived_users: set[str] = set()
        try:
            for d in _MEDIA_DIR.iterdir():
                if not d.is_dir():
                    continue
                # Cheap "any file?" check — break on first hit. Faster than
                # rglob+sum for accounts with hundreds of files.
                for f in d.rglob("*"):
                    if f.is_file():
                        archived_users.add(d.name)
                        break
        except OSError:
            pass

        reengaged = q.detect_reengagements(conn)

        # Privacy inference: union of every username that will appear in any section,
        # so each row can show a "likely private/public" hint. One bulk query, cached
        # for all build_row calls below.
        all_usernames: set[str] = set()
        for usernames in sections.values():
            all_usernames.update(usernames)
        privacy_map = q.privacy_status_bulk(conn, list(all_usernames))

        # Public mutuals — accounts that follow you, that you follow, AND
        # that are public (or you've manually flipped them to now_public).
        # Useful as a separate browse view from the all-mutuals list since
        # public follow-backs are the ones you can act on without going
        # through a request gate.
        now_public_set = {
            u for u, flags in flagged.items() if flags.get("now_public")
        }
        sections["public_mutuals"] = sorted(
            u for u in mutual_set
            if privacy_map.get(u) == "likely_public" or u in now_public_set
        )

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
            "mutual_break_you_first",
            "mutual_break_they_first",
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
                # Three distinct waiting states:
                #  - in_pend         → request you sent hasn't been accepted yet
                #  - in_fol, not in_back → they accepted (or it's public); they
                #                          haven't followed you back yet
                #  - in_back          → mutual, success
                #  - none of above    → you no longer follow them (withdrew or unfollowed)
                if in_pend:
                    return ("request pending", "pending")
                if in_back:
                    return ("now follows back ✓", "good")
                if in_fol:
                    return ("no follow back yet", "pending")
                return ("you've unfollowed", "stopped")
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
                "need_archive": flagged.get(u, {}).get("need_archive", False),
                # Virtual flag computed from filesystem (data/media/<u>/).
                # Surfaced as a 📦 pill on the row.
                "has_archive": u in archived_users,
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
            # "Last followed you" semantics: the snapshot we LAST observed
            # them as a follower. The unfollow itself happened sometime
            # between this snapshot's taken_at and the next one's. Use the
            # snapshot's taken_at (chronological time) as the timestamp —
            # NOT the per-row export_timestamp, which is when they originally
            # started following you (a fact IG persists across every snapshot
            # they remain a follower in, so it never changes).
            #
            # Separately, expose `started_following_you_ts` so the row can
            # still show the precise moment they began following — that fact
            # is meaningful and accurate.
            def _last_seen_follower_dt(sid: int):
                meta = snap_meta.get(sid, {})
                ta = meta.get("taken_at")
                if ta:
                    try:
                        return datetime.fromisoformat(ta.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                return parse_label_date(meta.get("label"))

            if kind == "not_following_you_back":
                last_sid = last_followers_sid.get(u)
                if last_sid is None:
                    row["ever_followed_you"] = False
                    row["last_followed_you_at"] = None
                    row["last_followed_you_days_ago"] = None
                else:
                    d = _last_seen_follower_dt(last_sid)
                    row["ever_followed_you"] = True
                    if d:
                        if d.tzinfo is None:
                            d = d.replace(tzinfo=timezone.utc)
                        row["last_followed_you_at"] = d.date().isoformat()
                        row["last_followed_you_days_ago"] = (now - d).days
                        row["last_followed_you_ts"] = int(d.timestamp())
                    row["last_followed_you_snapshot_id"] = last_sid
                    started_ts = last_followed_you_ts.get(u)
                    if started_ts:
                        row["started_following_you_ts"] = started_ts

            # History-list dates: populate the chronological field that's actually
            # meaningful for the row's list, so the sort dropdown does the right
            # thing instead of falling back to alphabetical.
            if kind in LAST_FOLLOWED_YOU_KINDS and "last_followed_you_at" not in row:
                last_sid = last_in_followers_sid.get(u)
                if last_sid is not None:
                    d = _last_seen_follower_dt(last_sid)
                    if d:
                        if d.tzinfo is None:
                            d = d.replace(tzinfo=timezone.utc)
                        row["last_followed_you_at"] = d.date().isoformat()
                        row["last_followed_you_days_ago"] = (now - d).days
                        row["last_followed_you_ts"] = int(d.timestamp())
                    started_ts = last_followed_you_ts.get(u)
                    if started_ts:
                        row["started_following_you_ts"] = started_ts
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
                    "archived_users": frozenset(archived_users),
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


_TAG_FLAGS = ("favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request", "now_public", "need_archive")
_BUCKET_KINDS_SET = {"favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request", "now_public", "need_archive"}
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
        # Three distinct waiting states (mirrors the bucket_status helper above).
        if in_pend:
            bs = ("request pending", "pending")
        elif in_back:
            bs = ("now follows back ✓", "good")
        elif in_fol:
            bs = ("no follow back yet", "pending")
        else:
            bs = ("you've unfollowed", "stopped")
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
        "has_archive": u in ctx["archived_users"],
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
        # Free-form per-account notes. Lives outside the lists_pure
        # cache so editing a note shows up immediately. Empty/whitespace
        # notes are stored as NULL and excluded.
        notes_map: dict[str, str] = {
            r["username"]: r["notes"]
            for r in conn.execute(
                "SELECT username, notes FROM profile_tags "
                "WHERE notes IS NOT NULL AND TRIM(notes) != ''"
            ).fetchall()
        }
        # Set of usernames the extension confirmed are private (saw the
        # banner on the IG page). Cheap query; ~one row per profile the
        # user has visited. Used to upgrade rows from "likely private" →
        # "private" in the lists + modal display.
        confirmed_private = {
            r["username"]
            for r in conn.execute(
                "SELECT username FROM profile_observations WHERE is_private = 1"
            ).fetchall()
        }
        # Set of usernames the extension confirmed are unavailable (saw the
        # "Sorry, this page isn't available" banner). Authoritative current
        # state — overrides the bucket-status logic that would otherwise say
        # "PAGE BACK" just because the user is still in the latest snapshot's
        # following list (IG keeps deactivated accounts there for ages).
        confirmed_unavailable = {
            r["username"]
            for r in conn.execute(
                "SELECT username FROM profile_observations WHERE is_unavailable = 1"
            ).fetchall()
        }
        # Pending requests confirmed by the extension's button-state observer
        # but not yet reflected in any export. We surface these in the
        # "pending" section so the count + list update instantly when the
        # user clicks Follow on a private account.
        ext_pending_usernames = {
            r["username"]
            for r in conn.execute(
                "SELECT username FROM profile_observations "
                "WHERE follow_button_state = 'requested'"
            ).fetchall()
        }
        # Same for "following" — public account follow not yet in export.
        ext_following_usernames = {
            r["username"]
            for r in conn.execute(
                "SELECT username FROM profile_observations "
                "WHERE follow_button_state = 'following'"
            ).fetchall()
        }
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
            if u in confirmed_private:
                row["privacy_confirmed_private"] = True
            if u in notes_map:
                row["note"] = notes_map[u]
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
        for r in bucket_rows:
            if r["username"] in confirmed_private:
                r["privacy_confirmed_private"] = True
            if r["username"] in notes_map:
                r["note"] = notes_map[r["username"]]
        annotated[flag] = bucket_rows
        sections_full[flag] = bucket_rows
    # Has-notes list — every account with a saved note. Sourced from
    # notes_map directly so unfollowed / disabled / unavailable accounts
    # all stay visible. Reuses _build_bucket_row (an unknown kind gets
    # an empty bucket_status, which is what we want).
    noted_usernames = sorted(notes_map.keys())
    noted_rows = [_build_bucket_row(ctx, flagged, u, "with_notes") for u in noted_usernames]
    for r in noted_rows:
        if r["username"] in confirmed_private:
            r["privacy_confirmed_private"] = True
        r["note"] = notes_map[r["username"]]
    annotated["with_notes"] = noted_rows
    sections_full["with_notes"] = noted_rows
    # NFB sort.
    if "not_following_you_back" in annotated:
        def nfb_key(r):
            if not r.get("ever_followed_you"):
                return (1, r["username"])
            days = r.get("last_followed_you_days_ago")
            return (0, days if days is not None else 1_000_000, r["username"])
        annotated["not_following_you_back"].sort(key=nfb_key)

    # Bucket-status override: if the extension confirmed an account is
    # unavailable / disabled (page-not-found banner), trust that over the
    # snapshot-derived "PAGE BACK" / "BACK ONLINE" alarm. The snapshot may
    # still show them in your following because IG keeps deactivated
    # accounts there indefinitely, but the live page check is authoritative.
    for bk in ("unavailable", "disabled"):
        for r in annotated.get(bk, []):
            if r["username"] in confirmed_unavailable:
                r["bucket_status"] = "still gone (extension confirms)"
                r["bucket_status_kind"] = "good"

    # Extension-confirmed pending requests not yet reflected in any export.
    # Append minimal rows to the "pending" section so the count + list
    # update instantly when the user clicks Follow on a private account.
    # These get auto-removed on the next export when the snapshot catches up
    # (the username will then be in the regular pending set).
    sd_pending_set = set(pure["ctx"]["sd_pending"])
    sd_following_set = set(pure["ctx"]["sd_following"])
    new_pending = ext_pending_usernames - sd_pending_set - sd_following_set - suppressed
    if new_pending:
        existing_pending = {r["username"] for r in annotated.get("pending", [])}
        for u in sorted(new_pending - existing_pending):
            user_flags = flagged.get(u, {})
            row = {
                "username": u,
                "currently_following": False,
                "currently_follower": False,
                "currently_pending": True,
                "currently_incoming_request": False,
                "relationship": "request pending",
                "relationship_kind": "info",
                "pending_via_extension": True,
            }
            for f in _TAG_FLAGS:
                row[f] = user_flags.get(f, False)
            if u in confirmed_private:
                row["privacy_confirmed_private"] = True
            annotated.setdefault("pending", []).append(row)
        # Re-sort pending: most-recently-requested first (extension-confirmed
        # ones go to the top since they have no pending_since_at to sort by).
        annotated["pending"].sort(
            key=lambda r: (
                0 if r.get("pending_via_extension") else 1,
                -(r.get("pending_ts") or 0),
                r["username"],
            )
        )

    new_following = ext_following_usernames - sd_following_set - suppressed
    if new_following:
        existing_all_fol = {r["username"] for r in annotated.get("all_following", [])}
        existing_nfb = {r["username"] for r in annotated.get("not_following_you_back", [])}
        # Mirror current_lists' definition of nfb: following \ followers \
        # incoming_requests. An account that's currently requesting to
        # follow you back is "requesting to follow back," not "doesn't
        # follow back," and shouldn't show up in the nfb list.
        sd_incoming_set = set(pure["ctx"]["sd_incoming_requests"])
        for u in sorted(new_following - existing_all_fol):
            user_flags = flagged.get(u, {})
            row = {
                "username": u,
                "currently_following": True,
                "currently_follower": False,
                "currently_pending": False,
                "currently_incoming_request": False,
                "relationship": "doesn't follow back",
                "relationship_kind": "warn",
                "following_via_extension": True,
            }
            for f in _TAG_FLAGS:
                row[f] = user_flags.get(f, False)
            if u in confirmed_private:
                row["privacy_confirmed_private"] = True
            annotated.setdefault("all_following", []).append(row)
            # Extension-bridged follows aren't in s.followers (we never know
            # whether they follow back from a profile visit), so by the
            # current_lists definition they belong in not_following_you_back
            # too. Skip if they're in incoming_requests — that case is
            # "requesting to follow back," not "doesn't follow back."
            # Without this, the per-list counts diverge from the
            # all_following total — bug surfaced as "Mutuals + Don't follow
            # back ≠ All following".
            if u not in existing_nfb and u not in sd_incoming_set:
                annotated.setdefault("not_following_you_back", []).append(dict(row))

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

# Hot TTL cache for the per-account lookup endpoint. The general
# _cached() machinery invalidates on snapshot version bump, which
# happens every 15–30 min when a new export lands. With multiple
# tabs / runner profiles all calling /api/lookup post-bump, that
# cliff is exactly when concurrency was hurting. A 30-second hot
# overlay smooths that out: stale-by-30s is fine for the overlay's
# "ever followed you" history, and it caps the post-bump stampede.
import time as _time
_LOOKUP_HOT: dict[str, tuple[float, dict]] = {}
_LOOKUP_HOT_TTL_S = 30.0
_LOOKUP_HOT_MAX = 500


@app.get("/api/lookup")
def lookup(account: str):
    username, profile_url = normalize_account_input(account)
    now = _time.monotonic()
    hot = _LOOKUP_HOT.get(username)
    if hot is not None and (now - hot[0]) < _LOOKUP_HOT_TTL_S:
        return hot[1]
    result = _cached(f"lookup:{username}", lambda: _lookup_compute(username, profile_url))
    if len(_LOOKUP_HOT) >= _LOOKUP_HOT_MAX:
        # Evict the oldest entry (insertion order preserved by dict).
        try:
            _LOOKUP_HOT.pop(next(iter(_LOOKUP_HOT)))
        except StopIteration:
            pass
    _LOOKUP_HOT[username] = (now, result)
    return result


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

        # Latest extension-captured profile observation (counts, bio,
        # verified, etc.). Returned alongside the snapshot data so the UI
        # can render live profile facts without re-visiting the IG page.
        obs_row = conn.execute(
            "SELECT observed_at, display_name, bio, external_link, "
            "follower_count, following_count, post_count, verified, "
            "is_private, profile_pic_url, follow_button_state, "
            "follow_state_changed_at, is_unavailable "
            "FROM profile_observations WHERE username = ?",
            (username,),
        ).fetchone()
        observation = None
        if obs_row is not None:
            observation = {k: obs_row[k] for k in obs_row.keys()}
            observation["verified"] = bool(observation.get("verified"))
            ip = observation.get("is_private")
            observation["is_private"] = (
                None if ip is None else bool(ip)
            )
            iu = observation.get("is_unavailable")
            observation["is_unavailable"] = (
                None if iu is None else bool(iu)
            )

        # Bridge the gap between extension observation and next export:
        # if the extension confirmed the user just clicked Follow on a
        # private account (button_state="requested") and the snapshot
        # doesn't yet reflect it, treat them as pending. Same for
        # following — public account follow that hasn't been exported yet.
        # Cleared automatically when the next export refreshes the
        # snapshot OR when the extension observes a state revert.
        pending_via_extension = following_via_extension = False
        if observation is not None:
            obs_btn = observation.get("follow_button_state")
            if obs_btn == "requested" and not currently_pending and not currently_following:
                currently_pending = True
                pending_via_extension = True
            elif obs_btn == "following" and not currently_following:
                currently_following = True
                following_via_extension = True

        # Archived-media presence — fast scan of data/media/<user>/.
        # Cheap (one stat + one rglob); the result lets the extension
        # overlay show a "📦 N items archived" line so the user knows
        # they've already saved this account before. Counts files
        # recursively so post_<id>/slide<N>.jpg etc. all roll up.
        archived_count = 0
        archived_bytes = 0
        try:
            mdir = _MEDIA_DIR / username
            if mdir.is_dir():
                for p in mdir.rglob("*"):
                    if p.is_file():
                        archived_count += 1
                        try:
                            archived_bytes += p.stat().st_size
                        except OSError:
                            pass
        except OSError:
            pass

        current_state = {
            "currently_following": currently_following,
            "currently_follower": currently_follower,
            "currently_pending": currently_pending,
            "currently_incoming_request": currently_incoming,
            "pending_via_extension": pending_via_extension,
            "following_via_extension": following_via_extension,
            "observation": observation,
            "archived_media_count": archived_count,
            "archived_media_bytes": archived_bytes,
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

def _parse_count(s):
    """Parse IG's count format ("1,234", "5.5K", "1.2M") into an integer.
    Returns None on unparseable input — callers store NULL in that case."""
    if s is None:
        return None
    try:
        s = str(s).strip().replace(",", "").replace(" ", "")
        if not s:
            return None
        mult = 1
        if s[-1].upper() in "KMB":
            mult = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[s[-1].upper()]
            s = s[:-1]
        return int(round(float(s) * mult))
    except (ValueError, TypeError):
        return None


@app.post("/api/profile-observation")
def profile_observation(payload: dict = Body(...)):
    """Upsert a profile observation captured by the browser extension as the
    user browses Instagram. Each call overwrites the previous observation
    for that username — current state only, no history (the user can rely
    on visiting the profile again if they want a refresh)."""
    username = (payload.get("username") or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="Need 'username'.")
    from datetime import datetime, timezone
    # Live follow-button state observed in the extension. One of:
    # not_following / requested / following / follow_back_available / null.
    button_state = payload.get("follow_button_state") or None
    # is_unavailable: extension confirmed "Sorry, this page isn't available"
    # at observation time. Overrides the bucket-status logic which would
    # otherwise say "PAGE BACK" purely because the user is still in the
    # latest snapshot's following set (IG keeps deactivated accounts in
    # following.json for ages).
    is_unavailable = (
        1 if payload.get("is_unavailable") is True
        else (0 if payload.get("is_unavailable") is False else None)
    )
    fields = {
        "username": username,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "display_name":     (payload.get("display_name") or None),
        "bio":              (payload.get("bio") or None),
        "external_link":    (payload.get("external_link") or None),
        "follower_count":   _parse_count(payload.get("followers")),
        "following_count":  _parse_count(payload.get("following")),
        "post_count":       _parse_count(payload.get("posts")),
        "verified":         1 if payload.get("verified") else 0,
        "is_private":       (1 if payload.get("is_private") is True
                              else (0 if payload.get("is_private") is False else None)),
        "profile_pic_url":  (payload.get("profile_pic") or None),
        "follow_button_state": button_state,
        "follow_state_changed_at": (
            datetime.now(timezone.utc).isoformat() if payload.get("button_state_changed") else None
        ),
        "is_unavailable": is_unavailable,
    }
    with db_conn() as conn:
        conn.execute(
            """
            INSERT INTO profile_observations (
                username, observed_at, display_name, bio, external_link,
                follower_count, following_count, post_count, verified,
                is_private, profile_pic_url, follow_button_state,
                follow_state_changed_at, is_unavailable
            ) VALUES (
                :username, :observed_at, :display_name, :bio, :external_link,
                :follower_count, :following_count, :post_count, :verified,
                :is_private, :profile_pic_url, :follow_button_state,
                :follow_state_changed_at, :is_unavailable
            )
            ON CONFLICT(username) DO UPDATE SET
                observed_at      = excluded.observed_at,
                display_name     = COALESCE(excluded.display_name, display_name),
                bio              = COALESCE(excluded.bio, bio),
                external_link    = COALESCE(excluded.external_link, external_link),
                follower_count   = COALESCE(excluded.follower_count, follower_count),
                following_count  = COALESCE(excluded.following_count, following_count),
                post_count       = COALESCE(excluded.post_count, post_count),
                verified         = excluded.verified,
                is_private       = COALESCE(excluded.is_private, is_private),
                profile_pic_url  = COALESCE(excluded.profile_pic_url, profile_pic_url),
                follow_button_state = COALESCE(excluded.follow_button_state, follow_button_state),
                follow_state_changed_at = COALESCE(excluded.follow_state_changed_at, follow_state_changed_at),
                is_unavailable   = COALESCE(excluded.is_unavailable, is_unavailable)
            """,
            fields,
        )
        conn.commit()
    # Bumping the tag version is the cheapest way to invalidate the lookup
    # cache so the next /api/lookup for this username picks up fresh data.
    _bump_tag_version()
    return {"ok": True}


_PROFILE_PICS_DIR = DB_PATH.parent / "profile_pics"


def _profile_pic_path(username: str) -> Path:
    """Sanitized filesystem path for a username's locally stored profile pic.
    IG usernames are alnum + . + _ (1-30 chars) so no escaping is required,
    but we still defensively reject anything else to keep the path scoped
    inside data/profile_pics/."""
    import re
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", username or ""):
        raise HTTPException(status_code=400, detail="Invalid username for path.")
    _PROFILE_PICS_DIR.mkdir(parents=True, exist_ok=True)
    return _PROFILE_PICS_DIR / f"{username}.jpg"


@app.post("/api/profile-pic-bytes")
def store_profile_pic(payload: dict = Body(...)):
    """Receive base64-encoded profile picture bytes from the extension and
    save them to data/profile_pics/<username>.jpg. The IG CDN URL has a
    short-lived signed token, so the URL we previously stored expires
    after a few hours — local storage gives the modal/overlay a stable
    image source for past observations.

    Skips the write if the existing file is newer than 24 hours old
    (mtime check) to avoid re-downloading on every page visit."""
    import base64, time
    username = (payload.get("username") or "").strip()
    bytes_b64 = payload.get("bytes_b64")
    if not username or not bytes_b64:
        raise HTTPException(status_code=400, detail="Need 'username' and 'bytes_b64'.")
    path = _profile_pic_path(username)
    # 24h freshness skip — same picture probably hasn't changed.
    if path.exists() and (time.time() - path.stat().st_mtime) < 86400:
        return {"ok": True, "skipped": "fresh"}
    try:
        data = base64.b64decode(bytes_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64.")
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (>5MB).")
    path.write_bytes(data)
    return {"ok": True, "size": len(data)}


@app.get("/api/profile-pic/{username}")
def get_profile_pic(username: str):
    """Serve the locally-stored profile picture for `username`. Cache-
    Controls allow the browser to reuse the response for an hour, since
    the file path is stable for a given username."""
    path = _profile_pic_path(username)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No local pic for this user.")
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})


# ---------- generic media archive (posts / reels / stories) ----------

_MEDIA_DIR = DB_PATH.parent / "media"


@app.post("/api/archive-complete")
def archive_complete(payload: dict = Body(...)):
    """Content script signals that archiveAllVisiblePosts ran to
    completion for this account. We write a `.archive_complete`
    marker file inside data/media/<username>/. The queue endpoint
    requires this marker to consider an account 'done' — partial
    archives (folder has files but no marker, e.g. extension was
    reloaded mid-run) get re-queued automatically."""
    import re as _re
    username = (payload.get("username") or "").strip()
    if not _re.fullmatch(r"[A-Za-z0-9._]{1,30}", username):
        raise HTTPException(status_code=400, detail="Invalid username.")
    user_dir = _MEDIA_DIR / username
    if not user_dir.exists():
        raise HTTPException(status_code=400, detail="No archive folder for this username.")
    marker = user_dir / ".archive_complete"
    marker.write_text(str(__import__("time").time()), encoding="utf-8")
    return {"ok": True, "marker": str(marker)}


@app.get("/api/archive-queue")
def archive_queue():
    """Usernames the auto-archive runner should process. Defined as:

      (need_archive ∪ favorites) - {accounts with a non-empty media folder}
                                 - {accounts tagged unavailable / disabled}

    `need_archive` is the manual-queue signal — user toggled this flag
    via the overlay or the popup's "Add to queue" field, which overrides
    the favorite-only default. Within the queue, manually-added accounts
    come FIRST (higher priority), then favorites by added_at.

    The "non-empty media folder" rule lets the user skip an account by
    deleting its media/<u>/ directory but keeping the (empty) folder
    around — that's our "I intentionally cleared this, don't refetch"
    signal. A truly missing folder means we never archived → process.
    """
    with db_conn() as conn:
        manual = tags_mod.list_with_flag(conn, "need_archive")
        favs = tags_mod.list_with_flag(conn, "favorite")
        skip_tagged = (
            {r["username"] for r in tags_mod.list_with_flag(conn, "unavailable")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "disabled")}
            | {r["username"] for r in tags_mod.list_with_flag(conn, "archive_skip")}
        )

    seen = set()
    combined: list[tuple[str, str | None, bool]] = []  # (username, added_at, is_manual)
    for r in manual:
        if r["username"] in seen:
            continue
        seen.add(r["username"])
        combined.append((r["username"], r.get("need_archive_added_at"), True))
    # Manual entries first (oldest add first), then favorites (oldest first).
    combined.sort(key=lambda x: x[1] or "")
    fav_entries = []
    for r in favs:
        if r["username"] in seen:
            continue
        seen.add(r["username"])
        fav_entries.append((r["username"], r.get("favorite_added_at"), False))
    fav_entries.sort(key=lambda x: x[1] or "")
    combined.extend(fav_entries)

    queue: list[str] = []
    queue_manual: list[str] = []
    skipped_already_archived = 0
    skipped_user_cleared = 0
    skipped_tagged = 0
    for username, _added_at, is_manual in combined:
        if username in skip_tagged:
            skipped_tagged += 1
            continue
        user_dir = _MEDIA_DIR / username
        if user_dir.exists():
            try:
                file_count = sum(1 for f in user_dir.rglob("*") if f.is_file() and f.name != ".archive_complete")
            except OSError:
                file_count = 0
            marker_exists = (user_dir / ".archive_complete").exists()
            if file_count > 0 and marker_exists:
                # Has files AND completion marker = fully archived. Skip.
                skipped_already_archived += 1
                continue
            elif file_count > 0 and not marker_exists:
                # Has files but no marker = partial archive (interrupted
                # by extension reload, lid sleep, etc.). Re-queue so the
                # runner finishes it. Idempotent media-bytes save means
                # already-downloaded posts don't re-download.
                queue.append(username)
                if is_manual:
                    queue_manual.append(username)
                continue
            else:
                # Folder exists with 0 files (excluding marker) =
                # user wiped on purpose.
                skipped_user_cleared += 1
                continue
        queue.append(username)
        if is_manual:
            queue_manual.append(username)

    return {
        "queue": queue,
        "manual_in_queue": queue_manual,
        "stats": {
            "queue_size": len(queue),
            "manual_in_queue": len(queue_manual),
            "skipped_already_archived": skipped_already_archived,
            "skipped_user_cleared": skipped_user_cleared,
            "skipped_tagged": skipped_tagged,
            "favorite_total": len(fav_entries),
            "manual_total": len(manual),
        },
    }


def _media_path(username: str, media_id: str, ext: str) -> Path:
    """Sanitized path for an archived media file under
    data/media/<username>/<media_id>.<ext>. The media id may now
    include forward-slashes so callers can group slides into a
    sub-folder per post (e.g. `post_<id>/slide1`, which lands at
    data/media/<user>/post_<id>/slide1.jpg). We still reject any
    `..` segment and characters outside [A-Za-z0-9_-/] so the
    resolved path can't escape the media dir."""
    import re
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", username or ""):
        raise HTTPException(status_code=400, detail="Invalid username.")
    if not re.fullmatch(r"[A-Za-z0-9_\-/]{1,120}", media_id or ""):
        raise HTTPException(status_code=400, detail="Invalid media id.")
    # Reject path-traversal patterns explicitly even though the regex
    # already excludes `.` — belt-and-braces.
    parts = media_id.split("/")
    if any(p in ("", "..", ".") for p in parts):
        raise HTTPException(status_code=400, detail="Invalid media id (segment).")
    if ext not in ("jpg", "png", "mp4", "webp"):
        raise HTTPException(status_code=400, detail="Unsupported ext.")
    user_dir = _MEDIA_DIR / username
    target = user_dir / f"{media_id}.{ext}"
    # Ensure the parent of the target is inside user_dir (resolve
    # symlinks etc.) before returning. mkdir creates intermediate
    # folders so nested groups Just Work.
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


@app.post("/api/media-bytes")
def store_media(payload: dict = Body(...)):
    """Receive base64-encoded media bytes from the extension and save
    them under data/media/<username>/<media_id>.<ext>. Idempotent —
    if the file already exists, returns ok without rewriting (so
    content scripts can call this every page view without disk
    churn). Hard-caps individual files at 25 MB to avoid runaway
    storage from a malformed request."""
    import base64
    username = (payload.get("username") or "").strip()
    media_id = (payload.get("media_id") or "").strip()
    ext      = (payload.get("ext") or "jpg").strip().lower()
    bytes_b64 = payload.get("bytes_b64")
    if not username or not media_id or not bytes_b64:
        raise HTTPException(status_code=400, detail="Need username, media_id, bytes_b64.")
    path = _media_path(username, media_id, ext)
    if path.exists():
        return {"ok": True, "skipped": "exists", "path": str(path.relative_to(DB_PATH.parent))}
    try:
        data = base64.b64decode(bytes_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64.")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Media too large (>25MB).")
    path.write_bytes(data)
    return {"ok": True, "size": len(data), "path": str(path.relative_to(DB_PATH.parent))}


@app.get("/api/media/{username}/{media_id:path}.{ext}")
def get_media(username: str, media_id: str, ext: str):
    """Serve a previously-archived media file. Browser-cacheable for an
    hour since the file path encodes both the user and the media id."""
    path = _media_path(username, media_id, ext)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media not archived.")
    media_type = {
        "jpg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "mp4": "video/mp4",
    }.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=media_type,
                        headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/media-summary")
def media_summary():
    """Top-level summary of the local media archive: per-user counts +
    sizes. Used by the home view's 'Archived media' tile so the user
    can see at a glance how much they've stored and click in to browse
    a specific account's archive."""
    if not _MEDIA_DIR.is_dir():
        return {"users": [], "total_items": 0, "total_bytes": 0}
    users = []
    total_items = 0
    total_bytes = 0
    for d in sorted(_MEDIA_DIR.iterdir()):
        if not d.is_dir():
            continue
        # Walk recursively — new layout nests slides under
        # `post_<id>/`, `highlight_<albumid>/`, etc. The previous
        # non-recursive scan missed all post-folder slides and
        # caused the home-page card to show "0 items" for users
        # who only have the new-format archives.
        files = [p for p in d.rglob("*") if p.is_file()]
        if not files:
            continue
        stats = [p.stat() for p in files]
        size = sum(s.st_size for s in stats)
        latest = max(s.st_mtime for s in stats)
        users.append({
            "username": d.name,
            "count": len(files),
            "bytes": size,
            "latest_mtime": latest,
        })
        total_items += len(files)
        total_bytes += size
    # Sort by most-recent activity so the home card surfaces the
    # accounts you just archived at the top. Falls back to count for
    # ties (none are likely, but keeps the order deterministic).
    users.sort(key=lambda u: (-u["latest_mtime"], -u["count"]))
    return {"users": users, "total_items": total_items, "total_bytes": total_bytes}


@app.get("/api/media-overview")
def media_overview():
    """Enriched per-user archive listing for the master /archive page.
    For each user returns count, bytes, group breakdown (posts vs
    highlights vs reels), and a small preview list (4 most-recent
    items with their served URLs) so the overview page can render
    each account as a thumbnail card without a second round-trip."""
    if not _MEDIA_DIR.is_dir():
        return {"users": [], "total_items": 0, "total_bytes": 0, "total_groups": 0}
    users = []
    total_items = 0
    total_bytes = 0
    total_groups = 0
    for d in sorted(_MEDIA_DIR.iterdir()):
        if not d.is_dir():
            continue
        files = [p for p in d.rglob("*") if p.is_file()]
        if not files:
            continue
        # Sort newest-first by mtime so the preview shows the most
        # recently archived items.
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        size = sum(p.stat().st_size for p in files)
        kinds = {}  # "post" | "reel" | "highlight" | "story" | "other" → count
        groups = set()
        preview = []
        for p in files:
            rel = p.relative_to(d)
            stem_parts = rel.with_suffix("").parts
            top = stem_parts[0] if stem_parts else ""
            kind = "other"
            if top.startswith("post_"):       kind = "post"
            elif top.startswith("reel_"):     kind = "reel"
            elif top.startswith("highlight_"):kind = "highlight"
            elif top.startswith("story_"):    kind = "story"
            kinds[kind] = kinds.get(kind, 0) + 1
            if len(stem_parts) > 1:
                groups.add(top)
            if len(preview) < 4:
                stem = "/".join(stem_parts)
                ext = p.suffix.lstrip(".")
                preview.append({
                    "media_id": stem,
                    "ext": ext,
                    "url": f"/api/media/{d.name}/{stem}.{ext}",
                })
        users.append({
            "username": d.name,
            "count": len(files),
            "bytes": size,
            "kinds": kinds,
            "groups": len(groups),
            "preview": preview,
            # files is already sorted newest-first; index 0's mtime is
            # the most recent archive activity for this account. Lets
            # the overview page offer a "Recently archived" sort.
            "latest_mtime": files[0].stat().st_mtime,
            "earliest_mtime": files[-1].stat().st_mtime,
        })
        total_items += len(files)
        total_bytes += size
        total_groups += len(groups)
    users.sort(key=lambda u: -u["count"])
    return {
        "users": users,
        "total_items": total_items,
        "total_bytes": total_bytes,
        "total_groups": total_groups,
    }


@app.delete("/api/media/{username}/{media_id:path}.{ext}")
def delete_media(username: str, media_id: str, ext: str):
    """Delete a previously-archived media file. Reuses _media_path for
    the same path-traversal protection as the GET endpoint — the
    username + media_id + ext are validated by the regex inside that
    helper, so we can't be tricked into deleting outside data/media/."""
    path = _media_path(username, media_id, ext)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media not archived.")
    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Couldn't delete: {e}")
    # If this was the last file in the user's folder, remove the empty
    # dir so the home-page archive card doesn't keep showing a stale
    # zero-count entry.
    parent = path.parent
    try:
        if parent != _MEDIA_DIR and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    return {"ok": True, "deleted": f"{username}/{media_id}.{ext}"}


@app.get("/api/media-list/{username}")
def list_media(username: str):
    """List all archived media filenames for a username. Used by the
    tracker UI's per-account modal to show 'X archived posts' with
    direct links back to the served files."""
    import re
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", username or ""):
        raise HTTPException(status_code=400, detail="Invalid username.")
    d = _MEDIA_DIR / username
    if not d.is_dir():
        return {"username": username, "items": []}
    items = []
    # Walk recursively so the new folder structure
    # (data/media/<user>/post_<id>/slide1.jpg, etc.) shows up too.
    # Each item carries:
    #   media_id — the relative path stem (e.g. "post_<id>/slide1")
    #   group    — the parent folder name (or "" for legacy flat files),
    #              used by the modal UI to bucket thumbnails by source
    for p in sorted(d.rglob("*"), key=lambda x: x.stat().st_mtime if x.is_file() else 0, reverse=True):
        if not p.is_file():
            continue
        rel = p.relative_to(d)
        stem_parts = rel.with_suffix("").parts
        stem = "/".join(stem_parts)
        ext = p.suffix.lstrip(".")
        # Group = first folder segment, or "" for top-level files.
        group = stem_parts[0] if len(stem_parts) > 1 else ""
        items.append({
            "media_id": stem,
            "group": group,
            "ext": ext,
            # Use a forward-slash URL even on Windows; FastAPI's path
            # converter for {media_id} accepts slashes via :path.
            "url": f"/api/media/{username}/{stem}.{ext}",
            "size": p.stat().st_size,
        })
    return {"username": username, "items": items}


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


@app.get("/api/note/{username}")
def get_note(username: str):
    """Return the free-form note saved for an account, or empty string if
    there isn't one. The note lives in profile_tags.notes — a per-user
    free-text scratchpad for things like 'has a vsco at …', 'met at X',
    'do not unfollow until Y'."""
    with db_conn() as conn:
        row = conn.execute(
            "SELECT notes FROM profile_tags WHERE username = ?", (username,)
        ).fetchone()
    return {"username": username, "note": (row["notes"] if row and row["notes"] else "")}


@app.post("/api/note")
def set_note(payload: dict = Body(...)):
    """Save (or clear) the free-form note for an account. Whitespace-only
    notes are stored as NULL so empty submissions don't keep an empty
    profile_tags row alive forever."""
    account = payload.get("account") or payload.get("username")
    if not account:
        raise HTTPException(status_code=400, detail="Need account.")
    note_raw = payload.get("note", "")
    note = (note_raw or "").strip()
    username, profile_url = normalize_account_input(account)
    with db_conn() as conn:
        conn.execute(
            """INSERT INTO profile_tags (username, notes, profile_url, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(username) DO UPDATE SET
                   notes = excluded.notes,
                   profile_url = COALESCE(excluded.profile_url, profile_tags.profile_url),
                   updated_at = CURRENT_TIMESTAMP""",
            (username, note or None, profile_url),
        )
        conn.commit()
    # Notes are part of the lists overlay, not snapshot-derived cache —
    # bumping the tag version invalidates the overlay so the new note
    # shows up on the next /api/lists request.
    _bump_tag_version()
    return {"username": username, "note": note}


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


@app.get("/media/{username}")
def media_page(username: str):
    """Standalone full-page archived-media view for a single account.
    The modal version is cramped — this gives more space to scroll
    through posts/highlights and is the target of the 'Full page ↗'
    link in the modal heading. Username lookup happens client-side
    from the URL; this just serves the static HTML shell."""
    import re
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", username or ""):
        raise HTTPException(status_code=400, detail="Invalid username.")
    return FileResponse(STATIC_DIR / "media.html", headers=_NO_CACHE)


@app.get("/archive")
def archive_overview_page():
    """Master archive page — every account at a glance. Each account
    is a card with thumbnail preview + counts; clicking opens the
    per-account /media/<user> page. Linked from the home view's
    Archived media card."""
    return FileResponse(STATIC_DIR / "archive.html", headers=_NO_CACHE)


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(
        STATIC_DIR / "manifest.webmanifest",
        media_type="application/manifest+json",
        headers=_NO_CACHE,
    )
