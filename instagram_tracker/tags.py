"""User-managed tags: favorites, want-remove, watchlist (a.k.a. wait-back).

Each flag has its own added_at column, set when the flag flips 0 -> 1 and
cleared when it flips back. This is what powers the wait-back overdue alerts.
"""

import sqlite3

from .db import utc_now_iso

VALID_FLAGS = {"favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request", "now_public", "to_follow", "star"}


def _added_at_col(flag: str) -> str:
    return f"{flag}_added_at"


def get_tags(conn: sqlite3.Connection, username: str) -> dict:
    row = conn.execute(
        "SELECT * FROM profile_tags WHERE username = ?", (username,)
    ).fetchone()
    if row is None:
        return {
            "username": username,
            "favorite": False,
            "want_remove": False,
            "watchlist": False,
            "disabled": False,
            "unavailable": False,
            "random_request": False,
            "now_public": False,
            "to_follow": False,
            "star": False,
            "favorite_added_at": None,
            "want_remove_added_at": None,
            "watchlist_added_at": None,
            "disabled_added_at": None,
            "unavailable_added_at": None,
            "random_request_added_at": None,
            "now_public_added_at": None,
            "to_follow_added_at": None,
            "star_added_at": None,
            "profile_url": None,
            "notes": None,
        }
    keys = row.keys()
    return {
        "username": row["username"],
        "favorite": bool(row["favorite"]),
        "want_remove": bool(row["want_remove"]),
        "watchlist": bool(row["watchlist"]),
        "disabled": bool(row["disabled"]) if "disabled" in keys else False,
        "unavailable": bool(row["unavailable"]) if "unavailable" in keys else False,
        "random_request": bool(row["random_request"]) if "random_request" in keys else False,
        "now_public": bool(row["now_public"]) if "now_public" in keys else False,
        "to_follow": bool(row["to_follow"]) if "to_follow" in keys else False,
        "star": bool(row["star"]) if "star" in keys else False,
        "favorite_added_at": row["favorite_added_at"],
        "want_remove_added_at": row["want_remove_added_at"],
        "watchlist_added_at": row["watchlist_added_at"],
        "disabled_added_at": row["disabled_added_at"] if "disabled_added_at" in keys else None,
        "unavailable_added_at": row["unavailable_added_at"] if "unavailable_added_at" in keys else None,
        "random_request_added_at": row["random_request_added_at"] if "random_request_added_at" in keys else None,
        "now_public_added_at": row["now_public_added_at"] if "now_public_added_at" in keys else None,
        "to_follow_added_at": row["to_follow_added_at"] if "to_follow_added_at" in keys else None,
        "star_added_at": row["star_added_at"] if "star_added_at" in keys else None,
        "profile_url": row["profile_url"],
        "notes": row["notes"],
    }


def set_flag(
    conn: sqlite3.Connection,
    username: str,
    flag: str,
    value: bool,
    profile_url: str | None = None,
) -> dict:
    if flag not in VALID_FLAGS:
        raise ValueError(f"Unknown tag: {flag}")

    now = utc_now_iso()
    existing = conn.execute(
        "SELECT * FROM profile_tags WHERE username = ?", (username,)
    ).fetchone()

    if existing is None:
        cols = {f: 0 for f in VALID_FLAGS}
        added = {_added_at_col(f): None for f in VALID_FLAGS}
        if value:
            cols[flag] = 1
            added[_added_at_col(flag)] = now
        conn.execute(
            """
            INSERT INTO profile_tags (
                username, favorite, favorite_added_at,
                want_remove, want_remove_added_at,
                watchlist, watchlist_added_at,
                disabled, disabled_added_at,
                unavailable, unavailable_added_at,
                random_request, random_request_added_at,
                now_public, now_public_added_at,
                to_follow, to_follow_added_at,
                star, star_added_at,
                profile_url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                username,
                cols["favorite"], added["favorite_added_at"],
                cols["want_remove"], added["want_remove_added_at"],
                cols["watchlist"], added["watchlist_added_at"],
                cols["disabled"], added["disabled_added_at"],
                cols["unavailable"], added["unavailable_added_at"],
                cols["random_request"], added["random_request_added_at"],
                cols["now_public"], added["now_public_added_at"],
                cols["to_follow"], added["to_follow_added_at"],
                cols["star"], added["star_added_at"],
                profile_url, now,
            ),
        )
    else:
        current_value = bool(existing[flag])
        new_value = 1 if value else 0
        added_at_col = _added_at_col(flag)
        if value and not current_value:
            new_added_at = now
        elif not value:
            new_added_at = None
        else:
            new_added_at = existing[added_at_col]

        conn.execute(
            f"""
            UPDATE profile_tags
            SET {flag} = ?, {added_at_col} = ?, profile_url = COALESCE(?, profile_url), updated_at = ?
            WHERE username = ?
            """,
            (new_value, new_added_at, profile_url, now, username),
        )

    conn.commit()
    return get_tags(conn, username)


def list_with_flag(conn: sqlite3.Connection, flag: str) -> list[dict]:
    if flag not in VALID_FLAGS:
        raise ValueError(f"Unknown tag: {flag}")
    rows = conn.execute(
        f"""
        SELECT username, profile_url, {flag}_added_at AS added_at
        FROM profile_tags WHERE {flag} = 1 ORDER BY username ASC
        """,
    ).fetchall()
    return [
        {"username": r["username"], "profile_url": r["profile_url"], "added_at": r["added_at"]}
        for r in rows
    ]


def all_flagged_usernames(conn: sqlite3.Connection) -> dict[str, dict[str, bool]]:
    rows = conn.execute(
        "SELECT username, favorite, want_remove, watchlist, disabled, unavailable, random_request, now_public, to_follow, star "
        "FROM profile_tags "
        "WHERE favorite = 1 OR want_remove = 1 OR watchlist = 1 OR disabled = 1 OR unavailable = 1 OR random_request = 1 OR now_public = 1 OR to_follow = 1 OR star = 1"
    ).fetchall()
    return {
        r["username"]: {
            "favorite": bool(r["favorite"]),
            "want_remove": bool(r["want_remove"]),
            "watchlist": bool(r["watchlist"]),
            "disabled": bool(r["disabled"]),
            "unavailable": bool(r["unavailable"]),
            "random_request": bool(r["random_request"]),
            "now_public": bool(r["now_public"]),
            "to_follow": bool(r["to_follow"]),
            "star": bool(r["star"]),
        }
        for r in rows
    }
