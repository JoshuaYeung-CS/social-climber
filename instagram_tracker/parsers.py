import json
from pathlib import Path
from urllib.parse import urlparse

Row = tuple[str, str | None, int | None]


def _read_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _row_from_item(item: dict) -> Row | None:
    """Extract (username, href, timestamp) from a single item entry,
    handling BOTH Meta export shapes:

    Old (pre-May 2026):
      {"string_list_data": [{"value": "username", "href": "...",
                              "timestamp": 1234}]}

    New (May 2026+):
      {"timestamp": 1234, "label_values": [
          {"label": "Username", "value": "username"},
          {"label": "URL", "value": "..."}, ...]}
    """
    # Old shape
    sld = item.get("string_list_data") if isinstance(item, dict) else None
    if sld:
        entry = sld[0]
        username = entry.get("value")
        if username:
            return (username, entry.get("href"), entry.get("timestamp"))
    # New shape
    lv = item.get("label_values") if isinstance(item, dict) else None
    if lv:
        username = None
        href = None
        for kv in lv:
            label = (kv.get("label") or "").lower()
            value = kv.get("value")
            if label == "username":
                username = value
            elif label == "url":
                href = value
        if username:
            return (username, href, item.get("timestamp"))
    return None


def _items_from_payload(data, *legacy_keys: str) -> list:
    """Top-level shape may be a bare list (new) or a dict with one of
    several known keys (old). Returns the list of items."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in legacy_keys:
            v = data.get(k)
            if isinstance(v, list):
                return v
    return []


def _extract_simple(items) -> list[Row]:
    rows: list[Row] = []
    for item in items or []:
        row = _row_from_item(item)
        if row is not None:
            rows.append(row)
    return rows


def parse_followers(path: Path) -> list[Row]:
    return _extract_simple(_read_json(path))


def parse_following(path: Path) -> list[Row]:
    data = _read_json(path)
    items = _items_from_payload(data, "relationships_following")
    rows: list[Row] = []
    for item in items:
        # Old shape sometimes has username at item.title; the helper
        # also covers both shapes via string_list_data / label_values.
        row = _row_from_item(item)
        if row is None and isinstance(item, dict):
            # Legacy fallback: title-only entries.
            username = item.get("title")
            if username:
                row = (username, None, None)
        if row is not None:
            rows.append(row)
    return rows


def parse_pending(path: Path) -> list[Row]:
    data = _read_json(path)
    items = _items_from_payload(
        data,
        "relationships_permanent_follow_requests",
        "relationships_follow_requests_sent",
    )
    return _extract_simple(items)


def parse_recently_unfollowed(path: Path) -> list[Row]:
    data = _read_json(path)
    items = _items_from_payload(data, "relationships_unfollowed_users")
    return _extract_simple(items)


def parse_incoming_requests(path: Path) -> list[Row]:
    """`follow_requests_you've_received.json` — pending requests *from* other
    accounts asking to follow you. Parallel shape to outgoing pending."""
    data = _read_json(path)
    items = _items_from_payload(data, "relationships_follow_requests_received")
    return _extract_simple(items)


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
