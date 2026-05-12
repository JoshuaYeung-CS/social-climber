#!/usr/bin/env python3
"""Quick stand-alone count of an Instagram data export.

Reads either a .zip file or a pre-extracted folder, finds the
`followers_and_following/` directory inside, and prints raw counts for
each list — followers, following, pending requests, incoming requests,
recently unfollowed.

No DB, no server, no side effects. Useful for sanity-checking what a
fresh export actually contains before importing.

Usage:
    ./scripts/count_export.py path/to/export.zip
    ./scripts/count_export.py path/to/extracted/folder
    ./scripts/count_export.py                       # latest in ~/Downloads
"""
from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path


# Filenames inside followers_and_following/ — most exports use the first
# spelling but Meta has shipped variants over the years.
FILE_GLOBS = {
    "followers": ["followers_1.json", "followers.json"],
    "following": ["following.json"],
    "pending":   ["pending_follow_requests.json"],
    "recent_pending": ["recent_follow_requests.json"],
    "incoming":  ["follow_requests_you've_received.json"],
    "recently_unfollowed": ["recently_unfollowed_accounts.json"],
}

# Some payloads are dicts with a single legacy-named key, others are
# bare lists. _count walks both shapes.
LEGACY_KEYS = (
    "relationships_followers",
    "relationships_following",
    "relationships_follow_requests_sent",
    "relationships_permanent_follow_requests",
    "relationships_recent_follow_requests",
    "relationships_follow_requests_received",
    "relationships_unfollowed_users",
)


def _count(path: Path) -> int:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return 0
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        for k in LEGACY_KEYS:
            if k in data and isinstance(data[k], list):
                return len(data[k])
        # Fall back: pick the first list value.
        for v in data.values():
            if isinstance(v, list):
                return len(v)
    return 0


def _locate_ff(root: Path) -> Path | None:
    for p in root.rglob("followers_and_following"):
        if p.is_dir():
            return p
    return None


def _count_section(ff: Path, candidates: list[str]) -> int | None:
    for name in candidates:
        p = ff / name
        if p.is_file():
            return _count(p)
    return None


def _scan(root: Path) -> dict[str, int | None]:
    ff = _locate_ff(root)
    if ff is None:
        return {}
    return {key: _count_section(ff, names) for key, names in FILE_GLOBS.items()}


def _newest_export_in(folder: Path) -> Path | None:
    candidates: list[Path] = []
    for p in folder.iterdir():
        if p.is_file() and p.suffix.lower() == ".zip":
            candidates.append(p)
        elif p.is_dir() and (p.name.startswith("meta-") or p.name.startswith("instagram-")):
            candidates.append(p)
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _print_counts(label: str, counts: dict[str, int | None]) -> None:
    print(f"\n{label}")
    print("-" * len(label))
    if not counts:
        print("  (no followers_and_following/ found)")
        return
    fmt = lambda v: "—" if v is None else f"{v:>5}"
    pairs = [
        ("Followers",                   counts.get("followers")),
        ("Following",                   counts.get("following")),
        ("Pending (you sent)",          counts.get("pending")),
        ("Recent pending (you sent)",   counts.get("recent_pending")),
        ("Incoming requests",           counts.get("incoming")),
        ("Recently unfollowed",         counts.get("recently_unfollowed")),
    ]
    width = max(len(k) for k, _ in pairs)
    for k, v in pairs:
        print(f"  {k.ljust(width)}  {fmt(v)}")
    if counts.get("followers") is not None and counts.get("following") is not None:
        net = (counts["following"] or 0) - (counts["followers"] or 0)
        arrow = "+" if net >= 0 else ""
        print(f"  {'follow gap (following − followers)'.ljust(width)}  {arrow}{net}")


def _handle(arg: Path) -> None:
    if arg.is_dir():
        _print_counts(str(arg), _scan(arg))
        return
    if arg.is_file() and arg.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory() as tmp:
            try:
                with zipfile.ZipFile(arg) as zf:
                    zf.extractall(tmp)
            except zipfile.BadZipFile:
                print(f"{arg}: not a valid zip", file=sys.stderr)
                sys.exit(2)
            _print_counts(str(arg), _scan(Path(tmp)))
        return
    print(f"{arg}: not a folder or .zip file", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    if len(sys.argv) == 1:
        # No args — fall back to the newest export in ~/Downloads, the
        # default watch folder.
        downloads = Path.home() / "Downloads"
        latest = _newest_export_in(downloads) if downloads.is_dir() else None
        if latest is None:
            print(
                "Usage: count_export.py <path-to-zip-or-folder>\n"
                "  (no zip / meta-* folder found in ~/Downloads to default to)",
                file=sys.stderr,
            )
            sys.exit(1)
        _handle(latest)
        return
    for arg in sys.argv[1:]:
        _handle(Path(arg).expanduser())


if __name__ == "__main__":
    main()
