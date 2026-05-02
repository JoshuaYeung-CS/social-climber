"""Snapshot diffs and current-snapshot list views. Pure functions; SQL stays out."""

from .queries import SnapshotData


def diff(
    old: SnapshotData,
    new: SnapshotData,
    *,
    ever_self_unfollowed: set[str] | None = None,
) -> dict[str, list[str]]:
    """Compare two snapshots.

    `ever_self_unfollowed` is the union of every snapshot's `recently_unfollowed`
    set — the canonical record of accounts the *user* has unfollowed at any point.
    Used to distinguish "you unfollowed them" from "they removed you as a follower".
    """
    left_following = old.following - new.following
    self_initiated = ever_self_unfollowed if ever_self_unfollowed is not None else new.recently_unfollowed
    you_unfollowed = left_following & self_initiated
    they_removed_you = left_following - self_initiated
    return {
        "new_followers": sorted(new.followers - old.followers),
        "they_unfollowed_you": sorted(old.followers - new.followers),
        "unfollowers_you_still_follow": sorted((old.followers - new.followers) & new.following),
        "new_following": sorted(new.following - old.following),
        "you_unfollowed": sorted(you_unfollowed),
        "they_removed_you_as_follower": sorted(they_removed_you),
        "new_pending": sorted(new.pending - old.pending),
        "resolved_pending": sorted(old.pending - new.pending),
        "new_recent_requests": sorted(new.recent_follow_requests - old.recent_follow_requests),
        "new_recently_unfollowed": sorted(new.recently_unfollowed - old.recently_unfollowed),
    }


def current_lists(s: SnapshotData) -> dict[str, list[str]]:
    return {
        "all_followers": sorted(s.followers),
        "all_following": sorted(s.following),
        "mutuals": sorted(s.followers & s.following),
        "feeder_accounts": sorted(s.followers - s.following),
        "not_following_you_back": sorted(s.following - s.followers - s.incoming_requests),
        "pending": sorted(s.pending),
        "recent_follow_requests": sorted(s.recent_follow_requests),
        "recently_unfollowed": sorted(s.recently_unfollowed),
        "incoming_requests": sorted(s.incoming_requests),
    }


def ever_unfollowers(followers_by_sid: dict[int, set[str]], ordered_ids: list[int]) -> set[str]:
    """Anyone who was a follower in some snapshot but not the next."""
    out: set[str] = set()
    for old_id, new_id in zip(ordered_ids[:-1], ordered_ids[1:]):
        out |= followers_by_sid.get(old_id, set()) - followers_by_sid.get(new_id, set())
    return out
