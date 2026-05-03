"""IG Vault FastAPI server. All paths live on the mounted encrypted volume."""

from __future__ import annotations

import base64
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


VAULT_VOLUME = Path(os.environ.get("IG_VAULT_VOLUME", "/Volumes/IGVault"))
DATA_DIR = VAULT_VOLUME / "data"
MEDIA_DIR = VAULT_VOLUME / "media"
DB_PATH = DATA_DIR / "vault.db"
STATIC_DIR = Path(__file__).parent / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)


app = FastAPI(title="IG Vault", version="0.1.0")

# CORS — extension-only. Tracker app and random websites can't reach us.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://.*$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_at    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    username    TEXT NOT NULL,
    ig_id       TEXT,
    ig_url      TEXT,
    media_path  TEXT NOT NULL,
    media_type  TEXT NOT NULL,
    caption     TEXT,
    note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_username ON items(username);
CREATE INDEX IF NOT EXISTS idx_items_kind     ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_saved_at ON items(saved_at);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _safe_username(u: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "", u or "")[:60] or "_"


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "mounted": VAULT_VOLUME.exists()}


@app.post("/api/save")
def save(payload: dict = Body(...)) -> dict:
    """Persist a media item the user actively chose to save. Bytes come in
    base64-encoded so the extension can fetch through the service worker
    and pass straight into the body."""
    kind = (payload.get("kind") or "post").lower()
    if kind not in {"post", "story", "highlight", "reel"}:
        raise HTTPException(400, "kind must be post|story|highlight|reel")

    username = (payload.get("username") or "").strip()
    if not username:
        raise HTTPException(400, "username required")

    media_b64 = payload.get("media_bytes_b64")
    if not media_b64:
        raise HTTPException(400, "media_bytes_b64 required")

    media_type = (payload.get("media_type") or "image").lower()
    if media_type not in {"image", "video"}:
        raise HTTPException(400, "media_type must be image|video")

    try:
        media_bytes = base64.b64decode(media_b64)
    except Exception:
        raise HTTPException(400, "media_bytes_b64 not valid base64")

    if not media_bytes:
        raise HTTPException(400, "empty media")

    ext = ".mp4" if media_type == "video" else ".jpg"
    ts_disk = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    relpath = f"{ts_disk}_{_safe_username(username)}_{kind}{ext}"
    full = MEDIA_DIR / relpath
    full.write_bytes(media_bytes)

    saved_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO items (saved_at, kind, username, ig_id, ig_url,
                               media_path, media_type, caption, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                saved_at,
                kind,
                username,
                payload.get("ig_id"),
                payload.get("ig_url"),
                relpath,
                media_type,
                payload.get("caption"),
                None,
            ),
        )
        conn.commit()
        item_id = int(cur.lastrowid)

    return {"ok": True, "id": item_id, "size_bytes": len(media_bytes)}


@app.get("/api/items")
def list_items(username: str | None = None, kind: str | None = None) -> list[dict]:
    sql = (
        "SELECT id, saved_at, kind, username, ig_id, ig_url, "
        "media_path, media_type, caption, note FROM items"
    )
    params: list = []
    where: list[str] = []
    if username:
        where.append("username = ?")
        params.append(username)
    if kind:
        where.append("kind = ?")
        params.append(kind)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY saved_at DESC"
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/media/{item_id}")
def get_media(item_id: int):
    with _connect() as conn:
        row = conn.execute(
            "SELECT media_path, media_type FROM items WHERE id = ?",
            (item_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(404)
    full = MEDIA_DIR / row["media_path"]
    if not full.exists():
        raise HTTPException(404, "media file missing on disk")
    media_type = "video/mp4" if row["media_type"] == "video" else "image/jpeg"
    return FileResponse(full, media_type=media_type)


@app.patch("/api/items/{item_id}")
def update_note(item_id: int, payload: dict = Body(...)) -> dict:
    note = payload.get("note")
    with _connect() as conn:
        cur = conn.execute("UPDATE items SET note = ? WHERE id = ?", (note, item_id))
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404)
    return {"ok": True}


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int) -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT media_path FROM items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(404)
        full = MEDIA_DIR / row["media_path"]
        if full.exists():
            try:
                full.unlink()
            except OSError:
                pass
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.commit()
    return {"ok": True}


# Static UI mounted last so /api routes win.
class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


app.mount("/", NoCacheStaticFiles(directory=STATIC_DIR, html=True), name="static")
