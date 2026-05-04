#!/usr/bin/env python3
"""Reset the IG Tracker DB while preserving manual tags + the follow queue.

Wipes all snapshot-derived data so the user can re-import their exports
from a clean slate. Useful when historical imports captured corrupted
or partial data and the cumulative-set computations are showing stale
artifacts.

Preserved:
  - profile_tags          (all manual tags: favorites, want_remove, etc.)
  - followup_queue        (the persistent outbound follow queue)

Wiped:
  - snapshots
  - followers
  - following
  - pending_follow_requests
  - recently_unfollowed
  - incoming_follow_requests
  - profile_observations  (extension observations — get re-collected as you
                           visit profiles again)

A timestamped backup of the DB is written before any deletion, so the
operation is fully reversible by copying the backup back over the live
file.

Usage:
    python scripts/reset_db.py [--yes]

Without --yes, prints what would be wiped and asks for confirmation.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# Locate the project root regardless of where the script is invoked from.
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "instagram_tracker.db"

WIPE_TABLES = [
    "snapshots",
    "followers",
    "following",
    "pending_follow_requests",
    "recently_unfollowed",
    "incoming_follow_requests",
    "profile_observations",
]
PRESERVE_TABLES = [
    "profile_tags",
    "followup_queue",
]


def main() -> int:
    p = argparse.ArgumentParser(description="Reset IG Tracker DB, preserving tags.")
    p.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    args = p.parse_args()

    if not DB_PATH.exists():
        print(f"DB not found at {DB_PATH}", file=sys.stderr)
        return 1

    # Snapshot current row counts so the user sees what's about to disappear.
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    counts: dict[str, int] = {}
    for t in WIPE_TABLES + PRESERVE_TABLES:
        try:
            counts[t] = conn.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"]
        except sqlite3.OperationalError:
            counts[t] = -1  # table missing
    conn.close()

    print(f"Database: {DB_PATH}")
    print()
    print("Will WIPE:")
    for t in WIPE_TABLES:
        c = counts.get(t, -1)
        print(f"  {t:35s} {c if c >= 0 else '(missing)'} rows")
    print()
    print("Will PRESERVE:")
    for t in PRESERVE_TABLES:
        c = counts.get(t, -1)
        print(f"  {t:35s} {c if c >= 0 else '(missing)'} rows")
    print()

    if not args.yes:
        try:
            reply = input("Proceed? Type 'yes' to confirm: ").strip().lower()
        except EOFError:
            reply = ""
        if reply != "yes":
            print("Aborted. No changes made.")
            return 0

    # Back up the live DB to a timestamped sibling file.
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = DB_PATH.with_name(f"{DB_PATH.name}.backup-{ts}")
    shutil.copy2(DB_PATH, backup_path)
    print(f"Backup: {backup_path}")

    # Wipe inside a single transaction so a partial failure leaves the DB
    # in its pre-wipe state. profile_tags + followup_queue are untouched.
    conn = sqlite3.connect(DB_PATH)
    try:
        with conn:
            for t in WIPE_TABLES:
                try:
                    conn.execute(f"DELETE FROM {t}")
                except sqlite3.OperationalError as e:
                    print(f"  skipping {t} ({e})")
        # VACUUM outside the transaction to actually reclaim disk space.
        conn.execute("VACUUM")
    finally:
        conn.close()

    print()
    print("Reset complete. To re-import:")
    print("  1. Start the server:  ./run.sh")
    print("  2. Open http://127.0.0.1:8000/ in a browser")
    print("  3. Click 'Scan Drive folder for new exports' to re-ingest from Drive,")
    print("     OR drag the export zip(s) onto the home card to import manually.")
    print()
    print(f"To restore: cp {backup_path} {DB_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
