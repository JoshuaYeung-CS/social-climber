import hashlib
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
    source_path TEXT,
    content_hash TEXT
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
    unavailable INTEGER NOT NULL DEFAULT 0,
    unavailable_added_at TEXT,
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
    if "unavailable" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN unavailable INTEGER NOT NULL DEFAULT 0")
    if "unavailable_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN unavailable_added_at TEXT")

    snap_cols = {row[1] for row in conn.execute("PRAGMA table_info(snapshots)").fetchall()}
    if "content_hash" not in snap_cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN content_hash TEXT")

    # Backfill content_hash for snapshots imported before this column existed,
    # so the duplicate check below has a complete index. One-time per-snapshot
    # cost; the COUNT(*) guard skips work once everything is populated.
    missing = conn.execute(
        "SELECT COUNT(*) FROM snapshots WHERE content_hash IS NULL"
    ).fetchone()[0]
    if missing:
        ids = [
            int(r[0])
            for r in conn.execute(
                "SELECT id FROM snapshots WHERE content_hash IS NULL"
            ).fetchall()
        ]
        for sid in ids:
            conn.execute(
                "UPDATE snapshots SET content_hash = ? WHERE id = ?",
                (compute_content_hash_from_db(conn, sid), sid),
            )

    conn.commit()
    return conn


_HASH_TABLES = ("followers", "following", "pending_follow_requests", "recently_unfollowed")


def compute_content_hash_from_db(conn: sqlite3.Connection, snapshot_id: int) -> str:
    """Hash all usernames stored for a snapshot, in a stable order. The same
    Instagram export imported twice produces identical row sets and therefore
    the same hash, regardless of insert order or filename."""
    h = hashlib.sha256()
    for table in _HASH_TABLES:
        h.update(table.encode())
        h.update(b"|")
        for r in conn.execute(
            f"SELECT username FROM {table} WHERE snapshot_id = ? ORDER BY username",
            (snapshot_id,),
        ).fetchall():
            h.update(b"\x00")
            h.update(r["username"].encode())
    return h.hexdigest()


def compute_content_hash_from_rows(
    followers: list,
    following: list,
    pending_merged: list,
    recently_unfollowed: list,
) -> str:
    """Same hash as compute_content_hash_from_db, computed from in-memory parsed rows.
    Each row tuple's first element is the username."""
    by_table = {
        "followers": followers,
        "following": following,
        "pending_follow_requests": pending_merged,
        "recently_unfollowed": recently_unfollowed,
    }
    h = hashlib.sha256()
    for table in _HASH_TABLES:
        h.update(table.encode())
        h.update(b"|")
        for u in sorted(r[0] for r in by_table[table]):
            h.update(b"\x00")
            h.update(u.encode())
    return h.hexdigest()
