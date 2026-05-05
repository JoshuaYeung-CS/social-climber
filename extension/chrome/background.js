// Service worker. One job: proxy fetches from content scripts to the
// local tracker. Reason: instagram.com is HTTPS, the local tracker is
// HTTP, and Chrome blocks HTTP fetches initiated from HTTPS pages as
// "mixed content" — even when the extension has host_permissions for
// the target. The fix is to make the fetch from the service worker
// (an extension-origin context, not a page-origin context); mixed-
// content rules don't apply there. Content scripts call
// chrome.runtime.sendMessage and we return the parsed body.
//
// MV3 extension service workers don't need install/activate handlers —
// they activate automatically on first event. Skip skipWaiting +
// clients.claim, which raise InvalidStateError in this context.

// ---------- scheduled export ----------
//
// chrome.alarms fires the "scheduled-export" alarm at the user-chosen
// interval (settable in the popup). On fire we:
//   1. Append a {ts, status:"triggered"} entry to exportHistory.
//   2. Open the wizard in a background tab and set wizardRunRequested.
//   3. Schedule a "drive-arrival-poll" alarm that fires 10 min later
//      and every 1 min after that — checks the local tracker for a
//      newly-imported export. When one shows up, record the elapsed
//      seconds in exportTimings (used for the "next arrival ~Xmin"
//      estimate shown in the popup).
//
// History + timings live in chrome.storage.local. Bounded to the last
// 50 entries each so the JSON stays small.
const SCHEDULE_ALARM = "scheduled-export";
const ARRIVAL_POLL_ALARM = "drive-arrival-poll";
const HISTORY_MAX = 50;
const TIMINGS_MAX = 50;
// User-measured arrival range is ~8-18 min (avg ~13). Start polling
// at 7min so we don't miss a fast arrival, then re-check every minute.
const ARRIVAL_FIRST_CHECK_MIN = 7;
const ARRIVAL_GIVE_UP_MIN = 90;

async function refreshExportAlarm() {
  const { exportScheduleHours } = await chrome.storage.local.get(["exportScheduleHours"]);
  const hours = Number(exportScheduleHours) || 0;
  await chrome.alarms.clear(SCHEDULE_ALARM);
  if (hours > 0) {
    const minutes = Math.max(1, hours * 60);
    chrome.alarms.create(SCHEDULE_ALARM, {
      delayInMinutes: minutes,
      periodInMinutes: minutes,
    });
    console.log(`[IG Tracker] Scheduled export every ${minutes} min (${hours}h).`);
  } else {
    console.log("[IG Tracker] Scheduled export disabled.");
  }
}

async function _appendHistory(entry) {
  const { exportHistory = [] } = await chrome.storage.local.get(["exportHistory"]);
  exportHistory.push(entry);
  if (exportHistory.length > HISTORY_MAX) {
    exportHistory.splice(0, exportHistory.length - HISTORY_MAX);
  }
  await chrome.storage.local.set({ exportHistory });
}

async function _appendTiming(seconds) {
  const { exportTimings = [] } = await chrome.storage.local.get(["exportTimings"]);
  exportTimings.push(seconds);
  if (exportTimings.length > TIMINGS_MAX) {
    exportTimings.splice(0, exportTimings.length - TIMINGS_MAX);
  }
  await chrome.storage.local.set({ exportTimings });
}

async function _trackerScan() {
  const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
  const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/api/scan?force=false`, { method: "POST" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function _onScheduledExportFire() {
  console.log("[IG Tracker] Scheduled export alarm fired — opening wizard.");
  const startedAt = Date.now();
  // Open in a SEPARATE non-focused window rather than a background
  // tab in the user's main window. Why: background tabs get
  // aggressive timer throttling (≥1s minimum interval) which breaks
  // the wizard's pacing, and the AudioContext keep-awake can't arm
  // without a user gesture in an unattended scheduled run. A tab in
  // its own window is in the foreground of that window — full speed
  // — but the window doesn't steal focus from the main work area
  // (focused: false). Window opens compact and minimized-style so
  // it stays out of the way.
  let tabId = null;
  try {
    const win = await chrome.windows.create({
      url: "https://accountscenter.instagram.com/info_and_permissions/dyi/",
      focused: false,
      type: "normal",
      state: "minimized",
    });
    tabId = win?.tabs?.[0]?.id ?? null;
  } catch (e) {
    // Fallback: if windows.create fails (e.g., insufficient permissions
    // on some platforms), fall back to a foreground tab. Worse UX
    // but at least the wizard runs.
    console.warn("[IG Tracker] windows.create failed, falling back to active tab:", e?.message || e);
    const tab = await chrome.tabs.create({
      url: "https://accountscenter.instagram.com/info_and_permissions/dyi/",
      active: true,
    });
    tabId = tab?.id ?? null;
  }
  await chrome.storage.local.set({
    wizardRunRequested: { ts: startedAt, tabId },
    pendingArrival: { startedAt },
  });
  await _appendHistory({ ts: startedAt, status: "triggered" });
  // First check after ARRIVAL_FIRST_CHECK_MIN minutes, then every minute.
  await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
  chrome.alarms.create(ARRIVAL_POLL_ALARM, {
    delayInMinutes: ARRIVAL_FIRST_CHECK_MIN,
    periodInMinutes: 1,
  });
}

async function _onArrivalPollFire() {
  const { pendingArrival } = await chrome.storage.local.get(["pendingArrival"]);
  if (!pendingArrival || !pendingArrival.startedAt) {
    await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
    return;
  }
  const elapsedMs = Date.now() - pendingArrival.startedAt;
  const elapsedMin = elapsedMs / 60000;
  if (elapsedMin > ARRIVAL_GIVE_UP_MIN) {
    console.warn(`[IG Tracker] Drive arrival poll: gave up after ${elapsedMin.toFixed(0)}min.`);
    await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
    await chrome.storage.local.set({ pendingArrival: null });
    await _appendHistory({
      ts: pendingArrival.startedAt,
      status: "no-arrival",
      elapsedSec: Math.round(elapsedMs / 1000),
    });
    return;
  }
  console.log(`[IG Tracker] Drive arrival poll: scanning (elapsed ${elapsedMin.toFixed(0)}min).`);
  const result = await _trackerScan();
  if (!result) return;
  const newImports = (result.imported || []).length;
  if (newImports > 0) {
    const elapsedSec = Math.round(elapsedMs / 1000);
    console.log(`[IG Tracker] Drive arrival! ${newImports} new import(s) after ${elapsedSec}s.`);
    await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
    await chrome.storage.local.set({ pendingArrival: null });
    await _appendTiming(elapsedSec);
    await _appendHistory({
      ts: pendingArrival.startedAt,
      status: "arrived",
      elapsedSec,
      imports: newImports,
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCHEDULE_ALARM) {
    await _onScheduledExportFire();
  } else if (alarm.name === ARRIVAL_POLL_ALARM) {
    await _onArrivalPollFire();
  }
});

// Re-evaluate the alarm whenever the schedule setting changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.exportScheduleHours) {
    refreshExportAlarm();
  }
});

// Set up the alarm on SW (re)start. MV3 service workers can be torn
// down and restarted, so this also runs after an idle wake-up.
chrome.runtime.onInstalled.addListener(refreshExportAlarm);
chrome.runtime.onStartup.addListener(refreshExportAlarm);
refreshExportAlarm().catch(() => {});

// ---------- chrome.debugger: trusted click dispatch ----------
//
// Meta's React wizard components silently reject synthetic events
// (e.isTrusted === false). Only events dispatched by the OS event
// loop carry isTrusted=true. The chrome.debugger API is the one
// extension-accessible path: attaching as a debugger lets us send
// Input.dispatchMouseEvent commands from the browser side, which
// arrive at the page already marked as trusted.
//
// Cost: Chrome shows a yellow "X is debugging this browser" infobar
// on the tab while the debugger is attached. Detach when the wizard
// finishes (success/error/stop) so the bar goes away.
//
// Tab lifecycle: tracked in _debuggerTabs. Auto-detach on tab close.
// If another debugger (e.g. DevTools) is attached, our attach()
// throws — content script falls back to synthetic clicks and we log
// a warning.
const _debuggerTabs = new Set();

async function _attachDebugger(tabId) {
  if (_debuggerTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    _debuggerTabs.add(tabId);
    console.log(`[IG Tracker] debugger: attached to tab ${tabId}`);
    return true;
  } catch (e) {
    console.warn(`[IG Tracker] debugger: attach failed for tab ${tabId}:`, e?.message || e);
    return false;
  }
}

async function _detachDebugger(tabId) {
  if (!_debuggerTabs.has(tabId)) return;
  _debuggerTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
    console.log(`[IG Tracker] debugger: detached from tab ${tabId}`);
  } catch (e) {
    // Tab might already be closed; ignore.
  }
}

// chrome.debugger.onDetach fires when DevTools opens, user clicks
// Cancel on the infobar, or the tab closes. Drop our tracking so we
// don't try to dispatch into a dead session.
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId != null && _debuggerTabs.has(tabId)) {
    _debuggerTabs.delete(tabId);
    console.log(`[IG Tracker] debugger: external detach for tab ${tabId}`);
  }
});

// Auto-detach on tab close, otherwise the session lingers until the
// SW recycles. Harmless but messy.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_debuggerTabs.has(tabId)) {
    _debuggerTabs.delete(tabId);
  }
});

async function _dispatchTrustedClick(tabId, x, y) {
  // Strategy A: Input.synthesizeTapGesture. Produces a complete
  // touch+pointer+mouse event cascade that matches a real user tap
  // (Chrome's input layer generates the canonical sequence). The
  // simpler Input.dispatchMouseEvent (Strategy B below) only fires
  // mouse events directly — Meta's React handlers appear to gate
  // against that on critical buttons (Create export, destination
  // chooser). v1.0.112 log: clicking <div role=button> "Create export"
  // via dispatchMouseEvent did NOT advance the page across 6 ancestor
  // levels. The tap gesture may slip past because it goes through
  // the same input pipeline as a real touch/click.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.synthesizeTapGesture", {
      x, y,
      duration: 60,
      tapCount: 1,
      gestureSourceType: "default",
    });
    console.log(`[IG Tracker] trusted-click: synthesizeTapGesture @ (${x},${y}) ✓`);
    return;
  } catch (e) {
    console.warn(`[IG Tracker] trusted-click: synthesizeTapGesture failed (${e?.message || e}) — falling back to dispatchMouseEvent`);
  }
  // Strategy B: legacy dispatchMouseEvent (mouseMoved → mousePressed
  // → mouseReleased). Kept as fallback in case the gesture API isn't
  // available on this Chrome version or fails for other reasons.
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
  console.log(`[IG Tracker] trusted-click: dispatchMouseEvent @ (${x},${y}) ✓ [fallback]`);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  // Content script asking "what tab am I in?" — used by the wizard
  // driver to compare its own tab id against the run flag's tabId
  // so unrelated wizard tabs don't auto-fill.
  if (msg.type === "get-tab-id") {
    sendResponse({ ok: true, tabId: sender?.tab?.id ?? null });
    return false;
  }
  // Trusted-click dispatch via chrome.debugger. Content script sends
  // viewport coords (rounded ints); SW attaches the debugger if not
  // already attached and dispatches mousePressed/Released. The
  // resulting events arrive at the page with isTrusted=true.
  if (msg.type === "trusted-click") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "no tab id" });
        return;
      }
      const attached = await _attachDebugger(tabId);
      if (!attached) {
        sendResponse({ ok: false, error: "debugger attach failed" });
        return;
      }
      try {
        await _dispatchTrustedClick(tabId, msg.x, msg.y);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  // Detach debugger when wizard finishes — clears the yellow infobar.
  if (msg.type === "wizard-detach-debugger") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId != null) await _detachDebugger(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }
  // "Start manual export" from the popup. Moved here because the
  // popup closes the instant the new tab gets focus, which was killing
  // the popup's JS context before its await chrome.storage.local.set
  // could land — so the run-flag never got written and the content
  // script bailed silently. Doing it from the SW is reliable.
  if (msg.type === "start-manual-export") {
    (async () => {
      const startedAt = Date.now();
      const url = "https://accountscenter.instagram.com/info_and_permissions/dyi/";
      const tab = await chrome.tabs.create({ url });
      await chrome.storage.local.set({
        wizardRunRequested: { ts: startedAt, tabId: tab?.id ?? null },
        pendingArrival: { startedAt },
      });
      await _appendHistory({ ts: startedAt, status: "triggered-manual" });
      // Kick off the arrival-time poll just like a scheduled run.
      await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
      chrome.alarms.create(ARRIVAL_POLL_ALARM, {
        delayInMinutes: ARRIVAL_FIRST_CHECK_MIN,
        periodInMinutes: 1,
      });
      sendResponse({ ok: true, tabId: tab?.id ?? null });
    })();
    return true;
  }
  // "Stop export" from the popup — cancels any in-progress arrival
  // poll. Storage flags (wizardRunRequested / pendingArrival) are
  // cleared by the popup before this fires; here we just need to
  // tear down the alarm so the SW stops scanning the tracker every
  // minute for an arrival that's no longer coming.
  if (msg.type === "stop-export") {
    (async () => {
      await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
      await _appendHistory({ ts: Date.now(), status: "stopped" });
      // Detach any wizard tabs we attached the debugger to — clears
      // the yellow "is debugging" infobar so the user isn't left
      // wondering after a stop.
      for (const tid of Array.from(_debuggerTabs)) {
        await _detachDebugger(tid);
      }
      console.log("[IG Tracker] Export stopped by user — alarm cleared.");
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Manual "Run export" from the popup — also kicks off the arrival
  // poll so timings get recorded for manual runs too.
  if (msg.type === "track-manual-export") {
    (async () => {
      const startedAt = Date.now();
      await _appendHistory({ ts: startedAt, status: "triggered-manual" });
      await chrome.storage.local.set({
        pendingArrival: { startedAt },
      });
      await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
      chrome.alarms.create(ARRIVAL_POLL_ALARM, {
        delayInMinutes: ARRIVAL_FIRST_CHECK_MIN,
        periodInMinutes: 1,
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Popup asks for current export status / history / timings.
  if (msg.type === "get-export-stats") {
    (async () => {
      const data = await chrome.storage.local.get([
        "exportHistory", "exportTimings", "pendingArrival", "exportScheduleHours",
      ]);
      sendResponse({
        ok: true,
        history: data.exportHistory || [],
        timings: data.exportTimings || [],
        pending: data.pendingArrival || null,
        scheduleHours: data.exportScheduleHours || 0,
      });
    })();
    return true;
  }
  // Standard JSON / text fetch — for tracker + vault API calls.
  if (msg.type === "tracker-fetch") {
    (async () => {
      try {
        const init = msg.init || {};
        const r = await fetch(msg.url, init);
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        sendResponse({ ok: r.ok, status: r.status, body });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  // Binary-blob fetch — used by Save-to-Vault. The SW issues the request
  // (avoiding mixed-content blocks since instagram.com is HTTPS) with the
  // page's cookies, reads the bytes, and base64-encodes for transport
  // back to the content script which POSTs them to the vault.
  if (msg.type === "tracker-fetch-bytes") {
    (async () => {
      // Two-pass fetch:
      //   1. credentials: "include" so cdninstagram.com signed URLs
      //      that depend on the user's IG session resolve.
      //   2. on failure, retry with credentials: "omit". Third-party
      //      CDNs IG embeds (giphy stickers, fbcdn assets without
      //      credentialed-CORS) return Access-Control-Allow-Origin:* which
      //      Chrome rejects when credentials are sent. The cookieless
      //      retry avoids that block at the cost of not having IG
      //      cookies (which third-party CDNs don't care about anyway).
      const fetchOnce = async (creds) => {
        const r = await fetch(msg.url, { credentials: creds });
        if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
        const buf = await r.arrayBuffer();
        let binary = "";
        const chunk = new Uint8Array(buf);
        const CHUNK_SIZE = 0x8000;
        for (let i = 0; i < chunk.length; i += CHUNK_SIZE) {
          binary += String.fromCharCode.apply(null, chunk.subarray(i, i + CHUNK_SIZE));
        }
        const b64 = btoa(binary);
        return { ok: true, status: r.status, body: b64 };
      };
      try {
        let result;
        try {
          result = await fetchOnce("include");
        } catch (e1) {
          // CORS rejection or network error with credentials — retry
          // cookieless. Most non-IG CDNs work this way.
          console.log(`[IG Tracker SW] credentialed fetch failed (${e1.message}), retrying cookieless: ${msg.url.slice(0, 80)}`);
          result = await fetchOnce("omit");
        }
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  return false;
});
