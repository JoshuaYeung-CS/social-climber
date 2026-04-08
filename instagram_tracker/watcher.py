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
    for p in out:
        s = str(p.resolve())
        if s not in seen_paths:
            seen_paths.add(s)
            deduped.append(p)
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


def _watcher_loop(root: Path) -> None:
    log.info("Watcher started on %s (polling every %ds)", root, _POLL_INTERVAL_S)
    seen: set[tuple[str, int, int]] = set()

    # Prime the seen-set with whatever's already there at startup — we don't
    # want to re-import every zip on every server restart. The duplicate
    # guard would catch them but it'd flood the log on boot.
    for p in _scan(root):
        try:
            seen.add(_file_key(p))
        except OSError:
            pass

    while True:
        time.sleep(_POLL_INTERVAL_S)
        try:
            current = _scan(root)
            for p in current:
                try:
                    key = _file_key(p)
                except OSError:
                    continue
                if key in seen:
                    continue
                if _is_drive_placeholder(p):
                    log.debug("Skipping %s (Drive placeholder, content not synced yet)", p.name)
                    continue
                _import_one(p)
                seen.add(key)
        except Exception as e:
            log.error("Watcher iteration failed: %s", e)


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


def scan_once() -> dict:
    """Run a single scan-and-import pass synchronously. Used by the manual
    'Scan Drive folder' button on the home page so the user can trigger an
    import on demand without paying for background polling."""
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
    imported = skipped = 0
    details: list[dict] = []
    for p in files:
        if _is_drive_placeholder(p):
            details.append({"file": p.name, "outcome": "placeholder",
                            "message": "Drive hasn't synced this file's content yet"})
            continue
        # Even already-imported zips are safe to re-feed: ingest dedups by
        # content_hash, so re-running this only pulls in genuine new files
        # plus any backfill opportunities. Cheap (single SQL round-trip).
        conn = None
        try:
            conn = connect(DB_PATH)
            run = import_path(conn, p)
            for r in run.imports:
                imported += 1
                details.append({"file": p.name, "outcome": "imported",
                                "snapshot_id": r.snapshot_id, "label": r.label})
            for s in run.skipped:
                skipped += 1
                details.append({"file": p.name, "outcome": s.reason,
                                "label": s.label, "message": s.message[:200]})
        except Exception as e:
            details.append({"file": p.name, "outcome": "error", "message": str(e)})
        finally:
            if conn is not None:
                conn.close()
    return {
        "ok": True,
        "watch_folder": str(root),
        "scanned": len(files),
        "imported": imported,
        "skipped": skipped,
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
