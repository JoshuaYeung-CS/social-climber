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
const RETRY_ALARM = "scheduled-export-retry";
const HISTORY_MAX = 50;
const TIMINGS_MAX = 50;
// Auto-retry: when a run fails (no-arrival/error/stopped), schedule
// ONE quick retry 10 min later before falling through to the regular
// 45–90 min jittered slot. Catches transient hiccups (Meta hiccup,
// Drive sync delay) without spamming exports if the failure is a
// real outage. RETRY_ALARM is one-shot, not periodic.
const AUTO_RETRY_DELAY_MIN = 10;
const AUTO_RETRY_MAX_PER_DAY = 4;
// further down.)
// Drive-arrival polling: when we have historical timings, we start
// polling a few minutes before the EARLIEST typical arrival (so we
// catch the fast cases) and keep going to a few minutes after the
// LATEST typical arrival. With no history we default to 12-min
// first-check / 90-min give-up — close to the user-measured ~13 min
// average. Cadence is always 1 minute between checks (user-preferred,
// "every next minute"). The local /api/scan call only reads the
// already-Drive-synced folder, so per-minute polls don't hit Google's
// API at all.
const ARRIVAL_DEFAULT_FIRST_MIN = 12;
const ARRIVAL_DEFAULT_GIVE_UP_MIN = 90;
const ARRIVAL_MIN_FIRST_MIN = 2;
const ARRIVAL_PRE_MARGIN_MIN = 2;     // start this many min before earliest historical arrival
const ARRIVAL_POST_MARGIN_MIN = 10;   // give up this many min after latest historical arrival
const ARRIVAL_HISTORY_FOR_ESTIMATE = 3;

function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[idx];
}

async function _arrivalWindowMin() {
  const { exportTimings = [] } = await chrome.storage.local.get(["exportTimings"]);
  if (exportTimings.length < ARRIVAL_HISTORY_FOR_ESTIMATE) {
    return {
      firstMin: ARRIVAL_DEFAULT_FIRST_MIN,
      giveUpMin: ARRIVAL_DEFAULT_GIVE_UP_MIN,
      basis: `default (${exportTimings.length} run${exportTimings.length === 1 ? "" : "s"} — need ${ARRIVAL_HISTORY_FOR_ESTIMATE})`,
    };
  }
  const sortedSec = [...exportTimings].sort((a, b) => a - b);
  const p10Sec = _percentile(sortedSec, 10);
  const p90Sec = _percentile(sortedSec, 90);
  const p10Min = p10Sec / 60;
  const p90Min = p90Sec / 60;
  const firstMin = Math.max(ARRIVAL_MIN_FIRST_MIN, Math.round(p10Min - ARRIVAL_PRE_MARGIN_MIN));
  const giveUpMin = Math.max(ARRIVAL_DEFAULT_GIVE_UP_MIN, Math.round(p90Min + ARRIVAL_POST_MARGIN_MIN));
  return {
    firstMin,
    giveUpMin,
    basis: `from ${exportTimings.length} runs (p10 ${p10Min.toFixed(1)}m, p90 ${p90Min.toFixed(1)}m)`,
  };
}

// Schedule resolution. New fields exportScheduleMinHours /
// exportScheduleMaxHours take precedence; the legacy single-value
// exportScheduleHours is honoured as min=max so an upgrade doesn't
// silently disable an existing schedule.
async function _resolveScheduleHours() {
  const s = await chrome.storage.local.get([
    "exportScheduleMinHours",
    "exportScheduleMaxHours",
    "exportScheduleHours",
  ]);
  const newMin = Number(s.exportScheduleMinHours);
  const newMax = Number(s.exportScheduleMaxHours);
  const legacy = Number(s.exportScheduleHours);
  const minH = Number.isFinite(newMin) && newMin > 0
    ? newMin
    : (Number.isFinite(legacy) && legacy > 0 ? legacy : 0);
  let maxH = Number.isFinite(newMax) && newMax > 0 ? newMax : minH;
  if (maxH < minH) maxH = minH;
  return { minH, maxH };
}

// One-shot alarm with a fresh random delay each fire. Replaces the
// previous periodInMinutes (fixed cadence) so each scheduled run
// lands at an unpredictable time inside [min, max] — pattern looks
// less robotic to Instagram than a perfectly periodic tick.
async function refreshExportAlarm() {
  const { minH, maxH } = await _resolveScheduleHours();
  await chrome.alarms.clear(SCHEDULE_ALARM);
  if (minH <= 0) {
    console.log("[Social Climber] Scheduled export disabled.");
    return;
  }
  const minMin = Math.max(1, minH * 60);
  const maxMin = Math.max(minMin, maxH * 60);
  const next = minMin + Math.random() * (maxMin - minMin);
  chrome.alarms.create(SCHEDULE_ALARM, { delayInMinutes: next });
  if (maxMin > minMin) {
    console.log(`[Social Climber] Next scheduled export in ${next.toFixed(1)} min (random ${minMin.toFixed(1)}–${maxMin.toFixed(1)}).`);
  } else {
    console.log(`[Social Climber] Next scheduled export in ${next.toFixed(1)} min (fixed).`);
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

// Mirror each run outcome to the tracker server so the watchdog can
// see consecutive failures without parsing chrome.storage. Best-effort:
// if the server is down we just lose that one event — schedule keeps
// running. The history in chrome.storage is still the canonical
// extension-side log.
async function _reportBotEvent(payload) {
  try {
    const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
    const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
    const ext = chrome.runtime.getManifest();
    await fetch(`${base}/api/bot-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, extensionVersion: ext.version }),
    });
  } catch (e) {
    console.warn("[Social Climber] bot-event report failed:", e?.message || e);
  }
}

// Phone push: routes through the local server's /api/push endpoint,
// which decides delivery method (iMessage / email / ntfy) based on
// ~/.config/social-climber/push.json. Centralising in the server keeps
// the user's phone number / smtp creds OUT of the extension and out
// of git.
async function _phonePush(title, body, priority = "default") {
  try {
    const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
    const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
    const r = await fetch(`${base}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message: body, priority }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) {
      console.log(`[Social Climber] push (${j.method}) sent: ${title}`);
    } else {
      console.warn(`[Social Climber] push failed: ${j.method || "?"} — ${j.error || j.info || "unknown"}`);
    }
  } catch (e) {
    console.warn("[Social Climber] push failed:", e?.message || e);
  }
}

// Auto-retry: arm a one-shot retry alarm AUTO_RETRY_DELAY_MIN minutes
// out. Used when a scheduled run fails. We cap retries per day so a
// chronically-failing setup (e.g. OAuth expired) doesn't burn through
// dozens of tries during your sleep — after the cap, we wait for the
// next regular jittered slot.
async function _scheduleAutoRetry(reason) {
  const { autoRetryCount = { day: "", count: 0 } } =
    await chrome.storage.local.get(["autoRetryCount"]);
  const today = new Date().toISOString().slice(0, 10);
  const dayMatches = autoRetryCount.day === today;
  const count = dayMatches ? Number(autoRetryCount.count) || 0 : 0;
  if (count >= AUTO_RETRY_MAX_PER_DAY) {
    console.log(`[Social Climber] Auto-retry: cap reached for ${today} (${count}/${AUTO_RETRY_MAX_PER_DAY}); waiting for next regular slot.`);
    return;
  }
  await chrome.storage.local.set({
    autoRetryCount: { day: today, count: count + 1 },
  });
  await chrome.alarms.clear(RETRY_ALARM);
  chrome.alarms.create(RETRY_ALARM, { delayInMinutes: AUTO_RETRY_DELAY_MIN });
  console.log(`[Social Climber] Auto-retry armed in ${AUTO_RETRY_DELAY_MIN} min (reason: ${reason}, today's count: ${count + 1}/${AUTO_RETRY_MAX_PER_DAY}).`);
}

// Check consecutive-failure count via /api/bot-health and push to ntfy
// if we've crossed the threshold. Idempotent — server is the source
// of truth, so this can be called every failure without dedup logic
// here (the server will return the current count and we compare).
async function _checkAndPushOnConsecutive() {
  const { trackerUrl, lastNtfyAt } = await chrome.storage.local.get(["trackerUrl", "lastNtfyAt"]);
  const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  let health;
  try {
    const r = await fetch(`${base}/api/bot-health`);
    if (!r.ok) return;
    health = await r.json();
  } catch (e) {
    return;
  }
  if ((health.consecutive_failures || 0) < 2) return;
  // Throttle to one push per hour even if many failures land — phone
  // doesn't need a barrage.
  const now = Date.now();
  if (lastNtfyAt && (now - lastNtfyAt) < 60 * 60 * 1000) return;
  const errLine = health.last_failure?.error || health.last_failure?.status || "(no detail)";
  await _phonePush(
    `IG Bot: ${health.consecutive_failures} failures in a row`,
    `Last error: ${errLine}\nLast success: ${health.last_success?.ts || "(never recently)"}`,
    "high",
  );
  await chrome.storage.local.set({ lastNtfyAt: now });
}

async function _trackerScan(sinceMs) {
  const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
  const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  const sinceQ = (sinceMs != null && Number.isFinite(sinceMs)) ? `&since_ms=${sinceMs}` : "";
  try {
    const r = await fetch(`${base}/api/scan?force=false${sinceQ}`, { method: "POST" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function _onScheduledExportFire({ manual = false } = {}) {
  // Min-gap guard against chrome.alarms wake-from-sleep replay. If
  // the previous fire was less than (minScheduleMin - 1) ago, treat
  // this as a replay artifact and skip. Critical for the export bot
  // because back-to-back Meta-export creates would be the most
  // suspicious thing IG could see.
  //
  // `manual=true` from the popup's "▶ Now" button bypasses this —
  // the user explicitly asked, and an extra export create is fine
  // when they specifically chose to do it.
  const { lastScheduledFireAt, exportScheduleMinHours, exportScheduleHours } = await chrome.storage.local.get([
    "lastScheduledFireAt", "exportScheduleMinHours", "exportScheduleHours",
  ]);
  const minH = Number(exportScheduleMinHours) || Number(exportScheduleHours) || 0;
  if (!manual && minH > 0 && lastScheduledFireAt) {
    const minGapMs = Math.max(60_000, (minH * 60_000) - 60_000);  // interval minus 1 min, minimum 1 min
    const sinceMs = Date.now() - lastScheduledFireAt;
    if (sinceMs < minGapMs) {
      console.log(`[Social Climber] Scheduled export: alarm-replay protection — last fire ${Math.round(sinceMs/1000)}s ago (need ${Math.round(minGapMs/1000)}s+). Skipping.`);
      return;
    }
  }
  await chrome.storage.local.set({ lastScheduledFireAt: Date.now() });

  console.log("[Social Climber] Scheduled export alarm fired — opening wizard.");
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
    console.warn("[Social Climber] windows.create failed, falling back to active tab:", e?.message || e);
    const tab = await chrome.tabs.create({
      url: "https://accountscenter.instagram.com/info_and_permissions/dyi/",
      active: true,
    });
    tabId = tab?.id ?? null;
  }
  const arrivalWindow = await _arrivalWindowMin();
  console.log(`[Social Climber] Arrival poll window: first check at +${arrivalWindow.firstMin}m, give up at +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
  // pendingArrival captures the window at alarm-creation time so a
  // mid-run history change doesn't move the goalpost.
  await chrome.storage.local.set({
    wizardRunRequested: { ts: startedAt, tabId },
    pendingArrival: {
      startedAt,
      firstMin: arrivalWindow.firstMin,
      giveUpMin: arrivalWindow.giveUpMin,
    },
  });
  await _appendHistory({ ts: startedAt, status: "triggered" });
  await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
  chrome.alarms.create(ARRIVAL_POLL_ALARM, {
    delayInMinutes: arrivalWindow.firstMin,
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
  const giveUpMin = Number.isFinite(pendingArrival.giveUpMin) ? pendingArrival.giveUpMin : ARRIVAL_DEFAULT_GIVE_UP_MIN;
  if (elapsedMin > giveUpMin) {
    console.warn(`[Social Climber] Drive arrival poll: gave up after ${elapsedMin.toFixed(0)}min.`);
    await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
    await chrome.storage.local.set({ pendingArrival: null });
    const elapsedSec = Math.round(elapsedMs / 1000);
    await _appendHistory({
      ts: pendingArrival.startedAt,
      status: "no-arrival",
      elapsedSec,
    });
    await _reportBotEvent({ status: "no-arrival", elapsedSec, error: "give-up window exceeded" });
    await _scheduleAutoRetry("no-arrival");
    await _checkAndPushOnConsecutive();
    return;
  }
  console.log(`[Social Climber] Drive arrival poll: scanning (elapsed ${elapsedMin.toFixed(0)}min).`);
  const result = await _trackerScan(pendingArrival.startedAt);
  if (!result) return;
  const newImports = Number(result.imported) || 0;
  // Treat duplicates as arrivals too: the export landed, we just had
  // identical contents already so we chose not to keep it. From the
  // bot's perspective the run succeeded — file is in Drive.
  const newSince = Number(result.new_files_since) || 0;
  if (newImports > 0 || newSince > 0) {
    const elapsedSec = Math.round(elapsedMs / 1000);
    const reason = newImports > 0
      ? `${newImports} new import(s)`
      : `${newSince} new file(s) in Drive (deduped against existing snapshots)`;
    console.log(`[Social Climber] Drive arrival! ${reason} after ${elapsedSec}s.`);
    await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
    await chrome.storage.local.set({ pendingArrival: null });
    await _appendTiming(elapsedSec);
    await _appendHistory({
      ts: pendingArrival.startedAt,
      status: "arrived",
      elapsedSec,
      imports: newImports,
      duplicate: newImports === 0 && newSince > 0,
    });
    await _reportBotEvent({
      status: "arrived",
      elapsedSec,
      duplicate: newImports === 0 && newSince > 0,
    });
    // A successful run resets the daily auto-retry budget so the
    // next failure (if any) can retry.
    await chrome.storage.local.set({ autoRetryCount: { day: "", count: 0 } });
  }
}

// Auto-close alarm armed 1 minute after the export wizard reaches its
// submit step. setTimeout doesn't survive an MV3 service-worker shutdown
// (Chrome can tear the SW down within ~30s of inactivity); chrome.alarms
// persist and respawn the SW to fire.
const CLOSE_WIZARD_TAB_PREFIX = "close-wizard-tab-";


chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCHEDULE_ALARM) {
    await _onScheduledExportFire();
    // Re-arm with a fresh random interval. We dropped periodInMinutes
    // when switching to jittered scheduling, so the alarm only fires
    // again if we ask for it.
    await refreshExportAlarm();
  } else if (alarm.name === RETRY_ALARM) {
    console.log("[Social Climber] Auto-retry firing.");
    await _onScheduledExportFire();
    // Don't re-arm the regular schedule from the retry path — the
    // regular schedule's next fire is already armed independently.
  } else if (alarm.name === ARRIVAL_POLL_ALARM) {
    await _onArrivalPollFire();
  } else if (alarm.name.startsWith(CLOSE_WIZARD_TAB_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(CLOSE_WIZARD_TAB_PREFIX.length), 10);
    if (Number.isFinite(tabId)) {
      try { await chrome.tabs.remove(tabId); }
      catch (_) { /* tab already closed by user */ }
      console.log(`[Social Climber] Wizard tab ${tabId} closed (post-submit alarm)`);
    }
});

// Re-evaluate the alarm whenever any schedule field changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.exportScheduleMinHours ||
      changes.exportScheduleMaxHours ||
      changes.exportScheduleHours) {
    refreshExportAlarm();
  }
});

// Set up the alarm on SW (re)start. MV3 service workers can be torn
// down and restarted, so this also runs after an idle wake-up.
// Re-arm alarms ONLY when:
//   - extension installs / updates  (onInstalled)
//   - browser starts                 (onStartup)
//   - SW wakes AND the alarm has gone missing (the catch-all below)
//
// CRITICAL: do NOT call refreshExportAlarm unconditionally on every SW
// wake. SW wakes constantly (alarm fires, popup messages, fetch
// handlers), and each refresh clears the existing alarm and arms a
// fresh 15-20 min countdown. With frequent wakes, that timer never
// reaches expiry — the export bot silently stops firing for hours.
// This was the actual cause of the 3-hour silent gap once observed.
// The alarm itself is persistent across SW restarts; we only repair
// it if it's missing.

// Reloading the extension at chrome://extensions fires onInstalled
// (same event as fresh installs and version updates). Previously this
// unconditionally called refreshExportAlarm, which clears + recreates
// the alarm with a fresh random delay — so a 25-min schedule restarted
// from 0 every reload. Preserve existing alarms across reloads;
// only arm when actually missing.
chrome.runtime.onInstalled.addListener(async () => {
  const sched = await chrome.alarms.get(SCHEDULE_ALARM).catch(() => null);
  if (!sched) refreshExportAlarm();
});
chrome.runtime.onStartup.addListener(async () => {
  // Browser-restart path. chrome.alarms persists across browser
  // restarts, so existing alarms should already be there. Only arm
  // if something's missing.
  const sched = await chrome.alarms.get(SCHEDULE_ALARM).catch(() => null);
  if (!sched) refreshExportAlarm();
});

(async function _ensureAlarmsArmed() {
  try {
    const sched = await chrome.alarms.get(SCHEDULE_ALARM);
    if (!sched) {
      console.log("[Social Climber] Boot: SCHEDULE_ALARM missing, re-arming.");
      await refreshExportAlarm();
    }
  } catch (e) {
    console.warn("[Social Climber] Boot alarm check failed:", e?.message || e);
    refreshExportAlarm().catch(() => {});
  }
})();



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
    console.log(`[Social Climber] debugger: attached to tab ${tabId}`);
    return true;
  } catch (e) {
    console.warn(`[Social Climber] debugger: attach failed for tab ${tabId}:`, e?.message || e);
    return false;
  }
}

async function _detachDebugger(tabId) {
  if (!_debuggerTabs.has(tabId)) return;
  _debuggerTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
    console.log(`[Social Climber] debugger: detached from tab ${tabId}`);
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
    console.log(`[Social Climber] debugger: external detach for tab ${tabId}`);
  }
});

// Auto-detach the debugger when the tab closes so we don't leak an
// orphaned session into the next SW lifetime.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_debuggerTabs.has(tabId)) _debuggerTabs.delete(tabId);
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
    console.log(`[Social Climber] trusted-click: synthesizeTapGesture @ (${x},${y}) ✓`);
    return;
  } catch (e) {
    console.warn(`[Social Climber] trusted-click: synthesizeTapGesture failed (${e?.message || e}) — falling back to dispatchMouseEvent`);
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
  console.log(`[Social Climber] trusted-click: dispatchMouseEvent @ (${x},${y}) ✓ [fallback]`);
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
  // Wizard reached "Export submitted ✓" — close the tab ~1 minute
  // later so the user doesn't have to reach over and kill it. We don't
  // close immediately because Meta sometimes fires the password prompt
  // seconds after the submit click; the password watchdog (also in
  // meta-export.js) needs the tab alive to fill it. Uses chrome.alarms
  // instead of setTimeout — MV3 service workers can shut down in ~30s
  // of idle, which kills setTimeout; alarms persist and respawn the SW.
  if (msg.type === "wizard-finished") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        await chrome.alarms.create(`${CLOSE_WIZARD_TAB_PREFIX}${tabId}`, {
          delayInMinutes: 1,
        });
        console.log(`[Social Climber] Wizard finished, closing tab ${tabId} in 1 min (alarm)`);
      }
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
      const arrivalWindow = await _arrivalWindowMin();
      await chrome.storage.local.set({
        wizardRunRequested: { ts: startedAt, tabId: tab?.id ?? null },
        pendingArrival: {
          startedAt,
          firstMin: arrivalWindow.firstMin,
          giveUpMin: arrivalWindow.giveUpMin,
        },
      });
      await _appendHistory({ ts: startedAt, status: "triggered-manual" });
      console.log(`[Social Climber] Arrival poll window: first +${arrivalWindow.firstMin}m, give up +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
      await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
      chrome.alarms.create(ARRIVAL_POLL_ALARM, {
        delayInMinutes: arrivalWindow.firstMin,
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
      await _reportBotEvent({ status: "stopped" });
      // Detach any wizard tabs we attached the debugger to — clears
      // the yellow "is debugging" infobar so the user isn't left
      // wondering after a stop.
      for (const tid of Array.from(_debuggerTabs)) {
        await _detachDebugger(tid);
      }
      console.log("[Social Climber] Export stopped by user — alarm cleared.");
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Manual "Run export" from the popup — also kicks off the arrival
  // poll so timings get recorded for manual runs too.
  if (msg.type === "track-manual-export") {
    (async () => {
      const startedAt = Date.now();
      const arrivalWindow = await _arrivalWindowMin();
      await _appendHistory({ ts: startedAt, status: "triggered-manual" });
      await chrome.storage.local.set({
        pendingArrival: {
          startedAt,
          firstMin: arrivalWindow.firstMin,
          giveUpMin: arrivalWindow.giveUpMin,
        },
      });
      console.log(`[Social Climber] Arrival poll window: first +${arrivalWindow.firstMin}m, give up +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
      await chrome.alarms.clear(ARRIVAL_POLL_ALARM);
      chrome.alarms.create(ARRIVAL_POLL_ALARM, {
        delayInMinutes: arrivalWindow.firstMin,
        periodInMinutes: 1,
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Popup asks for current export status / history / timings.
  if (msg.type === "get-export-stats") {
    (async () => {
      const [data, alarm] = await Promise.all([
        chrome.storage.local.get([
          "exportHistory", "exportTimings", "pendingArrival",
          "exportScheduleHours", "exportScheduleMinHours", "exportScheduleMaxHours",
        ]),
        chrome.alarms.get(SCHEDULE_ALARM).catch(() => null),
      ]);
      sendResponse({
        ok: true,
        history: data.exportHistory || [],
        timings: data.exportTimings || [],
        pending: data.pendingArrival || null,
        scheduleMinHours: data.exportScheduleMinHours || data.exportScheduleHours || 0,
        scheduleMaxHours: data.exportScheduleMaxHours || data.exportScheduleHours || 0,
        nextFireAt: alarm ? alarm.scheduledTime : null,
      });
    })();
    return true;
  }
  // "Run export now" — manually trigger the next scheduled fire of the
  // export wizard without waiting for the alarm. Same code path as the
  // alarm fire, then re-arms the alarm so the next auto-run is `interval`
  // minutes from NOW (not from the previously-armed time). No-op when a
  // run is already in flight to avoid overlap.
  if (msg.type === "export-fire-now") {
    (async () => {
      try {
        const { pendingArrival } = await chrome.storage.local.get(["pendingArrival"]);
        if (pendingArrival) {
          sendResponse({ ok: false, error: "An export is already in flight. Hit Stop first if you want to restart." });
          return;
        }
        await _appendHistory({ ts: Date.now(), status: "triggered-now" });
        await _onScheduledExportFire({ manual: true });
        // Re-anchor the alarm so the next auto-fire is `interval`
        // minutes from now, not from the previously-armed time.
        await refreshExportAlarm();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  // Standard JSON / text fetch — relays tracker API calls from content
  // scripts. instagram.com is HTTPS and the local tracker is HTTP;
  // page-origin fetches get blocked as mixed content, but extension-
  // origin fetches (from the SW) are not gated the same way.
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
  // Binary-blob fetch — the SW issues the request (avoiding mixed-content
  // blocks since instagram.com is HTTPS) with the page's cookies, reads
  // the bytes, and base64-encodes for transport back to the content
  // script.
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
          console.log(`[Social Climber SW] credentialed fetch failed (${e1.message}), retrying cookieless: ${msg.url.slice(0, 80)}`);
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
