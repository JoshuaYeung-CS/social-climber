"""Shared dependencies for route modules.

Provides the canonical `db_conn()` context manager. Route modules should
import from here rather than defining their own mirror — keeps all
connection-opening behavior (timeout, WAL pragmas) in one place.

CACHE INVARIANT: This module owns ZERO cache state. It exposes only
DB plumbing. Cache helpers (`_cached`, `_bump_*_version`, `_LOOKUP_GLOBALS`)
remain in server.py.
"""

from __future__ import annotations

from contextlib import contextmanager

from .config import DB_PATH
from .db import connect


@contextmanager
def db_conn():
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()
