# Instagram Tracker

A local-only web app for tracking changes to your Instagram followers and following over time. Imports the official Instagram data export, stores everything in a local SQLite database, and runs a small FastAPI server with a mobile-friendly web UI. No third-party services, no Instagram API, no data ever leaves your machine.

## Features

- **One-step import.** Drop the `.zip` Instagram emails you onto the home screen. The app auto-discovers the relevant JSON files inside any nesting level.
- **Snapshot history.** Every import is stored as a snapshot. Compare any two snapshots, browse the full timeline, or look up an account's complete history.
- **Cumulative analyses across all snapshots:**
  - Anyone who ever unfollowed you, with rename and deactivation noise filtered out
  - Anyone who ever removed you as a follower (Instagram's silent kick)
  - Accounts you still follow despite them dropping you
- **Per-account intelligence:**
  - Detects username renames using shared Instagram-side timestamps
  - Detects account deactivations (gaps where the original follow timestamp is preserved)
  - Counts distinct on/off/on follow runs per account
- **Tagging buckets:**
  - ★ Favorites — alert when they unfollow you
  - ✦ Want to remove — plan-to-unfollow list
  - ↺ Wait-back — auto-alerts when a tagged account hasn't followed back in 7 days
  - ⚠ Disabled — flag dead accounts; auto-unflag on reactivation
- **Bulk check.** Paste a list of usernames or Instagram links to see which ones you've already followed/requested and which are net-new.
- **Persistent follow queue.** New accounts you decide to follow stay queued across sessions. Tap a queue entry to open Instagram and remove it from the queue.
- **PWA-ready.** Add to Home Screen on iPhone for a native-feeling app over your local Wi-Fi.

## Running locally

Requires Python 3.10+ (3.11 recommended). On first run, dependencies install into a local `.venv` automatically.

```bash
./run.sh
```

The launcher prints two URLs:
- `http://localhost:8000` — open on the same machine
- `http://<your-lan-ip>:8000` — open in Safari on your phone (same Wi-Fi)

Stop with `Ctrl-C`. Your local database lives at `data/instagram_tracker.db`.

## Project layout

```
instagram_tracker/
├── server.py     FastAPI HTTP API (~12 endpoints)
├── ingest.py     Zip/folder import with auto-discovery
├── queries.py    Read-side queries, rename + deactivation detection
├── diffs.py      Snapshot diff math (pure functions)
├── alerts.py     Home-screen alert generation
├── tags.py       Bucket flags + auto-clear logic
├── followup.py   Persistent follow queue
├── filtering.py  Bulk seen-vs-new analyzer
├── parsers.py    Instagram JSON parsing
├── db.py         SQLite schema + idempotent migrations
└── static/       Mobile-first single-page UI (vanilla JS, no build step)
```

## Privacy

This is the entire surface area for your data:
- `data/instagram_tracker.db` — local SQLite file, never transmitted
- A FastAPI server that binds to `0.0.0.0:8000` so your phone on the same Wi-Fi can reach it
- The frontend is plain HTML/CSS/JS served from disk; it makes no third-party requests

`data/`, `.venv/`, and other local artifacts are gitignored. Even if this repository is shared, none of your follower history is included.

## License

MIT — see [LICENSE](./LICENSE).
