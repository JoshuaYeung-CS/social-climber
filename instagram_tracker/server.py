"""FastAPI server. Tiny request handlers; all logic lives in the modules above."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import alerts as alerts_mod
from . import diffs as diffs_mod
from . import filtering as filtering_mod
from . import followup as followup_mod
from . import ingest as ingest_mod
from . import queries as q
from . import tags as tags_mod
from .config import DB_PATH, STATIC_DIR
from .db import connect
from .parsers import normalize_account_input

app = FastAPI(title="Instagram Tracker", version="2.0.0")


@contextmanager
def db_conn():
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


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
    """Single endpoint that powers the home screen."""
    with db_conn() as conn:
        snaps = q.list_snapshots(conn)
        latest = q.latest_id(conn)
        previous = q.previous_id(conn, latest) if latest is not None else None

        summary = None
        if latest is not None:
            curr = q.snapshot_data(conn, latest)

            # Cumulative across all history.
            followers_by_sid = q.followers_by_snapshot(conn)
            following_by_sid = q.following_by_snapshot(conn)
            ordered_sids = sorted(set(followers_by_sid) | set(following_by_sid))
            ever_unfollowed_you: set[str] = set()
            ever_left_following: set[str] = set()
            for old_id, new_id in zip(ordered_sids[:-1], ordered_sids[1:]):
                ever_unfollowed_you |= followers_by_sid.get(old_id, set()) - followers_by_sid.get(new_id, set())
                ever_left_following |= following_by_sid.get(old_id, set()) - following_by_sid.get(new_id, set())
            ever_self = q.ever_self_unfollowed(conn)
            ever_removed = ever_left_following - ever_self

            # Strip rename chains so renames don't inflate "they unfollowed/removed you" counts.
            alias_map = q.username_alias_map(conn)
            def aliases_active(u: str, in_set: set[str]) -> bool:
                chain = alias_map.get(u)
                if not chain:
                    return False
                return any(a in in_set for a in chain if a != u)

            ever_unfollowed_you = {u for u in ever_unfollowed_you if not aliases_active(u, curr.followers)}
            ever_removed = {u for u in ever_removed if not aliases_active(u, curr.following)}

            # Strip deactivations: if they "left" but their timestamp was preserved when
            # they came back, that wasn't a real unfollow/removal — it was deactivation.
            deact_map = q.detect_deactivations(conn)
            deactivated_returned: set[str] = set()
            for u in list(ever_unfollowed_you):
                info = deact_map.get(u)
                if info and info["likely_deactivated"] and u in curr.followers:
                    deactivated_returned.add(u)
                    ever_unfollowed_you.discard(u)
            for u in list(ever_removed):
                info = deact_map.get(u)
                if info and info["likely_deactivated"] and u in curr.following:
                    deactivated_returned.add(u)
                    ever_removed.discard(u)

            still_follow_them = ever_unfollowed_you & curr.following

            summary = {
                "snapshot_id": latest,
                "followers": len(curr.followers),
                "following": len(curr.following),
                "mutuals": len(curr.followers & curr.following),
                "not_following_you_back": len(curr.following - curr.followers),
                "feeder_accounts": len(curr.followers - curr.following),
                "pending": len(curr.pending),
                # Cumulative (ever) counts:
                "ever_unfollowed_you": len(ever_unfollowed_you),
                "ever_removed_you_as_follower": len(ever_removed),
                "ever_you_unfollowed": len(ever_self),
                "still_follow_after_drop": len(still_follow_them),
                "deactivated_then_returned": len(deactivated_returned),
                "disabled_tagged": len(tags_mod.list_with_flag(conn, "disabled")),
            }

        bucket_counts = {
            "favorites": len(tags_mod.list_with_flag(conn, "favorite")),
            "want_remove": len(tags_mod.list_with_flag(conn, "want_remove")),
            "watchlist": len(tags_mod.list_with_flag(conn, "watchlist")),
            "disabled": len(tags_mod.list_with_flag(conn, "disabled")),
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
        return {"deleted": snapshot_id}


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
            results = ingest_mod.import_path(conn, import_target, label)

        return {
            "imports": [
                {
                    "snapshot_id": r.snapshot_id,
                    "label": r.label,
                    "counts": r.counts,
                    "missing_files": r.missing_files,
                }
                for r in results
            ]
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
    from datetime import datetime, timezone

    with db_conn() as conn:
        sid = _resolve(conn, snapshot_id)
        sd = q.snapshot_data(conn, sid)
        sections = diffs_mod.current_lists(sd)

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
            sections["they_removed_you_as_follower"] = sorted(left_following - sd.recently_unfollowed)
        else:
            sections["they_unfollowed_you"] = []
            sections["unfollowers_you_still_follow"] = []
            sections["you_unfollowed"] = []
            sections["they_removed_you_as_follower"] = []

        # Bucket lists.
        for flag in ("favorite", "want_remove", "watchlist", "disabled"):
            sections[flag] = sorted(r["username"] for r in tags_mod.list_with_flag(conn, flag))

        # ---- Cumulative / historical lists across ALL snapshots ----
        followers_by_sid = q.followers_by_snapshot(conn)
        following_by_sid = q.following_by_snapshot(conn)
        ordered_sids = sorted(followers_by_sid.keys() | following_by_sid.keys())

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
        ever_removed_you = ever_left_following - ever_self

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

        # Detect deactivations — same-timestamp gaps in followers/following/pending history.
        deact_map = q.detect_deactivations(conn)

        # Anyone whose disappearance was actually a deactivation (timestamp preserved on
        # return) shouldn't count as "they unfollowed/removed you". Move them to a
        # dedicated list instead.
        deactivated_then_returned: set[str] = set()
        for u in list(ever_unfollowed_you):
            info = deact_map.get(u)
            if info and info["likely_deactivated"] and u in sd.followers:
                deactivated_then_returned.add(u)
                ever_unfollowed_you.discard(u)
        for u in list(ever_removed_you):
            info = deact_map.get(u)
            if info and info["likely_deactivated"] and u in sd.following:
                deactivated_then_returned.add(u)
                ever_removed_you.discard(u)

        sections["ever_unfollowed_you"] = sorted(ever_unfollowed_you)
        sections["ever_removed_you_as_follower"] = sorted(ever_removed_you)
        sections["deactivated_then_returned"] = sorted(deactivated_then_returned)
        # Subset of ever_unfollowed_you that you still follow.
        sections["still_follow_after_drop"] = sorted(ever_unfollowed_you & sd.following)

        # Cumulative "you unfollowed" — anyone who ever appeared in your recently_unfollowed.
        sections["you_unfollowed_ever"] = sorted(ever_self)

        # Renamed accounts — show one row per chain, keyed by the latest username.
        chains = q.detect_renames(conn)
        sections["renamed"] = sorted({c["sequence"][-1] for c in chains})

        # Per-username timestamp of when you started following them (from Instagram's export).
        following_ts: dict[str, int | None] = {}
        for r in conn.execute(
            "SELECT username, export_timestamp FROM following WHERE snapshot_id = ?",
            (sid,),
        ).fetchall():
            following_ts[r["username"]] = r["export_timestamp"]

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
        last_followers_sid: dict[str, int] = {}
        if nfb_set:
            placeholders = ",".join("?" * len(nfb_set))
            for r in conn.execute(
                f"SELECT username, MAX(snapshot_id) AS sid FROM followers WHERE username IN ({placeholders}) GROUP BY username",
                list(nfb_set),
            ).fetchall():
                last_followers_sid[r["username"]] = int(r["sid"])

        # For mutuals: when did they first appear in BOTH following and followers in the same snapshot?
        mutual_set = sd.followers & sd.following
        mutual_since_sid: dict[str, int] = {}
        if mutual_set:
            placeholders = ",".join("?" * len(mutual_set))
            for r in conn.execute(
                f"""
                SELECT f.username, MIN(f.snapshot_id) AS sid
                FROM following f
                INNER JOIN followers fr ON fr.snapshot_id = f.snapshot_id AND fr.username = f.username
                WHERE f.username IN ({placeholders})
                GROUP BY f.username
                """,
                list(mutual_set),
            ).fetchall():
                mutual_since_sid[r["username"]] = int(r["sid"])

        # For currently-pending: when did the request first appear?
        pending_set = sd.pending
        pending_since_sid: dict[str, int] = {}
        if pending_set:
            placeholders = ",".join("?" * len(pending_set))
            for r in conn.execute(
                f"SELECT username, MIN(snapshot_id) AS sid FROM pending_follow_requests WHERE username IN ({placeholders}) GROUP BY username",
                list(pending_set),
            ).fetchall():
                pending_since_sid[r["username"]] = int(r["sid"])

        TIMED_KINDS = {
            "not_following_you_back",
            "unfollowers_you_still_follow",
            "mutuals",
            "all_following",
            "pending",
            "all_followers",
            "feeder_accounts",
        }
        BUCKET_KINDS = {"favorite", "want_remove", "watchlist", "disabled"}

        flagged = tags_mod.all_flagged_usernames(conn)

        # deact_map already computed above where filters were applied; if we reach this
        # block before that's set (e.g. caller order changes), recompute defensively.
        try:
            deact_map  # type: ignore[name-defined]
        except NameError:
            deact_map = q.detect_deactivations(conn)

        def relationship(u: str) -> tuple[str, str]:
            in_fol = u in sd.following
            in_back = u in sd.followers
            in_pend = u in sd.pending
            if in_fol and in_back:
                return ("mutual", "good")
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
                "currently_following": u in sd.following,
                "currently_follower": u in sd.followers,
                "currently_pending": u in sd.pending,
                "relationship": rel,
                "relationship_kind": rel_kind,
            }
            # Deactivation / reengagement evidence.
            d_info = deact_map.get(u)
            if d_info:
                if d_info["likely_deactivated"]:
                    row["history_status"] = "deactivated_returned"
                elif d_info["likely_reengaged"]:
                    row["history_status"] = "re-engaged"
            # Aliases (rename chain).
            chain = alias_map.get(u)
            if chain:
                row["aliases"] = chain
            # When you started following them.
            ts = following_ts.get(u)
            if ts:
                followed_at = datetime.fromtimestamp(ts, tz=timezone.utc)
                row["followed_ts"] = ts
                row["followed_at"] = followed_at.date().isoformat()
                row["days_since"] = (now - followed_at).days
            # When you became mutual (first overlap).
            if u in mutual_since_sid:
                d, ago = days_ago_for_sid(mutual_since_sid[u])
                row["mutual_since_at"] = d
                row["mutual_since_days_ago"] = ago
            # When pending request first appeared.
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
                    meta = snap_meta.get(last_sid, {})
                    d = parse_label_date(meta.get("label"))
                    row["ever_followed_you"] = True
                    row["last_followed_you_at"] = d.date().isoformat() if d else meta.get("label")
                    row["last_followed_you_days_ago"] = (now - d).days if d else None
                    row["last_followed_you_snapshot_id"] = last_sid
            return row

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


# ---------- per-account lookup ----------

@app.get("/api/lookup")
def lookup(account: str):
    username, profile_url = normalize_account_input(account)
    with db_conn() as conn:
        summary = q.ever_summary(conn, username)
        tags = tags_mod.get_tags(conn, username)
        aliases = q.username_alias_map(conn).get(username, [])
        if summary is None:
            return {
                "username": username,
                "profile_url": profile_url,
                "found": False,
                "tags": tags,
                "aliases": aliases,
            }
        return {**summary, "found": True, "tags": tags, "aliases": aliases}


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
        raise HTTPException(status_code=400, detail="Need account and a valid flag (favorite | want_remove | watchlist).")
    username, profile_url = normalize_account_input(account)
    with db_conn() as conn:
        return tags_mod.set_flag(conn, username, flag, value, profile_url)


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")
