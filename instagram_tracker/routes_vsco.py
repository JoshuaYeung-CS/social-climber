"""VSCO media archive endpoints.

Mirrors the /api/media-bytes pattern used for Instagram, but writes
under data/vsco_media/<username>/ instead of data/media/<username>/ so
the two archives stay separate on disk (a person's IG @handle and VSCO
@handle aren't always the same string, and we don't want to silently
mix them).

CACHE INVARIANT: no cache state owned here. Pure filesystem I/O —
identical to routes_profiles.py. Any aggregate-affecting endpoint
added later must import version-bump helpers from server.py rather
than recreating cache state in this module.

Why server-side: the Cloudflare gate on vsco.co blocks plain HTTP
clients, so the actual byte fetch has to happen inside the browser
content script (which has the Cloudflare cookies from the page
visit). The server's role here is just to receive base64 bytes and
write them to disk — same shape as the IG `/api/media-bytes`
endpoint. No outbound fetches to VSCO from this module.
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

_VSCO_DIR = DB_PATH.parent / "vsco_media"
# VSCO usernames are alphanumeric + period + underscore + hyphen, up to
# 30 chars. Defensively reject anything else so the saved path can't
# escape the vsco_media root.
_USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
# Media IDs from VSCO URLs look like base64-ish slugs. Allow alnum +
# common URL-safe punctuation; reject slashes (which would let a
# malicious caller traverse into other accounts).
_MEDIA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
_VSCO_MAX_BYTES = 30 * 1024 * 1024  # 30 MB per file — photos are typically <5MB, videos can hit 20


def _user_dir(username: str) -> Path:
    if not _USER_RE.fullmatch(username or ""):
        raise HTTPException(status_code=400, detail="Invalid VSCO username.")
    d = _VSCO_DIR / username
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_media_id(media_id: str) -> str:
    if not _MEDIA_ID_RE.fullmatch(media_id or ""):
        raise HTTPException(status_code=400, detail="Invalid media_id.")
    return media_id


@router.post("/api/vsco-media-bytes")
def store_vsco_media(payload: dict = Body(...)):
    """Receive a VSCO image/video by base64 bytes (decoded + saved).

    Idempotent: if a file with the same media_id + ext already exists
    and the new payload is byte-identical, no write happens (just
    returns skipped=True). This lets the content script re-emit on
    re-visit without ballooning disk.
    """
    username = (payload.get("username") or "").strip()
    media_id = (payload.get("media_id") or "").strip()
    ext = (payload.get("ext") or "jpg").lower().strip()
    bytes_b64 = payload.get("bytes_b64")
    if not username or not media_id or not bytes_b64:
        raise HTTPException(status_code=400, detail="Need 'username', 'media_id', 'bytes_b64'.")
    if ext not in ("jpg", "jpeg", "png", "webp", "mp4", "mov"):
        raise HTTPException(status_code=400, detail=f"Unsupported ext '{ext}'.")
    media_id = _safe_media_id(media_id)
    try:
        data = base64.b64decode(bytes_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64.") from None
    if len(data) > _VSCO_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"Payload exceeds {_VSCO_MAX_BYTES // (1024*1024)}MB cap.")
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty payload.")
    d = _user_dir(username)
    target = d / f"{media_id}.{ext}"
    if target.exists() and target.read_bytes() == data:
        return {"ok": True, "skipped": "duplicate", "size": len(data)}
    target.write_bytes(data)
    return {"ok": True, "size": len(data), "path": str(target.relative_to(DB_PATH.parent))}


@router.get("/api/vsco-list/{username}")
def list_vsco_media(username: str):
    """Return the archived VSCO media for `username`. Same shape as
    /api/media-list for IG: each item carries media_id, ext, url,
    size. The URL points back at this module's serve endpoint so the
    UI can render thumbnails without a separate fetch round-trip."""
    if not _USER_RE.fullmatch(username or ""):
        raise HTTPException(status_code=400, detail="Invalid VSCO username.")
    d = _VSCO_DIR / username
    if not d.is_dir():
        return {"username": username, "items": []}
    items = []
    for p in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime if x.is_file() else 0, reverse=True):
        if not p.is_file() or p.name.startswith("."):
            continue
        ext = p.suffix.lstrip(".")
        stem = p.stem
        items.append({
            "media_id": stem,
            "ext": ext,
            "url": f"/api/vsco-media/{username}/{stem}.{ext}",
            "size": p.stat().st_size,
        })
    return {"username": username, "items": items}


@router.get("/api/vsco-media/{username}/{media_id}.{ext}")
def serve_vsco_media(username: str, media_id: str, ext: str):
    """Serve a previously-archived VSCO file. Defensive path-sanitize
    on both segments so the {media_id:path} converter can't be tricked
    into ../../ traversal."""
    if not _USER_RE.fullmatch(username or ""):
        raise HTTPException(status_code=400, detail="Invalid VSCO username.")
    media_id = _safe_media_id(media_id)
    if ext not in ("jpg", "jpeg", "png", "webp", "mp4", "mov"):
        raise HTTPException(status_code=400, detail="Bad extension.")
    p = _VSCO_DIR / username / f"{media_id}.{ext}"
    if not p.exists():
        raise HTTPException(status_code=404, detail="Not archived.")
    media_type = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp",
        "mp4": "video/mp4", "mov": "video/quicktime",
    }[ext]
    return FileResponse(p, media_type=media_type,
                        headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/api/vsco-media/{username}/{media_id}.{ext}")
def delete_vsco_media(username: str, media_id: str, ext: str):
    """Delete a single archived VSCO file. Same auth model as the IG
    delete endpoint — none, because the whole tracker runs on
    localhost. Idempotent: 404 if the file's already gone."""
    if not _USER_RE.fullmatch(username or ""):
        raise HTTPException(status_code=400, detail="Invalid VSCO username.")
    media_id = _safe_media_id(media_id)
    p = _VSCO_DIR / username / f"{media_id}.{ext}"
    if not p.exists():
        raise HTTPException(status_code=404, detail="Not archived.")
    p.unlink()
    return {"ok": True, "deleted": str(p.relative_to(DB_PATH.parent))}


@router.delete("/api/vsco-profile/{username}")
def delete_vsco_profile(username: str):
    """Delete an entire archived VSCO profile — every file under
    data/vsco_media/<username>/. Used by the /vsco page's per-profile
    trash button. Same no-auth model as the per-file delete: localhost
    only. Idempotent: 404 if the directory's already gone."""
    if not _USER_RE.fullmatch(username or ""):
        raise HTTPException(status_code=400, detail="Invalid VSCO username.")
    d = _VSCO_DIR / username
    if not d.is_dir():
        raise HTTPException(status_code=404, detail="Profile not archived.")
    removed = 0
    for p in d.iterdir():
        if p.is_file() and not p.name.startswith("."):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    try:
        d.rmdir()
    except OSError:
        # Non-empty (hidden files, OS metadata) — leave the empty dir
        pass
    return {"ok": True, "username": username, "removed": removed}


@router.get("/api/vsco-summary")
def vsco_summary():
    """Aggregate across all archived VSCO users — total items, bytes,
    per-user breakdown. Mirrors /api/media-summary for the IG side so
    the UI can show a parallel card if we want one later."""
    if not _VSCO_DIR.exists():
        return {"users": [], "total_items": 0, "total_bytes": 0}
    users = []
    total_items = 0
    total_bytes = 0
    for d in _VSCO_DIR.iterdir():
        if not d.is_dir():
            continue
        count = 0
        size = 0
        latest_mtime = 0.0
        for p in d.iterdir():
            if not p.is_file() or p.name.startswith("."):
                continue
            count += 1
            try:
                stat = p.stat()
                size += stat.st_size
                latest_mtime = max(latest_mtime, stat.st_mtime)
            except OSError:
                continue
        if count > 0:
            users.append({
                "username": d.name,
                "count": count,
                "bytes": size,
                "latest_mtime": latest_mtime,
            })
            total_items += count
            total_bytes += size
    users.sort(key=lambda u: u["latest_mtime"], reverse=True)
    return {"users": users, "total_items": total_items, "total_bytes": total_bytes}
