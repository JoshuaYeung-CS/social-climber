"""Polling folder watcher for auto-importing Instagram export zips.

Watches a folder (recursively) for `.zip` files matching IG export naming
patterns and runs `ingest.import_path` on anything new it finds. Designed
for the Google Drive desktop / iCloud Drive / Dropbox flow: Meta drops a
zip into your Drive, Drive syncs it down to your Mac, the watcher sees it,
and the snapshot lands in the database without you touching anything.

Polling rather than fsevents/inotify because the cloud-storage virtual
filesystems (Google Drive's stream files, iCloud Drive's data-saver mode)
don't always fire reliable filesystem events for newly-synced files —
they materialize as placeholders first, then the file content streams in
on first read. A 30-second poll is the safe, simple option and the cost
is trivial (a single `rglob`).

Activation: set IG_WATCH_FOLDER in the environment when starting the
server. Empty / unset = no watcher.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path

from .config import DB_PATH
from .db import connect
from .ingest import import_path

log = logging.getLogger("instagram_tracker.watcher")

# Serializes scan_once() calls. Without this, two near-simultaneous button
# clicks (or a button click + the polling thread) could race the duplicate
# guard in ingest and produce double-imported snapshots. The unique
# content_hash index in db.py is the second line of defence.
_SCAN_LOCK = threading.Lock()

# Paths that errored or produced suspect output during the current process's
# lifetime. The watcher always re-attempts these on the next scan even when
# they path-match an existing snapshot — handles the "I just clicked scan
# again, why are the same errors back" complaint when Drive is mid-sync.
# Successful imports remove the path from this set.
_RECENT_ERROR_PATHS: set[str] = set()

# Files that returned EDEADLK (Drive Desktop sync lock). Tracked so the
# scan endpoint can report the count without us spamming audit_log every
# minute with the same error rows.
_DEFERRED_PATHS: set[str] = set()


def clear_seen_cache() -> None:
    """Reset the in-memory recent-error + deferred sets. Called after
    a snapshot reset so the next scan treats every file as fresh."""
    _RECENT_ERROR_PATHS.clear()
    _DEFERRED_PATHS.clear()

# Filename patterns Meta uses for the artifacts we care about. Matched
# case-insensitively against the basename. Two flavors:
#   - .zip files (Meta's "Send to email" delivery, or a Drive download)
#   - bare folders named meta-YYYY-Mon-DD-HH-MM-SS or instagram-* (Meta's
#     "Send to Google Drive" delivery uploads extracted contents, not a
#     zip — they show up as ordinary folders in your Drive)
_ZIP_PATTERNS = [
    re.compile(r"^instagram-.*\.zip$", re.IGNORECASE),
    re.compile(r"^meta-.*\.zip$", re.IGNORECASE),
    re.compile(r"^drive-download-.*\.zip$", re.IGNORECASE),
]
_FOLDER_PATTERNS = [
    re.compile(r"^meta-\d{4}-[A-Za-z]{3}-\d{2}-\d{2}-\d{2}-\d{2}$", re.IGNORECASE),
    re.compile(r"^instagram-.*$", re.IGNORECASE),
]

# How often to scan the watch root when polling is enabled.
# Now that _scan only lists the root + known subfolders (no rglob), a poll
# is sub-second on Drive's virtual filesystem. 60s is a reasonable default
# that picks up new exports quickly without thrashing.
_POLL_INTERVAL_S = int(os.environ.get("IG_WATCH_INTERVAL_S", "60"))


def _looks_like_ig_zip(name: str) -> bool:
    return any(p.match(name) for p in _ZIP_PATTERNS)


def _looks_like_ig_folder(name: str) -> bool:
    return any(p.match(name) for p in _FOLDER_PATTERNS)


def _load_skiplist() -> set[str]:
    """Read data/import_skiplist.txt — one absolute path per line, # comments
    allowed. Paths in the skiplist are silently ignored by _scan() so the
    user can tag bad exports (truncated, partial, manually flagged) without
    deleting the underlying folder from Drive. Returns a set of resolved
    absolute path strings for fast lookup."""
    skip_path = Path(__file__).resolve().parent.parent / "data" / "import_skiplist.txt"
    if not skip_path.exists():
        return set()
    out: set[str] = set()
    try:
        for line in skip_path.read_text().splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            try:
                out.add(str(Path(s).expanduser().resolve()))
            except Exception:
                out.add(s)
    except OSError as e:
        log.warning("Could not read skiplist %s: %s", skip_path, e)
    return out


def _scan(root: Path) -> list[Path]:
    """Look for IG export artifacts at the root and a few likely subfolders.

    Two artifact shapes:
      - `.zip` files (the email-delivery flow)
      - bare `meta-YYYY-Mon-DD-HH-MM-SS/` directories (the Send-to-Drive
        flow uploads pre-extracted contents)

    Listing is non-recursive because the Drive virtual filesystem is slow
    to enumerate large trees (105s rglob benchmark on the user's actual
    Drive). We do peek into a handful of well-known subfolder names users
    sometimes organize their exports into."""
    out: list[Path] = []
    candidate_dirs = [root]
    for sub in ("Meta", "Instagram", "Meta Exports", "Instagram Exports", "instagram", "meta"):
        sd = root / sub
        if sd.is_dir():
            candidate_dirs.append(sd)
    for d in candidate_dirs:
        try:
            for p in d.iterdir():
                if p.is_file() and _looks_like_ig_zip(p.name):
                    out.append(p)
                elif p.is_dir() and _looks_like_ig_folder(p.name):
                    # import_path handles folders too — it just finds the
                    # `followers_and_following` subdir and ingests from there.
                    out.append(p)
        except (OSError, PermissionError) as e:
            log.warning("Scan of %s failed: %s", d, e)
    # Dedup in case the same path is reachable from multiple candidate dirs.
    seen_paths: set[str] = set()
    deduped: list[Path] = []
    skiplist = _load_skiplist()
    skipped_count = 0
    for p in out:
        s = str(p.resolve())
        if s in skiplist:
            skipped_count += 1
            continue
        if s not in seen_paths:
            seen_paths.add(s)
            deduped.append(p)
    if skipped_count:
        log.info("Skipped %d export(s) listed in import_skiplist.txt", skipped_count)
    return deduped


def _file_key(p: Path) -> tuple[str, int, int]:
    """Identity tuple we use to decide if a path is 'the same' as one we've
    already processed. (path, mtime, size) — survives Drive re-syncs that
    re-upload the same content under the same path. For folders we use the
    inode mtime, which Drive bumps when contents change."""
    st = p.stat()
    return (str(p), int(st.st_mtime), int(st.st_size))


def _is_drive_placeholder(p: Path) -> bool:
    """A Drive 'stream files' placeholder is a stub the desktop app shows
    before the actual content has streamed down. For zip files this manifests
    as a tiny file (<1KB). Folders don't have placeholder behavior at the
    folder level — their entries materialize as you list them — so we only
    apply the check to files."""
    if not p.is_file():
        return False
    try:
        return p.stat().st_size < 1024
    except OSError:
        return True


def _import_one(zip_path: Path) -> None:
    log.info("Auto-importing %s", zip_path.name)
    conn = None
    try:
        conn = connect(DB_PATH)
        run = import_path(conn, zip_path)
        for r in run.imports:
            log.info("  + #%d %s (F=%d G=%d)", r.snapshot_id, r.label,
                     r.counts.get("followers", 0), r.counts.get("following", 0))
        for s in run.skipped:
            log.info("  [%s] %s — %s", s.reason, s.label, s.message[:120])
    except Exception as e:
        log.error("Import failed for %s: %s", zip_path, e)
    finally:
        if conn is not None:
            conn.close()


def _load_fingerprints() -> dict[str, tuple[float | None, int | None]]:
    """Map of source_path → (mtime, size) captured at import time. Same
    semantic both the polling loop and the manual scan_once use to decide
    whether a path-matching file should be re-processed."""
    out: dict[str, tuple[float | None, int | None]] = {}
    conn = None
    try:
        conn = connect(DB_PATH)
        for r in conn.execute(
            "SELECT source_path, source_mtime, source_size FROM snapshots "
            "WHERE source_path IS NOT NULL AND source_path != ''"
        ).fetchall():
            out[str(r["source_path"])] = (r["source_mtime"], r["source_size"])
    except Exception as e:
        log.warning("Failed to read previously-imported fingerprints: %s", e)
    finally:
        if conn is not None:
            conn.close()
    return out


def _file_unchanged_since_import(p: Path, prev: tuple[float | None, int | None]) -> bool:
    """True iff the file at p still has the size + mtime we recorded when
    we imported it. Fingerprint mismatch (or stat failure) means re-process."""
    prev_mtime, prev_size = prev
    if prev_mtime is None and prev_size is None:
        # Legacy row with no fingerprint — trust path-only equality.
        return True
    try:
        st = p.stat()
    except OSError:
        return False
    if prev_size is not None and int(st.st_size) != int(prev_size):
        return False
    if prev_mtime is not None and abs(float(st.st_mtime) - float(prev_mtime)) > 1.0:
        return False
    return True


def _watcher_loop(root: Path) -> None:
    log.info("Watcher started on %s (polling every %ds)", root, _POLL_INTERVAL_S)

    while True:
        try:
            current = _scan(root)
            fingerprints = _load_fingerprints()
            for p in current:
                path_str = str(p)
                if path_str not in _RECENT_ERROR_PATHS:
                    prev = fingerprints.get(path_str)
                    if prev is not None and _file_unchanged_since_import(p, prev):
                        continue
                if _is_drive_placeholder(p):
                    log.debug("Skipping %s (Drive placeholder, content not synced yet)", p.name)
                    _RECENT_ERROR_PATHS.add(path_str)
                    continue
                _import_one(p)
                # _import_one logs internally; we don't have a clean status
                # back here, so leave _RECENT_ERROR_PATHS management to the
                # manual-scan path which has finer-grained outcomes.
        except Exception as e:
            log.error("Watcher iteration failed: %s", e)
        time.sleep(_POLL_INTERVAL_S)


def get_watch_folder() -> Path | None:
    """Resolve IG_WATCH_FOLDER from the env into an absolute path. Returns
    None if unset, missing, or not a directory."""
    raw = os.environ.get("IG_WATCH_FOLDER", "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        return None
    return p


def scan_once(force: bool = False) -> dict:
    """Run a single scan-and-import pass synchronously. Used by the manual
    'Scan Drive folder' button on the home page so the user can trigger an
    import on demand without paying for background polling. Serialized via
    _SCAN_LOCK so concurrent invocations can't race on the duplicate guard.

    `force=True` bypasses the path-fingerprint dedup so EVERY file gets
    re-extracted and re-evaluated by ingest's content-hash dedup. Slower
    but catches files that the fingerprint check incorrectly skipped
    (e.g. Drive returned cached bytes that didn't actually match the
    current on-disk file)."""
    if not _SCAN_LOCK.acquire(blocking=False):
        return {
            "ok": False,
            "watch_folder": str(get_watch_folder()) if get_watch_folder() else None,
            "message": "A scan is already running — wait for it to finish.",
            "scanned": 0,
            "imported": 0,
            "skipped": 0,
        }
    try:
        return _scan_once_locked(force=force)
    finally:
        _SCAN_LOCK.release()


def _scan_once_locked(force: bool = False) -> dict:
    root = get_watch_folder()
    if root is None:
        return {
            "ok": False,
            "watch_folder": None,
            "message": (
                "No watch folder configured. Set IG_WATCH_FOLDER to your Drive "
                "path (or the Meta-exports subfolder inside it) and restart."
            ),
            "scanned": 0,
            "imported": 0,
            "skipped": 0,
        }
    files = _scan(root)

    # Build the dedup map: path → (mtime, size) recorded at the import time
    # of any prior successful snapshot. We skip a file ONLY when the path
    # matches AND the current file's fingerprint matches the stored one.
    # If the file changed (most common cause: Drive finished syncing a
    # placeholder we already partial-imported), we re-process — which lets
    # ingest's content_hash dedup either spot a real duplicate or land
    # the corrected snapshot data.
    #
    # Legacy snapshots (imported before source_mtime/source_size existed)
    # have NULL fingerprints; for those we keep the old path-only behaviour
    # to avoid spuriously re-processing every file on first scan after the
    # column upgrade.
    fingerprints: dict[str, tuple[float | None, int | None]] = {}
    conn0 = None
    try:
        conn0 = connect(DB_PATH)
        for r in conn0.execute(
            "SELECT source_path, source_mtime, source_size FROM snapshots "
            "WHERE source_path IS NOT NULL AND source_path != ''"
        ).fetchall():
            fingerprints[str(r["source_path"])] = (r["source_mtime"], r["source_size"])
    finally:
        if conn0 is not None:
            conn0.close()

    def can_skip(p: Path) -> bool:
        # Force mode: never skip. Every file gets re-extracted and the
        # ingest content-hash dedup decides what's a real duplicate.
        if force:
            return False
        path_str = str(p)
        # Force-retry paths that errored earlier in this process's lifetime.
        if path_str in _RECENT_ERROR_PATHS:
            return False
        prev = fingerprints.get(path_str)
        if prev is None:
            return False
        prev_mtime, prev_size = prev
        # Legacy row with no fingerprint recorded — fall back to path-only
        # skip so we don't re-import every file after upgrading.
        if prev_mtime is None and prev_size is None:
            return True
        try:
            st = p.stat()
        except OSError:
            return False
        # Size is the strong signal (Drive grows the file as it syncs).
        # mtime can lie on some networked filesystems, so we only trust it
        # when size hasn't changed.
        if prev_size is not None and int(st.st_size) != int(prev_size):
            return False
        if prev_mtime is not None and abs(float(st.st_mtime) - float(prev_mtime)) > 1.0:
            return False
        return True

    imported = skipped = already = 0
    details: list[dict] = []
    for p in files:
        if can_skip(p):
            already += 1
            continue
        if _is_drive_placeholder(p):
            details.append({"file": p.name, "outcome": "placeholder",
                            "message": "Drive hasn't synced this file's content yet"})
            _RECENT_ERROR_PATHS.add(str(p))
            continue
        conn = None
        try:
            conn = connect(DB_PATH)
            run = import_path(conn, p)
            had_real_import = False
            for r in run.imports:
                imported += 1
                had_real_import = True
                # Treat "all-zeroes" imports as suspicious — a 0-followers
                # 0-following snapshot is almost always a partial-sync that
                # parsed to empty JSONs. Force-retry next scan.
                counts = r.counts or {}
                if (counts.get("followers", 0) + counts.get("following", 0)) == 0:
                    _RECENT_ERROR_PATHS.add(str(p))
                    details.append({
                        "file": p.name,
                        "outcome": "imported",
                        "snapshot_id": r.snapshot_id,
                        "label": r.label,
                        "warning": "Imported with 0 followers + 0 following — likely partial sync; will retry next scan.",
                    })
                else:
                    details.append({"file": p.name, "outcome": "imported",
                                    "snapshot_id": r.snapshot_id, "label": r.label})
            for s in run.skipped:
                skipped += 1
                details.append({"file": p.name, "outcome": s.reason,
                                "label": s.label, "message": s.message[:200]})
            # Successful, non-empty import → clear any prior error record.
            if had_real_import or run.skipped:
                _RECENT_ERROR_PATHS.discard(str(p))
        except OSError as e:
            # Errno 11 (EDEADLK) on Drive-synced folders means Google Drive
            # Desktop is holding a sync lock — file is materialized as a
            # placeholder but contents haven't downloaded yet. Treat as
            # 'deferred', not 'error': don't spam the audit log every
            # minute with the same lock failure. Drive will eventually
            # finish; we'll pick the file up on a later scan.
            if getattr(e, "errno", None) == 11:
                details.append({
                    "file": p.name,
                    "outcome": "deferred",
                    "message": "Drive Desktop still syncing this folder (EDEADLK). Will retry on next scan.",
                })
                _DEFERRED_PATHS.add(str(p))
                # Don't add to _RECENT_ERROR_PATHS — that triggers force-
                # retry semantics meant for actual errors.
            else:
                details.append({"file": p.name, "outcome": "error", "message": str(e)})
                _RECENT_ERROR_PATHS.add(str(p))
        except Exception as e:
            details.append({"file": p.name, "outcome": "error", "message": str(e)})
            _RECENT_ERROR_PATHS.add(str(p))
        finally:
            if conn is not None:
                conn.close()
    deferred_count = sum(1 for d in details if d.get("outcome") == "deferred")
    return {
        "ok": True,
        "watch_folder": str(root),
        "scanned": len(files),
        "already_seen": already,  # quick path-based dedup hits, no work done
        "imported": imported,
        "skipped": skipped,
        "deferred": deferred_count,  # Drive-sync-locked files, will retry next scan
        "details": details,
    }


def start_watcher_thread() -> threading.Thread | None:
    """If IG_WATCH_FOLDER is set AND IG_WATCH_POLL is truthy, start a daemon
    thread that auto-imports new IG zips dropped there.

    Disabled by default — the manual 'Scan Drive folder' button is cheaper
    if your watch folder is the whole Drive root (slow to enumerate).
    Enable polling only when you've narrowed IG_WATCH_FOLDER to a subfolder
    where rglob is fast."""
    if not os.environ.get("IG_WATCH_POLL"):
        return None
    root = get_watch_folder()
    if root is None:
        log.info("IG_WATCH_POLL set but IG_WATCH_FOLDER is missing/invalid; not polling")
        return None
    t = threading.Thread(target=_watcher_loop, args=(root,), daemon=True, name="ig-watcher")
    t.start()
    return t
