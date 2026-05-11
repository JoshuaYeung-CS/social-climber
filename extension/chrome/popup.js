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
  exportScheduleHours: 0,        // legacy fallback; new fields below take precedence
  exportScheduleMinHours: 0,     // 0 = off
  exportScheduleMaxHours: 0,     // ≥ min; equal = no jitter
};

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

// Schedule UI: a checkbox + min/max number inputs + unit selector that
// map to `exportScheduleMinHours` / `exportScheduleMaxHours` in storage.
// Setting min < max gives a random uniform draw inside [min, max] for
// each scheduled run — makes the cadence look less robotic to IG.
// Setting min == max keeps a fixed interval. Legacy
// `exportScheduleHours` is honoured as a fallback when the new fields
// are unset (so an upgrade doesn't silently disable the schedule).
const _UNIT_TO_HOURS = { minutes: 1 / 60, hours: 1, days: 24 };

function _pickUnit(hours) {
  if (hours >= 24 && Number.isInteger(hours / 24)) return "days";
  if (Number.isInteger(hours)) return "hours";
  return "minutes";
}

function _hoursToAmount(hours, unit) {
  if (unit === "days") return hours / 24;
  if (unit === "minutes") return Math.round(hours * 60);
  return Number.isInteger(hours) ? hours : Number(hours.toFixed(2));
}

function _rangeToInputs(minHours, maxHours) {
  if (!minHours || minHours <= 0) return { on: false, amountMin: 1, amountMax: 1, unit: "hours" };
  // Pick the unit that renders min cleanly; max uses the same unit.
  const unit = _pickUnit(minHours);
  return {
    on: true,
    amountMin: _hoursToAmount(minHours, unit),
    amountMax: _hoursToAmount(maxHours || minHours, unit),
    unit,
  };
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
    const firstMin = resp.pending.firstMin;
    const giveUpMin = resp.pending.giveUpMin;
    let pendingText = `current run waiting in Drive (${elapsedMin}m elapsed`;
    if (Number.isFinite(firstMin) && Number.isFinite(giveUpMin)) {
      pendingText += `, polling +${firstMin}–${giveUpMin}m`;
    }
    pendingText += ")";
    summaryParts.push(pendingText);
  }
  // Next-fire time is independent of whether a current run is in flight —
  // the alarm fires whenever its scheduled time arrives. Show it always
  // so the user can see when to expect the next scheduled run, even
  // mid-run.
  if (resp.nextFireAt) {
    const minsUntil = Math.max(0, Math.round((resp.nextFireAt - Date.now()) / 60000));
    const clock = new Date(resp.nextFireAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    summaryParts.push(`next auto-run at ${clock} (in ${minsUntil} min)`);
  } else if (!resp.pending) {
    summaryParts.push(`next auto-run: not scheduled (toggle schedule off→on to arm)`);
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
      ? `arrived in ${_fmtSeconds(h.elapsedSec)}${h.duplicate ? " (duplicate of existing)" : ""}`
      : h.status === "no-arrival"
        ? `no arrival within ${_fmtSeconds(h.elapsedSec)}`
        : "";
    return `<li><span class="badge">${badge}</span> ${when}${detail ? " — " + detail : ""}</li>`;
  }).join("");
}

function _fmtHours(h) {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h % 1 === 0 ? h : h.toFixed(1)} hr`;
  const days = h / 24;
  return `${days % 1 === 0 ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
}

function _fmtScheduleStatus(minHours, maxHours) {
  if (!minHours || minHours <= 0) return "off";
  if (!maxHours || maxHours <= minHours) return `every ${_fmtHours(minHours)}`;
  return `every ${_fmtHours(minHours)}–${_fmtHours(maxHours)} (random)`;
}

function initScheduleControls(initialMinHours, initialMaxHours) {
  const onEl = el("schedule-on");
  const minEl = el("schedule-amount-min");
  const maxEl = el("schedule-amount-max");
  const unitEl = el("schedule-unit");
  const statusEl = el("schedule-status");
  const init = _rangeToInputs(initialMinHours, initialMaxHours);
  onEl.checked = init.on;
  minEl.value = String(init.amountMin);
  maxEl.value = String(init.amountMax);
  unitEl.value = init.unit;
  minEl.disabled = !init.on;
  maxEl.disabled = !init.on;
  unitEl.disabled = !init.on;
  statusEl.textContent = _fmtScheduleStatus(initialMinHours, initialMaxHours);

  async function persist() {
    minEl.disabled = !onEl.checked;
    maxEl.disabled = !onEl.checked;
    unitEl.disabled = !onEl.checked;
    let minH = onEl.checked ? _inputsToHours(minEl.value, unitEl.value) : 0;
    let maxH = onEl.checked ? _inputsToHours(maxEl.value, unitEl.value) : 0;
    if (onEl.checked && maxH < minH) maxH = minH;  // keep max >= min
    await chrome.storage.local.set({
      exportScheduleMinHours: minH,
      exportScheduleMaxHours: maxH,
      exportScheduleHours: minH,  // keep legacy field in sync for any older readers
    });
    statusEl.textContent = _fmtScheduleStatus(minH, maxH);
  }

  onEl.addEventListener("change", persist);
  minEl.addEventListener("input", persist);
  maxEl.addEventListener("input", persist);
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

// Wire every .card-toggle: clicking flips aria-expanded, which the CSS
// uses to hide the sibling .card-body. State persists per-card in
// chrome.storage.local under "collapse:<key>" so cards stay collapsed
// across popup opens — but defaults to expanded for first-time users.
async function wireCollapsibles() {
  const toggles = Array.from(document.querySelectorAll(".card-toggle"));
  if (!toggles.length) return;
  const keys = toggles.map((t) => `collapse:${t.dataset.collapse}`);
  let stored = {};
  try { stored = await chrome.storage.local.get(keys); } catch (_) { /* default to expanded */ }
  for (const t of toggles) {
    const k = `collapse:${t.dataset.collapse}`;
    const collapsed = !!stored[k];
    t.setAttribute("aria-expanded", collapsed ? "false" : "true");
    t.addEventListener("click", async () => {
      const isExpanded = t.getAttribute("aria-expanded") !== "false";
      t.setAttribute("aria-expanded", isExpanded ? "false" : "true");
      try { await chrome.storage.local.set({ [k]: isExpanded }); } catch (_) {}
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Wire collapsibles before anything else so the cards' shown state
  // matches the user's saved preference by the time everything renders.
  wireCollapsibles();

  // Show the extension version in the footer so the user can see at a
  // glance whether they're running the latest code without having to
  // open chrome://extensions. Useful when iterating on fixes — if the
  // displayed version doesn't match the latest manifest bump, the
  // extension hasn't been reloaded.
  try {
    const v = chrome.runtime.getManifest().version;
    const ev = el("extension-version");
    if (ev) ev.textContent = `v${v} · all data stays local`;
  } catch (_) { /* getManifest unavailable in some test contexts */ }

  const settings = await loadSettings();
  el("tracker-url").value = settings.trackerUrl;
  el("vault-url").value = settings.vaultUrl;
  el("ig-password").value = settings.igPassword;
  el("notification-email").value = settings.notificationEmail || "";
  el("google-account-email").value = settings.googleAccountEmail || "";
  el("autosubmit-google").checked = settings.autosubmitGoogle;
  el("show-overlay").checked = settings.showOverlay;
  el("auto-archive-media").checked = settings.autoArchiveMedia;
  // Honour new min/max fields when present; fall back to the legacy
  // single-value field so an upgrade doesn't lose the user's setting.
  const initMin = Number(settings.exportScheduleMinHours) || Number(settings.exportScheduleHours) || 0;
  const initMax = Number(settings.exportScheduleMaxHours) || initMin;
  initScheduleControls(initMin, initMax);

  await checkTrackerReachable(settings.trackerUrl);
  renderExportStats();
  renderArchiveRunner();
  initArchiveRunnerControls();

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

  // "▶ Now" — fires the next scheduled export immediately and
  // re-anchors the schedule so the next auto-run is `interval`
  // minutes from now (not from the original schedule).
  el("run-export-now").addEventListener("click", async () => {
    const btn = el("run-export-now");
    btn.disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: "export-fire-now" });
      if (r?.ok) {
        flashStatus("Export firing now.");
        renderExportStats();
      } else {
        flashStatus(r?.error ? `⚠ ${r.error}` : "⚠ Failed.");
      }
    } catch (e) {
      flashStatus(`⚠ ${e?.message || e}`);
    } finally {
      // Re-enable after a beat so the user doesn't accidentally
      // double-click before the in-flight check has a chance to
      // see the new state.
      setTimeout(() => { btn.disabled = false; }, 1500);
    }
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

  // List + copy URLs of every open vsco.co tab across ALL windows.
  // Filters to canonical profile/gallery shapes — vsco.co/<user> or
  // vsco.co/<user>/gallery — so vsco.co/about / /spaces / /studio etc.
  // are skipped. Output is one URL per line ready to paste into an
  // incognito-window address bar (one paste per tab). Also lists the
  // detected usernames inline in the popup so the user can sanity-check
  // before pasting.
  el("list-vsco-tabs").addEventListener("click", async () => {
    const result = el("vsco-tabs-result");
    result.style.display = "block";
    result.textContent = "scanning tabs…";
    try {
      const tabs = await chrome.tabs.query({});
      // Reserves match the content-script's RESERVED set so we don't
      // treat e.g. vsco.co/studio as a profile.
      const RESERVED = new Set([
        "m", "spaces", "studio", "feed", "search", "discover", "explore",
        "settings", "account", "login", "join", "user", "users",
        "membership", "about", "privacy", "terms", "help", "legal",
        "ai-lab", "blog", "stories", "support", "company",
        "products", "solutions", "resources", "downloads", "campaigns",
      ]);
      const seen = new Set();
      const matches = [];
      for (const t of tabs) {
        const url = t.url || "";
        const m = url.match(/^https?:\/\/(?:www\.)?vsco\.co\/([A-Za-z0-9._-]{1,40})(?:\/(?:gallery)?)?(?:\?|#|$)/i);
        if (!m) continue;
        const handle = m[1];
        if (RESERVED.has(handle.toLowerCase())) continue;
        if (seen.has(handle.toLowerCase())) continue;
        seen.add(handle.toLowerCase());
        matches.push({ handle, url: `https://vsco.co/${handle}/gallery` });
      }
      if (!matches.length) {
        result.textContent = "no vsco.co tabs open. Open some profile tabs first.";
        return;
      }
      const text = matches.map((m) => m.url).join("\n") + "\n";
      try { await navigator.clipboard.writeText(text); }
      catch (_) { /* clipboard may fail in some popup contexts */ }
      // Handles can only contain [A-Za-z0-9._-] per the regex so HTML
      // escaping isn't strictly needed, but textContent on a fresh
      // <div> per row is the safe path either way.
      result.innerHTML = "";
      const head = document.createElement("div");
      head.innerHTML = `<strong>${matches.length} VSCO tab${matches.length === 1 ? "" : "s"}</strong> — URLs copied to clipboard.`;
      result.appendChild(head);
      const list = document.createElement("div");
      list.style.cssText = "margin-top:6px; max-height:160px; overflow-y:auto; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5;";
      for (const m of matches) {
        const row = document.createElement("div");
        row.textContent = "@" + m.handle;
        list.appendChild(row);
      }
      result.appendChild(list);
      const hint = document.createElement("div");
      hint.style.marginTop = "6px";
      hint.textContent = "Paste into an incognito window (one URL per tab) and click the 📥 Archive button on each.";
      result.appendChild(hint);
    } catch (e) {
      result.textContent = `failed: ${e?.message || e}`;
    }
  });

  // Fan out an archive command to every open vsco.co profile tab. Each
  // tab's content script scrolls to the gallery bottom (to trigger
  // lazy-loaded images), then archives in place. Fire-and-forget: the
  // popup closes as soon as the messages dispatch — progress shows in
  // each tab via the existing overlay.
  el("archive-vsco-tabs").addEventListener("click", async () => {
    const result = el("vsco-tabs-result");
    result.style.display = "block";
    result.textContent = "scanning tabs…";
    try {
      const tabs = await chrome.tabs.query({});
      const RESERVED = new Set([
        "m", "spaces", "studio", "feed", "search", "discover", "explore",
        "settings", "account", "login", "join", "user", "users",
        "membership", "about", "privacy", "terms", "help", "legal",
        "ai-lab", "blog", "stories", "support", "company",
        "products", "solutions", "resources", "downloads", "campaigns",
      ]);
      const seen = new Set();
      const matches = [];
      for (const t of tabs) {
        const url = t.url || "";
        const m = url.match(/^https?:\/\/(?:www\.)?vsco\.co\/([A-Za-z0-9._-]{1,40})(?:\/(?:gallery)?)?(?:\?|#|$)/i);
        if (!m) continue;
        const handle = m[1];
        if (RESERVED.has(handle.toLowerCase())) continue;
        if (seen.has(handle.toLowerCase())) continue;
        seen.add(handle.toLowerCase());
        matches.push({ tabId: t.id, handle });
      }
      if (!matches.length) {
        result.textContent = "no vsco.co tabs open. Open some profile tabs first.";
        return;
      }
      let dispatched = 0;
      const failures = [];
      for (const m of matches) {
        try {
          await chrome.tabs.sendMessage(m.tabId, {
            cmd: "archive-vsco",
            scrollFirst: true,
          });
          dispatched += 1;
        } catch (e) {
          // sendMessage rejects when the tab has no listener — most
          // commonly because the user opened the tab before the content
          // script's manifest entry was registered (fresh install) or
          // because chrome://... blocks injection. We surface those
          // separately from "successfully started".
          failures.push({ handle: m.handle, error: e?.message || String(e) });
        }
      }
      result.innerHTML = "";
      const head = document.createElement("div");
      const tip = dispatched ? " — watch each tab's bottom-right overlay for per-tab progress." : "";
      head.textContent = `Started archive on ${dispatched}/${matches.length} VSCO tab${matches.length === 1 ? "" : "s"}${tip}`;
      result.appendChild(head);
      if (failures.length) {
        const errList = document.createElement("div");
        errList.style.cssText = "margin-top:6px; color:#b00; font-size:11px;";
        errList.textContent = `${failures.length} tab(s) didn't accept the message — reload them and try again:`;
        result.appendChild(errList);
        for (const f of failures) {
          const row = document.createElement("div");
          row.textContent = `@${f.handle} — ${f.error}`;
          row.style.cssText = "font-family: ui-monospace, monospace; font-size: 10px;";
          result.appendChild(row);
        }
      }
    } catch (e) {
      result.textContent = `failed: ${e?.message || e}`;
    }
  });

  // Fully-automated incognito flow: collect every open vsco.co profile
  // URL, write them into a queue in chrome.storage.local, open one
  // fresh incognito window with all of them as tabs, and let each tab's
  // content script auto-archive on load and request close-after-done.
  el("archive-vsco-incognito").addEventListener("click", async () => {
    const result = el("vsco-tabs-result");
    result.style.display = "block";
    result.textContent = "scanning tabs…";
    try {
      // Need the user to opt in to incognito for this extension first —
      // otherwise we can open the window but the content script won't
      // load there and the tabs will just sit. Check + tell them.
      let allowed = false;
      try {
        allowed = await chrome.extension.isAllowedIncognitoAccess();
      } catch (_) { /* old Chrome lacks this API; assume true */ allowed = true; }
      if (!allowed) {
        result.innerHTML = "";
        const msg = document.createElement("div");
        msg.style.cssText = "color: var(--bad);";
        msg.textContent = "Enable 'Allow in Incognito' for this extension first.";
        result.appendChild(msg);
        const hint = document.createElement("div");
        hint.style.marginTop = "4px";
        hint.textContent = "Open chrome://extensions → IG Tracker → Details → toggle 'Allow in Incognito' on.";
        result.appendChild(hint);
        return;
      }
      const tabs = await chrome.tabs.query({});
      const RESERVED = new Set([
        "m", "spaces", "studio", "feed", "search", "discover", "explore",
        "settings", "account", "login", "join", "user", "users",
        "membership", "about", "privacy", "terms", "help", "legal",
        "ai-lab", "blog", "stories", "support", "company",
        "products", "solutions", "resources", "downloads", "campaigns",
      ]);
      const seen = new Set();
      const urls = [];
      for (const t of tabs) {
        const url = t.url || "";
        const m = url.match(/^https?:\/\/(?:www\.)?vsco\.co\/([A-Za-z0-9._-]{1,40})(?:\/(?:gallery)?)?(?:\?|#|$)/i);
        if (!m) continue;
        const handle = m[1];
        if (RESERVED.has(handle.toLowerCase())) continue;
        if (seen.has(handle.toLowerCase())) continue;
        seen.add(handle.toLowerCase());
        urls.push(`https://vsco.co/${handle}/gallery`);
      }
      if (!urls.length) {
        result.textContent = "no vsco.co tabs open. Open some profile tabs first.";
        return;
      }
      // Write the queue. The content script checks this on load — when
      // its URL matches an entry, it auto-archives and asks the SW to
      // close the tab. Stored as a Set-equivalent dict so duplicate
      // navigations don't trigger a second archive in the same window.
      await chrome.storage.local.set({
        vscoAutoArchiveQueue: urls.reduce((o, u) => { o[u] = Date.now(); return o; }, {}),
      });
      const win = await chrome.windows.create({ incognito: true, url: urls });
      result.innerHTML = "";
      const head = document.createElement("div");
      head.innerHTML = `<strong>Opened ${urls.length} profile${urls.length === 1 ? "" : "s"} in incognito.</strong>`;
      result.appendChild(head);
      const hint = document.createElement("div");
      hint.style.marginTop = "6px";
      hint.textContent = "Each tab will scroll, archive, then close itself. The window stays open if any tab fails so you can inspect it.";
      result.appendChild(hint);
    } catch (e) {
      result.textContent = `failed: ${e?.message || e}`;
    }
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
    };
    // Schedule has its own dedicated UI that saves on every change
    // (see initScheduleControls); we don't include those fields in the
    // Save-settings patch so we don't clobber a fresh edit made between
    // the schedule input firing and the Save button being clicked.
    await saveSettings(patch);
    el("save-settings").textContent = "Saved ✓";
    setTimeout(() => { el("save-settings").textContent = "Save settings"; }, 1200);
    await checkTrackerReachable(patch.trackerUrl);
  });
});

// ---------- archive-runner card ----------

function initArchiveRunnerControls() {
  const onEl = el("archive-runner-on");
  const intervalEl = el("archive-runner-interval");
  const graceEl = el("archive-runner-grace");
  const modeIntervalEl = el("archive-runner-mode-interval");
  const modeCompletionEl = el("archive-runner-mode-completion");
  const statusEl = el("archive-runner-status");
  const addInput = el("archive-add-input");
  const addBtn = el("archive-add-btn");
  if (!onEl || !intervalEl) return;

  if (addBtn && addInput) {
    const doAdd = async () => {
      const u = addInput.value.trim().replace(/^@/, "");
      if (!u) return;
      addBtn.disabled = true;
      addBtn.textContent = "Adding…";
      const resp = await new Promise((r) => {
        try { chrome.runtime.sendMessage({ type: "archive-queue-add", username: u }, (x) => r(x || null)); }
        catch { r(null); }
      });
      addBtn.disabled = false;
      if (resp && resp.ok) {
        addBtn.textContent = "Added ✓";
        addInput.value = "";
        setTimeout(() => { addBtn.textContent = "Add"; renderArchiveRunner(); }, 900);
      } else {
        addBtn.textContent = "Failed";
        setTimeout(() => { addBtn.textContent = "Add"; }, 1500);
      }
    };
    addBtn.addEventListener("click", doAdd);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  }

  // "▶ Now" — fires the next scheduled archive runner cycle
  // immediately and re-anchors the schedule.
  const runNowBtn = el("run-archive-now");
  if (runNowBtn) {
    runNowBtn.addEventListener("click", async () => {
      runNowBtn.disabled = true;
      try {
        const r = await chrome.runtime.sendMessage({ type: "archive-runner-fire-now" });
        if (r?.ok) {
          // The summary line / next-fire countdown re-renders from
          // chrome.storage so the user sees the new schedule
          // immediately. Don't await — it's best-effort UI refresh.
          renderArchiveRunner();
        } else {
          // Surface the in-flight rejection or any other error in
          // the runner status line so the user can see it without
          // scrolling around.
          if (statusEl) statusEl.textContent = r?.error || "Failed.";
          setTimeout(() => renderArchiveRunner(), 2000);
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = `⚠ ${e?.message || e}`;
      } finally {
        setTimeout(() => { runNowBtn.disabled = false; }, 1500);
      }
    });
  }

  function _statusText(isOn, mode, intervalMin, graceMin) {
    if (!isOn) return "off";
    if (mode === "completion") return `after each + ${graceMin} min`;
    return `every ${intervalMin} min`;
  }

  function _applyEnabled() {
    const isOn = onEl.checked;
    const mode = modeCompletionEl.checked ? "completion" : "interval";
    intervalEl.disabled = !isOn || mode !== "interval";
    graceEl.disabled = !isOn || mode !== "completion";
    modeIntervalEl.disabled = !isOn;
    modeCompletionEl.disabled = !isOn;
  }

  chrome.storage.local.get(
    ["archiveRunnerOn", "archiveRunnerIntervalMin", "archiveRunnerMode", "archiveRunnerGraceMin"],
    (s) => {
      onEl.checked = !!s.archiveRunnerOn;
      intervalEl.value = String(Number(s.archiveRunnerIntervalMin) || 10);
      graceEl.value = String(Number(s.archiveRunnerGraceMin) || 1);
      const mode = s.archiveRunnerMode === "completion" ? "completion" : "interval";
      modeIntervalEl.checked = (mode === "interval");
      modeCompletionEl.checked = (mode === "completion");
      _applyEnabled();
      statusEl.textContent = _statusText(
        onEl.checked, mode,
        Number(intervalEl.value) || 10,
        Number(graceEl.value) || 1,
      );
    },
  );

  const persist = async () => {
    _applyEnabled();
    const interval = Math.max(1, Number(intervalEl.value) || 10);
    const grace = Math.max(1, Number(graceEl.value) || 1);
    const mode = modeCompletionEl.checked ? "completion" : "interval";
    await chrome.storage.local.set({
      archiveRunnerOn: onEl.checked,
      archiveRunnerIntervalMin: interval,
      archiveRunnerGraceMin: grace,
      archiveRunnerMode: mode,
    });
    statusEl.textContent = _statusText(onEl.checked, mode, interval, grace);
    setTimeout(renderArchiveRunner, 400);
  };
  onEl.addEventListener("change", persist);
  intervalEl.addEventListener("input", persist);
  graceEl.addEventListener("input", persist);
  modeIntervalEl.addEventListener("change", persist);
  modeCompletionEl.addEventListener("change", persist);
}

async function renderArchiveRunner() {
  const card = el("archive-runner-card");
  if (!card) return;
  const resp = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: "get-archive-runner-stats" }, (r) => resolve(r || null)); }
    catch { resolve(null); }
  });
  if (!resp || !resp.ok) return;
  const summary = el("archive-runner-summary");
  const stats = resp.lastStats;
  const parts = [];
  if (stats) {
    parts.push(`queue: ${stats.queue_size} remaining`);
    if (stats.manual_in_queue) {
      parts.push(`${stats.manual_in_queue} manual`);
    }
    if (stats.skipped_already_archived != null) {
      parts.push(`${stats.skipped_already_archived} already archived`);
    }
    if (stats.skipped_user_cleared) {
      parts.push(`${stats.skipped_user_cleared} you cleared`);
    }
    if (stats.skipped_tagged) {
      parts.push(`${stats.skipped_tagged} tagged unavailable/disabled`);
    }
  } else {
    parts.push("no queue fetched yet");
  }
  if (resp.passNumber > 1) {
    parts.push(`pass #${resp.passNumber}`);
  }
  if (resp.on && resp.nextFireAt) {
    const minsUntil = Math.max(0, Math.round((resp.nextFireAt - Date.now()) / 60000));
    const clock = new Date(resp.nextFireAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const modeTag = resp.mode === "completion" ? " · completion mode" : "";
    parts.push(`next at ${clock} (~${minsUntil} min)${modeTag}`);
  }
  summary.textContent = parts.join(" · ");

  // Mirror a compact status into the collapsed-header slot so the
  // user can see queue depth + on/off state at a glance even with the
  // card minimized. Keep it short — the header has limited width.
  const collapsed = el("archive-runner-summary-collapsed");
  if (collapsed) {
    const onOff = resp.on ? "on" : "off";
    const q = stats ? `${stats.queue_size} queued` : "no data";
    collapsed.textContent = `${q} · ${onOff}`;
  }

  // Permanent-failure banner — persistent until user retries or
  // permanently dismisses by tagging the account as unavailable.
  const banner = el("archive-runner-permfail-banner");
  if (banner) {
    const failed = resp.permanentFailures || {};
    const failedNames = Object.keys(failed);
    if (failedNames.length === 0) {
      banner.hidden = true;
      banner.innerHTML = "";
    } else {
      banner.hidden = false;
      const rows = failedNames.map((u) => {
        const f = failed[u];
        const since = f.firstFailedAt ? _fmtAgo(f.firstFailedAt) : "?";
        const safeU = u.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
        return `<div style="margin-top:4px"><b>@${safeU}</b> — failed ${f.attempts || 10}× since ${since}<button data-retry="${safeU}">Retry</button></div>`;
      }).join("");
      banner.innerHTML = `<div>⚠ ${failedNames.length} account${failedNames.length === 1 ? "" : "s"} permanently failed (won't retry until you tell them to):</div>${rows}`;
      banner.querySelectorAll("button[data-retry]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const u = btn.dataset.retry;
          btn.disabled = true;
          btn.textContent = "…";
          await new Promise((r) => {
            try { chrome.runtime.sendMessage({ type: "archive-runner-retry-permanent", username: u }, (x) => r(x)); }
            catch { r(null); }
          });
          renderArchiveRunner();
        });
      });
    }
  }

  const list = el("archive-runner-history");
  list.innerHTML = (resp.history || []).map((h) => {
    const when = _fmtAgo(h.ts);
    const badge = h.status === "opened"        ? "▶"
                : h.status === "closed"        ? "·"
                : h.status === "archived"      ? "✓"
                : h.status === "skipped"       ? "↷"
                : h.status === "permanent-fail"? "⛔"
                : "·";
    const detail = h.status === "skipped" ? ` (skip, attempt ${h.attempts || "?"}/10)`
                : h.status === "permanent-fail" ? " — permanent fail"
                : h.status === "archived" ? " — archived ✓"
                : "";
    return `<li><span class="badge">${badge}</span> ${when} — @${h.username}${detail}</li>`;
  }).join("");
}
