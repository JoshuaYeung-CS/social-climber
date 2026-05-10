"""Alerts shown on the home screen.

Two flavors:
  - "diff" alerts: things that changed since the previous import (transient per import)
  - "stateful" alerts: derived from current state (e.g. wait-back overdue)
"""

import sqlite3
from datetime import datetime, timedelta, timezone

from .config import (
    PRIVATE_NO_FOLLOWBACK_ALERT_DAYS,
    RECENT_UNFOLLOW_ALERT_DAYS,
    WAITBACK_ALERT_DAYS,
    WANT_REMOVE_ALERT_DAYS_PRIVATE,
    WANT_REMOVE_ALERT_DAYS_PUBLIC,
)
from .queries import (
    latest_id,
    previous_id,
    privacy_status_bulk,
    snapshot_data,
)
from .tags import list_with_flag, set_flag


def _parse_iso(value: str | None) -> datetime | None:
    """Parse a stored timestamp into a tz-aware UTC datetime. Defensively
    promotes naive results to UTC so downstream comparisons against
    `datetime.now(timezone.utc)` never raise. Older rows may be naive even
    though current writes go through `utc_now_iso()` (which is tz-aware) —
    don't crash alerts the next time an old row resurfaces."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _privacy_label(status: str, now_public: bool = False) -> str:
    """Short privacy badge for inclusion in alert messages. Mirrors the
    site-wide invariant: "🔒 private" for any pending evidence, "🌐 public"
    for user-confirmed flips, "🌐 likely public" for inference, "?" when
    we have no signal."""
    if now_public:
        return "🌐 public"
    if status == "likely_private":
        return "🔒 private"
    if status == "likely_public":
        return "🌐 likely public"
    return "? unknown"


def compute_alerts(conn: sqlite3.Connection) -> dict:
    latest = latest_id(conn)
    if latest is None:
        return {"diff": [], "stateful": [], "latest_snapshot_id": None, "previous_snapshot_id": None}

    previous = previous_id(conn, latest)
    favorites = {row["username"] for row in list_with_flag(conn, "favorite")}

    # Reference timestamp for diff alerts: the latest snapshot's taken_at.
    # Diff events fired between prev and latest, so this approximates "when
    # did this happen" precisely enough to sort newest-first.
    latest_taken_at_iso = conn.execute(
        "SELECT taken_at FROM snapshots WHERE id = ?", (latest,)
    ).fetchone()
    latest_ts = 0
    if latest_taken_at_iso and latest_taken_at_iso["taken_at"]:
        try:
            dt = datetime.fromisoformat(latest_taken_at_iso["taken_at"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            latest_ts = int(dt.timestamp())
        except ValueError:
            pass

    diff_alerts: list[dict] = []
    suppressed = (
        {r["username"] for r in list_with_flag(conn, "disabled")}
        | {r["username"] for r in list_with_flag(conn, "unavailable")}
        | {r["username"] for r in list_with_flag(conn, "random_request")}
    )
    # Pre-load privacy + now_public for any usernames that might appear
    # in alerts, so each alert message can include a "(🔒 private)" /
    # "(🌐 likely public)" badge without per-alert queries.
    def _privacy_for(usernames: list[str]) -> tuple[dict, set]:
        if not usernames:
            return {}, set()
        priv = privacy_status_bulk(conn, usernames)
        ph = ",".join("?" * len(usernames))
        np = {r["username"] for r in conn.execute(
            f"SELECT username FROM profile_tags WHERE now_public = 1 AND username IN ({ph})",
            usernames,
        ).fetchall()}
        return priv, np

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

        # Partial-export guard for the pending-list diff.
        # IG occasionally emits an export with a dramatically truncated
        # pending_follow_requests.json (observed: 1,492 → ~0 in a single
        # 20-minute window). The set diff fires "rejected" for every
        # missing username, which is wrong — they're still pending IG-
        # side, the JSON just didn't include them this time.
        # If more than half of the previous snapshot's pending list
        # vanished in this transition, treat the whole pending diff as
        # noise: don't emit reject/accept alerts for the missing
        # accounts. Real reject/accept storms in a 20-min window
        # are vanishingly rare; partial exports are common enough that
        # this guard saves the user from a 1,000+ false-alert avalanche.
        # The legitimate diff still fires next import once IG re-includes
        # the pending list; bounce-collapse in the activity log handles
        # those.
        prev_pending_count = len(prev.pending)
        curr_pending_count = len(curr.pending)
        pending_partial_export = (
            prev_pending_count >= 50
            and curr_pending_count < prev_pending_count * 0.5
        )

        # Outbound follow request disappeared without becoming a follow:
        # they declined, expired, or the user cancelled. We can't tell
        # which from snapshot data alone — frame as "request rejected/
        # withdrawn" in the alert message.
        if pending_partial_export:
            request_rejected_outbound = set()
            request_accepted_outbound = set()
        else:
            request_rejected_outbound = (
                (prev.pending - curr.pending) - curr.following - suppressed
            )
            # Outbound follow request accepted (was pending, now in
            # following). Of those, the subset who haven't followed you
            # back yet AND aren't currently requesting to follow you.
            # This is the moment of acceptance — distinct from the
            # stateful 3-day overdue alert which catches the durable
            # state. The diff alert fires once at acceptance, the
            # stateful one keeps firing if they don't reciprocate
            # within the threshold window.
            request_accepted_outbound = (
                (prev.pending - curr.pending) & curr.following
            ) - suppressed
        accepted_no_followback = (
            request_accepted_outbound - curr.followers - curr.incoming_requests
        )
        # Same partial-export guard for the inbound-request side.
        prev_incoming_count = len(prev.incoming_requests)
        curr_incoming_count = len(curr.incoming_requests)
        incoming_partial_export = (
            prev_incoming_count >= 50
            and curr_incoming_count < prev_incoming_count * 0.5
        )
        # Inbound follow request disappeared without becoming a follow:
        # they withdrew, the user rejected, or it was auto-handled.
        # Same ambiguity, framed as "withdrew their request".
        if incoming_partial_export:
            request_withdrawn_inbound = set()
        else:
            request_withdrawn_inbound = (
                (prev.incoming_requests - curr.incoming_requests) - curr.followers - suppressed
            )

        # Single privacy lookup covering every account that could end up
        # in a diff alert. Includes all new mutuals so we can fire the
        # public_now_follows_back alert for non-favorite public accounts.
        diff_users = sorted(
            lost_followers
            | they_removed_you
            | request_rejected_outbound
            | request_withdrawn_inbound
            | accepted_no_followback
            | ((curr.followers - prev.followers) & curr.following)
        )
        diff_priv, diff_np = _privacy_for(diff_users)

        def _badge(u: str) -> str:
            return _privacy_label(diff_priv.get(u, "unknown"), u in diff_np)

        for u in sorted(lost_followers & favorites):
            diff_alerts.append({
                "kind": "favorite_unfollowed_you",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} ({_badge(u)}) unfollowed you.",
                "ts": latest_ts,
            })

        for u in sorted(lost_followers - favorites):
            diff_alerts.append({
                "kind": "they_unfollowed_you",
                "username": u,
                "severity": "normal",
                "message": f"{u} ({_badge(u)}) unfollowed you.",
                "ts": latest_ts,
            })

        for u in sorted(they_removed_you & favorites):
            diff_alerts.append({
                "kind": "favorite_removed_you",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} ({_badge(u)}) removed you as a follower.",
                "ts": latest_ts,
            })

        for u in sorted(they_removed_you - favorites):
            diff_alerts.append({
                "kind": "they_removed_you_as_follower",
                "username": u,
                "severity": "normal",
                "message": f"{u} ({_badge(u)}) removed you as a follower.",
                "ts": latest_ts,
            })

        # Outbound request was rejected / withdrew — your pending dropped
        # without becoming a follow. Favorites get high severity since
        # the user explicitly cared about getting that follow.
        for u in sorted(request_rejected_outbound & favorites):
            diff_alerts.append({
                "kind": "favorite_my_request_rejected",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} ({_badge(u)}) — your follow request was rejected/withdrew.",
                "ts": latest_ts,
            })

        for u in sorted(request_rejected_outbound - favorites):
            diff_alerts.append({
                "kind": "my_request_rejected",
                "username": u,
                "severity": "normal",
                "message": f"✕ {u} ({_badge(u)}) — your follow request was rejected/withdrew.",
                "ts": latest_ts,
            })

        # Inbound request disappeared — they withdrew, you rejected, or
        # it was auto-handled. Framed as "removed their request" since
        # that's the most user-relevant interpretation.
        for u in sorted(request_withdrawn_inbound & favorites):
            diff_alerts.append({
                "kind": "favorite_removed_their_request",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} ({_badge(u)}) removed their follow request to you.",
                "ts": latest_ts,
            })

        for u in sorted(request_withdrawn_inbound - favorites):
            diff_alerts.append({
                "kind": "removed_their_request",
                "username": u,
                "severity": "normal",
                "message": f"✕ {u} ({_badge(u)}) removed their follow request to you.",
                "ts": latest_ts,
            })

        # NOTE: previously emitted diff alerts for "they accepted but
        # haven't followed back" (kinds: accepted_no_followback /
        # favorite_accepted_no_followback) — disabled per user request
        # because these resolve fast (private accepts often follow back
        # within hours) and were filling the alerts panel with state
        # that's about to change. The set `accepted_no_followback` is
        # still computed above so future re-enablement is a one-line
        # restore. The /api/lists "private_accepted_no_follow_back"
        # surface remains the durable view of this state.

        # New mutuals this snapshot — accounts that joined your followers
        # AND that you're already following.
        new_mutuals = (curr.followers - prev.followers) & curr.following

        # Favorites get the high-severity flavor.
        for u in sorted(new_mutuals & favorites):
            diff_alerts.append({
                "kind": "favorite_now_follows_back",
                "username": u,
                "severity": "high",
                "message": f"★ Favorite {u} ({_badge(u)}) now follows you back.",
                "ts": latest_ts,
            })

        # Public non-favorites also get a notification — these are the
        # follow-backs you didn't have to send a request for, so it's
        # worth knowing they came through. Skipped for private accounts
        # (those already get covered by the watchlist/waitback flow when
        # the user explicitly asked to be reminded).
        for u in sorted(new_mutuals - favorites):
            status = diff_priv.get(u, "unknown")
            is_now_public = u in diff_np
            if status == "likely_public" or is_now_public:
                diff_alerts.append({
                    "kind": "public_now_follows_back",
                    "username": u,
                    "severity": "normal",
                    "message": f"🌐 {u} ({_badge(u)}) now follows you back.",
                    "ts": latest_ts,
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
    watchlist_usernames = [e["username"] for e in watchlist_entries]
    privacy = privacy_status_bulk(conn, watchlist_usernames)
    # Pull now_public tags for the watchlist set so we can render the
    # accurate privacy badge (privacy_status_bulk doesn't see manual tags).
    now_public_set: set[str] = set()
    if watchlist_usernames:
        ph = ",".join("?" * len(watchlist_usernames))
        for r in conn.execute(
            f"SELECT username FROM profile_tags WHERE now_public = 1 AND username IN ({ph})",
            watchlist_usernames,
        ).fetchall():
            now_public_set.add(r["username"])

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
        priv_label = _privacy_label(status, u in now_public_set)
        is_fav = u in favorites
        prefix = "★↺" if is_fav else "↺"
        fav_label = "★ Favorite " if is_fav else ""
        # For private accounts the user already cleared an approval gate,
        # so the "they accepted but didn't follow back" framing is the
        # informative one. For everyone else, just say the wait time.
        if status == "likely_private" and u not in now_public_set:
            msg = f"{prefix} {fav_label}{u} ({priv_label}) accepted but hasn't followed you back in {days} days."
        else:
            msg = f"{prefix} {fav_label}{u} ({priv_label}) hasn't followed you back in {days} days."
        stateful.append({
            "kind": "waitback_overdue",
            "username": u,
            "severity": "high" if is_fav else "normal",
            "message": msg,
            "days": days,
            "privacy": status,
            "ts": int(added.timestamp()),
        })

    # Stateful: want-remove follow-up alerts.
    # Accounts you tagged "want to remove" (✦) that you currently follow
    # AND who don't follow you back AND it's been past the per-privacy
    # threshold since you started following them. Public accounts get
    # WANT_REMOVE_ALERT_DAYS_PUBLIC (default 7) — auto-accept means
    # they'd have followed back already if they were going to. Private
    # accounts get WANT_REMOVE_ALERT_DAYS_PRIVATE (default 3) — accept
    # is a manual decision they took or didn't.
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

        now_utc = datetime.now(timezone.utc)
        wr_privacy = privacy_status_bulk(conn, wr_usernames)
        # now_public tag overrides the inferred privacy for the badge.
        wr_now_public_set: set[str] = set()
        ph = ",".join("?" * len(wr_usernames))
        for r in conn.execute(
            f"SELECT username FROM profile_tags WHERE now_public = 1 AND username IN ({ph})",
            wr_usernames,
        ).fetchall():
            wr_now_public_set.add(r["username"])
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
            status = wr_privacy.get(u, "unknown")
            is_now_public = u in wr_now_public_set
            # Pick the threshold per privacy. now_public (user manually
            # confirmed they went public) maps to the public threshold.
            # Unknown defaults to the private threshold so we nudge
            # sooner when we can't tell.
            if status == "likely_public" or is_now_public:
                threshold_days = WANT_REMOVE_ALERT_DAYS_PUBLIC
            else:
                threshold_days = WANT_REMOVE_ALERT_DAYS_PRIVATE
            cutoff = now_utc - timedelta(days=threshold_days)
            if followed_at > cutoff:
                continue  # haven't waited the threshold yet
            days = (now_utc - followed_at).days
            priv_label = _privacy_label(status, is_now_public)
            is_fav = u in favorites
            prefix = "★✦" if is_fav else "✦"
            fav_label = "★ Favorite " if is_fav else ""
            stateful.append({
                "kind": "want_remove_overdue",
                "username": u,
                "severity": "high" if is_fav else "normal",
                "message": f"{prefix} {fav_label}{u} ({priv_label}) — tagged 'want to remove'; still doesn't follow you back after {days} days.",
                "days": days,
                "privacy": status,
                "ts": int(followed_at.timestamp()),
            })

    # NOTE: stateful "private_no_followback_overdue" alert removed
    # per user request. It fired 3+ days after a private account
    # accepted without following back, but private accept→follow-back
    # often takes longer than the threshold for benign reasons (they
    # check back when active, etc.) and the panel got cluttered with
    # state about to flip on its own. The user's explicit-action paths
    # still cover this:
    #   ★ Favorite + want_remove → want_remove_overdue (3d / 7d split)
    #   ↺ watchlist → waitback_overdue (7d uniform)
    #   /api/lists "private_accepted_no_follow_back" → durable view of
    #     this state without alert pressure.
    # PRIVATE_NO_FOLLOWBACK_ALERT_DAYS still lives in config so re-
    # enabling is a one-block restore.

    # Stateful: recent unfollows. Surfaces every account whose last
    # appearance in your followers was within the past
    # RECENT_UNFOLLOW_ALERT_DAYS days but who isn't a follower now and
    # isn't in pending/incoming (the IG-bounce filter — they may have
    # just flickered through pending). Persists across snapshots until
    # the window expires or they re-follow, so the user has a week to
    # see and act on each event instead of having to catch the single-
    # diff transient alert. The diff alerts above (they_unfollowed_you,
    # favorite_unfollowed_you) still fire per-import; the stateful one
    # is the durable companion view.
    #
    # CRITICAL: use MAX(snapshots.taken_at) — the most recent moment IG
    # saw them as a follower — NOT MAX(followers.export_timestamp). The
    # export_timestamp is when they first hit Follow (or the last time
    # they re-followed); it has nothing to do with when they unfollowed.
    # An earlier version used export_timestamp and produced two bugs:
    #   1. The "N days ago" number was wrong — said "5 days ago" when
    #      they actually unfollowed today, because their original follow
    #      was 5 days ago.
    #   2. Long-time followers who unfollowed got missed entirely — if
    #      they followed in 2023, their MAX(export_timestamp) was 2 years
    #      old, so they fell outside the 7-day cutoff even when the
    #      unfollow was yesterday.
    # snapshots.taken_at fixes both: it's the actual most recent
    # observation we have of them as a follower, regardless of when the
    # original follow occurred.
    cutoff_unfollow = datetime.now(timezone.utc) - timedelta(days=RECENT_UNFOLLOW_ALERT_DAYS)
    # Match the taken_at column's stored format (naive ISO, no tz
    # suffix, no microseconds) for the lexical SQL comparison. Without
    # this, the cutoff string is "2026-05-01T16:00:00.123456+00:00"
    # and snapshot strings like "2026-05-01T16:00:00" sort BEFORE it
    # because the longer suffix makes the cutoff lexically greater —
    # silently excluding snapshots within a few seconds of the cutoff.
    cutoff_unfollow_iso = cutoff_unfollow.replace(
        tzinfo=None, microsecond=0
    ).isoformat()
    bounced_now = curr.pending | curr.incoming_requests
    last_seen_iso: dict[str, str] = {}
    for r in conn.execute(
        "SELECT f.username, MAX(s.taken_at) AS last_seen "
        "FROM followers f "
        "JOIN snapshots s ON s.id = f.snapshot_id "
        "WHERE s.taken_at IS NOT NULL "
        "GROUP BY f.username "
        "HAVING last_seen >= ?",
        (cutoff_unfollow_iso,),
    ).fetchall():
        if r["last_seen"]:
            last_seen_iso[r["username"]] = r["last_seen"]

    recent_unfollow_users = [
        u for u in last_seen_iso
        if u not in curr.followers
        and u not in suppressed
        and u not in bounced_now
    ]
    ru_priv, ru_np = _privacy_for(recent_unfollow_users)
    now_utc = datetime.now(timezone.utc)
    for u in sorted(recent_unfollow_users, key=lambda x: last_seen_iso[x], reverse=True):
        last_seen = _parse_iso(last_seen_iso[u])
        if last_seen is None:
            continue
        # snapshots.taken_at is stored as a naive ISO string in some
        # legacy rows. Promote it to UTC so the timezone-aware
        # subtraction doesn't throw "can't subtract offset-naive and
        # offset-aware datetimes".
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        days_ago = (now_utc - last_seen).days
        is_fav = u in favorites
        priv_label = _privacy_label(ru_priv.get(u, "unknown"), u in ru_np)
        prefix = "★⤴" if is_fav else "⤴"
        fav_label = "★ Favorite " if is_fav else ""
        when_text = "today" if days_ago == 0 else (
            f"{days_ago} day{'s' if days_ago != 1 else ''} ago"
        )
        stateful.append({
            "kind": "recent_unfollow" if not is_fav else "favorite_recent_unfollow",
            "username": u,
            "severity": "high" if is_fav else "normal",
            # The unfollow happened SOMETIME after we last saw them — we
            # can't pinpoint the exact moment. The "last seen" phrasing
            # is honest about that limit. "N days ago" = how long since
            # the most recent snapshot they were still in.
            "message": f"{prefix} {fav_label}{u} ({priv_label}) unfollowed you (last seen following {when_text}).",
            "days": days_ago,
            "privacy": ru_priv.get(u, "unknown"),
            "ts": int(last_seen.timestamp()),
        })

    # Stateful: inbound request withdrawn / expired. Mirrors the
    # recent_unfollow pattern but for the incoming_follow_requests
    # table. Surfaces every account whose last appearance in your
    # incoming requests was within the past RECENT_UNFOLLOW_ALERT_DAYS
    # days but who isn't currently requesting AND isn't currently a
    # follower (which would mean you accepted and they followed
    # through). The diff alert (removed_their_request /
    # favorite_removed_their_request) fires once per import; this
    # stateful one keeps surfacing them for a week so the user has
    # time to notice + act on missed requests.
    #
    # IG doesn't tell us WHO ended it (they withdrew vs you ignored
    # vs auto-expired) — same ambiguity as request_withdrawn_inbound
    # in the diff path. Phrasing stays honest.
    cutoff_request = datetime.now(timezone.utc) - timedelta(days=RECENT_UNFOLLOW_ALERT_DAYS)
    cutoff_request_iso = cutoff_request.replace(
        tzinfo=None, microsecond=0
    ).isoformat()
    last_requested_iso: dict[str, str] = {}
    for r in conn.execute(
        "SELECT i.username, MAX(s.taken_at) AS last_seen "
        "FROM incoming_follow_requests i "
        "JOIN snapshots s ON s.id = i.snapshot_id "
        "WHERE s.taken_at IS NOT NULL "
        "GROUP BY i.username "
        "HAVING last_seen >= ?",
        (cutoff_request_iso,),
    ).fetchall():
        if r["last_seen"]:
            last_requested_iso[r["username"]] = r["last_seen"]
    # Skip users already surfaced by recent_unfollow. IG's pending-list
    # bounce sometimes flicks an unfollower briefly through your incoming
    # requests on the way out (the same memo'd quirk that drives the
    # bounced-now filter on the diff side); without this skip, we'd
    # double-alert on the same real-world event with two different
    # framings, none of them quite right.
    _ru_set = set(recent_unfollow_users)
    recent_request_withdrawn_users = [
        u for u in last_requested_iso
        if u not in curr.incoming_requests
        and u not in curr.followers
        and u not in suppressed
        and u not in _ru_set
    ]
    rw_priv, rw_np = _privacy_for(recent_request_withdrawn_users)
    for u in sorted(recent_request_withdrawn_users,
                     key=lambda x: last_requested_iso[x], reverse=True):
        last_seen = _parse_iso(last_requested_iso[u])
        if last_seen is None:
            continue
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        days_ago = (now_utc - last_seen).days
        is_fav = u in favorites
        priv_label = _privacy_label(rw_priv.get(u, "unknown"), u in rw_np)
        prefix = "★✕" if is_fav else "✕"
        fav_label = "★ Favorite " if is_fav else ""
        when_text = "today" if days_ago == 0 else (
            f"{days_ago} day{'s' if days_ago != 1 else ''} ago"
        )
        stateful.append({
            "kind": "favorite_recent_request_withdrawn" if is_fav else "recent_request_withdrawn",
            "username": u,
            "severity": "high" if is_fav else "normal",
            "message": f"{prefix} {fav_label}{u} ({priv_label}) — their follow request to you went away (last seen requesting {when_text}).",
            "days": days_ago,
            "privacy": rw_priv.get(u, "unknown"),
            "ts": int(last_seen.timestamp()),
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
                    "ts": latest_ts,
                })
                to_unflag.append(u)
        for u in to_unflag:
            set_flag(conn, u, flag, False)

    # Dedup against stateful alerts: the per-import diff alert
    # duplicates the same event surfaced by the matching stateful
    # alert (which carries the "N days ago" suffix and persists for a
    # week). Suppress the diff side so the user sees one entry per
    # real-world event, not two.
    #
    # Pairs:
    #   they_unfollowed_you / favorite_unfollowed_you
    #     ↔ recent_unfollow / favorite_recent_unfollow
    #   they_removed_you_as_follower / favorite_removed_you
    #     ↔ recent_unfollow / favorite_recent_unfollow (same source list)
    #   removed_their_request / favorite_removed_their_request
    #     ↔ recent_request_withdrawn / favorite_recent_request_withdrawn
    # Other diff kinds (request_rejected, accepted, public_now_follows_back)
    # have no stateful equivalent — those pass through.
    _stateful_unfollow_users = {
        a["username"] for a in stateful
        if a.get("kind") in ("recent_unfollow", "favorite_recent_unfollow")
    }
    _stateful_request_withdrawn_users = {
        a["username"] for a in stateful
        if a.get("kind") in ("recent_request_withdrawn", "favorite_recent_request_withdrawn")
    }
    diff_alerts = [
        a for a in diff_alerts
        if not (
            a.get("kind") in (
                "they_unfollowed_you", "favorite_unfollowed_you",
                "they_removed_you_as_follower", "favorite_removed_you",
            ) and a.get("username") in _stateful_unfollow_users
        ) and not (
            a.get("kind") in (
                "removed_their_request", "favorite_removed_their_request",
            ) and a.get("username") in _stateful_request_withdrawn_users
        )
    ]

    # Sort newest-first by ts. Pure chronological — favorites and
    # non-favorites interleave by date, so the most recent activity
    # always reads at the top regardless of severity. Username is the
    # secondary sort to keep ordering stable when many alerts share
    # the same ts (e.g. all the diff alerts firing for one import).
    diff_alerts.sort(key=lambda a: (-a.get("ts", 0), a.get("username", "")))
    stateful.sort(key=lambda a: (-a.get("ts", 0), a.get("username", "")))

    return {
        "diff": diff_alerts,
        "stateful": stateful,
        "latest_snapshot_id": latest,
        "previous_snapshot_id": previous,
    }
