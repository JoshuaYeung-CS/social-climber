from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent

DB_PATH = PROJECT_DIR / "data" / "instagram_tracker.db"
STATIC_DIR = PACKAGE_DIR / "static"

DEFAULT_PORT = 8000
DEFAULT_HOST = "0.0.0.0"

WAITBACK_ALERT_DAYS = 7
# "Want to remove" follow-up threshold, split by inferred privacy.
# Public accounts get 7 days because public follows are auto-accepted —
# if they wanted to follow back they'd have done it by now, but the
# user might still be hoping. Private accounts get 3 days because
# accept/reject is an explicit human action they take or don't.
# `now_public` (manual override) maps to PUBLIC; "unknown" defaults to
# PRIVATE so we err toward nudging the user sooner.
WANT_REMOVE_ALERT_DAYS_PUBLIC = 7
WANT_REMOVE_ALERT_DAYS_PRIVATE = 3
# Backwards-compat alias — code that just wants "the conservative
# default" can keep using this. New code should pick the per-privacy
# constant above.
WANT_REMOVE_ALERT_DAYS = WANT_REMOVE_ALERT_DAYS_PRIVATE
# How long a "they unfollowed you" event stays surfaced as a stateful
# alert after the unfollow happened. 7 days = one weekly cycle, long
# enough to see and act on (re-follow, tag, etc.) without piling up
# old alerts forever. The transient diff alert still fires per-import.
RECENT_UNFOLLOW_ALERT_DAYS = 7
