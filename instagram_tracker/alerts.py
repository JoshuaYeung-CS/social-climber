"""Alerts shown on the home screen.

Two flavors:
  - "diff" alerts: things that changed since the previous import (transient per import)
  - "stateful" alerts: derived from current state (e.g. wait-back overdue)
"""

import sqlite3
from datetime import datetime, timedelta, timezone

from .config import WAITBACK_ALERT_DAYS, WANT_REMOVE_ALERT_DAYS
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
    suppressed = (
        {r["username"] for r in list_with_flag(conn, "disabled")}
        | {r["username"] for r in list_with_flag(conn, "unavailable")}
        | {r["username"] for r in list_with_flag(conn, "random_request")}
    )
    if previous is not None:
        prev = snapshot_data(conn, previous)
        curr = snapshot_data(conn, latest)

        # IG-bounce filter, applied to BOTH sides:
        # IG occasionally drops accounts out of followers_*.json or
        # following.json and stuffs them into pending_follow_requests.json
        # or follow_requests_you've_received.json without a real change in
        # relationship. If an account is currently in either of those
        # active-relationship states, treat the disappearance as a data
        # quirk and don't fire a 'they unfollowed' / 'they removed' alert.
        # Verified case: snapshot #542 partial-export dropped 30 mutuals
        # to pending; the previous snapshot 43 min earlier still had them.
        bounced = curr.pending | curr.incoming_requests
        lost_followers = (prev.followers - curr.followers) - suppressed - bounced
        left_following = (prev.following - curr.following) - suppressed
        # Same-snapshot rule: if it's not in the new snapshot's recently_unfollowed,
        # the user didn't initiate the unfollow — assume they removed you.
        they_removed_you = left_following - curr.recently_unfollowed - bounced
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
    # Alert when a watchlist-tagged account hasn't followed you back
    # within WAITBACK_ALERT_DAYS (default 7) of when you tagged them.
    # Applies uniformly across privacy types — private and public both
    # get the same week-long grace period.
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
        if added > cutoff:
            continue  # haven't waited the full week yet
        days = (datetime.now(timezone.utc) - added).days
        status = privacy.get(u, "unknown")
        if status == "likely_private":
            msg = f"↺ {u} (private) accepted but hasn't followed you back in {days} days."
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

    # Stateful: want-remove follow-up alerts.
    # Accounts you tagged "want to remove" (✦) that you currently follow
    # AND who don't follow you back AND it's been WANT_REMOVE_ALERT_DAYS
    # (default 3) since you started following them. Acts as a reminder
    # to actually unfollow once the waiting period is up.
    want_remove_entries = list_with_flag(conn, "want_remove")
    if want_remove_entries:
        wr_usernames = [e["username"] for e in want_remove_entries]
        placeholders = ",".join("?" * len(wr_usernames))
        follow_ts_map: dict[str, int] = {}
        for r in conn.execute(
            f"SELECT username, MAX(export_timestamp) AS ts FROM following "
            f"WHERE username IN ({placeholders}) AND export_timestamp IS NOT NULL "
            f"GROUP BY username",
            wr_usernames,
        ).fetchall():
            if r["ts"] is not None:
                follow_ts_map[r["username"]] = int(r["ts"])

        wr_cutoff = datetime.now(timezone.utc) - timedelta(days=WANT_REMOVE_ALERT_DAYS)
        wr_privacy = privacy_status_bulk(conn, wr_usernames)
        for entry in want_remove_entries:
            u = entry["username"]
            if u not in curr.following:
                continue  # not currently following — nothing to remove
            if u in curr.followers:
                continue  # they follow back — handled by user, not overdue
            ts = follow_ts_map.get(u)
            if ts is None:
                continue
            followed_at = datetime.fromtimestamp(ts, tz=timezone.utc)
            if followed_at > wr_cutoff:
                continue  # haven't waited the threshold yet
            days = (datetime.now(timezone.utc) - followed_at).days
            status = wr_privacy.get(u, "unknown")
            stateful.append({
                "kind": "want_remove_overdue",
                "username": u,
                "severity": "normal",
                "message": f"✦ {u} — tagged 'want to remove'; still doesn't follow you back after {days} days.",
                "days": days,
                "privacy": status,
            })

    # Stateful: tagged-as-disabled or tagged-as-unavailable accounts that show
    # real proof-of-life. The only reliable signal is them appearing in YOUR
    # followers (they actively follow you back, so their account must be alive).
    # `curr.following` and outgoing `pending` are both preserved by Instagram
    # even after deactivation, so they don't count as reactivation evidence.
    for flag, icon, label in (
        ("disabled", "⚠", "disabled"),
        ("unavailable", "✕", "unavailable"),
        ("random_request", "🎲", "random request"),
    ):
        to_unflag: list[str] = []
        for entry in list_with_flag(conn, flag):
            u = entry["username"]
            if u in curr.followers:
                stateful.append({
                    "kind": f"{flag}_reactivated",
                    "username": u,
                    "severity": "high",
                    "message": f"{icon} {u} (tagged {label}) is back online — flag cleared.",
                })
                to_unflag.append(u)
        for u in to_unflag:
            set_flag(conn, u, flag, False)

    return {
        "diff": diff_alerts,
        "stateful": stateful,
        "latest_snapshot_id": latest,
        "previous_snapshot_id": previous,
    }
