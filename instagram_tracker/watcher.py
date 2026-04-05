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

# Filename patterns Meta uses for the zips we care about. Matched
# case-insensitively against the file name (not the full path), so a
# zip nested in any subfolder of the watch root still hits.
_PATTERNS = [
    re.compile(r"^instagram-.*\.zip$", re.IGNORECASE),
    re.compile(r"^meta-.*\.zip$", re.IGNORECASE),
    re.compile(r"^drive-download-.*\.zip$", re.IGNORECASE),
]

# How often to scan the watch root. Cheap operation (just metadata listing
# on Drive's virtual filesystem), 30s is well under the human-perceptible
# threshold for "auto-import".
_POLL_INTERVAL_S = 30


def _looks_like_ig_zip(name: str) -> bool:
    return any(p.match(name) for p in _PATTERNS)


def _scan(root: Path) -> list[Path]:
    """Return all current IG-zip-shaped files under root. We use rglob so any
    nesting depth works — Meta sometimes drops into 'My Drive/Meta' or
    'My Drive/Instagram', and we don't want the user to have to configure it."""
    out: list[Path] = []
    try:
        for p in root.rglob("*.zip"):
            if p.is_file() and _looks_like_ig_zip(p.name):
                out.append(p)
    except (OSError, PermissionError) as e:
        log.warning("Scan of %s failed: %s", root, e)
    return out


def _file_key(p: Path) -> tuple[str, int, int]:
    """Identity tuple we use to decide if a file is 'the same' as one we've
    already processed. (path, mtime, size) — survives Drive re-syncs that
    re-upload the same content under the same path. If the user replaces a
    zip with new content at the same path, mtime or size will differ and
    we'll re-import (the duplicate guard in `ingest` will then either
    accept the new one or backfill incoming-requests as appropriate)."""
    st = p.stat()
    return (str(p), int(st.st_mtime), int(st.st_size))


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
                # Drive sometimes lists a placeholder before the content has
                # streamed down. Wait one more cycle if the file is tiny —
                # below the smallest plausible IG export — to avoid trying
                # to unzip an empty placeholder.
                if key[2] < 1024:
                    log.debug("Skipping %s (size %d, looks like a Drive placeholder)", p.name, key[2])
                    continue
                _import_one(p)
                seen.add(key)
        except Exception as e:
            log.error("Watcher iteration failed: %s", e)


def start_watcher_thread() -> threading.Thread | None:
    """If IG_WATCH_FOLDER is set in the env, start a daemon thread that
    auto-imports new IG zips dropped there. No-op otherwise."""
    raw = os.environ.get("IG_WATCH_FOLDER", "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser().resolve()
    if not root.exists():
        log.warning("IG_WATCH_FOLDER=%s does not exist; watcher not starting", root)
        return None
    if not root.is_dir():
        log.warning("IG_WATCH_FOLDER=%s is not a directory; watcher not starting", root)
        return None

    t = threading.Thread(target=_watcher_loop, args=(root,), daemon=True, name="ig-watcher")
    t.start()
    return t
