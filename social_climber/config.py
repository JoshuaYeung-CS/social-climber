from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent

DB_PATH = PROJECT_DIR / "data" / "social_climber.db"
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
# Auto-alert when a private account you follow hasn't followed you back
# within this many days. Mirrors WANT_REMOVE_ALERT_DAYS_PRIVATE but does
# NOT require the want_remove tag — fires for ANY private account you've
# been following past the threshold. The waitback_overdue (7d, watchlist-
# tagged only) and want_remove_overdue alerts handle the explicitly-
# tagged cases; this fills the un-tagged gap. Skipped for accounts
# already covered by those tagged paths so a single account never
# triggers two alerts.
PRIVATE_NO_FOLLOWBACK_ALERT_DAYS = 3
# Surface incoming follow-requests that have been pending for at least
# this many days. The diff alert (`new_incoming_request`) fires once
# per arrival, but if it goes unanswered it falls off the alerts panel
# the next import. This stateful version keeps unresolved requests
# visible so they don't get forgotten about. Threshold is generous —
# requests <3 days old are "still fresh, you'll see them when you
# next open the app"; alerts only kick in when something has been
# sitting and you might have lost track of it.
INCOMING_REQUEST_PENDING_DAYS = 3
