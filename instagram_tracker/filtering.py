"""Replaces the prune-ever-file workflow.

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
    new_to_you: list[dict] = []
    invalid: list[dict] = []

    latest = latest_id(conn)
    current = snapshot_data(conn, latest) if latest is not None else None

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

        summary = ever_summary(conn, username)
        if summary is None:
            new_to_you.append({"input": stripped, "username": username, "profile_url": profile_url})
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
        })

    return {
        "seen": seen_in_history,
        "new": new_to_you,
        "invalid": invalid,
        "pruned_text": "\n".join(item["input"] for item in new_to_you),
    }
