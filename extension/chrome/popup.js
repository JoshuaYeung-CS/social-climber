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
  googleAccountEmail: "",  // empty = OAuth account picker is left manual
  autosubmitGoogle: false,
  showOverlay: true,
  autoArchiveMedia: false, // opt-in: download bytes of every post/reel viewed
  exportScheduleHours: 0,  // 0 = off; 24 = daily, 168 = weekly, etc.
};

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

// Schedule UI: a checkbox + number input + unit selector that map to a
// single `exportScheduleHours` value in storage. We render whatever is
// stored as the most natural unit (e.g. 0.5h shows as "30 minutes",
// 168h as "7 days"). Changes save instantly — the background SW
// listens for the storage change and re-arms the alarm.
const _UNIT_TO_HOURS = { minutes: 1 / 60, hours: 1, days: 24 };

function _hoursToInputs(hours) {
  if (!hours || hours <= 0) return { on: false, amount: 1, unit: "hours" };
  // Prefer a unit where the value lands as a clean integer.
  if (hours >= 24 && Number.isInteger(hours / 24)) {
    return { on: true, amount: hours / 24, unit: "days" };
  }
  if (Number.isInteger(hours)) {
    return { on: true, amount: hours, unit: "hours" };
  }
  return { on: true, amount: Math.round(hours * 60), unit: "minutes" };
}

function _inputsToHours(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * (_UNIT_TO_HOURS[unit] || 1);
}

function _fmtAgo(ts) {
  if (!ts) return "—";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function _fmtSeconds(s) {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)} min`;
}

async function renderExportStats() {
  const card = el("export-stats-card");
  if (!card) return;
  const resp = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: "get-export-stats" }, (r) => resolve(r || null)); }
    catch { resolve(null); }
  });
  if (!resp || !resp.ok) { card.hidden = true; return; }
  const history = resp.history || [];
  const timings = resp.timings || [];
  if (history.length === 0 && timings.length === 0 && !resp.pending) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  // Summary line: predicted arrival window. Use measured timings
  // when we have them; otherwise fall back to the empirical
  // estimate of ~13min ± 5min the user reported from manual timing.
  const summaryParts = [];
  if (timings.length > 0) {
    const sorted = [...timings].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    summaryParts.push(`avg arrival ${_fmtSeconds(Math.round(avg))} (range ${_fmtSeconds(min)}–${_fmtSeconds(max)}) over ${timings.length} run${timings.length === 1 ? "" : "s"}`);
  } else {
    summaryParts.push(`expected arrival ~13 min (typically 8–18) — no measured runs yet`);
  }
  if (resp.pending && resp.pending.startedAt) {
    const elapsedMin = Math.round((Date.now() - resp.pending.startedAt) / 60000);
    summaryParts.push(`current run waiting in Drive (${elapsedMin}m elapsed)`);
  }
  el("export-stats-summary").textContent = summaryParts.join(" · ");

  // History list — newest first, last 8 entries.
  const recent = history.slice().reverse().slice(0, 8);
  el("export-history").innerHTML = recent.map((h) => {
    const when = _fmtAgo(h.ts);
    const badge = h.status === "arrived" ? "✓"
                : h.status === "no-arrival" ? "⚠"
                : h.status === "triggered-manual" ? "▶ manual"
                : "▶ auto";
    const detail = h.status === "arrived"
      ? `arrived in ${_fmtSeconds(h.elapsedSec)}`
      : h.status === "no-arrival"
        ? `no arrival within ${_fmtSeconds(h.elapsedSec)}`
        : "";
    return `<li><span class="badge">${badge}</span> ${when}${detail ? " — " + detail : ""}</li>`;
  }).join("");
}

function _fmtScheduleStatus(hours) {
  if (!hours || hours <= 0) return "off";
  if (hours < 1) return `every ${Math.round(hours * 60)} min`;
  if (hours < 24) return `every ${hours % 1 === 0 ? hours : hours.toFixed(1)} hr`;
  const days = hours / 24;
  return `every ${days % 1 === 0 ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
}

function initScheduleControls(initialHours) {
  const onEl = el("schedule-on");
  const amtEl = el("schedule-amount");
  const unitEl = el("schedule-unit");
  const statusEl = el("schedule-status");
  const init = _hoursToInputs(initialHours);
  onEl.checked = init.on;
  amtEl.value = String(init.amount);
  unitEl.value = init.unit;
  amtEl.disabled = !init.on;
  unitEl.disabled = !init.on;
  statusEl.textContent = _fmtScheduleStatus(initialHours);

  async function persist() {
    amtEl.disabled = !onEl.checked;
    unitEl.disabled = !onEl.checked;
    const hours = onEl.checked ? _inputsToHours(amtEl.value, unitEl.value) : 0;
    await chrome.storage.local.set({ exportScheduleHours: hours });
    statusEl.textContent = _fmtScheduleStatus(hours);
  }

  onEl.addEventListener("change", persist);
  amtEl.addEventListener("input", persist);
  unitEl.addEventListener("change", persist);
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
  el("google-account-email").value = settings.googleAccountEmail || "";
  el("autosubmit-google").checked = settings.autosubmitGoogle;
  el("show-overlay").checked = settings.showOverlay;
  el("auto-archive-media").checked = settings.autoArchiveMedia;
  initScheduleControls(settings.exportScheduleHours || 0);

  await checkTrackerReachable(settings.trackerUrl);
  renderExportStats();

  el("run-export").addEventListener("click", () => {
    // Delegate to the background SW: it opens the wizard tab, captures
    // its id, sets wizardRunRequested with {ts, tabId}, appends a
    // history entry, and starts the arrival-poll alarm — all in one
    // place that's not tied to the popup's lifecycle. (The popup
    // closes the moment chrome.tabs.create focuses the new tab, so any
    // post-create awaits in the popup get cut off.)
    try { chrome.runtime.sendMessage({ type: "start-manual-export" }); } catch {}
    // Fire-and-forget — the popup may close before this returns. That's
    // fine; the SW handles everything.
  });

  el("stop-export").addEventListener("click", async () => {
    // Cancel any in-progress export. Clearing wizardRunRequested
    // makes the content script's per-step abort check throw, and
    // prevents the post-OAuth landing from auto-resuming. Background
    // handler also kills the arrival-poll alarm so we stop checking
    // for a Drive arrival that's not coming.
    await chrome.storage.local.set({
      wizardRunRequested: 0,
      pendingArrival: null,
    });
    try { await chrome.runtime.sendMessage({ type: "stop-export" }); } catch {}
    renderExportStats();
    flashStatus("Export stopped.");
  });

  function flashStatus(text) {
    const status = el("status");
    if (!status) return;
    status.textContent = text;
    setTimeout(() => { status.textContent = ""; }, 3000);
  }
  el("save-all-tabs").addEventListener("click", async () => {
    // Collect every open Instagram profile URL across windows and POST
    // them in a batch to /api/followup/add. The tracker dedupes against
    // its existing queue + the user's current followers/following so
    // already-known accounts don't get re-queued.
    const settings = await loadSettings();
    const tabs = await chrome.tabs.query({});
    const items = [];
    const seen = new Set();
    for (const t of tabs) {
      const url = t.url || "";
      // Match a profile URL like /<username>/ — exclude obvious non-profile
      // paths (post pages, reels, stories, accounts/center, explore, etc).
      const m = url.match(/^https:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?|$|#)/);
      if (!m) continue;
      const username = m[1].toLowerCase();
      const RESERVED = new Set([
        "explore", "reels", "direct", "p", "accounts", "accountscenter",
        "tv", "stories", "web", "about", "developer", "legal", "press",
      ]);
      if (RESERVED.has(username)) continue;
      if (seen.has(username)) continue;
      seen.add(username);
      items.push({ username, profile_url: `https://www.instagram.com/${username}/`, input: username });
    }
    if (items.length === 0) {
      flashStatus("no IG profile tabs open");
      return;
    }
    flashStatus(`saving ${items.length} tab${items.length === 1 ? "" : "s"}…`);
    try {
      const r = await fetch(`${settings.trackerUrl}/api/followup/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await r.json();
      flashStatus(`queued ${data.added}/${items.length} (total ${data.total})`);
    } catch (e) {
      flashStatus(`failed: ${e.message}`);
    }
  });

  el("archive-current-media").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (!/^https:\/\/(www\.)?instagram\.com\//.test(tab.url || "")) {
      flashStatus("open an instagram.com post / reel first");
      return;
    }
    flashStatus("archiving current media…");
    chrome.tabs.sendMessage(tab.id, { type: "archive-current-media" }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // "Could not establish connection. Receiving end does not
        // exist." means the IG tab was loaded BEFORE the extension was
        // reloaded, so the old content script (which doesn't have this
        // handler) is still running. The user needs to refresh the IG
        // tab to pick up the new code.
        if (/Receiving end does not exist/i.test(err.message || "")) {
          flashStatus("refresh the IG tab first (extension was reloaded)");
        } else {
          flashStatus(`failed: ${err.message}`);
        }
        return;
      }
      if (!resp) {
        flashStatus("no response — try refreshing the IG tab");
        return;
      }
      if (resp.ok) {
        const slideInfo = resp.slides && resp.slides > 1
          ? ` (${resp.saved}/${resp.slides} slides)`
          : "";
        flashStatus(`saved @${resp.username}/${resp.media_id}${slideInfo}`);
      } else {
        flashStatus(`failed: ${resp.error || "unknown"}`);
      }
    });
  });

  el("copy-debug-log").addEventListener("click", async () => {
    // Pull the [IG Tracker] log out of the active tab's content
    // script. We don't know up front whether we're on instagram.com
    // (ig-profile.js) or accountscenter.instagram.com (meta-export.js)
    // so just try the active tab — both content scripts respond to
    // get-debug-log.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      flashStatus("no active tab");
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "get-debug-log" }, async (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/Receiving end does not exist/i.test(err.message || "")) {
          flashStatus("no IG Tracker logs on this tab — open instagram.com");
        } else {
          flashStatus(`failed: ${err.message}`);
        }
        return;
      }
      if (!resp || !resp.ok) {
        flashStatus("no logs available");
        return;
      }
      const header = `# IG Tracker debug log\n# url: ${resp.url}\n# entries: ${resp.count}\n# extension version: ${chrome.runtime.getManifest().version}\n\n`;
      const text = header + (resp.log || "(empty)");
      try {
        await navigator.clipboard.writeText(text);
        flashStatus(`copied ${resp.count} log line${resp.count === 1 ? "" : "s"}`);
      } catch (e) {
        flashStatus(`clipboard failed: ${e.message}`);
      }
    });
  });

  el("save-settings").addEventListener("click", async () => {
    const patch = {
      trackerUrl: el("tracker-url").value.trim() || DEFAULT_TRACKER,
      vaultUrl: el("vault-url").value.trim(),          // empty = save-to-vault button hidden
      igPassword: el("ig-password").value,             // empty = don't autofill
      notificationEmail: el("notification-email").value.trim(),
      googleAccountEmail: el("google-account-email").value.trim(),
      autosubmitGoogle: el("autosubmit-google").checked,
      showOverlay: el("show-overlay").checked,
      autoArchiveMedia: el("auto-archive-media").checked,
      // Schedule has its own dedicated UI that saves on every change
      // (see initScheduleControls), so we re-read the current stored
      // value here rather than computing from the inputs again.
      exportScheduleHours: (await chrome.storage.local.get(["exportScheduleHours"])).exportScheduleHours || 0,
    };
    await saveSettings(patch);
    el("save-settings").textContent = "Saved ✓";
    setTimeout(() => { el("save-settings").textContent = "Save settings"; }, 1200);
    await checkTrackerReachable(patch.trackerUrl);
  });
});
