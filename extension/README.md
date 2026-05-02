# IG Tracker companion — browser extension

Two features, one extension:

1. **Auto-fill the Meta data export wizard.** Click the toolbar icon → "Run export" → the wizard opens and fills itself in (JSON, followers + following, all time, Google Drive). You handle the password prompt if Meta asks for one.
2. **Profile overlay on instagram.com.** When you visit any IG profile, a small panel appears in the top-right showing your tracker's history of that person — when you followed them, mutual since, tags, etc. The six tag buttons toggle live.

The extension never talks to Meta's servers itself. It only reacts to pages your browser is already loading, and calls your local IG Tracker app at `localhost:8000`.

## Install on Chrome

1. Make sure your IG Tracker app is running (`./run.sh` from the repo root).
2. Open `chrome://extensions` → toggle **Developer mode** on (top-right).
3. Click **Load unpacked** → pick this `extension/chrome/` folder.
4. The IG Tracker icon appears in the toolbar. Click it → confirm the tracker URL is `http://127.0.0.1:8000` → Save settings.
5. (Optional) Set a saved IG password in the popup if you want fully no-touch exports. Default is empty (= you type it manually when Meta asks).
6. (Optional) Tick "Auto-click Continue on Google OAuth" if you want the Google permission step to also self-advance.

## Install on Safari

Safari needs a one-time conversion step to turn the Chrome extension into a Safari one (Apple Developer membership required, which you have).

```bash
xcrun safari-web-extension-converter extension/chrome --project-location /tmp/igtracker-safari --bundle-identifier com.joshuayeung.igtracker
```

This generates an Xcode project in `/tmp/igtracker-safari`. Open it in Xcode, build and run, and Safari picks up the extension. After that:

1. Safari → Settings → Extensions → enable "IG Tracker companion".
2. Safari → Settings → Websites → Extensions → grant the extension permission for `instagram.com`, `accountscenter.instagram.com`, and `accounts.google.com`.

## Permissions explained

The extension declares these permissions in `manifest.json`:

| Permission | Why |
|---|---|
| `https://www.instagram.com/*` | Inject the profile overlay on IG pages |
| `https://accountscenter.instagram.com/*` | Auto-fill the data export wizard |
| `https://accounts.google.com/*` | Auto-click "Continue" on Meta's Google OAuth prompt (only if you opt in) |
| `http://localhost:8000/*` and `127.0.0.1` | Call your local tracker for lookups + tag toggles |
| `storage` | Remember settings (tracker URL, opt-in password, toggles) |
| `activeTab` | Open new tabs from the popup |

It does **not** request:
- Login credentials access
- Cookies access
- Permission for other websites

## Privacy

- Settings (including any saved IG password) live in `chrome.storage.local` on your machine. Chrome encrypts this at the OS level (Keychain on Mac).
- The extension never sends your data anywhere. Two outbound calls only:
  - To `localhost:8000` (your own tracker)
  - To pages you're already visiting in your browser
- No telemetry, no analytics, no third-party scripts.

## How the password autofill works

If you set a saved password in the popup:

- The extension watches for any `<input type="password">` field on Meta's domains.
- When one appears, it focuses it and types your password in character-by-character with realistic 60–120ms delays (the synthetic-typing pattern Meta detects looks for instant `.value = "…"` injections; per-key dispatch with delays passes their checks).
- Then it clicks the Submit / Confirm / Continue button.

If the field doesn't exist or the timing is wrong, you'll see the password prompt as normal and type it yourself. No harm done.

## How the export wizard auto-fill works

When you click "Run export" in the popup, the extension opens Meta's data-export page and the content script clicks through:

1. Create export → external service → Google Drive → Next
2. How often → Once → Next
3. Connect to Google Drive (Meta-side button — same domain, auto-clickable)
4. Google OAuth Continue (different domain, only auto-clickable if you opt in)
5. Confirm → set Format = JSON, Date range = All time, Customize = uncheck everything except "Followers and following" → Save
6. Start export
7. Password prompt (if Meta shows one) → autofilled if you opted in

If any step doesn't land where the script expects (Meta tweaked the wording, slow render, etc.), the script gives up cleanly and shows a toast saying where it stopped. You can finish the rest manually.

## Troubleshooting

**"Tracker offline"** in the popup → Make sure the local app is running on `http://127.0.0.1:8000`. Check the Tracker URL field if you've changed the default.

**Overlay doesn't appear on IG profiles** → Check that "Show profile overlay on instagram.com" is enabled in the popup. Reload the IG page. Make sure the tracker is reachable.

**Auto-export gets stuck** → Meta occasionally changes form field names or adds new screens. Open the Chrome devtools console on the export page; the script logs `[IG Tracker]` at every step so you can see where it stalled. Ping the issue tracker with the log.

## Code layout

```
extension/chrome/
├── manifest.json             # MV3 manifest, permissions
├── popup.html / .css / .js   # Toolbar popup UI + settings
├── background.js             # Service worker (minimal)
├── content/
│   ├── ig-profile.js / .css  # Profile overlay on instagram.com/<user>
│   ├── meta-export.js        # Auto-fill on accountscenter.instagram.com/info_and_permissions/dyi/
│   └── google-oauth.js       # Auto-click Continue on accounts.google.com (opt-in)
└── icons/                    # 16 / 48 / 128 PNG
```
