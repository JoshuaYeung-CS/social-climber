import hashlib
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -32000;        -- 32 MB page cache (negative = KB)
PRAGMA mmap_size = 268435456;      -- 256 MB memory-mapped I/O

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT,
    source_path TEXT,
    content_hash TEXT,
    taken_at TEXT,
    source_mtime REAL,
    source_size INTEGER
);
-- Index for taken_at is created in the migration block AFTER the ALTER for
-- pre-existing DBs, so we don't reference a column that's still being added.

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

CREATE TABLE IF NOT EXISTS incoming_follow_requests (
    snapshot_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT,
    export_timestamp INTEGER,
    PRIMARY KEY (snapshot_id, username),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_incoming_username ON incoming_follow_requests(username);

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
    random_request INTEGER NOT NULL DEFAULT 0,
    random_request_added_at TEXT,
    need_archive INTEGER NOT NULL DEFAULT 0,
    need_archive_added_at TEXT,
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

-- Live profile facts pulled from the IG page DOM by the browser
-- extension as the user browses. Not part of the official IG export
-- (which only gives username + href + timestamp). Each observation
-- overwrites the previous one for that username — current state only.
-- `is_private` is 1 only when we saw the literal "Account is Private"
-- banner; NULL otherwise (we can't prove public from the DOM).
CREATE TABLE IF NOT EXISTS profile_observations (
    username TEXT PRIMARY KEY,
    observed_at TEXT NOT NULL,
    display_name TEXT,
    bio TEXT,
    external_link TEXT,
    follower_count INTEGER,
    following_count INTEGER,
    post_count INTEGER,
    verified INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER,
    profile_pic_url TEXT,
    follow_button_state TEXT,
    follow_state_changed_at TEXT,
    is_unavailable INTEGER
);

-- Append-only audit trail of significant data operations: imports,
-- backfills, errors, resets, manual deletions. Lets the user (and a
-- future debugging session) reconstruct exactly what happened to the
-- DB without having to dig through console logs.
--
-- `op` is a short verb ("import", "import_error", "backfill",
-- "skip", "reset_snapshots", "rescan", "quarantine", etc.).
-- `target` is whatever object the op acted on (file path, snapshot id,
-- "all snapshots" for a wipe). `details_json` stores the full reason /
-- context as JSON so we don't have to invent columns for every kind of
-- detail.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    op TEXT NOT NULL,
    target TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_op ON audit_log(op);
"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


_INITIALIZED_PATHS: set[str] = set()
_FAST_PRAGMAS = (
    "PRAGMA synchronous = NORMAL;"
    "PRAGMA temp_store = MEMORY;"
    "PRAGMA cache_size = -32000;"
    "PRAGMA mmap_size = 268435456;"
)


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Per-process schema/migration is one-shot: the SCHEMA + ALTERs are
    # idempotent but each connection still pays ~5-15ms parsing/executing
    # them. After first init, every subsequent connection just sets the
    # connection-local fast pragmas and returns. Saves the cost on every
    # FastAPI request, which opens a fresh connection.
    key = str(db_path)
    if key in _INITIALIZED_PATHS:
        conn.executescript(_FAST_PRAGMAS)
        return conn

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
    if "random_request" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN random_request INTEGER NOT NULL DEFAULT 0")
    if "random_request_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN random_request_added_at TEXT")
    # now_public: manual override for accounts that flipped private→public
    # after approving you. Without it, the historical pending evidence
    # in your DB makes the account look "likely private" even though
    # it's currently public. Setting this tag forces the privacy display
    # to "🌐 public" (un-hedged) since the user has personally verified.
    if "now_public" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN now_public INTEGER NOT NULL DEFAULT 0")
    if "now_public_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN now_public_added_at TEXT")
    # need_archive: user-set "I want to archive this account" reminder.
    # Independent of whether archived files exist on disk — flips on
    # when the user marks intent, off when they clear it manually
    # (the extension also auto-clears it once archived items appear,
    # so the tag acts as a TODO list of accounts waiting to be saved).
    if "need_archive" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN need_archive INTEGER NOT NULL DEFAULT 0")
    if "need_archive_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN need_archive_added_at TEXT")
    # archive_skip: explicit "do NOT include in the auto-archive
    # queue" flag. Used by the home-page queue UI's Remove button so
    # the user can take a favorited account off the queue without
    # un-favoriting it. The runner endpoint excludes any account with
    # this flag set even if it's also in favorites or need_archive.
    if "archive_skip" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN archive_skip INTEGER NOT NULL DEFAULT 0")
    if "archive_skip_added_at" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN archive_skip_added_at TEXT")
    # Free-form per-account notes — the user can jot down a VSCO link,
    # who introduced them, why they're tagged, etc. One row per username
    # max; an empty/whitespace string is treated as no note.
    if "notes" not in cols:
        conn.execute("ALTER TABLE profile_tags ADD COLUMN notes TEXT")

    # profile_observations new columns for live button-state observation
    obs_cols = {row[1] for row in conn.execute("PRAGMA table_info(profile_observations)").fetchall()}
    if obs_cols and "follow_button_state" not in obs_cols:
        conn.execute("ALTER TABLE profile_observations ADD COLUMN follow_button_state TEXT")
    if obs_cols and "follow_state_changed_at" not in obs_cols:
        conn.execute("ALTER TABLE profile_observations ADD COLUMN follow_state_changed_at TEXT")
    if obs_cols and "is_unavailable" not in obs_cols:
        conn.execute("ALTER TABLE profile_observations ADD COLUMN is_unavailable INTEGER")

    snap_cols = {row[1] for row in conn.execute("PRAGMA table_info(snapshots)").fetchall()}
    if "content_hash" not in snap_cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN content_hash TEXT")
    if "taken_at" not in snap_cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN taken_at TEXT")
    # source_mtime / source_size: file fingerprint captured at import time so
    # the watcher can detect partial-then-fully-synced files (Drive can hand
    # us a 50KB stub, we import it, then Drive finishes streaming and the
    # file becomes 5MB — the path is the same but we want to re-process).
    if "source_mtime" not in snap_cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN source_mtime REAL")
    if "source_size" not in snap_cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN source_size INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_taken_at ON snapshots(taken_at)")
    # Unique partial index on content_hash defends against duplicate imports
    # under concurrency. The duplicate guard in ingest does its own SELECT
    # first, but two concurrent imports of the same export can both observe
    # an empty result before either commits — the unique index turns that
    # into a constraint violation that ingest catches and recovers from.
    # Partial because old rows may have NULL content_hash.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_content_hash_unique "
        "ON snapshots(content_hash) WHERE content_hash IS NOT NULL"
    )

    # Backfill content_hash for snapshots imported before this column existed,
    # so the duplicate check has a complete index. One-time per-snapshot cost;
    # the COUNT(*) guard skips work once everything is populated.
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

    # Backfill taken_at from each snapshot's parsed label. Without this,
    # chronological queries collapse to id-order (their old behaviour) for
    # any pre-existing snapshot, which is fine for the current data because
    # imports were always chronological — but the column has to be populated
    # for the indexed sort to actually use it.
    missing_ts = conn.execute(
        "SELECT COUNT(*) FROM snapshots WHERE taken_at IS NULL"
    ).fetchone()[0]
    if missing_ts:
        rows = conn.execute(
            "SELECT id, label, created_at FROM snapshots WHERE taken_at IS NULL"
        ).fetchall()
        for r in rows:
            ts = parse_label_to_iso(r["label"]) or r["created_at"]
            conn.execute("UPDATE snapshots SET taken_at = ? WHERE id = ?", (ts, int(r["id"])))

    conn.commit()
    _INITIALIZED_PATHS.add(key)
    return conn


def parse_label_to_iso(label: str | None) -> str | None:
    """Parse a snapshot label like '2026-04-30_14-31-18' into an ISO timestamp
    '2026-04-30T14:31:18' so it sorts correctly as a TEXT column. Returns None
    for unparseable labels — caller falls back to created_at."""
    if not label:
        return None
    import re
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", label)
    if m:
        y, mo, d, hh, mm, ss = m.groups()
        return f"{y}-{mo}-{d}T{hh}:{mm}:{ss}"
    return None


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
