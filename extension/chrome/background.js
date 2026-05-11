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
// (Budget tab-close moved to chrome.alarms — see ARCHIVE_RUNNER_TAB_BUDGET_MIN
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
      console.log(`[IG Tracker] Scheduled export: alarm-replay protection — last fire ${Math.round(sinceMs/1000)}s ago (need ${Math.round(minGapMs/1000)}s+). Skipping.`);
      return;
    }
  }
  await chrome.storage.local.set({ lastScheduledFireAt: Date.now() });

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

// Prefixes for the auto-close alarms we arm 1 minute after (a) the
// export wizard reaches its submit step, (b) the auto-archive runner
// receives a completion signal. setTimeout doesn't survive an MV3
// service-worker shutdown — Chrome can tear the SW down within ~30s
// of inactivity, killing any pending timer. chrome.alarms persists
// the schedule and respawns the SW to fire it.
const CLOSE_WIZARD_TAB_PREFIX = "close-wizard-tab-";
const CLOSE_RUNNER_WIN_PREFIX = "close-runner-window-";
// Per-fire fallback alarm: closes the runner window after the budget
// elapses even if the content script never signals completion (e.g.
// IG redirected, the script crashed mid-scroll, or the SW was
// dormant when the message arrived). chrome.alarms are MV3-safe
// where the previous setTimeout(ARCHIVE_RUNNER_TAB_BUDGET_MS) wasn't.
const RUNNER_BUDGET_PREFIX = "runner-budget-";
// Per-account tab-budget. Bumped 4 → 10: accounts with lots of
// posts + multi-slide carousels + highlights need more wall-clock
// time to walk all five tabs (Posts → Reels → Tagged → Highlights →
// Story) and step through each carousel. With the new 2-retry cap,
// this is a hard 20-minute total cap per account before permanent-
// fail (10 min × 2 attempts), which still lets the queue advance
// reasonably while giving heavy accounts a real chance to finish in
// one go. Idempotent saves on the server mean a second attempt only
// downloads slides missed in the first.
const ARCHIVE_RUNNER_TAB_BUDGET_MIN = 10;

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
  } else if (alarm.name.startsWith(CLOSE_WIZARD_TAB_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(CLOSE_WIZARD_TAB_PREFIX.length), 10);
    if (Number.isFinite(tabId)) {
      try { await chrome.tabs.remove(tabId); }
      catch (_) { /* tab already closed by user */ }
      console.log(`[IG Tracker] Wizard tab ${tabId} closed (post-submit alarm)`);
    }
  } else if (alarm.name.startsWith(CLOSE_RUNNER_WIN_PREFIX)) {
    const winId = parseInt(alarm.name.slice(CLOSE_RUNNER_WIN_PREFIX.length), 10);
    if (Number.isFinite(winId)) {
      try { await chrome.windows.remove(winId); }
      catch (_) { /* already gone */ }
      // Cancel any still-pending budget alarm for this window — once
      // we've fired the post-completion close, the budget fallback
      // would just be a no-op (window already gone) but it would
      // ALSO trigger budget-fallback's _scheduleNextRunnerFireFromCompletion
      // call, double-advancing the runner. Clear it.
      try { await chrome.alarms.clear(`${RUNNER_BUDGET_PREFIX}${winId}`); } catch (_) {}
      console.log(`[IG Tracker] Archive runner: closed window ${winId} (post-completion alarm)`);
    }
  } else if (alarm.name.startsWith(RUNNER_BUDGET_PREFIX)) {
    // Budget fallback: completion message never arrived (content
    // script crashed, page never loaded, SW slept through it). Close
    // the window AND advance the runner the same way the regular
    // completion path would have.
    const winId = parseInt(alarm.name.slice(RUNNER_BUDGET_PREFIX.length), 10);
    if (Number.isFinite(winId)) {
      try { await chrome.windows.remove(winId); }
      catch (_) { /* already gone */ }
      console.log(`[IG Tracker] Archive runner: closed window ${winId} (budget fallback alarm)`);
      const state = await _loadArchiveState();
      // Only history-log if this budget alarm corresponds to a still-
      // tracked in-flight account. Otherwise we'd log a spurious
      // 'closed' entry for an account whose run already completed.
      if (state.inFlightWindowId === winId && state.inFlight) {
        await _appendArchiveRunnerHistory({
          ts: Date.now(),
          username: state.inFlight,
          status: "closed",
        });
      }
      await _scheduleNextRunnerFireFromCompletion("budget-fallback");
    }
  }
});

// ---------- auto-archive runner ----------

async function _archiveTrackerUrl() {
  const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
  return (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
}

async function refreshArchiveRunnerAlarm() {
  const {
    archiveRunnerOn,
    archiveRunnerIntervalMin,
    archiveRunnerMode,
    archiveRunnerGraceMin,
  } = await chrome.storage.local.get([
    "archiveRunnerOn",
    "archiveRunnerIntervalMin",
    "archiveRunnerMode",
    "archiveRunnerGraceMin",
  ]);
  await chrome.alarms.clear(ARCHIVE_RUNNER_ALARM);
  if (!archiveRunnerOn) {
    console.log("[IG Tracker] Archive runner: off");
    return;
  }
  const mode = archiveRunnerMode === "completion" ? "completion" : "interval";
  if (mode === "interval") {
    // Periodic alarm — fires every N minutes regardless of whether the
    // previous account finished archiving.
    const interval = Math.max(1, Number(archiveRunnerIntervalMin) || ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN);
    chrome.alarms.create(ARCHIVE_RUNNER_ALARM, {
      delayInMinutes: 0.25,
      periodInMinutes: interval,
    });
    console.log(`[IG Tracker] Archive runner: interval mode, every ${interval} min`);
  } else {
    // Completion mode — one-shot alarm. Re-armed by either:
    //   1. The "archive-runner-complete" SW message (content script
    //      finished — fires next account after grace_min)
    //   2. The tab-budget setTimeout (fallback when content script
    //      crashed or never sent the message — fires next account
    //      after grace_min)
    // Initial fire 15s out, just like interval mode.
    chrome.alarms.create(ARCHIVE_RUNNER_ALARM, { delayInMinutes: 0.25 });
    const grace = Math.max(0.25, Number(archiveRunnerGraceMin) || 1);
    console.log(`[IG Tracker] Archive runner: completion mode, grace ${grace} min`);
  }
}

async function _scheduleNextRunnerFireFromCompletion(reason) {
  const { archiveRunnerOn, archiveRunnerMode, archiveRunnerGraceMin } = await chrome.storage.local.get([
    "archiveRunnerOn", "archiveRunnerMode", "archiveRunnerGraceMin",
  ]);
  if (!archiveRunnerOn) return;
  if (archiveRunnerMode !== "completion") return;
  const grace = Math.max(0.25, Number(archiveRunnerGraceMin) || 1);
  await chrome.alarms.clear(ARCHIVE_RUNNER_ALARM);
  chrome.alarms.create(ARCHIVE_RUNNER_ALARM, { delayInMinutes: grace });
  console.log(`[IG Tracker] Archive runner: completion-triggered next fire in ${grace} min (reason: ${reason})`);
}

// Failure-handling threshold. After this many cumulative failed
// attempts on a single account, mark it as PERMANENT FAILURE and
// stop retrying — the user gets a persistent banner in the popup
// plus a Reminders/iMessage push.
//
// Set to 2 (down from 10): accounts that don't exist / went private /
// got banned silently produce zero files and have no way to ever
// succeed in the runner's hostile background-tab environment. With
// the old cap of 10, dead accounts blocked the queue for ~80 minutes
// before being given up on. 2 retries lets us move on to the next
// account in <16 minutes. If a real account fails twice in a row in
// the background, manually opening the profile and clicking the 📦
// button is more reliable anyway — that path uses a foreground tab
// without Chrome's timer throttling.
const ARCHIVE_RUNNER_MAX_ATTEMPTS = 2;

// ---------- manual-archive slot manager ----------
//
// Cross-tab serialization for 📦 Archive selected clicks. Each
// "slot" lets one foreground tab archive a profile at full speed
// (no Chrome timer throttling, real user gesture for AudioContext,
// manual-quality results). When all slots are taken, additional
// clicks queue and the SW grants them slots in FIFO order as
// in-flight archives complete.
//
// User-tested observation: 2-3 concurrent foreground archives is
// the sweet spot. 1 is too sequential, 10 saturates the local
// server / IG. Default 2; configurable via chrome.storage.local.
//   manualArchiveSlotLimit. Slots auto-release after 30 min if
// the owning tab never sends a release (browser crash, navigation
// away mid-run, etc.) so the queue can't deadlock.
const MANUAL_ARCHIVE_SLOT_LIMIT_DEFAULT = 2;
const MANUAL_ARCHIVE_SLOT_TIMEOUT_MS = 30 * 60_000;

async function _loadManualArchiveState() {
  const v = await chrome.storage.local.get([
    "manualArchiveSlots", "manualArchiveQueue", "manualArchiveSlotLimit",
  ]);
  return {
    slots: Array.isArray(v.manualArchiveSlots) ? v.manualArchiveSlots : [],
    queue: Array.isArray(v.manualArchiveQueue) ? v.manualArchiveQueue : [],
    limit: Number(v.manualArchiveSlotLimit) || MANUAL_ARCHIVE_SLOT_LIMIT_DEFAULT,
  };
}

async function _saveManualArchiveState(state) {
  await chrome.storage.local.set({
    manualArchiveSlots: state.slots,
    manualArchiveQueue: state.queue,
  });
}

// Drop slots / queue entries whose owning tab is gone or whose
// claim is stale (>30 min). Called before any allocate decision.
async function _cleanupStaleManualSlots(state) {
  const now = Date.now();
  const validSlots = [];
  for (const s of state.slots) {
    if (now - (s.claimedAt || 0) > MANUAL_ARCHIVE_SLOT_TIMEOUT_MS) continue;
    try {
      await chrome.tabs.get(s.tabId);
      validSlots.push(s);
    } catch { /* tab gone */ }
  }
  state.slots = validSlots;
  const validQueue = [];
  for (const q of state.queue) {
    try {
      await chrome.tabs.get(q.tabId);
      validQueue.push(q);
    } catch { /* tab gone */ }
  }
  state.queue = validQueue;
}

// After releasing a slot or cleaning stale ones, hand grants to as
// many waiters as the slot limit allows. Sends each granted tab a
// `manual-archive-slot-granted` message so its content script can
// kick off the archive.
async function _grantManualSlotsAsAvailable(state) {
  while (state.slots.length < state.limit && state.queue.length > 0) {
    const next = state.queue.shift();
    state.slots.push({
      tabId: next.tabId,
      username: next.username,
      claimedAt: Date.now(),
    });
    try {
      await chrome.tabs.sendMessage(next.tabId, {
        type: "manual-archive-slot-granted",
        username: next.username,
      });
    } catch (e) {
      // Tab gone between queueing and granting — pop the slot we
      // just allocated and try the next waiter.
      state.slots.pop();
    }
  }
}

async function _loadArchiveState() {
  const { archiveRunnerState = {} } = await chrome.storage.local.get(["archiveRunnerState"]);
  return {
    triedThisPass: archiveRunnerState.triedThisPass || [],
    attemptCounts: archiveRunnerState.attemptCounts || {},
    permanentFailures: archiveRunnerState.permanentFailures || {},
    passNumber: archiveRunnerState.passNumber || 1,
    inFlight: archiveRunnerState.inFlight || null,
    inFlightWindowId: archiveRunnerState.inFlightWindowId || null,
  };
}

async function _saveArchiveState(state) {
  await chrome.storage.local.set({ archiveRunnerState: state });
}

async function _verifyPreviousAttempt(state, liveQueue) {
  // Called at the start of each fire. If a previous run was in flight
  // (tab opened, may have closed), check whether the user dropped from
  // the queue (success) or is still there (failure). Update counts.
  if (!state.inFlight) return;
  const u = state.inFlight;
  const stillQueued = liveQueue.includes(u);
  if (stillQueued) {
    // Failed this attempt.
    state.attemptCounts[u] = (state.attemptCounts[u] || 0) + 1;
    if (state.attemptCounts[u] >= ARCHIVE_RUNNER_MAX_ATTEMPTS) {
      state.permanentFailures[u] = {
        firstFailedAt: state.permanentFailures[u]?.firstFailedAt || Date.now(),
        attempts: state.attemptCounts[u],
      };
      delete state.attemptCounts[u];
      state.triedThisPass = state.triedThisPass.filter(x => x !== u);
      console.warn(`[IG Tracker] Archive runner: PERMANENT FAILURE @${u} after ${ARCHIVE_RUNNER_MAX_ATTEMPTS} attempts`);
      await _appendArchiveRunnerHistory({ ts: Date.now(), username: u, status: "permanent-fail" });
      // Push exactly once when it crosses the threshold.
      try {
        await _phonePush(
          `IG Archive: @${u} permanently failed`,
          `Couldn't archive after ${ARCHIVE_RUNNER_MAX_ATTEMPTS} tries. Tag the account as unavailable, or delete the (empty) data/media/${u} folder if you want to keep retrying.`,
          "high",
        );
      } catch (_) { /* push best-effort */ }
    } else {
      if (!state.triedThisPass.includes(u)) {
        state.triedThisPass.push(u);
      }
      console.log(`[IG Tracker] Archive runner: @${u} still queued — attempt ${state.attemptCounts[u]}/${ARCHIVE_RUNNER_MAX_ATTEMPTS}, skipping`);
      await _appendArchiveRunnerHistory({
        ts: Date.now(),
        username: u,
        status: "skipped",
        attempts: state.attemptCounts[u],
      });
    }
  } else {
    // Success — drop from tracking.
    delete state.attemptCounts[u];
    state.triedThisPass = state.triedThisPass.filter(x => x !== u);
    console.log(`[IG Tracker] Archive runner: ✓ @${u} archived successfully`);
    await _appendArchiveRunnerHistory({ ts: Date.now(), username: u, status: "archived" });
  }
  state.inFlight = null;
}

async function _onArchiveRunnerFire({ manual = false } = {}) {
  // Manual-slot priority: don't kick off the auto-runner if any
  // manual-archive slots are currently active. Two foreground
  // archives + a runner background tab would compete for the
  // local server's threadpool and IG's anti-bot patience. The
  // auto-runner alarm will fire again next interval; if the
  // manual slots are still busy, it'll skip again. This applies
  // to BOTH alarm fires AND the popup's "▶ Now" button — manual
  // archives always win the conflict.
  const { manualArchiveSlots: _mSlots = [] } = await chrome.storage.local.get(["manualArchiveSlots"]);
  if (Array.isArray(_mSlots) && _mSlots.length > 0) {
    console.log(`[IG Tracker] Archive runner: ${_mSlots.length} manual slot(s) active — yielding to manual archives`);
    return;
  }
  // Min-gap guard. chrome.alarms replays missed periodic fires after
  // the system wakes from sleep — if the laptop slept 5h with the
  // runner armed for 8min, on wake Chrome can fire several catch-up
  // schedules in tight succession (observed: two fires <1min apart).
  // That would be exactly the kind of burst that trips IG's anti-
  // bot. We treat any fire that lands within (interval - 30s) of
  // the previous fire as a replay artifact and skip — the next
  // properly-spaced fire will resume normal cadence.
  //
  // `manual=true` from the popup's "▶ Now" button bypasses this —
  // the user explicitly asked us to fire now, so a 30s replay
  // shouldn't suppress them.
  const { archiveRunnerLastFireAt, archiveRunnerIntervalMin } = await chrome.storage.local.get([
    "archiveRunnerLastFireAt", "archiveRunnerIntervalMin",
  ]);
  const intervalMin = Math.max(1, Number(archiveRunnerIntervalMin) || ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN);
  const minGapMs = (intervalMin * 60_000) - 30_000;
  if (!manual && archiveRunnerLastFireAt && (Date.now() - archiveRunnerLastFireAt) < minGapMs) {
    const sinceS = Math.round((Date.now() - archiveRunnerLastFireAt) / 1000);
    console.log(`[IG Tracker] Archive runner: alarm-replay protection — last fire ${sinceS}s ago (need ${Math.round(minGapMs/1000)}s+). Skipping this fire.`);
    return;
  }
  await chrome.storage.local.set({ archiveRunnerLastFireAt: Date.now() });

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

  const state = await _loadArchiveState();
  await _verifyPreviousAttempt(state, queue);

  // Permanent failures filtered out — they stop being attempted.
  const liveQueue = queue.filter(u => !state.permanentFailures[u]);
  await chrome.storage.local.set({
    archiveRunnerLastStats: {
      ...stats,
      fetchedAt: Date.now(),
      live_queue_size: liveQueue.length,
      tried_this_pass: state.triedThisPass.length,
      pass_number: state.passNumber,
      permanent_failures: Object.keys(state.permanentFailures),
    },
  });

  if (liveQueue.length === 0) {
    console.log("[IG Tracker] Archive runner: live queue empty.");
    await _saveArchiveState(state);
    return;
  }

  // Pick the first user not already attempted in this pass.
  let pick = liveQueue.find(u => !state.triedThisPass.includes(u));
  if (!pick) {
    // All live-queue users have been attempted this pass without
    // success → start a new pass. Failed users get re-tried, with
    // their accumulated attempt counts intact (so the 10-attempt cap
    // still applies across passes).
    state.triedThisPass = [];
    state.passNumber += 1;
    pick = liveQueue[0];
    console.log(`[IG Tracker] Archive runner: starting pass #${state.passNumber}, retrying ${liveQueue.length} failed account(s)`);
  }

  state.inFlight = pick;
  await _saveArchiveState(state);

  console.log(`[IG Tracker] Archive runner: opening @${pick} (${liveQueue.length} live, ${state.triedThisPass.length} tried this pass, ${Object.keys(state.permanentFailures).length} permanent fails)`);

  let windowId = null;
  try {
    const win = await chrome.windows.create({
      url: `https://www.instagram.com/${encodeURIComponent(pick)}/#igtracker-runner=archive`,
      focused: false,
      type: "normal",
      state: "minimized",
    });
    windowId = win?.id ?? null;
  } catch (e) {
    console.warn("[IG Tracker] Archive runner: window.create failed:", e?.message || e);
    state.inFlight = null;
    state.inFlightWindowId = null;
    await _saveArchiveState(state);
    return;
  }
  // Persist the window id so the archive-runner-complete message
  // handler can close THIS specific window 1 minute after the
  // content script signals done. Without this, the SW only closes
  // via the 4-minute budget timer below regardless of completion.
  state.inFlightWindowId = windowId;
  await _saveArchiveState(state);

  await _appendArchiveRunnerHistory({
    ts: Date.now(),
    username: pick,
    status: "opened",
    attempt: (state.attemptCounts[pick] || 0) + 1,
  });

  // Budget-fallback close: previously a setTimeout(4 min). MV3 service
  // workers can shut down within ~30s of inactivity, killing pending
  // setTimeouts. chrome.alarms persist and respawn the SW to fire,
  // so this is reliable even when the SW has been dormant the whole
  // budget window. Alarm name embeds the windowId so concurrent
  // budgets for different fires don't collide. The handler down at
  // chrome.alarms.onAlarm closes the window AND advances the runner
  // via _scheduleNextRunnerFireFromCompletion('budget-fallback').
  await chrome.alarms.create(`${RUNNER_BUDGET_PREFIX}${windowId}`, {
    delayInMinutes: ARCHIVE_RUNNER_TAB_BUDGET_MIN,
  });
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
// Re-arm alarms ONLY when:
//   - extension installs / updates  (onInstalled)
//   - browser starts                 (onStartup)
//   - SW wakes AND the alarm has gone missing (the catch-all below)
//
// CRITICAL: do NOT call refreshExportAlarm unconditionally on every SW
// wake. SW wakes constantly (archive-alarm fires, popup messages,
// fetch handlers), and each refresh clears the existing alarm and
// arms a fresh 15-20 min countdown. With frequent wakes, that timer
// never reaches expiry — the export bot silently stops firing for
// hours. This was the actual cause of the 3-hour silent gap the user
// reported. The alarm itself is persistent across SW restarts; we
// only need to repair it if it's missing.
// One-time migration: when ARCHIVE_RUNNER_MAX_ATTEMPTS dropped from
// 10 → 2 and the per-account budget bumped 4 → 10 min, accounts that
// already had attemptCounts ≥ 2 from the old code would be instantly
// permanent-failed on the next runner fire — without ever seeing the
// new longer budget. Reset attemptCounts + triedThisPass once per
// migration version so every stuck account gets a fair fresh shot
// under the new constants. Permanent-fails (which were set after
// reaching the OLD cap of 10) are preserved — those are genuine
// "couldn't archive after lots of tries" signals worth keeping.
const RUNNER_STATE_MIGRATION_VERSION = "1.0.147-2-retry-cap-and-10min-budget";
async function _maybeMigrateRunnerState() {
  const { runnerStateMigrationVersion } = await chrome.storage.local.get(["runnerStateMigrationVersion"]);
  if (runnerStateMigrationVersion === RUNNER_STATE_MIGRATION_VERSION) return;
  const { archiveRunnerState } = await chrome.storage.local.get(["archiveRunnerState"]);
  if (archiveRunnerState && typeof archiveRunnerState === "object") {
    const before = {
      attempts: Object.keys(archiveRunnerState.attemptCounts || {}).length,
      tried: (archiveRunnerState.triedThisPass || []).length,
    };
    archiveRunnerState.attemptCounts = {};
    archiveRunnerState.triedThisPass = [];
    // Reset the pass number so the runner starts a clean pass too —
    // otherwise the in-memory "this pass" tracking can carry over.
    archiveRunnerState.passNumber = 1;
    await chrome.storage.local.set({ archiveRunnerState });
    console.log(`[IG Tracker] Runner state migrated to ${RUNNER_STATE_MIGRATION_VERSION} (cleared ${before.attempts} attempt counts, ${before.tried} tried-this-pass entries)`);
  } else {
    console.log(`[IG Tracker] Runner state migration: nothing to clear (no prior state)`);
  }
  await chrome.storage.local.set({ runnerStateMigrationVersion: RUNNER_STATE_MIGRATION_VERSION });
}

chrome.runtime.onInstalled.addListener(() => {
  _maybeMigrateRunnerState();
  refreshExportAlarm();
  refreshArchiveRunnerAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  _maybeMigrateRunnerState();
  refreshExportAlarm();
  refreshArchiveRunnerAlarm();
});

(async function _ensureAlarmsArmed() {
  try {
    const [sched, runner] = await Promise.all([
      chrome.alarms.get(SCHEDULE_ALARM),
      chrome.alarms.get(ARCHIVE_RUNNER_ALARM),
    ]);
    if (!sched) {
      console.log("[IG Tracker] Boot: SCHEDULE_ALARM missing, re-arming.");
      await refreshExportAlarm();
    }
    if (!runner) {
      console.log("[IG Tracker] Boot: ARCHIVE_RUNNER_ALARM missing, re-arming.");
      await refreshArchiveRunnerAlarm();
    }
  } catch (e) {
    // Defensive: if chrome.alarms.get errors, fall back to forcing
    // a re-arm. Better than the alarm silently being absent.
    console.warn("[IG Tracker] Boot alarm check failed:", e?.message || e);
    refreshExportAlarm().catch(() => {});
    refreshArchiveRunnerAlarm().catch(() => {});
  }
})();

// Orphan-cleanup pass. If a previous SW lifetime had a runner tab
// open when the extension reloaded (or Chrome crashed), the
// minimized window stays around forever — it's a normal Chrome
// window not owned by the extension. Find any tab whose URL matches
// the inFlight username with our runner hash flag, and close it.
// Also clear inFlight so the next runner cycle picks the right
// account. Combined with the marker-file resume system, this means
// dev-iteration reloads leave no stale windows AND the partial
// archive resumes naturally.
(async function _orphanRunnerCleanup() {
  try {
    const { archiveRunnerState } = await chrome.storage.local.get(["archiveRunnerState"]);
    const inFlight = archiveRunnerState?.inFlight;
    if (!inFlight) return;
    const tabs = await chrome.tabs.query({ url: `*://www.instagram.com/${encodeURIComponent(inFlight)}/*` });
    let closedCount = 0;
    for (const t of tabs) {
      if ((t.url || "").includes("igtracker-runner=archive")) {
        try { await chrome.windows.remove(t.windowId); closedCount += 1; }
        catch (_) { /* may have been closed already */ }
      }
    }
    if (closedCount > 0) {
      console.log(`[IG Tracker] Orphan cleanup: closed ${closedCount} zombie runner window(s) for @${inFlight}`);
    }
    // Clear inFlight regardless — even if the window was already
    // closed manually, the state should be reset so the next fire
    // picks a fresh account from the queue. The partial archive
    // (if any) is preserved on disk; the queue's marker-file rule
    // handles whether to re-queue.
    archiveRunnerState.inFlight = null;
    await chrome.storage.local.set({ archiveRunnerState });
  } catch (e) {
    console.warn("[IG Tracker] Orphan cleanup failed:", e?.message || e);
  }
})();

// Re-arm runner whenever its config changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.archiveRunnerOn ||
      changes.archiveRunnerIntervalMin ||
      changes.archiveRunnerMode ||
      changes.archiveRunnerGraceMin) {
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
  // Fetch a VSCO CDN URL on behalf of the content script. Content
  // scripts run in the page's origin and hit CORS when fetching
  // im.vsco.co (no Access-Control-Allow-Origin returned), but the
  // extension SW has host_permissions for *.vsco.co/* — Chrome treats
  // that as same-origin-equivalent and skips the CORS preflight check.
  // We return base64-encoded bytes so the content script can repost to
  // the local tracker via its existing /api/vsco-media-bytes endpoint.
  if (msg.type === "fetch-vsco-bytes") {
    (async () => {
      try {
        // No credentials — we want a logged-out fetch so VSCO can't
        // tie this to any account. CDN images are public anyway.
        const r = await fetch(msg.url, { credentials: "omit" });
        if (!r.ok) {
          sendResponse({ ok: false, error: `HTTP ${r.status}` });
          return;
        }
        const blob = await r.blob();
        const MAX = 30 * 1024 * 1024;
        if (blob.size > MAX) {
          sendResponse({ ok: false, error: `too large (${blob.size} bytes)` });
          return;
        }
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ ok: true, body: btoa(binary), size: blob.size });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }
  // Close the tab that sent this message. Used by the auto-archive
  // queue flow so each tab can finish its work and then ask to be
  // closed (content scripts can't close their own tab directly).
  if (msg.type === "close-my-tab") {
    const tabId = sender?.tab?.id;
    if (tabId != null) {
      // Tiny delay so the user can see "Done" before the tab vanishes
      // — same UX pattern as the wizard's post-finish close.
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
    }
    sendResponse({ ok: true });
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
  // later so the user doesn't have to reach over and kill it. Match
  // the archive runner's post-completion delay for consistency. We
  // don't close immediately because Meta sometimes fires the password
  // prompt seconds after the submit click; the password watchdog
  // (also in meta-export.js) needs the tab alive to fill it.
  // Uses chrome.alarms instead of setTimeout — MV3 service workers
  // can shut down in ~30s of idle, which kills setTimeout but
  // alarms persist and respawn the SW to fire.
  if (msg.type === "wizard-finished") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        await chrome.alarms.create(`${CLOSE_WIZARD_TAB_PREFIX}${tabId}`, {
          delayInMinutes: 1,
        });
        console.log(`[IG Tracker] Wizard finished, closing tab ${tabId} in 1 min (alarm)`);
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
          "archiveRunnerMode", "archiveRunnerGraceMin",
          "archiveRunnerHistory", "archiveRunnerLastStats",
          "archiveRunnerState",
        ]),
        chrome.alarms.get(ARCHIVE_RUNNER_ALARM).catch(() => null),
      ]);
      const st = data.archiveRunnerState || {};
      sendResponse({
        ok: true,
        on: !!data.archiveRunnerOn,
        intervalMin: Number(data.archiveRunnerIntervalMin) || ARCHIVE_RUNNER_DEFAULT_INTERVAL_MIN,
        mode: data.archiveRunnerMode === "completion" ? "completion" : "interval",
        graceMin: Number(data.archiveRunnerGraceMin) || 1,
        history: (data.archiveRunnerHistory || []).slice(-15).reverse(),
        lastStats: data.archiveRunnerLastStats || null,
        nextFireAt: alarm ? alarm.scheduledTime : null,
        passNumber: st.passNumber || 1,
        triedThisPass: st.triedThisPass || [],
        permanentFailures: st.permanentFailures || {},
        attemptCounts: st.attemptCounts || {},
      });
    })();
    return true;
  }
  // Content script signals the archive run for an account is done.
  // In completion mode this is the trigger for the next account; we
  // re-arm a one-shot alarm `graceMin` minutes out. In interval mode
  // this is informational only — the periodic alarm is what advances
  // the queue.
  // Dead-account signal from the runner content script. Fires the
  // moment we land on a profile and detect "Sorry, this page isn't
  // available" / "This account is private" (and not following) /
  // empty grid. We mark the account as permanently failed
  // immediately — no retries, no waiting for the 4-minute budget.
  // This unsticks the queue: a typo'd or banned handle moves out of
  // the way in seconds instead of blocking 8+ hours of retry cycles.
  // Manual-archive slot manager. See _loadManualArchiveState comment
  // block for design. Three message types: claim, release, cancel,
  // plus query for UI status.
  if (msg.type === "claim-archive-slot") {
    (async () => {
      const tabId = sender?.tab?.id;
      const username = (msg.username || "").trim();
      if (!tabId || !username) {
        sendResponse({ ok: false, error: "missing tab or username" });
        return;
      }
      const state = await _loadManualArchiveState();
      await _cleanupStaleManualSlots(state);
      // If this tab already owns a slot (re-entry), confirm.
      if (state.slots.find((s) => s.tabId === tabId)) {
        await _saveManualArchiveState(state);
        sendResponse({
          ok: true, granted: true, slotsActive: state.slots.length,
          slotLimit: state.limit, position: 0,
        });
        return;
      }
      // Try immediate grant.
      if (state.slots.length < state.limit) {
        state.slots.push({ tabId, username, claimedAt: Date.now() });
        await _saveManualArchiveState(state);
        sendResponse({
          ok: true, granted: true, slotsActive: state.slots.length,
          slotLimit: state.limit, position: 0,
        });
        return;
      }
      // Queue (de-dup by tabId).
      if (!state.queue.find((q) => q.tabId === tabId)) {
        state.queue.push({ tabId, username, requestedAt: Date.now() });
      }
      await _saveManualArchiveState(state);
      const position = state.queue.findIndex((q) => q.tabId === tabId) + 1;
      sendResponse({
        ok: true, granted: false, position,
        slotsActive: state.slots.length, slotLimit: state.limit,
      });
    })();
    return true;
  }
  if (msg.type === "release-archive-slot") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (!tabId) { sendResponse({ ok: false }); return; }
      const state = await _loadManualArchiveState();
      state.slots = state.slots.filter((s) => s.tabId !== tabId);
      state.queue = state.queue.filter((q) => q.tabId !== tabId);
      await _cleanupStaleManualSlots(state);
      await _grantManualSlotsAsAvailable(state);
      await _saveManualArchiveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "cancel-archive-slot") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (!tabId) { sendResponse({ ok: false }); return; }
      const state = await _loadManualArchiveState();
      state.slots = state.slots.filter((s) => s.tabId !== tabId);
      state.queue = state.queue.filter((q) => q.tabId !== tabId);
      await _grantManualSlotsAsAvailable(state);
      await _saveManualArchiveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "query-archive-slot-status") {
    (async () => {
      const state = await _loadManualArchiveState();
      sendResponse({
        ok: true,
        slotsActive: state.slots.length,
        slotLimit: state.limit,
        queueDepth: state.queue.length,
      });
    })();
    return true;
  }
  if (msg.type === "archive-runner-dead-account") {
    (async () => {
      try {
        if (!msg.username) { sendResponse({ ok: false, error: "missing username" }); return; }
        const state = await _loadArchiveState();
        // Only act if the dead account matches the one we're tracking.
        if (state.inFlight && state.inFlight === msg.username) {
          state.permanentFailures[msg.username] = {
            firstFailedAt: state.permanentFailures[msg.username]?.firstFailedAt || Date.now(),
            attempts: (state.attemptCounts[msg.username] || 0) + 1,
            reason: msg.reason || "dead_account",
          };
          delete state.attemptCounts[msg.username];
          state.triedThisPass = state.triedThisPass.filter(x => x !== msg.username);
          console.warn(`[IG Tracker] Archive runner: PERMANENT FAILURE @${msg.username} (${msg.reason || "dead_account"}, fast-fail)`);
          await _appendArchiveRunnerHistory({ ts: Date.now(), username: msg.username, status: "permanent-fail", reason: msg.reason });
          // Close the window now and advance immediately — no point
          // waiting the full 4-minute budget on a confirmed dead
          // account.
          const winToClose = state.inFlightWindowId;
          state.inFlight = null;
          state.inFlightWindowId = null;
          await _saveArchiveState(state);
          if (winToClose != null) {
            try { await chrome.windows.remove(winToClose); } catch (_) {}
            try { await chrome.alarms.clear(`${RUNNER_BUDGET_PREFIX}${winToClose}`); } catch (_) {}
          }
          await _scheduleNextRunnerFireFromCompletion("dead-account-fast-fail");
          // One push notification per dead account so the user sees
          // which handle to investigate (typo? rename? account gone?).
          try {
            const reasonLabel = ({
              account_unavailable: "page not found / banned / deactivated",
              private_not_following: "private and you don't follow",
              no_visible_content: "no visible posts or reels",
            })[msg.reason] || msg.reason || "dead account";
            await _phonePush(
              `IG Archive: @${msg.username} skipped`,
              `Reason: ${reasonLabel}. Check the handle, or unfollow it from the queue.`,
              "normal",
            );
          } catch (_) { /* push best-effort */ }
        } else {
          console.log(`[IG Tracker] archive-runner-dead-account: ignored (inFlight=${state.inFlight}, msg=${msg.username})`);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === "archive-runner-complete") {
    (async () => {
      try {
        const state = await _loadArchiveState();
        // Only act if the completing account is the one we're
        // tracking — guards against stale messages from old tabs the
        // user might still have open after a runner restart.
        if (msg.username && state.inFlight && state.inFlight === msg.username) {
          await _scheduleNextRunnerFireFromCompletion("content-script-signal");
          // Close the runner window 1 minute after completion. Gives
          // the page time to flush any in-flight media saves the
          // content script may have queued without forcing the user
          // to wait the full 4-minute budget. Captures the window id
          // by value so a subsequent fire setting a new inFlight
          // doesn't shift the close target. Uses chrome.alarms so
          // the close survives an MV3 service-worker shutdown
          // during the 1-minute wait.
          const winToClose = state.inFlightWindowId;
          if (winToClose != null) {
            await chrome.alarms.create(`${CLOSE_RUNNER_WIN_PREFIX}${winToClose}`, {
              delayInMinutes: 1,
            });
            console.log(`[IG Tracker] Archive runner: scheduled @${msg.username} window close in 1 min (alarm)`);
          }
        } else {
          console.log(`[IG Tracker] archive-runner-complete: ignored (inFlight=${state.inFlight}, msg=${msg.username})`);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  // Manual queue add/remove via existing /api/tags need_archive flag.
  // Popup posts here; SW relays to local server (no CORS).
  if (msg.type === "archive-queue-add") {
    (async () => {
      const { trackerUrl } = await chrome.storage.local.get(["trackerUrl"]);
      const base = (trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
      const username = (msg.username || "").trim().replace(/^@/, "");
      if (!username) { sendResponse({ ok: false, error: "missing username" }); return; }
      try {
        const r = await fetch(`${base}/api/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, flag: "need_archive", value: true }),
        });
        const j = await r.json().catch(() => ({}));
        sendResponse({ ok: r.ok, body: j });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  // "Run now" buttons — manually trigger the next scheduled fire of
  // the export wizard or the archive runner without waiting for the
  // alarm. Same code path as the alarm fire, then re-arms the alarm
  // so the next auto-run happens `interval` minutes from NOW (not
  // from the original schedule, which would otherwise double-fire
  // shortly after).
  //
  // No-op (with error) if a run is already in flight, to avoid
  // overlap and respect the existing concurrency model.
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
  if (msg.type === "archive-runner-fire-now") {
    (async () => {
      try {
        const state = await _loadArchiveState();
        if (state.inFlight) {
          sendResponse({ ok: false, error: `Archive runner is already in flight on @${state.inFlight}.` });
          return;
        }
        await _appendArchiveRunnerHistory({ ts: Date.now(), status: "triggered-now" });
        await _onArchiveRunnerFire({ manual: true });
        // Re-anchor the alarm so the next auto-fire is `interval`
        // minutes from now, not from the previously-armed time.
        await refreshArchiveRunnerAlarm();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  // Clear permanent-fail flag for a username so it gets re-queued.
  if (msg.type === "archive-runner-retry-permanent") {
    (async () => {
      const username = (msg.username || "").trim();
      const state = await _loadArchiveState();
      if (state.permanentFailures[username]) {
        delete state.permanentFailures[username];
        // Reset attempt count so they get the full 10-try budget again.
        delete state.attemptCounts[username];
        await _saveArchiveState(state);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not in permanent failures" });
      }
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
