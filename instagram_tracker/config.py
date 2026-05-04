from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent

DB_PATH = PROJECT_DIR / "data" / "instagram_tracker.db"
STATIC_DIR = PACKAGE_DIR / "static"

DEFAULT_PORT = 8000
DEFAULT_HOST = "0.0.0.0"

WAITBACK_ALERT_DAYS = 7
WANT_REMOVE_ALERT_DAYS = 3
