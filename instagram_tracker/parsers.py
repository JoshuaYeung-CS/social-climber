import json
from pathlib import Path
from urllib.parse import urlparse

Row = tuple[str, str | None, int | None]


def _read_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _extract_simple(items) -> list[Row]:
    rows: list[Row] = []
    for item in items or []:
        sld = item.get("string_list_data", [])
        if not sld:
            continue
        entry = sld[0]
        username = entry.get("value")
        if username:
            rows.append((username, entry.get("href"), entry.get("timestamp")))
    return rows


def parse_followers(path: Path) -> list[Row]:
    return _extract_simple(_read_json(path))


def parse_following(path: Path) -> list[Row]:
    data = _read_json(path)
    rows: list[Row] = []
    for item in data.get("relationships_following", []):
        username = item.get("title")
        sld = item.get("string_list_data", [])
        entry = sld[0] if sld else {}
        if username:
            rows.append((username, entry.get("href"), entry.get("timestamp")))
    return rows


def parse_pending(path: Path) -> list[Row]:
    data = _read_json(path)
    items = data.get("relationships_permanent_follow_requests")
    if items is None:
        items = data.get("relationships_follow_requests_sent", [])
    return _extract_simple(items)


def parse_recently_unfollowed(path: Path) -> list[Row]:
    data = _read_json(path)
    return _extract_simple(data.get("relationships_unfollowed_users", []))


def parse_incoming_requests(path: Path) -> list[Row]:
    """`follow_requests_you've_received.json` — pending requests *from* other
    accounts asking to follow you. Parallel shape to outgoing pending."""
    data = _read_json(path)
    return _extract_simple(data.get("relationships_follow_requests_received", []))


def normalize_account_input(value: str) -> tuple[str, str]:
    """Accepts a raw username, @handle, or instagram URL. Returns (username, canonical_url)."""
    raw = (value or "").strip()
    if not raw:
        raise ValueError("Empty username/link.")

    compact = "".join(raw.split())
    candidate = compact

    if "instagram.com/" in compact and not compact.startswith(("http://", "https://")):
        candidate = "https://" + compact

    if candidate.startswith(("http://", "https://")):
        parsed = urlparse(candidate)
        path_parts = [p for p in parsed.path.split("/") if p]
        if not path_parts:
            raise ValueError(f"Could not extract username from link: {value}")
        username = path_parts[0].replace("@", "").strip()
    else:
        username = compact.replace("@", "").strip().strip("/")

    if not username:
        raise ValueError("Empty username/link.")

    return username, f"https://www.instagram.com/{username}/"
