"""Alerts shown on the home screen.

Two flavors:
  - "diff" alerts: things that changed since the previous import (transient per import)
  - "stateful" alerts: derived from current state (e.g. wait-back overdue)
"""

import sqlite3
from datetime import datetime, timedelta, timezone

from .config import WAITBACK_ALERT_DAYS
from .queries import (
    latest_id,
    previous_id,
    privacy_status_bulk,
    snapshot_data,
)
from .tags import list_with_flag, set_flag


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def compute_alerts(conn: sqlite3.Connection) -> dict:
    latest = latest_id(conn)
    if latest is None:
        return {"diff": [], "stateful": [], "latest_snapshot_id": None, "previous_snapshot_id": None}

    previous = previous_id(conn, latest)
    favorites = {row["username"] for row in list_with_flag(conn, "favorite")}

    diff_alerts: list[dict] = []
    disabled_tagged = {r["username"] for r in list_with_flag(conn, "disabled")}
    if previous is not None:
        prev = snapshot_data(conn, previous)
        curr = snapshot_data(conn, latest)

        lost_followers = (prev.followers - curr.followers) - disabled_tagged  # they unfollowed you
        left_following = (prev.following - curr.following) - disabled_tagged
        # Same-snapshot rule: if it's not in the new snapshot's recently_unfollowed,
        # the user didn't initiate the unfollow — assume they removed you.
        they_removed_you = left_following - curr.recently_unfollowed
        # (left_following & curr.recently_unfollowed) = you unfollowed them; not surfaced as an alert.

        for u in sorted(lost_followers & favorites):
            diff_alerts.append({
                "kind": "favorite_unfollowed_you",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} unfollowed you.",
            })

        for u in sorted(lost_followers - favorites):
            diff_alerts.append({
                "kind": "they_unfollowed_you",
                "username": u,
                "severity": "normal",
                "message": f"{u} unfollowed you.",
            })

        for u in sorted(they_removed_you & favorites):
            diff_alerts.append({
                "kind": "favorite_removed_you",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} removed you as a follower.",
            })

        for u in sorted(they_removed_you - favorites):
            diff_alerts.append({
                "kind": "they_removed_you_as_follower",
                "username": u,
                "severity": "normal",
                "message": f"{u} removed you as a follower.",
            })

        # Favorites that previously didn't follow you back, but now do (became mutual).
        for u in sorted((curr.followers - prev.followers) & curr.following & favorites):
            diff_alerts.append({
                "kind": "favorite_now_follows_back",
                "username": u,
                "severity": "good",
                "message": f"★ Favorite {u} now follows you back.",
            })

    # Stateful: wait-back alerts.
    # Private accounts -> alert as soon as they're not following back.
    # Public/unknown   -> wait WAITBACK_ALERT_DAYS days first.
    stateful: list[dict] = []
    curr = snapshot_data(conn, latest)
    cutoff = datetime.now(timezone.utc) - timedelta(days=WAITBACK_ALERT_DAYS)
    watchlist_entries = list_with_flag(conn, "watchlist")
    privacy = privacy_status_bulk(conn, [e["username"] for e in watchlist_entries])

    for entry in watchlist_entries:
        u = entry["username"]
        added = _parse_iso(entry["added_at"])
        if added is None:
            continue
        if u in curr.followers:
            continue
        if u not in curr.following:
            continue
        status = privacy.get(u, "unknown")
        if status != "likely_private" and added > cutoff:
            continue
        days = (datetime.now(timezone.utc) - added).days
        if status == "likely_private":
            msg = f"↺ {u} (private) accepted but isn't following you back."
        else:
            msg = f"↺ {u} hasn't followed you back in {days} days."
        stateful.append({
            "kind": "waitback_overdue",
            "username": u,
            "severity": "normal",
            "message": msg,
            "days": days,
            "privacy": status,
        })

    # Stateful: tagged-as-disabled accounts that show real proof-of-life.
    # The only reliable signal is them appearing in YOUR followers (they actively
    # follow you back, so their account must be alive). `curr.following` and the
    # outgoing `pending` are both preserved by Instagram even after deactivation,
    # so they don't count as reactivation evidence.
    to_unflag: list[str] = []
    for entry in list_with_flag(conn, "disabled"):
        u = entry["username"]
        if u in curr.followers:
            stateful.append({
                "kind": "disabled_reactivated",
                "username": u,
                "severity": "high",
                "message": f"⚠ {u} (tagged disabled) is back online — flag cleared.",
            })
            to_unflag.append(u)
    for u in to_unflag:
        set_flag(conn, u, "disabled", False)

    return {
        "diff": diff_alerts,
        "stateful": stateful,
        "latest_snapshot_id": latest,
        "previous_snapshot_id": previous,
    }
