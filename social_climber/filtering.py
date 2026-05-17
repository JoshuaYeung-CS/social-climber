"""Bulk seen-vs-new analyzer.

Take a multi-line text blob (usernames, @handles, or instagram links).
Return which entries the user has ever seen (so they can prune them out)
and which are net-new.
"""

import sqlite3

from .parsers import normalize_account_input
from .queries import ever_summary, latest_id, snapshot_data


def _status_for(summary: dict, current) -> tuple[str, str]:
    """Returns (primary_label, severity_kind) describing current relationship."""
    in_fol = current and summary["username"] in current.following
    in_back = current and summary["username"] in current.followers
    in_pending = current and summary["username"] in current.pending

    if in_fol and in_back:
        return ("mutual", "good")
    if in_fol:
        return ("you follow them", "warn")
    if in_back:
        return ("follows you only", "info")
    if in_pending:
        return ("request pending", "info")

    # Not currently connected; describe history.
    bits = []
    if summary.get("ever_followed"):
        bits.append("previously followed")
    if summary.get("ever_requested"):
        bits.append("requested before")
    if summary.get("ever_was_follower"):
        bits.append("was a follower")
    if not bits:
        return ("in history", "muted")
    return (" · ".join(bits), "muted")


def analyze(conn: sqlite3.Connection, text: str) -> dict:
    seen_in_history: list[dict] = []
    viewed_no_interaction: list[dict] = []
    new_to_you: list[dict] = []
    invalid: list[dict] = []

    latest = latest_id(conn)
    current = snapshot_data(conn, latest) if latest is not None else None

    # Parse + dedup pass first, so we can bulk-query the
    # profile_observations table once instead of per-username.
    parsed_lines: list[tuple[str, str, str]] = []
    seen_keys: set[str] = set()
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            username, profile_url = normalize_account_input(stripped)
        except ValueError as e:
            invalid.append({"input": stripped, "error": str(e)})
            continue
        if username in seen_keys:
            continue
        seen_keys.add(username)
        parsed_lines.append((stripped, username, profile_url))

    # Pre-fetch observation timestamps so we can flag accounts the
    # user has visited via the extension overlay even when they
    # have no follower/following/request history. Bulk one-shot
    # query keeps this fast even on large pastes.
    observed_at_map: dict[str, str] = {}
    if parsed_lines:
        usernames = [p[1] for p in parsed_lines]
        placeholders = ",".join("?" * len(usernames))
        rows = conn.execute(
            f"SELECT username, observed_at FROM profile_observations "
            f"WHERE username IN ({placeholders})",
            usernames,
        ).fetchall()
        for r in rows:
            observed_at_map[r["username"]] = r["observed_at"]

    for stripped, username, profile_url in parsed_lines:
        summary = ever_summary(conn, username)
        if summary is None:
            # No interaction history. If the user has visited this
            # profile before via the extension overlay, surface that
            # so they don't accidentally re-add someone they've
            # already evaluated. Bucket separately from "new" so
            # the user can spot it at a glance.
            if username in observed_at_map:
                viewed_no_interaction.append({
                    "input": stripped,
                    "username": username,
                    "profile_url": profile_url,
                    "observed_at": observed_at_map[username],
                })
            else:
                new_to_you.append({
                    "input": stripped, "username": username, "profile_url": profile_url
                })
            continue

        primary, severity = _status_for({**summary, "username": username}, current)
        seen_in_history.append({
            "input": stripped,
            "username": username,
            "profile_url": summary.get("profile_url") or profile_url,
            "status": primary,
            "status_kind": severity,
            "currently_following": current is not None and username in current.following,
            "currently_follower": current is not None and username in current.followers,
            "currently_pending": current is not None and username in current.pending,
            "ever_followed": summary["ever_followed"],
            "ever_requested": summary["ever_requested"],
            "ever_was_follower": summary.get("ever_was_follower", False),
            # Observation timestamp surfaces "you visited recently"
            # even on accounts that already have history — useful
            # tie-break when triaging long lists.
            "observed_at": observed_at_map.get(username),
        })

    return {
        "seen": seen_in_history,
        "viewed": viewed_no_interaction,
        "new": new_to_you,
        "invalid": invalid,
        # Pruned text excludes BOTH already-interacted and
        # viewed-no-interaction. The user's "safe to follow fresh"
        # workflow shouldn't include accounts they've already eyed.
        "pruned_text": "\n".join(item["input"] for item in new_to_you),
    }
