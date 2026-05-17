"""Append-only audit log of significant data operations.

Used so the user can see exactly what's been imported, what errored,
what got reset, and why — without digging through server logs that
are wiped on every restart. Each call commits a single row to the
`audit_log` table; queries return rows newest-first.

Keep entries short and useful: the goal is "what happened and why",
not a full debug trace. For verbose details, log to the server console
and put a reference (snapshot id, file name) in the audit row.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def log(
    conn: sqlite3.Connection,
    op: str,
    target: str | None = None,
    ok: bool = True,
    **details: Any,
) -> None:
    """Append one row to the audit log. Always commits — these rows
    must survive even if the surrounding transaction rolls back."""
    payload = json.dumps(details, default=str) if details else None
    try:
        conn.execute(
            "INSERT INTO audit_log (op, target, ok, details_json) VALUES (?, ?, ?, ?)",
            (op, target, 1 if ok else 0, payload),
        )
        conn.commit()
    except Exception:
        # Never let audit failures crash the operation they're about.
        pass


def list_recent(conn: sqlite3.Connection, limit: int = 200) -> list[dict]:
    """Return the most recent N audit rows, newest first."""
    rows = conn.execute(
        "SELECT id, ts, op, target, ok, details_json FROM audit_log "
        "ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("details_json"):
            try:
                d["details"] = json.loads(d["details_json"])
            except Exception:
                d["details"] = None
        else:
            d["details"] = None
        d.pop("details_json", None)
        d["ok"] = bool(d["ok"])
        out.append(d)
    return out
