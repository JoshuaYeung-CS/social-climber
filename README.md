# Instagram Tracker

A local-only web app for tracking changes to your Instagram followers and following over time. Imports the official Instagram data export, stores everything in a local SQLite database, and runs a small FastAPI server with a mobile-friendly web UI. **No third-party services, no Instagram API, no data ever leaves your machine.**

## Why

Instagram's "Activity" page only shows you a few weeks of changes and never tells you *who* unfollowed you, who removed you as a follower (the silent kick), or what happened to that account that vanished without a trace. The data is all in the official export — but that export is a frozen snapshot from one moment in time, with no way to track change.

This is what falls out when you persist every export and let the diffs do the talking:

- A list of every account that ever unfollowed you, with renames and deactivations filtered out so the count means something
- The exact moment each follow / unfollow / mutual happened, pulled from Instagram's per-row timestamps
- A live activity log of who came, who went, and who quietly removed you between snapshots
- A cumulative "everyone you've ever interacted with" view that doesn't get reset by Instagram's 30-day windows

It's a single SQLite file plus a FastAPI server. You drop in the export zip; it does the rest.

## Features

- **One-step import.** Drop the `.zip` Instagram emails you onto the home screen, or point it at the pre-extracted folder Meta uploads to your Google Drive. The app finds the relevant JSON files at any nesting depth.
- **Auto-import via Drive.** Set `IG_WATCH_FOLDER` to your Drive sync folder and any new Meta export becomes a snapshot in your DB without a click. Detects both `.zip` deliveries and the `meta-YYYY-Mon-DD-HH-MM-SS/` folders Meta drops on the Drive export path. A button on the home page also runs a one-shot scan on demand.
- **Chronological insertion.** Snapshots are ordered by the export's actual timestamp, not the import order. You can drop in a six-month-old export tomorrow and it slots into the right place on the timeline without breaking diffs.
- **Duplicate-safe.** A content hash on every snapshot means re-dropping the same export is a no-op, and a re-drop of an old export back-fills any columns that didn't exist when the snapshot was first imported.
- **Cumulative analyses across all snapshots:**
  - Everyone who ever unfollowed you, with rename and IG-export-quirk noise filtered out
  - Everyone who ever removed you as a follower (Instagram's silent kick)
  - Accounts you still follow despite them dropping you
  - Both directions of "ever requested": follow-requests-you've-sent and follow-requests-you've-received
  - "Follow Request Rejected" / "Incoming Request Rejected" — requests that fizzled instead of resolving as follows
- **Per-account intelligence:**
  - Detects username renames using shared Instagram-side timestamps; aliases are clickable inside the account modal
  - Per-account history view showing every snapshot's status (mutual, not-following-back, recent-unfollow, etc.)
  - Counts distinct on/off/on follow runs per account
  - Heuristic privacy inference (private vs public) per account
- **History tab with timeline chart.** Multi-series line chart of followers / following / mutuals / pending / unfollowers over time, with hover tooltips, drag-to-zoom, and a per-snapshot drill-down on tap. A scrollable activity log under the chart lists every individual change event (someone followed you, you unfollowed someone, your request was accepted, etc.) with precise IG timestamps and per-kind filters.
- **Tagging buckets:**
  - ★ Favorites — high-severity alert when they unfollow you
  - ✦ Want to remove — plan-to-unfollow list
  - ↺ Wait-back — auto-alerts when a tagged account hasn't followed back in 7 days
  - ⚠ Disabled — flag dead accounts; auto-clears on reactivation
  - ✕ Unavailable — flag accounts whose IG page is gone
- **Bulk check.** Paste a list of usernames or Instagram links to see which you've already followed / requested and which are net-new.
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

### Drive auto-import

If your Instagram exports go to Google Drive (Meta's "Send to Google Drive" delivery option) and you have Drive desktop installed on your Mac, set `IG_WATCH_FOLDER` to your Drive's My Drive path and the home page gets a "Scan Drive folder for new exports" button. Already-imported exports are skipped instantly via a `source_path` cache, so re-clicking is cheap.

```bash
IG_WATCH_FOLDER="$HOME/Library/CloudStorage/GoogleDrive-you@example.com/My Drive" ./run.sh
```

For fully-automatic background polling, add `IG_WATCH_POLL=1` (default 60-second interval, override with `IG_WATCH_INTERVAL_S`).

### Optional: HTTPS with a self-signed cert

The default `http://` setup works fine when accessing the app from the same Mac. From your phone over your home Wi-Fi it also works, but iOS Safari blocks some browser features (most notably the Clipboard API used by the **Paste + look up** button) on HTTP origins that aren't `localhost`. If you want those features on the phone, run the server over HTTPS using a cert you generate yourself. **Nothing leaves your LAN.** No third party involved.

**One-time setup** (~5 minutes):

```bash
./scripts/make-cert.sh
```

This produces `data/cert.pem` and `data/key.pem` valid for 10 years, covering `localhost`, `127.0.0.1`, and your Mac's current LAN IP. Both files are git-ignored — they never go to GitHub.

**Run with HTTPS:**

```bash
IG_HTTPS=1 ./run.sh
```

Output now reads `https://localhost:8443` and `https://<lan-ip>:8443`.

**Trust the cert on your iPhone** (one-time, ~5 taps):

1. AirDrop `data/cert.pem` from your Mac to your iPhone (or email it to yourself, or put it in iCloud Drive and tap from Files).
2. iOS shows "Profile Downloaded" — tap to open.
3. Settings → General → VPN & Device Management → tap **IG Tracker Local** profile → **Install** → enter passcode.
4. Settings → General → About → **Certificate Trust Settings** → toggle on "IG Tracker Local".
5. Done. Visit `https://<your-mac-lan-ip>:8443` from Safari — green padlock, no warnings, clipboard works.

**Trust the cert on your Mac** (only if you also see warnings there):

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain data/cert.pem
```

**Re-generating the cert** (e.g. if your LAN IP changes when you switch networks):

```bash
./scripts/make-cert.sh
```

It will ask before overwriting. After regenerating you'll need to re-trust on devices that had the old cert.

### Optional: encrypted media vault

A separate, isolated module for personal-archival of media you actively view on Instagram. Lives at [vault/](vault/) with its own server, port (8765), database, and UI — completely separate from the main tracker. Refuses to run unless its encrypted volume is mounted.

```bash
./scripts/make-vault.sh                 # one-time: creates AES-256 sparsebundle, prompts for passphrase
open "$HOME/Documents/IG Vault.sparsebundle"   # mount it (Finder prompts for passphrase)
python -m vault                          # runs at http://localhost:8765
```

When done: stop the server (Ctrl-C) AND eject the volume in Finder.

The browser extension (also opt-in) adds a "Save to vault" button to its overlay. Set Vault URL in the extension popup to enable.

**Read [vault/SECURITY.md](vault/SECURITY.md) before relying on this.** Encryption protects against post-hoc disclosure (cold drive analysis, lost laptop). It does NOT protect against shoulder-surfing, screen-recording malware, or coercion. Use [scripts/check-screen-recording.sh](scripts/check-screen-recording.sh) to audit which apps have macOS Screen Recording permission.

## Project layout

```
instagram_tracker/
├── server.py     FastAPI HTTP API (~20 endpoints)
├── ingest.py     Zip/folder import with auto-discovery, dedup, backfill
├── watcher.py    Polling folder watcher for Drive auto-import
├── queries.py    Read-side queries, rename + reengagement detection,
│                  privacy inference
├── diffs.py      Snapshot diff math (pure functions)
├── alerts.py     Home-screen alert generation w/ IG-bounce filter
├── tags.py       Five tag buckets w/ auto-clear logic
├── followup.py   Persistent follow queue
├── filtering.py  Bulk seen-vs-new analyzer
├── parsers.py    Instagram JSON parsing
├── db.py         SQLite schema + idempotent migrations + content-hash
│                  helpers
└── static/       Mobile-first single-page UI (vanilla JS, hand-rolled
                   SVG charts, no build step)
```

## Privacy

This is the entire surface area for your data:
- `data/instagram_tracker.db` — local SQLite file, never transmitted
- A FastAPI server that binds to `0.0.0.0:8000` so your phone on the same Wi-Fi can reach it
- The frontend is plain HTML/CSS/JS served from disk; it makes no third-party requests

`data/`, `.venv/`, and other local artifacts are gitignored. Even if this repository is shared, none of your follower history is included.

## License

MIT — see [LICENSE](./LICENSE).
