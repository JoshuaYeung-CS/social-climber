"""Profile-picture endpoints, extracted from server.py for module clarity.

CACHE INVARIANT: This module owns ZERO cache state. The endpoints here
do pure filesystem I/O — they never touch _cache, _LOOKUP_GLOBALS, or
the version counters. Adding any aggregate-affecting endpoint here in
the future would require importing version-bump helpers from server.py;
do not recreate cache state in this module.

Why a separate module: the two endpoints + helper + dir constant share
nothing with the rest of the API surface and shape a clean, testable
unit. The base64 decode + 5MB cap + 24h freshness skip lives here so
server.py doesn't grow a stray import-base64.
"""

from __future__ import annotations

import base64
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from .config import DB_PATH


router = APIRouter()

_PROFILE_PICS_DIR = DB_PATH.parent / "profile_pics"


def _profile_pic_path(username: str) -> Path:
    """Sanitized filesystem path for a username's locally stored profile pic.
    IG usernames are alnum + . + _ (1-30 chars) so no escaping is required,
    but we still defensively reject anything else to keep the path scoped
    inside data/profile_pics/."""
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", username or ""):
        raise HTTPException(status_code=400, detail="Invalid username for path.")
    _PROFILE_PICS_DIR.mkdir(parents=True, exist_ok=True)
    return _PROFILE_PICS_DIR / f"{username}.jpg"


@router.post("/api/profile-pic-bytes")
def store_profile_pic(payload: dict = Body(...)):
    """Receive base64-encoded profile picture bytes from the extension and
    save them to data/profile_pics/<username>.jpg. The IG CDN URL has a
    short-lived signed token, so the URL we previously stored expires
    after a few hours — local storage gives the modal/overlay a stable
    image source for past observations.

    Skips the write if the existing file is newer than 24 hours old
    (mtime check) to avoid re-downloading on every page visit."""
    username = (payload.get("username") or "").strip()
    bytes_b64 = payload.get("bytes_b64")
    if not username or not bytes_b64:
        raise HTTPException(status_code=400, detail="Need 'username' and 'bytes_b64'.")
    path = _profile_pic_path(username)
    if path.exists() and (time.time() - path.stat().st_mtime) < 86400:
        return {"ok": True, "skipped": "fresh"}
    try:
        data = base64.b64decode(bytes_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64.")
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (>5MB).")
    path.write_bytes(data)
    return {"ok": True, "size": len(data)}


@router.get("/api/profile-pic/{username}")
def get_profile_pic(username: str):
    """Serve the locally-stored profile picture for `username`. Cache-
    Controls allow the browser to reuse the response for an hour, since
    the file path is stable for a given username."""
    path = _profile_pic_path(username)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No local pic for this user.")
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})
