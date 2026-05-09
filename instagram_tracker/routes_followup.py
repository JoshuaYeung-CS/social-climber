"""Follow-up queue endpoints, extracted from server.py for module clarity.

CACHE INVARIANT: This module owns ZERO cache state. The follow-up endpoints
only read/write the followup_queue table and never call _bump_*_version() or
_cached(). They're the safest first extraction precisely because they don't
touch the cache machinery.

If a future endpoint added here ever needs to invalidate cached aggregates,
it MUST import the version-bump helpers from server.py — never recreate
counters or dicts here. All cache state lives in exactly one module.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from . import followup as followup_mod
from .db import connect
from .config import DB_PATH


# Local db_conn helper — mirrors server.py's pattern of opening a fresh
# connection per request. Avoids importing from server.py to keep the
# module self-contained (server.py imports go the OTHER way; this module
# is imported BY server.py during app assembly).
from contextlib import contextmanager


@contextmanager
def _db():
    conn = connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


router = APIRouter()


# Empty for now — endpoints get moved here in a follow-up commit. The
# router is registered in server.py after middleware setup so the
# wiring is proven before any real moves happen.
