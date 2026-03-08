"""Single-step import: takes a folder OR a zip and persists a snapshot.

Auto-discovers Instagram's `followers_and_following` directory anywhere inside
the input. If a zip contains multiple exports (rare for a single download),
imports each as its own snapshot.
"""

import re
import shutil
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

_MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def _clean_label_from_name(name: str) -> str | None:
    """Extract YYYY-MM-DD_HH-MM-SS from a zip/folder name. Falls back to None.

    Handles Instagram/Meta export filenames like:
      meta-2026-Apr-28-15-50-49-20260428T233019Z-3-001.zip
      drive-download-20260428T191229Z-3-001
      2026-04-21_10-30-34
    """
    n = name
    if n.lower().endswith(".zip"):
        n = n[:-4]

    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[T_\-](\d{2})[:_\-](\d{2})[:_\-](\d{2})", n)
    if m:
        y, mo, d, hh, mm, ss = m.groups()
        return f"{y}-{mo}-{d}_{hh}-{mm}-{ss}"

    m = re.search(r"(\d{4})-([A-Za-z]{3})-(\d{2})-(\d{2})-(\d{2})-(\d{2})", n)
    if m:
        y, mtxt, d, hh, mm, ss = m.groups()
        mo = _MONTHS.get(mtxt.lower())
        if mo:
            return f"{y}-{mo}-{d}_{hh}-{mm}-{ss}"

    m = re.search(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z", n)
    if m:
        y, mo, d, hh, mm, ss = m.groups()
        return f"{y}-{mo}-{d}_{hh}-{mm}-{ss}"

    return None

from .db import utc_now_iso
from .parsers import (
    Row,
    parse_followers,
    parse_following,
    parse_pending,
    parse_recently_unfollowed,
)


@dataclass
class ImportResult:
    snapshot_id: int
    label: str
    counts: dict[str, int]
    missing_files: list[str]


def _find_ff_dirs(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("followers_and_following") if p.is_dir())


def _merge_pending(
    pending: list[Row], recent: list[Row]
) -> tuple[list[Row], dict[str, str]]:
    """Merge the two sources; track which file each username came from."""
    merged: dict[str, Row] = {}
    sources: dict[str, str] = {}

    def absorb(rows: list[Row], label: str) -> None:
        for username, url, ts in rows:
            if username not in merged:
                merged[username] = (username, url, ts)
                sources[username] = label
                continue
            _, ex_url, ex_ts = merged[username]
            best_ts = ex_ts if ts is None else (ts if ex_ts is None else max(ex_ts, ts))
            best_url = ex_url or url
            merged[username] = (username, best_url, best_ts)
            if sources[username] != label:
                sources[username] = "both"

    absorb(pending, "pending_follow_requests")
    absorb(recent, "recent_follow_requests")
    return list(merged.values()), sources


def _bulk_insert(
    conn: sqlite3.Connection,
    table: str,
    snapshot_id: int,
    rows: list[Row],
) -> None:
    if not rows:
        return
    conn.executemany(
        f"INSERT OR IGNORE INTO {table} (snapshot_id, username, profile_url, export_timestamp) VALUES (?, ?, ?, ?)",
        [(snapshot_id, u, url, ts) for u, url, ts in rows],
    )


def _bulk_insert_pending(
    conn: sqlite3.Connection,
    snapshot_id: int,
    rows: list[Row],
    sources: dict[str, str],
) -> None:
    if not rows:
        return
    conn.executemany(
        """
        INSERT OR IGNORE INTO pending_follow_requests
            (snapshot_id, username, profile_url, export_timestamp, source_label)
        VALUES (?, ?, ?, ?, ?)
        """,
        [(snapshot_id, u, url, ts, sources.get(u, "")) for u, url, ts in rows],
    )


def _ingest_one(
    conn: sqlite3.Connection,
    ff_dir: Path,
    label: str,
    source_path: str,
) -> ImportResult:
    missing_files: list[str] = []

    follower_files = sorted(ff_dir.glob("followers_*.json"))
    follower_rows: list[Row] = []
    if follower_files:
        merged_followers: dict[str, Row] = {}
        for fp in follower_files:
            for u, url, ts in parse_followers(fp):
                merged_followers[u] = (u, url, ts)
        follower_rows = list(merged_followers.values())
    else:
        missing_files.append("followers (followers_*.json)")

    if (ff_dir / "following.json").exists():
        following_rows = parse_following(ff_dir / "following.json")
    else:
        following_rows = []
        missing_files.append("following (following.json)")

    if (ff_dir / "pending_follow_requests.json").exists():
        pending_rows = parse_pending(ff_dir / "pending_follow_requests.json")
    else:
        pending_rows = []
        missing_files.append("pending requests you've sent (pending_follow_requests.json)")

    if (ff_dir / "recent_follow_requests.json").exists():
        recent_rows = parse_pending(ff_dir / "recent_follow_requests.json")
    else:
        recent_rows = []
        missing_files.append("recent follow requests (recent_follow_requests.json)")

    if (ff_dir / "recently_unfollowed_profiles.json").exists():
        unfollowed_rows = parse_recently_unfollowed(ff_dir / "recently_unfollowed_profiles.json")
    else:
        unfollowed_rows = []
        missing_files.append("recently unfollowed by you (recently_unfollowed_profiles.json)")

    if not any([follower_rows, following_rows, pending_rows, recent_rows, unfollowed_rows]):
        raise ValueError(f"No usable Instagram export data found in: {ff_dir}")

    cur = conn.execute(
        "INSERT INTO snapshots (created_at, label, source_path) VALUES (?, ?, ?)",
        (utc_now_iso(), label, source_path),
    )
    snapshot_id = int(cur.lastrowid)

    _bulk_insert(conn, "followers", snapshot_id, follower_rows)
    _bulk_insert(conn, "following", snapshot_id, following_rows)
    merged, sources = _merge_pending(pending_rows, recent_rows)
    _bulk_insert_pending(conn, snapshot_id, merged, sources)
    _bulk_insert(conn, "recently_unfollowed", snapshot_id, unfollowed_rows)
    conn.commit()

    return ImportResult(
        snapshot_id=snapshot_id,
        label=label,
        counts={
            "followers": len(follower_rows),
            "following": len(following_rows),
            "pending": sum(1 for u in sources if sources[u] in ("pending_follow_requests", "both")),
            "recent_requests": sum(1 for u in sources if sources[u] in ("recent_follow_requests", "both")),
            "recently_unfollowed": len(unfollowed_rows),
        },
        missing_files=missing_files,
    )


def _label_from_path(path: Path) -> str:
    cleaned = _clean_label_from_name(path.name)
    if cleaned:
        return cleaned
    # Last resort: strip the .zip and Drive download noise.
    name = path.name[:-4] if path.name.lower().endswith(".zip") else path.name
    return re.sub(r"-\d{8}T\d{6}Z-\d+-\d+$", "", name) or path.name


def import_path(
    conn: sqlite3.Connection,
    path: Path,
    label: str | None = None,
) -> list[ImportResult]:
    """Top-level entry point. `path` may be a folder, a zip, or a single ff_dir."""
    if not path.exists():
        raise ValueError(f"Path not found: {path}")

    cleanup_dir: Path | None = None
    try:
        if path.is_file() and path.suffix.lower() == ".zip":
            cleanup_dir = Path(tempfile.mkdtemp(prefix="ig_import_"))
            with zipfile.ZipFile(path) as zf:
                zf.extractall(cleanup_dir)
            search_root = cleanup_dir
        elif path.is_dir():
            search_root = path
        else:
            raise ValueError(f"Unsupported import path (need folder or .zip): {path}")

        ff_dirs = _find_ff_dirs(search_root)
        if not ff_dirs:
            # Maybe `path` is itself the followers_and_following dir.
            if (search_root / "followers_1.json").exists() or (search_root / "following.json").exists():
                ff_dirs = [search_root]
            else:
                raise ValueError(
                    "Could not find an Instagram 'followers_and_following' folder inside the input."
                )

        results: list[ImportResult] = []
        used_labels: set[str] = set()
        for ff in ff_dirs:
            base_label = label or _label_from_path(path) if len(ff_dirs) == 1 else _label_from_path(ff.parent)
            base_label = base_label or "snapshot"
            unique = base_label
            i = 2
            while unique in used_labels:
                unique = f"{base_label}_{i}"
                i += 1
            used_labels.add(unique)
            results.append(_ingest_one(conn, ff, unique, str(path)))
        return results
    finally:
        if cleanup_dir is not None and cleanup_dir.exists():
            shutil.rmtree(cleanup_dir, ignore_errors=True)
