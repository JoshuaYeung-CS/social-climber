import sqlite3
from pathlib import Path
from datetime import datetime, timezone

SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT,
    source_path TEXT
);

CREATE TABLE IF NOT EXISTS followers (
    snapshot_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT,
    export_timestamp INTEGER,
    PRIMARY KEY (snapshot_id, username),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_followers_username ON followers(username);

CREATE TABLE IF NOT EXISTS following (
    snapshot_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT,
    export_timestamp INTEGER,
    PRIMARY KEY (snapshot_id, username),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_following_username ON following(username);

CREATE TABLE IF NOT EXISTS pending_follow_requests (
    snapshot_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT,
    export_timestamp INTEGER,
    source_label TEXT,
    PRIMARY KEY (snapshot_id, username),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_username ON pending_follow_requests(username);

CREATE TABLE IF NOT EXISTS recently_unfollowed (
    snapshot_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT,
    export_timestamp INTEGER,
    PRIMARY KEY (snapshot_id, username),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recently_unfollowed_username ON recently_unfollowed(username);

CREATE TABLE IF NOT EXISTS profile_tags (
    username TEXT PRIMARY KEY,
    favorite INTEGER NOT NULL DEFAULT 0,
    favorite_added_at TEXT,
    want_remove INTEGER NOT NULL DEFAULT 0,
    want_remove_added_at TEXT,
    watchlist INTEGER NOT NULL DEFAULT 0,
    watchlist_added_at TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    disabled_added_at TEXT,
    notes TEXT,
    profile_url TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS followup_queue (
    username TEXT PRIMARY KEY,
    profile_url TEXT,
    source_input TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)

    # Idempotent column adds for older databases.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(profile_tags)").fetchall()}
    if "disabled" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")
    if "disabled_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN disabled_added_at TEXT")

    conn.commit()
    return conn
