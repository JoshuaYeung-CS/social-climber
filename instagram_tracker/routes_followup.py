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
from .deps import db_conn as _db


router = APIRouter()


# Follow-up queue: a manual triage list for accounts the user wants to
# stage before deciding whether to follow. The Check tab's bulk-paste
# adds entries here. Entries persist until manually marked done or the
# whole list is cleared.
#
# All four endpoints share the same shape: open a fresh DB connection,
# call the matching followup_mod function, return a small dict. No
# cache invalidation — these endpoints don't affect any cached
# aggregates (the queue isn't surfaced in /api/home or /api/lists).


@router.get("/api/followup")
def followup_list():
    with _db() as conn:
        return {"items": followup_mod.list_all(conn)}


@router.post("/api/followup/add")
def followup_add(payload: dict = Body(...)):
    items = payload.get("items")
    if not items:
        username = payload.get("username")
        if not username:
            raise HTTPException(status_code=400, detail="Provide 'username' or 'items'")
        items = [{
            "username": username,
            "profile_url": payload.get("profile_url"),
            "input": payload.get("input") or username,
        }]
    with _db() as conn:
        added = followup_mod.add_many(conn, items)
        total = followup_mod.count(conn)
    return {"added": added, "total": total}


@router.post("/api/followup/done")
def followup_done(payload: dict = Body(...)):
    username = payload.get("username")
    if not username:
        raise HTTPException(status_code=400, detail="username required")
    with _db() as conn:
        followup_mod.remove(conn, username)
    return {"removed": username}


@router.delete("/api/followup")
def followup_clear():
    with _db() as conn:
        n = followup_mod.clear(conn)
    return {"cleared": n}
