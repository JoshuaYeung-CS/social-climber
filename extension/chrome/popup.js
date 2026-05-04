// Popup UI for the IG Tracker companion extension. Handles:
//   - Showing whether the local app is reachable
//   - "Run export" button → opens the Meta export page so the content
//     script there can take over and auto-fill the wizard
//   - Quick-link shortcuts to common views in the local app
//   - Settings: tracker URL, optional saved IG password, OAuth auto-click
//     toggle, profile-overlay enable/disable
//
// All settings persist in chrome.storage.local. Nothing is ever sent off
// the user's machine — the extension only ever talks to two destinations:
// (1) the user's own localhost tracker, and (2) instagram.com pages they
// were already going to visit.

const DEFAULT_TRACKER = "http://127.0.0.1:8000";
const DEFAULTS = {
  trackerUrl: DEFAULT_TRACKER,
  vaultUrl: "",            // empty = vault save button hidden
  igPassword: "",
  notificationEmail: "",   // used by the "Fill notification email" quick-button
  autosubmitGoogle: false,
  showOverlay: true,
};

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

function el(id) { return document.getElementById(id); }

async function checkTrackerReachable(url) {
  const status = el("status");
  status.textContent = "checking…";
  status.className = "status";
  try {
    const r = await fetch(`${url}/api/health`, { method: "GET" });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    status.textContent = `tracker v${data.version} ok`;
    status.className = "status ok";
  } catch (e) {
    status.textContent = "tracker offline";
    status.className = "status err";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await loadSettings();
  el("tracker-url").value = settings.trackerUrl;
  el("vault-url").value = settings.vaultUrl;
  el("ig-password").value = settings.igPassword;
  el("notification-email").value = settings.notificationEmail || "";
  el("autosubmit-google").checked = settings.autosubmitGoogle;
  el("show-overlay").checked = settings.showOverlay;

  await checkTrackerReachable(settings.trackerUrl);

  const u = settings.trackerUrl.replace(/\/$/, "");
  el("open-tracker").href = u + "/";
  el("open-lists").href = u + "/?view=lists";
  el("open-imports").href = u + "/?view=snapshots";

  // Open the local app in a new tab when the user clicks a quick link.
  for (const id of ["open-tracker", "open-lists", "open-imports"]) {
    el(id).addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: e.target.href });
    });
  }

  el("run-export").addEventListener("click", async () => {
    // Open Meta's "Download or transfer your information" page. The
    // meta-export content script picks up from there.
    const url = "https://accountscenter.instagram.com/info_and_permissions/dyi/";
    chrome.tabs.create({ url });
    // Mark the next-page-load as "wizard auto-run requested" so the
    // content script knows to take action instead of waiting passively.
    await chrome.storage.local.set({ wizardRunRequested: Date.now() });
  });

  // One-shot quick-fill helpers. Each sends a message to the active
  // Meta tab; the content script there runs the matching step.
  async function sendOneShot(messagePayload, doneText) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (!/accountscenter\.instagram\.com|instagram\.com\/accounts\/center/.test(tab.url || "")) {
      flashStatus("open the IG export page first");
      return;
    }
    chrome.tabs.sendMessage(tab.id, messagePayload, (resp) => {
      const err = chrome.runtime.lastError;
      if (err || !resp?.ok) {
        flashStatus(resp?.error || "couldn't reach the page — refresh it?");
      } else {
        flashStatus(doneText);
      }
    });
  }
  function flashStatus(text) {
    const status = el("status");
    if (!status) return;
    status.textContent = text;
    setTimeout(() => { status.textContent = ""; }, 3000);
  }
  el("toggle-followers-only").addEventListener("click", () =>
    sendOneShot({ type: "toggle-followers-only" }, "done — only F+F checked"));
  el("set-format-json").addEventListener("click", () =>
    sendOneShot({ type: "set-format-json" }, "format → JSON"));
  el("set-date-all-time").addEventListener("click", () =>
    sendOneShot({ type: "set-date-all-time" }, "date → All time"));
  el("fill-email").addEventListener("click", async () => {
    const settings = await loadSettings();
    if (!settings.notificationEmail) {
      flashStatus("set a notification email in Settings first");
      return;
    }
    sendOneShot({ type: "fill-email", email: settings.notificationEmail },
                `email → ${settings.notificationEmail}`);
  });

  el("save-settings").addEventListener("click", async () => {
    const patch = {
      trackerUrl: el("tracker-url").value.trim() || DEFAULT_TRACKER,
      vaultUrl: el("vault-url").value.trim(),          // empty = save-to-vault button hidden
      igPassword: el("ig-password").value,             // empty = don't autofill
      notificationEmail: el("notification-email").value.trim(),
      autosubmitGoogle: el("autosubmit-google").checked,
      showOverlay: el("show-overlay").checked,
    };
    await saveSettings(patch);
    el("save-settings").textContent = "Saved ✓";
    setTimeout(() => { el("save-settings").textContent = "Save settings"; }, 1200);
    await checkTrackerReachable(patch.trackerUrl);
  });
});
