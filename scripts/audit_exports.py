#!/usr/bin/env python3
"""Audit IG export folders in Drive: report which are complete vs incomplete.

A "complete" export has both `followers_*.json` AND `following.json` inside
its `connections/followers_and_following/` directory. Without those two
files, the resulting snapshot has empty followers / following sets and
the diff math reads as "everyone unfollowed" — exactly the corrupted
history the user is trying to fix.

This script:
  1. Walks the configured Drive watch root non-recursively for top-level
     `meta-*` and `instagram-*` export folders.
  2. For each, locates the `followers_and_following` subdir (1–2 levels
     deep is the standard layout).
  3. Tests presence of each critical file.
  4. Prints a per-export verdict: COMPLETE, INCOMPLETE (which files
     missing), or NO_FF_DIR (couldn't find a followers_and_following
     directory at all).
  5. Optionally writes the bad ones to data/import_skiplist.txt so the
     watcher / ingest path can skip them on future scans.

Usage:
    python scripts/audit_exports.py                 # report only
    python scripts/audit_exports.py --write-skip    # also write skiplist
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Pull the watch root from the same env var the watcher uses.
WATCH_ROOT = Path(os.environ.get(
    "IG_WATCH_DIR",
    "/Users/joshua/Library/CloudStorage/GoogleDrive-joshua.jiale.yeung@gmail.com/My Drive",
)).expanduser()

# Files we consider critical for a valid snapshot. Without these, the
# diff math is incoherent. (Inbound/pending files are nice-to-have but
# their absence doesn't make the snapshot useless for follower/following
# diffs.)
CRITICAL_GLOBS = ("followers_*.json", "following.json")
# Files we'd like to have but don't require.
OPTIONAL = (
    "pending_follow_requests.json",
    "recently_unfollowed_profiles.json",
    "follow_requests_you've_received.json",
    "recent_follow_requests.json",
)


def find_ff_dir(export_root: Path) -> Path | None:
    """Locate connections/followers_and_following/ inside an export.
    The standard layout is `<export_root>/instagram-<handle>-<date>-<id>/connections/followers_and_following/`.
    Some older exports drop the inner `instagram-...` wrapper."""
    direct = export_root / "connections" / "followers_and_following"
    if direct.is_dir():
        return direct
    try:
        for child in export_root.iterdir():
            if child.is_dir() and child.name.startswith("instagram-"):
                ff = child / "connections" / "followers_and_following"
                if ff.is_dir():
                    return ff
    except (OSError, PermissionError):
        return None
    return None


def _count_entries(path: Path) -> int | None:
    """Best-effort entry count for an IG followers/following JSON file.
    The schema is either a flat list or a wrapper dict like
    {"relationships_following": [...]}. We pick the longest list-shaped
    value we find. Returns None on parse error."""
    import json
    try:
        with path.open("r") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        best = 0
        for v in data.values():
            if isinstance(v, list) and len(v) > best:
                best = len(v)
        return best
    return 0


def audit_one(export_root: Path) -> dict:
    """Return a dict describing the completeness of a single export."""
    ff = find_ff_dir(export_root)
    if ff is None:
        return {"path": export_root, "verdict": "NO_FF_DIR", "missing": ["(entire connections/followers_and_following dir)"], "optional_missing": [], "followers": None, "following": None}
    missing = []
    optional_missing = []
    follower_files = list(ff.glob("followers_*.json"))
    if not follower_files:
        missing.append("followers_*.json")
        followers_count = None
    else:
        # Sum across followers_1.json + followers_2.json etc.
        followers_count = 0
        for fp in follower_files:
            n = _count_entries(fp)
            if n is None:
                followers_count = None
                missing.append(f"followers (parse error in {fp.name})")
                break
            followers_count += n
    following_path = ff / "following.json"
    if not following_path.exists():
        missing.append("following.json")
        following_count = None
    else:
        following_count = _count_entries(following_path)
        if following_count is None:
            missing.append("following.json (parse error)")
    for name in OPTIONAL:
        if not (ff / name).exists():
            optional_missing.append(name)
    return {
        "path": export_root,
        "ff_dir": ff,
        "verdict": "COMPLETE" if not missing else "INCOMPLETE",
        "missing": missing,
        "optional_missing": optional_missing,
        "followers": followers_count,
        "following": following_count,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--write-skip", action="store_true",
                   help="Write incomplete export paths to data/import_skiplist.txt")
    p.add_argument("--root", default=None,
                   help="Override the Drive watch root path")
    args = p.parse_args()

    root = Path(args.root).expanduser() if args.root else WATCH_ROOT
    if not root.is_dir():
        print(f"Watch root not found: {root}", file=sys.stderr)
        return 1

    # Match the watcher's pattern set: top-level meta-* / instagram-* dirs.
    candidates: list[Path] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        n = entry.name.lower()
        if n.startswith("meta-") or n.startswith("instagram-"):
            candidates.append(entry)
    candidates.sort(key=lambda p: p.name)

    print(f"Auditing {len(candidates)} export folders in {root}\n")

    complete: list[dict] = []
    incomplete: list[dict] = []
    no_ff: list[dict] = []
    for c in candidates:
        result = audit_one(c)
        if result["verdict"] == "COMPLETE":
            complete.append(result)
        elif result["verdict"] == "INCOMPLETE":
            incomplete.append(result)
        else:
            no_ff.append(result)

    # Outlier detection: chronologically order exports, then look for
    # dip-and-recover anomalies — counts drop sharply in one export but
    # both neighbors (before and after) have much higher counts. Real
    # unfollows are sticky (they persist). A truncated export shows up
    # as a transient dip surrounded by normal counts.
    suspicious: list[dict] = []
    by_time = sorted(complete, key=lambda r: r["path"].name)  # name encodes timestamp
    for i, r in enumerate(by_time):
        f, g = r["followers"], r["following"]
        if f is None or g is None:
            continue
        # Look at the closest non-None neighbor on each side.
        prev_f = next_f = None
        prev_g = next_g = None
        for j in range(i - 1, -1, -1):
            if by_time[j]["followers"] is not None and by_time[j]["following"] is not None:
                prev_f, prev_g = by_time[j]["followers"], by_time[j]["following"]
                break
        for j in range(i + 1, len(by_time)):
            if by_time[j]["followers"] is not None and by_time[j]["following"] is not None:
                next_f, next_g = by_time[j]["followers"], by_time[j]["following"]
                break
        reasons = []
        # A dip is "f below 70% of BOTH neighbors" — so a truncation
        # surrounded by intact exports stands out, while normal growth
        # over time doesn't trip the check.
        if prev_f is not None and next_f is not None and f < 0.7 * prev_f and f < 0.7 * next_f:
            reasons.append(f"followers={f} (prev={prev_f}, next={next_f})")
        if prev_g is not None and next_g is not None and g < 0.7 * prev_g and g < 0.7 * next_g:
            reasons.append(f"following={g} (prev={prev_g}, next={next_g})")
        if reasons:
            r["suspicious_reasons"] = reasons
            suspicious.append(r)

    if incomplete:
        print(f"INCOMPLETE ({len(incomplete)}) — missing critical file(s), should be skipped:")
        for r in incomplete:
            print(f"  {r['path'].name:50s}  missing: {', '.join(r['missing'])}")
        print()

    if no_ff:
        print(f"NO_FF_DIR ({len(no_ff)}) — followers_and_following directory not found:")
        for r in no_ff:
            print(f"  {r['path'].name}")
        print()

    if suspicious:
        print(f"SUSPICIOUS ({len(suspicious)}) — files present but counts far below median (likely truncated):")
        for r in sorted(suspicious, key=lambda x: x["path"].name):
            print(f"  {r['path'].name:50s}  {' · '.join(r['suspicious_reasons'])}")
        print()

    healthy = [r for r in complete if r not in suspicious]
    print(f"HEALTHY ({len(healthy)})")
    if healthy and len(healthy) <= 10:
        for r in healthy:
            print(f"  {r['path'].name}  followers={r['followers']} following={r['following']}")
    elif healthy:
        print(f"  (showing 5 most recent of {len(healthy)})")
        for r in sorted(healthy, key=lambda x: x["path"].name, reverse=True)[:5]:
            print(f"  {r['path'].name}  followers={r['followers']} following={r['following']}")
    print()

    # Roll-up of which optional files are missing across the COMPLETE set.
    # Helps spot "all my exports are missing recently_unfollowed_profiles"
    # patterns that lead to attribution drift (you-unfollowed events
    # not getting recorded → they look like "they removed you").
    optional_count: dict[str, int] = {name: 0 for name in OPTIONAL}
    for r in complete:
        for name in r.get("optional_missing", []):
            optional_count[name] = optional_count.get(name, 0) + 1
    if any(optional_count.values()):
        print("Optional files missing across the complete set (count of exports):")
        for name, n in sorted(optional_count.items(), key=lambda x: -x[1]):
            if n > 0:
                pct = 100 * n / len(complete) if complete else 0
                print(f"  {name:55s}  {n} / {len(complete)} ({pct:.0f}%)")
        print()

    bad = incomplete + no_ff + suspicious
    print(f"Summary: {len(healthy)} healthy · {len(suspicious)} suspicious · {len(incomplete)} incomplete · {len(no_ff)} no-ff-dir")

    if args.write_skip and bad:
        skip_path = ROOT / "data" / "import_skiplist.txt"
        skip_path.parent.mkdir(parents=True, exist_ok=True)
        existing: set[str] = set()
        if skip_path.exists():
            existing = {line.strip() for line in skip_path.read_text().splitlines() if line.strip() and not line.startswith("#")}
        new_lines = []
        for r in bad:
            line = str(r["path"].resolve())
            if line not in existing:
                new_lines.append(line)
        if new_lines:
            with skip_path.open("a") as f:
                if not skip_path.read_text().endswith("\n") and skip_path.stat().st_size > 0:
                    f.write("\n")
                f.write(f"# Added by audit_exports.py — incomplete or unparseable exports\n")
                for line in new_lines:
                    f.write(line + "\n")
            print(f"\nWrote {len(new_lines)} new path(s) to {skip_path}")
        else:
            print(f"\nAll bad paths already in {skip_path}")
    elif args.write_skip:
        print("\nNothing to skip — all exports look complete.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
