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
