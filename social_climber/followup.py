"""Persistent follow-queue.

When a bulk check finds 'new to you' accounts, they get added to this queue.
The user works through it on phone or Mac; tapping a row removes it.
Queue survives across server restarts and is shared between Mac and phone
(both hit the same SQLite file).
"""

import sqlite3
from typing import Iterable

from .db import utc_now_iso


def add_many(conn: sqlite3.Connection, items: Iterable[dict]) -> int:
    rows = []
    now = utc_now_iso()
    for it in items:
        username = it.get("username")
        if not username:
            continue
        rows.append((username, it.get("profile_url"), it.get("input"), now))
    if not rows:
        return 0
    conn.executemany(
        "INSERT OR IGNORE INTO followup_queue (username, profile_url, source_input, added_at) VALUES (?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)


def list_all(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT username, profile_url, source_input, added_at FROM followup_queue ORDER BY added_at ASC, username ASC"
    ).fetchall()
    return [
        {
            "username": r["username"],
            "profile_url": r["profile_url"],
            "source_input": r["source_input"],
            "added_at": r["added_at"],
        }
        for r in rows
    ]


def remove(conn: sqlite3.Connection, username: str) -> None:
    conn.execute("DELETE FROM followup_queue WHERE username = ?", (username,))
    conn.commit()


def clear(conn: sqlite3.Connection) -> int:
    cur = conn.execute("DELETE FROM followup_queue")
    conn.commit()
    return cur.rowcount or 0


def count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) FROM followup_queue").fetchone()
    return int(row[0]) if row else 0
