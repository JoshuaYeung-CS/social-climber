# Instagram Tracker

A local-only web app to track changes to your Instagram followers/following over time. No accounts, no API, no data ever leaves your devices.

## What it does

- **Drop a zip, get answers.** Drag the Instagram data export (the `.zip` they email you) into the app. It finds the right files inside, no manual prep.
- **"Who unfollowed me since last time?"** Front and center on the home screen.
- **Have I ever followed them?** Paste any username or `instagram.com/...` link and instantly see whether you've ever followed/requested/been followed-by them.
- **Filter a list of links.** Paste a list, get back which entries you've already touched and which are new.
- **Tag people.** Three buckets: ★ Favorites (alert if they unfollow), ✦ Want-remove (planning to unfollow), ↺ Wait-back (recently followed, waiting on them; alerts after 7 days with no follow-back).

## Run it

```bash
cd /Users/joshua/git-repos/instagram_tracker
./run.sh
```

First run installs deps into a local `.venv`. After that it just starts. The launcher prints two URLs:

- `http://localhost:8000` — open on the Mac
- `http://<mac-ip>:8000` — open in Safari on your phone (must be on the same Wi-Fi)

To use it like an app on your iPhone: open the second URL in Safari, tap Share → "Add to Home Screen". The icon launches a fullscreen, app-feeling experience.

## Stop it

Ctrl-C in the terminal that ran `./run.sh`. The data lives in `data/instagram_tracker.db`.

## Where things are

- `instagram_tracker/server.py` — HTTP API
- `instagram_tracker/static/` — web UI (HTML/CSS/JS)
- `instagram_tracker/db.py` — SQLite schema
- `instagram_tracker/ingest.py` — zip/folder import
- `instagram_tracker/queries.py` — read-side queries
- `instagram_tracker/diffs.py` — snapshot diff math
- `instagram_tracker/alerts.py` — home-screen alerts
- `instagram_tracker/tags.py` — favorites/want-remove/wait-back
- `instagram_tracker/filtering.py` — "filter my links list" logic
- `instagram_tracker/migrate_v1.py` — one-shot migration db
- `data/instagram_tracker.db` — your local database

## Migration

Runs automatically on first launch (if the old `instagram_tracker_v1/instagram_tracker.db` exists). It's idempotent — re-running does nothing if v2 already has data.

The v1 database file was backed up to `instagram_tracker.db.backup_2026-04-28` before any migration ran.

## Future iOS app path

The frontend is written so it can be wrapped in [Capacitor](https://capacitorjs.com) into a real iOS app later. The Python backend would need to be replaced for true on-device standalone.
