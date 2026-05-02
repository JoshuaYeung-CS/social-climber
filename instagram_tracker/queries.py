"""All read-side queries.

Multi-snapshot queries load all rows in a single SQL roundtrip, then group in
memory — much faster than re-fetching per snapshot in a loop.
"""

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class SnapshotMeta:
    id: int
    created_at: str
    label: str | None
    source_path: str | None


@dataclass(frozen=True)
class SnapshotData:
    followers: set[str]
    following: set[str]
    pending: set[str]              # current pending requests you've sent (not yet accepted)
    recent_follow_requests: set[str]
    recently_unfollowed: set[str]
    incoming_requests: set[str]    # accounts that have requested to follow you (still pending)


# ---------- snapshot listing ----------

def list_snapshots(conn: sqlite3.Connection) -> list[SnapshotMeta]:
    """Snapshots in chronological order (taken_at ASC, id as tiebreaker for
    same-second imports)."""
    rows = conn.execute(
        "SELECT id, created_at, label, source_path FROM snapshots "
        "ORDER BY taken_at ASC, id ASC"
    ).fetchall()
    return [SnapshotMeta(r["id"], r["created_at"], r["label"], r["source_path"]) for r in rows]


def latest_id(conn: sqlite3.Connection) -> int | None:
    """Most-recent snapshot CHRONOLOGICALLY (not by import order)."""
    row = conn.execute(
        "SELECT id FROM snapshots ORDER BY taken_at DESC, id DESC LIMIT 1"
    ).fetchone()
    return None if row is None else int(row["id"])


def previous_id(conn: sqlite3.Connection, snapshot_id: int) -> int | None:
    """The chronologically-prior snapshot to `snapshot_id`. Compares on the
    pair (taken_at, id) so two same-second imports still have a deterministic
    order (the lower id is 'earlier')."""
    pair = conn.execute(
        "SELECT taken_at, id FROM snapshots WHERE id = ?", (snapshot_id,)
    ).fetchone()
    if pair is None:
        return None
    row = conn.execute(
        "SELECT id FROM snapshots "
        "WHERE (taken_at, id) < (?, ?) "
        "ORDER BY taken_at DESC, id DESC LIMIT 1",
        (pair["taken_at"], pair["id"]),
    ).fetchone()
    return None if row is None else int(row["id"])


def delete_snapshot(conn: sqlite3.Connection, snapshot_id: int) -> None:
    conn.execute("DELETE FROM snapshots WHERE id = ?", (snapshot_id,))
    conn.commit()


# ---------- per-snapshot data ----------

def _names(conn: sqlite3.Connection, table: str, snapshot_id: int) -> set[str]:
    rows = conn.execute(f"SELECT username FROM {table} WHERE snapshot_id = ?", (snapshot_id,)).fetchall()
    return {r["username"] for r in rows}


def snapshot_data(conn: sqlite3.Connection, snapshot_id: int) -> SnapshotData:
    followers = _names(conn, "followers", snapshot_id)
    following = _names(conn, "following", snapshot_id)
    pending_rows = conn.execute(
        """
        SELECT username, source_label FROM pending_follow_requests WHERE snapshot_id = ?
        """,
        (snapshot_id,),
    ).fetchall()
    pending = {r["username"] for r in pending_rows if r["source_label"] in ("pending_follow_requests", "both")}
    recent_requests = {r["username"] for r in pending_rows if r["source_label"] in ("recent_follow_requests", "both")}
    pending = pending - followers  # if they accepted, drop from "current pending"
    recently_unfollowed = _names(conn, "recently_unfollowed", snapshot_id)
    incoming = _names(conn, "incoming_follow_requests", snapshot_id)
    # Anyone you already follow back has effectively resolved their incoming
    # request — strip them so the "they want to follow you" count isn't
    # inflated by your-existing-followers leaking into the incoming set.
    incoming = incoming - followers
    return SnapshotData(
        followers=followers,
        following=following,
        pending=pending,
        recent_follow_requests=recent_requests,
        recently_unfollowed=recently_unfollowed,
        incoming_requests=incoming,
    )


# ---------- whole-history loaders (used for fast "ever" / multi-snapshot computations) ----------

def followers_by_snapshot(conn: sqlite3.Connection, max_snapshot_id: int | None = None) -> dict[int, set[str]]:
    if max_snapshot_id is None:
        rows = conn.execute("SELECT snapshot_id, username FROM followers").fetchall()
    else:
        rows = conn.execute(
            "SELECT snapshot_id, username FROM followers WHERE snapshot_id <= ?",
            (max_snapshot_id,),
        ).fetchall()
    out: dict[int, set[str]] = {}
    for r in rows:
        out.setdefault(r["snapshot_id"], set()).add(r["username"])
    return out


def following_by_snapshot(conn: sqlite3.Connection, max_snapshot_id: int | None = None) -> dict[int, set[str]]:
    if max_snapshot_id is None:
        rows = conn.execute("SELECT snapshot_id, username FROM following").fetchall()
    else:
        rows = conn.execute(
            "SELECT snapshot_id, username FROM following WHERE snapshot_id <= ?",
            (max_snapshot_id,),
        ).fetchall()
    out: dict[int, set[str]] = {}
    for r in rows:
        out.setdefault(r["snapshot_id"], set()).add(r["username"])
    return out


def pending_by_snapshot(conn: sqlite3.Connection, max_snapshot_id: int | None = None) -> dict[int, set[str]]:
    """Returns ALL pending+recent rows, not split by source. Used for privacy inference."""
    sql = "SELECT snapshot_id, username FROM pending_follow_requests"
    params: tuple = ()
    if max_snapshot_id is not None:
        sql += " WHERE snapshot_id <= ?"
        params = (max_snapshot_id,)
    rows = conn.execute(sql, params).fetchall()
    out: dict[int, set[str]] = {}
    for r in rows:
        out.setdefault(r["snapshot_id"], set()).add(r["username"])
    return out


# ---------- per-username helpers ----------

def _runs_in(conn: sqlite3.Connection, table: str, username: str) -> list[dict]:
    """Distinct on/off cycles for a username across all snapshots in `table`.

    A run is a maximal contiguous sequence of snapshots where the username is present.
    Returns [{start_snapshot_id, end_snapshot_id, length}, ...].
    """
    snaps = [r["id"] for r in conn.execute(
        "SELECT id FROM snapshots ORDER BY taken_at ASC, id ASC"
    ).fetchall()]
    if not snaps:
        return []
    present = {
        r["snapshot_id"]
        for r in conn.execute(
            f"SELECT snapshot_id FROM {table} WHERE username = ?", (username,)
        ).fetchall()
    }
    runs: list[dict] = []
    start: int | None = None
    end: int | None = None
    for sid in snaps:
        is_in = sid in present
        if is_in and start is None:
            start = sid
            end = sid
        elif is_in:
            end = sid
        elif not is_in and start is not None:
            runs.append({"start_snapshot_id": start, "end_snapshot_id": end, "length": _count_between(snaps, start, end)})
            start = None
            end = None
    if start is not None:
        runs.append({"start_snapshot_id": start, "end_snapshot_id": end, "length": _count_between(snaps, start, end)})
    return runs


def _count_between(ordered: list[int], start: int, end: int) -> int:
    return sum(1 for x in ordered if start <= x <= end)


def follow_runs(conn: sqlite3.Connection, username: str) -> list[dict]:
    return _runs_in(conn, "following", username)


def follower_runs(conn: sqlite3.Connection, username: str) -> list[dict]:
    return _runs_in(conn, "followers", username)


def latest_profile_url(conn: sqlite3.Connection, username: str) -> str | None:
    """Most recent (chronological) profile URL for a username across any table."""
    row = conn.execute(
        """
        SELECT u.profile_url
        FROM (
            SELECT profile_url, snapshot_id FROM following WHERE username = ? AND profile_url IS NOT NULL AND profile_url != ''
            UNION ALL
            SELECT profile_url, snapshot_id FROM followers WHERE username = ? AND profile_url IS NOT NULL AND profile_url != ''
            UNION ALL
            SELECT profile_url, snapshot_id FROM pending_follow_requests WHERE username = ? AND profile_url IS NOT NULL AND profile_url != ''
        ) AS u
        JOIN snapshots s ON s.id = u.snapshot_id
        ORDER BY s.taken_at DESC, s.id DESC
        LIMIT 1
        """,
        (username, username, username),
    ).fetchone()
    return row["profile_url"] if row else None


def ever_summary(conn: sqlite3.Connection, username: str) -> dict | None:
    """Single-username history summary computed entirely from snapshot rows."""
    following = conn.execute(
        """
        SELECT s.id, s.created_at, COALESCE(s.label, '') AS label
        FROM following f JOIN snapshots s ON s.id = f.snapshot_id
        WHERE f.username = ? ORDER BY s.taken_at ASC, s.id ASC
        """,
        (username,),
    ).fetchall()
    pending = conn.execute(
        """
        SELECT s.id, s.created_at, COALESCE(s.label, '') AS label
        FROM pending_follow_requests p JOIN snapshots s ON s.id = p.snapshot_id
        WHERE p.username = ? ORDER BY s.taken_at ASC, s.id ASC
        """,
        (username,),
    ).fetchall()
    followers = conn.execute(
        """
        SELECT s.id, s.created_at, COALESCE(s.label, '') AS label
        FROM followers f JOIN snapshots s ON s.id = f.snapshot_id
        WHERE f.username = ? ORDER BY s.taken_at ASC, s.id ASC
        """,
        (username,),
    ).fetchall()

    if not following and not pending and not followers:
        return None

    def pack(rows):
        if not rows:
            return None, None, 0
        first = {"snapshot_id": rows[0]["id"], "created_at": rows[0]["created_at"], "label": rows[0]["label"]}
        last = {"snapshot_id": rows[-1]["id"], "created_at": rows[-1]["created_at"], "label": rows[-1]["label"]}
        return first, last, len(rows)

    f_first, f_last, f_count = pack(following)
    p_first, p_last, p_count = pack(pending)
    fr_first, fr_last, fr_count = pack(followers)

    runs = follow_runs(conn, username)
    follower_run_list = follower_runs(conn, username)

    return {
        "username": username,
        "profile_url": latest_profile_url(conn, username),
        "ever_followed": bool(following),
        "ever_requested": bool(pending),
        "ever_was_follower": bool(followers),
        "first_followed_snapshot": f_first,
        "last_followed_snapshot": f_last,
        "followed_snapshot_count": f_count,
        "first_requested_snapshot": p_first,
        "last_requested_snapshot": p_last,
        "requested_snapshot_count": p_count,
        "first_follower_snapshot": fr_first,
        "last_follower_snapshot": fr_last,
        "follower_snapshot_count": fr_count,
        "follow_runs": runs,
        "follow_runs_count": len(runs),
        "follower_runs": follower_run_list,
        "follower_runs_count": len(follower_run_list),
    }


def ever_self_unfollowed(conn: sqlite3.Connection) -> set[str]:
    """Every username that has ever appeared in the user's recently_unfollowed list,
    across all snapshots. Authoritative record of self-initiated unfollows."""
    rows = conn.execute("SELECT DISTINCT username FROM recently_unfollowed").fetchall()
    return {r["username"] for r in rows}


def detect_renames(conn: sqlite3.Connection) -> list[dict]:
    """Heuristic: usernames sharing an Instagram-side `export_timestamp` in the same
    table, but appearing in non-overlapping CONTIGUOUS snapshot ranges, are almost
    certainly the same account renamed. Handles back-and-forth renames (A->B->A)
    by tracking each contiguous run separately.

    Returns chains: [{evidence_tables, timestamp, sequence: [name1, name2, ...], ...}, ...]
    """
    all_snaps = [int(r["id"]) for r in conn.execute(
        "SELECT id FROM snapshots ORDER BY taken_at ASC, id ASC"
    ).fetchall()]
    if not all_snaps:
        return []
    snap_index = {sid: i for i, sid in enumerate(all_snaps)}

    chains: list[dict] = []
    for table in ("following", "followers", "pending_follow_requests"):
        rows = conn.execute(
            f"SELECT username, export_timestamp, snapshot_id FROM {table} WHERE export_timestamp IS NOT NULL"
        ).fetchall()

        # Group rows by (username, timestamp) -> snapshot ids
        per_user_ts: dict[tuple, list[int]] = {}
        for r in rows:
            key = (r["username"], int(r["export_timestamp"]))
            per_user_ts.setdefault(key, []).append(int(r["snapshot_id"]))

        # Slice into contiguous runs per (username, ts)
        runs_by_ts: dict[int, list[dict]] = {}
        for (username, ts), sids in per_user_ts.items():
            sorted_sids = sorted(sids)
            run_start = sorted_sids[0]
            run_end = sorted_sids[0]
            for sid in sorted_sids[1:]:
                if snap_index[sid] == snap_index[run_end] + 1:
                    run_end = sid
                else:
                    runs_by_ts.setdefault(ts, []).append({"username": username, "smin": run_start, "smax": run_end})
                    run_start = sid
                    run_end = sid
            runs_by_ts.setdefault(ts, []).append({"username": username, "smin": run_start, "smax": run_end})

        for ts, runs in runs_by_ts.items():
            distinct_names = {r["username"] for r in runs}
            if len(distinct_names) < 2:
                continue
            runs.sort(key=lambda x: x["smin"])
            non_overlap = all(runs[i]["smax"] < runs[i + 1]["smin"] for i in range(len(runs) - 1))
            if not non_overlap:
                continue
            chains.append({
                "table": table,
                "timestamp": ts,
                "sequence": [r["username"] for r in runs],
                "snapshots": [(r["smin"], r["smax"]) for r in runs],
            })

    def collapse(seq):
        out = []
        for x in seq:
            if not out or out[-1] != x:
                out.append(x)
        return out

    # Deduplicate by (timestamp, set-of-distinct-names) so the same chain detected via
    # multiple tables is merged. Use the longest collapsed sequence as canonical.
    merged: dict[tuple, dict] = {}
    for c in chains:
        seq = collapse(c["sequence"])
        if len(set(seq)) < 2:
            continue
        key = frozenset(seq)
        if key in merged:
            existing = merged[key]
            existing["evidence_tables"].add(c["table"])
            if len(seq) > len(existing["sequence"]):
                existing["sequence"] = seq
                existing["snapshots"] = c["snapshots"]
        else:
            merged[key] = {
                "timestamp": c["timestamp"],
                "sequence": seq,
                "snapshots": c["snapshots"],
                "evidence_tables": {c["table"]},
            }

    out = list(merged.values())
    for c in out:
        c["evidence_tables"] = sorted(c["evidence_tables"])
    out.sort(key=lambda x: (-len(x["evidence_tables"]), x["sequence"][0]))
    return out


def username_alias_map(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """Returns username -> ordered list of all aliases (including itself) per detected chain.
    Order is oldest -> newest by first-appearance snapshot."""
    chains = detect_renames(conn)
    out: dict[str, list[str]] = {}
    for c in chains:
        for u in c["sequence"]:
            out[u] = list(c["sequence"])
    return out


def detect_reengagements(conn: sqlite3.Connection) -> set[str]:
    """Returns the set of usernames whose follow timestamp changed across a gap in
    their followers/following/pending history — i.e. they left and explicitly
    re-followed (Instagram assigns a new timestamp on a fresh follow). Used to
    surface a "re-engaged" tag on rows."""
    all_snaps = [int(r["id"]) for r in conn.execute(
        "SELECT id FROM snapshots ORDER BY taken_at ASC, id ASC"
    ).fetchall()]
    if not all_snaps:
        return set()
    snap_index = {sid: i for i, sid in enumerate(all_snaps)}

    out: set[str] = set()
    for table in ("followers", "following", "pending_follow_requests"):
        rows = conn.execute(
            f"SELECT username, snapshot_id, export_timestamp FROM {table} "
            f"WHERE export_timestamp IS NOT NULL"
        ).fetchall()
        per_user: dict[str, list[tuple[int, int, int]]] = {}
        for r in rows:
            sid = int(r["snapshot_id"])
            if sid not in snap_index:
                continue
            per_user.setdefault(r["username"], []).append(
                (snap_index[sid], sid, int(r["export_timestamp"]))
            )
        for username, history in per_user.items():
            history.sort()  # by chronological position
            for i in range(1, len(history)):
                prev_pos, _, prev_ts = history[i - 1]
                curr_pos, _, curr_ts = history[i]
                if curr_pos - prev_pos > 1 and curr_ts != prev_ts:
                    out.add(username)
                    break
    return out


def recently_unfollowed_by_snapshot(conn: sqlite3.Connection) -> dict[int, set[str]]:
    rows = conn.execute("SELECT snapshot_id, username FROM recently_unfollowed").fetchall()
    out: dict[int, set[str]] = {}
    for r in rows:
        out.setdefault(int(r["snapshot_id"]), set()).add(r["username"])
    return out


def privacy_status_bulk(conn: sqlite3.Connection, usernames: list[str]) -> dict[str, str]:
    """For each username, infer likely_private / likely_public / unknown.

    Three sources of evidence, applied in order:

      1. Per-row export_timestamp evidence (most precise).
         IG records the exact second of every follow + every pending request.
         If a pending observation's timestamp precedes the follow timestamp,
         a request was needed → likely_private. If we have *snapshot coverage*
         (i.e. some snapshot was taken before the follow's exact second) and
         saw no pending across that period, no request was needed →
         likely_public.

      2. Snapshot-position evidence (fallback when timestamps missing).
         Compare the chronological position of the user's first appearance
         in `pending_follow_requests` vs `following`. Pending earlier →
         likely_private; following earlier with no pending → likely_public.

      3. Same-snapshot ambiguity (sharpened from the prior version).
         When pending and following both first appear in the *same* snapshot
         (and that snapshot isn't the chronologically first one — i.e. we
         had earlier coverage), the pending entry caught a request that
         IG accepted between the two file-generation moments. This happens
         only for private accounts; public follows never produce a pending
         entry. Treat as likely_private rather than the prior "unknown".

    Comparisons are by chronological position (taken_at) — never by raw
    snapshot_id, so out-of-order imports don't lie about who came first.
    """
    if not usernames:
        return {}

    snap_rows = conn.execute(
        "SELECT id, taken_at FROM snapshots ORDER BY taken_at ASC, id ASC"
    ).fetchall()
    if not snap_rows:
        return {}
    snap_order: dict[int, int] = {int(r["id"]): i for i, r in enumerate(snap_rows)}
    earliest_taken_at = snap_rows[0]["taken_at"]

    placeholders = ",".join("?" * len(usernames))

    # 1) Most-recent follow timestamp from `following` (the canonical "when
    #    they followed" — IG's per-row export_timestamp). MAX collapses
    #    multiple snapshots-per-user into one anchor point.
    follow_ts: dict[str, int] = {}
    for r in conn.execute(
        f"""
        SELECT username, MAX(export_timestamp) AS ts
        FROM following
        WHERE username IN ({placeholders}) AND export_timestamp IS NOT NULL
        GROUP BY username
        """,
        usernames,
    ).fetchall():
        if r["ts"] is not None:
            follow_ts[r["username"]] = int(r["ts"])

    # 2) Earliest pending observation per user — both timestamp and
    #    chronological snapshot position. Two views because the pending row
    #    might not have a timestamp on older imports.
    first_pending_ts: dict[str, int] = {}
    first_pending_pos: dict[str, int] = {}
    for r in conn.execute(
        f"""
        SELECT username, export_timestamp, snapshot_id
        FROM pending_follow_requests
        WHERE username IN ({placeholders})
        """,
        usernames,
    ).fetchall():
        u = r["username"]
        if r["export_timestamp"] is not None:
            ts = int(r["export_timestamp"])
            if u not in first_pending_ts or ts < first_pending_ts[u]:
                first_pending_ts[u] = ts
        pos = snap_order.get(int(r["snapshot_id"]))
        if pos is not None and (u not in first_pending_pos or pos < first_pending_pos[u]):
            first_pending_pos[u] = pos

    # 3) First chronological appearance in following (snapshot position).
    first_following_pos: dict[str, int] = {}
    for r in conn.execute(
        f"SELECT username, snapshot_id FROM following WHERE username IN ({placeholders})",
        usernames,
    ).fetchall():
        u = r["username"]
        pos = snap_order.get(int(r["snapshot_id"]))
        if pos is not None and (u not in first_following_pos or pos < first_following_pos[u]):
            first_following_pos[u] = pos

    def has_pre_follow_coverage(ft: int) -> bool:
        """True iff our earliest snapshot was taken before the follow happened —
        meaning we'd have seen a pending entry if there was one."""
        if not earliest_taken_at:
            return False
        ft_iso = datetime.fromtimestamp(ft, tz=timezone.utc).isoformat()
        # Both ISO 8601, lexically comparable.
        return earliest_taken_at < ft_iso

    out: dict[str, str] = {}
    for u in usernames:
        ft = follow_ts.get(u)
        pt = first_pending_ts.get(u)

        # Strongest signal: the per-row timestamps say the request preceded the follow.
        if ft is not None and pt is not None and pt <= ft:
            out[u] = "likely_private"
            continue

        ff_pos = first_following_pos.get(u)
        fp_pos = first_pending_pos.get(u)

        # Snapshot-order evidence (used when timestamps are missing or
        # when timestamps alone don't decide).
        if ff_pos is not None and fp_pos is not None:
            if fp_pos < ff_pos:
                out[u] = "likely_private"
                continue
            if fp_pos == ff_pos and ff_pos > 0:
                # Pending and following first appeared in the same snapshot
                # we observed — pending caught a request that IG resolved
                # between file generation. Public follows never appear in
                # pending → this is private with high confidence.
                out[u] = "likely_private"
                continue

        # No pending evidence. Now decide between likely_public and unknown.
        if ft is not None and has_pre_follow_coverage(ft):
            # Snapshots from before the follow happened, no pending observed → public.
            out[u] = "likely_public"
            continue
        if ff_pos is not None and ff_pos > 0:
            # No timestamp, but snapshot-position evidence shows they appeared
            # in following at a non-first snapshot — same coverage argument
            # in coarser form.
            out[u] = "likely_public"
            continue

        out[u] = "unknown"
    return out


def account_history_lines(conn: sqlite3.Connection, username: str) -> list[dict]:
    """Per-snapshot status of a username across all snapshots."""
    snaps = list_snapshots(conn)
    if not snaps:
        return []

    sids = [s.id for s in snaps]
    placeholders = ",".join("?" * len(sids))

    def names_per_snapshot(table: str) -> dict[int, bool]:
        rows = conn.execute(
            f"SELECT snapshot_id FROM {table} WHERE username = ? AND snapshot_id IN ({placeholders})",
            (username, *sids),
        ).fetchall()
        return {int(r["snapshot_id"]): True for r in rows}

    in_followers = names_per_snapshot("followers")
    in_following = names_per_snapshot("following")
    in_pending_rows = conn.execute(
        f"SELECT snapshot_id, COALESCE(source_label, '') AS source_label FROM pending_follow_requests WHERE username = ? AND snapshot_id IN ({placeholders})",
        (username, *sids),
    ).fetchall()
    pending_by_sid: dict[int, str] = {int(r["snapshot_id"]): r["source_label"] for r in in_pending_rows}
    in_recently_unfollowed = names_per_snapshot("recently_unfollowed")

    out: list[dict] = []
    prev_was_follower = False
    prev_was_following = False
    for s in snaps:
        statuses: list[str] = []
        is_follower = s.id in in_followers
        is_following = s.id in in_following
        if is_follower and is_following:
            statuses.append("mutual")
        elif is_following:
            statuses.append("not-following-you-back")
        elif is_follower:
            statuses.append("feeder-account")
        else:
            statuses.append("not-connected")

        src = pending_by_sid.get(s.id, "")
        if src in ("pending_follow_requests", "both"):
            statuses.append("pending")
        if src in ("recent_follow_requests", "both"):
            statuses.append("recent-follow-request")
        if s.id in in_recently_unfollowed:
            statuses.append("recently-unfollowed-by-you")
        if prev_was_follower and not is_follower:
            statuses.append("unfollowed-you")
        if prev_was_follower and not is_follower and is_following:
            statuses.append("you-still-follow")
        if not prev_was_following and is_following:
            statuses.append("started-following")

        out.append(
            {
                "snapshot_id": s.id,
                "label": s.label,
                "created_at": s.created_at,
                "statuses": statuses,
            }
        )
        prev_was_follower = is_follower
        prev_was_following = is_following

    return out
