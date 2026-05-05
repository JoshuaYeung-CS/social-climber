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
const ARCHIVE_RUNNER_ALARM = "archive-runner";
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
// Auto-archive runner: opens favorited-not-yet-archived accounts in a
// minimized window one at a time, paced by the alarm. The main
// extension's ig-profile.js content script (with autoArchiveMedia=true)
// does the actual scraping when each tab loads. We just orchestrate
// the queue and pacing — no scraping code lives here.
//
// IG aggressively rate-limits scraping; 5+ profiles a minute will
// trigger CAPTCHA / temp-block. Default cadence is 3 minutes per
// account, which lets the content script finish one before the next
// starts and stays under typical anti-bot thresholds. Per-tab budget
// of 90s gives the scroll loop time to load enough media before we
// close the tab.
const ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN = 10;
// 4 minutes per account is enough for typical favorites (50–300 tiles).
// At 10-min pacing we still leave 6 min idle between accounts. If you
// have power-users with thousands of posts, raise this; the alarm
// won't fire the next account until this expires anyway.
const ARCHIVE_RUNNER_TAB_BUDGET_MS = 4 * 60_000;
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
    console.log("[IG Tracker] Scheduled export disabled.");
    return;
  }
  const minMin = Math.max(1, minH * 60);
  const maxMin = Math.max(minMin, maxH * 60);
  const next = minMin + Math.random() * (maxMin - minMin);
  chrome.alarms.create(SCHEDULE_ALARM, { delayInMinutes: next });
  if (maxMin > minMin) {
    console.log(`[IG Tracker] Next scheduled export in ${next.toFixed(1)} min (random ${minMin.toFixed(1)}–${maxMin.toFixed(1)}).`);
  } else {
    console.log(`[IG Tracker] Next scheduled export in ${next.toFixed(1)} min (fixed).`);
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
    console.warn("[IG Tracker] bot-event report failed:", e?.message || e);
  }
}

// Phone push: routes through the local server's /api/push endpoint,
// which decides delivery method (iMessage / email / ntfy) based on
// ~/.config/igtracker/push.json. Centralising in the server keeps
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
      console.log(`[IG Tracker] push (${j.method}) sent: ${title}`);
    } else {
      console.warn(`[IG Tracker] push failed: ${j.method || "?"} — ${j.error || j.info || "unknown"}`);
    }
  } catch (e) {
    console.warn("[IG Tracker] push failed:", e?.message || e);
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
    console.log(`[IG Tracker] Auto-retry: cap reached for ${today} (${count}/${AUTO_RETRY_MAX_PER_DAY}); waiting for next regular slot.`);
    return;
  }
  await chrome.storage.local.set({
    autoRetryCount: { day: today, count: count + 1 },
  });
  await chrome.alarms.clear(RETRY_ALARM);
  chrome.alarms.create(RETRY_ALARM, { delayInMinutes: AUTO_RETRY_DELAY_MIN });
  console.log(`[IG Tracker] Auto-retry armed in ${AUTO_RETRY_DELAY_MIN} min (reason: ${reason}, today's count: ${count + 1}/${AUTO_RETRY_MAX_PER_DAY}).`);
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
  const arrivalWindow = await _arrivalWindowMin();
  console.log(`[IG Tracker] Arrival poll window: first check at +${arrivalWindow.firstMin}m, give up at +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
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
    console.warn(`[IG Tracker] Drive arrival poll: gave up after ${elapsedMin.toFixed(0)}min.`);
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
  console.log(`[IG Tracker] Drive arrival poll: scanning (elapsed ${elapsedMin.toFixed(0)}min).`);
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
    console.log(`[IG Tracker] Drive arrival! ${reason} after ${elapsedSec}s.`);
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCHEDULE_ALARM) {
    await _onScheduledExportFire();
    // Re-arm with a fresh random interval. We dropped periodInMinutes
    // when switching to jittered scheduling, so the alarm only fires
    // again if we ask for it.
    await refreshExportAlarm();
  } else if (alarm.name === RETRY_ALARM) {
    console.log("[IG Tracker] Auto-retry firing.");
    await _onScheduledExportFire();
    // Don't re-arm the regular schedule from the retry path — the
    // regular schedule's next fire is already armed independently.
  } else if (alarm.name === ARRIVAL_POLL_ALARM) {
    await _onArrivalPollFire();
  } else if (alarm.name === ARCHIVE_RUNNER_ALARM) {
    await _onArchiveRunnerFire();
  }
});

// ---------- auto-archive runner ----------

async function _archiveTrackerUrl() {
  const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
  return (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
}

async function refreshArchiveRunnerAlarm() {
  const { archiveRunnerOn, archiveRunnerIntervalMin } = await chrome.storage.local.get([
    "archiveRunnerOn", "archiveRunnerIntervalMin",
  ]);
  await chrome.alarms.clear(ARCHIVE_RUNNER_ALARM);
  if (!archiveRunnerOn) {
    console.log("[IG Tracker] Archive runner: off");
    return;
  }
  const interval = Math.max(1, Number(archiveRunnerIntervalMin) || ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN);
  // First fire after a short kick (15s) so toggling on doesn't make
  // the user wait `interval` minutes for nothing to happen, then
  // every `interval` minutes after that.
  chrome.alarms.create(ARCHIVE_RUNNER_ALARM, {
    delayInMinutes: 0.25,
    periodInMinutes: interval,
  });
  console.log(`[IG Tracker] Archive runner: armed every ${interval} min`);
}

async function _onArchiveRunnerFire() {
  const base = await _archiveTrackerUrl();
  let queue = [];
  let stats = null;
  try {
    const r = await fetch(`${base}/api/archive-queue`);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    queue = j.queue || [];
    stats = j.stats || null;
  } catch (e) {
    console.warn("[IG Tracker] Archive runner: fetch failed:", e?.message || e);
    return;
  }
  await chrome.storage.local.set({
    archiveRunnerLastStats: { ...stats, fetchedAt: Date.now() },
  });
  if (queue.length === 0) {
    console.log("[IG Tracker] Archive runner: queue empty.");
    return;
  }
  const username = queue[0];
  console.log(`[IG Tracker] Archive runner: opening ${username} (${queue.length} remaining)`);

  // Open in a separate non-focused minimized window — same trick as
  // the export bot uses, so we don't background-throttle the content
  // script's scroll loop.
  let tabId = null;
  let windowId = null;
  try {
    const win = await chrome.windows.create({
      // Hash flag tells the content script "you were opened by the
      // runner — override visibility and auto-fire archive-all".
      url: `https://www.instagram.com/${encodeURIComponent(username)}/#igtracker-runner=archive`,
      focused: false,
      type: "normal",
      state: "minimized",
    });
    tabId = win?.tabs?.[0]?.id ?? null;
    windowId = win?.id ?? null;
  } catch (e) {
    console.warn("[IG Tracker] Archive runner: window.create failed:", e?.message || e);
    return;
  }

  await _appendArchiveRunnerHistory({
    ts: Date.now(),
    username,
    status: "opened",
  });

  // Close the tab after the budget. If the tab was already closed by
  // the user we just swallow the error.
  setTimeout(async () => {
    try {
      if (windowId != null) await chrome.windows.remove(windowId);
    } catch (_) { /* tab already gone */ }
    await _appendArchiveRunnerHistory({
      ts: Date.now(),
      username,
      status: "closed",
    });
  }, ARCHIVE_RUNNER_TAB_BUDGET_MS);
}

async function _appendArchiveRunnerHistory(entry) {
  const { archiveRunnerHistory = [] } = await chrome.storage.local.get(["archiveRunnerHistory"]);
  archiveRunnerHistory.push(entry);
  if (archiveRunnerHistory.length > 100) {
    archiveRunnerHistory.splice(0, archiveRunnerHistory.length - 100);
  }
  await chrome.storage.local.set({ archiveRunnerHistory });
}

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
chrome.runtime.onInstalled.addListener(() => { refreshExportAlarm(); refreshArchiveRunnerAlarm(); });
chrome.runtime.onStartup.addListener(() => { refreshExportAlarm(); refreshArchiveRunnerAlarm(); });
refreshExportAlarm().catch(() => {});
refreshArchiveRunnerAlarm().catch(() => {});

// Re-arm runner whenever its config changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.archiveRunnerOn || changes.archiveRunnerIntervalMin) {
    refreshArchiveRunnerAlarm();
  }
});

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
      console.log(`[IG Tracker] Arrival poll window: first +${arrivalWindow.firstMin}m, give up +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
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
      const arrivalWindow = await _arrivalWindowMin();
      await _appendHistory({ ts: startedAt, status: "triggered-manual" });
      await chrome.storage.local.set({
        pendingArrival: {
          startedAt,
          firstMin: arrivalWindow.firstMin,
          giveUpMin: arrivalWindow.giveUpMin,
        },
      });
      console.log(`[IG Tracker] Arrival poll window: first +${arrivalWindow.firstMin}m, give up +${arrivalWindow.giveUpMin}m (${arrivalWindow.basis}).`);
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
  // Popup asks for archive-runner state.
  if (msg.type === "get-archive-runner-stats") {
    (async () => {
      const [data, alarm] = await Promise.all([
        chrome.storage.local.get([
          "archiveRunnerOn", "archiveRunnerIntervalMin",
          "archiveRunnerHistory", "archiveRunnerLastStats",
        ]),
        chrome.alarms.get(ARCHIVE_RUNNER_ALARM).catch(() => null),
      ]);
      sendResponse({
        ok: true,
        on: !!data.archiveRunnerOn,
        intervalMin: Number(data.archiveRunnerIntervalMin) || ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN,
        history: (data.archiveRunnerHistory || []).slice(-10).reverse(),
        lastStats: data.archiveRunnerLastStats || null,
        nextFireAt: alarm ? alarm.scheduledTime : null,
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
