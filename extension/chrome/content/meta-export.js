// Auto-fills Meta's "Download or transfer your information" wizard with
// the saved preferences (JSON, followers + following only, all time, Google
// Drive). Runs only when the popup explicitly requested an auto-export
// (chrome.storage.local.wizardRunRequested timestamp set in the last
// five minutes) so the user can still navigate the page manually without
// it taking over.
//
// Approach: at each step we describe the click as a target (button text,
// label content, or aria-label) and let a polling loop find and click it.
// Meta changes the underlying class names regularly, but the visible text
// they use ("Create export", "Next", "Save", category names) is stable.
//
// Per-step waits use both DOM-mutation observation and polling (max 10s
// per step) so we tolerate slow renders without spinning forever.

const STEP_TIMEOUT_MS = 15000;
// Time we wait after every click for the page to react. Bumped to
// 1100ms with 0-400ms jitter so the cadence isn't fixed — slower
// connections (or post-OAuth landing) need extra breathing room
// before we try to click the next screen, and a metronomic pattern
// is exactly what anti-automation looks for.
const SETTLE_MS_MIN = 1100;
const SETTLE_MS_JITTER = 400;
async function _settle() {
  // Check for user-initiated stop before settling, so a Stop click
  // aborts the wizard at the next step boundary rather than running
  // through to completion.
  await _abortIfStopped();
  const ms = SETTLE_MS_MIN + Math.random() * SETTLE_MS_JITTER;
  await new Promise((r) => setTimeout(r, ms));
}
// Backwards-compat constant some callers still reference.
const SETTLE_MS = SETTLE_MS_MIN;
// Wait budgets after a click. Pulled up from 9s/18s — Meta's slower
// transitions (especially post-OAuth, where the page might still be
// processing the auth code) needed longer windows.
const WAIT_AFTER_CLICK_MS = 14000;
const WAIT_AFTER_CONNECT_MS = 30000;

// Fast-fail if no recent run request — user might just be on the page
// for other reasons (e.g. checking past exports).
//
// Don't consume the flag here — the OAuth redirect navigates the tab
// out and back, and the wizard needs to resume on the Confirm screen
// after that. Auto-expire after 20 minutes so a stale flag doesn't
// auto-run the wizard on later visits, but slow OAuth + Drive consent
// flows (Google chooser → consent → token exchange → tyi/ landing)
// still get to resume — those can take 8-12 minutes when Google asks
// for re-auth or a 2FA challenge. consumeWizardFlag() is called when
// the wizard reaches Start export (terminal step).
//
// Tab-binding: wizardRunRequested is now {ts, tabId}. When the popup
// (or scheduler) opens the wizard, it tags the flag with the new
// tab's id so other wizard tabs the user happens to open within the
// run window don't auto-fill. The legacy bare-number form is still
// honored for backwards compatibility (older popup versions, or a
// stored value from before the upgrade).
async function _myTabId() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "get-tab-id" }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp?.tabId ?? null);
      });
    } catch { resolve(null); }
  });
}
function _runFlagAge(flag) {
  if (!flag) return Infinity;
  if (typeof flag === "number") return Date.now() - flag;
  if (typeof flag === "object" && flag.ts) return Date.now() - flag.ts;
  return Infinity;
}
function _runFlagTabId(flag) {
  if (flag && typeof flag === "object") return flag.tabId ?? null;
  return null; // legacy number form has no tab binding
}
async function shouldRun() {
  const stored = await chrome.storage.local.get(["wizardRunRequested"]);
  const flag = stored.wizardRunRequested;
  if (!flag) return false;
  const age = _runFlagAge(flag);
  if (age > 20 * 60 * 1000) {
    await chrome.storage.local.set({ wizardRunRequested: 0 });
    return false;
  }
  // Tab-binding check. If the flag has a tabId, only the matching
  // tab is allowed to auto-fill. If it doesn't (legacy number form),
  // any tab is allowed — preserves old behavior on a stale flag.
  const taggedTabId = _runFlagTabId(flag);
  if (taggedTabId != null) {
    const myId = await _myTabId();
    if (myId != null && myId !== taggedTabId) {
      console.log(`[IG Tracker] shouldRun: flag is bound to tab ${taggedTabId}, this is tab ${myId} — skipping auto-fill`);
      return false;
    }
  }
  return true;
}

async function consumeWizardFlag() {
  await chrome.storage.local.set({ wizardRunRequested: 0 });
}

// Per-step abort check. The popup's "Stop" button clears
// wizardRunRequested; if it's gone (or zeroed) while we're mid-run,
// throw to short-circuit the wizard. Called from _settle() so it
// runs between every step without the per-step code needing to
// know about cancellation.
async function _abortIfStopped() {
  const stored = await chrome.storage.local.get(["wizardRunRequested"]);
  const flag = stored.wizardRunRequested;
  if (!flag) {
    throw new Error("Export stopped by user");
  }
  // Treat zeroed legacy form (=0) as "stopped" too.
  if (typeof flag === "number" && flag === 0) {
    throw new Error("Export stopped by user");
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Look for an element matching a predicate, polling every 200ms up to timeout.
async function waitFor(predicate, { timeout = STEP_TIMEOUT_MS, label = "" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const result = predicate();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// Find a clickable element whose visible text matches `text`.
//
// Strategy: walk every element in the document, find the LEAF whose
// direct text content (ignoring descendants) equals the target. Then
// walk up its ancestors to the nearest clickable element (button,
// role=button|radio|checkbox|menuitem, tabindex >=0, or cursor:pointer).
// This handles Meta's deeply-nested div-based UI without needing to
// guess which level has the role attribute.
function _isClickable(el) {
  if (!el || el === document.body) return false;
  if (el.tagName === "BUTTON" || el.tagName === "A") return true;
  const role = el.getAttribute && el.getAttribute("role");
  if (role && /^(button|radio|checkbox|menuitem|menuitemradio|menuitemcheckbox|tab|option|link)$/.test(role)) {
    return true;
  }
  if (el.tabIndex !== undefined && el.tabIndex >= 0) return true;
  try {
    if (getComputedStyle(el).cursor === "pointer") return true;
  } catch (_) {}
  return false;
}

// Walk up to the nearest interactive ancestor. Returns null when the
// element has no clickable ancestor within 10 levels — callers should
// then try the next match. The previous "fall back to the original
// element" behavior caused .click() to fire on plain text nodes (e.g.
// the page <h2>Create export</h2>) which is a silent no-op and made the
// wizard appear to advance when it hadn't.
function _climbToClickable(el) {
  let cur = el;
  for (let i = 0; cur && cur !== document.body && i < 10; i++) {
    if (_isClickable(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Walk up looking for the smallest ancestor that contains a toggle
// (checkbox / radio / switch). Used by findRowByLabel for the
// Customize Information screen, where the label and the toggle are
// siblings rather than the toggle being an ancestor of the label.
// checkLabel() then queries inside the returned row for the toggle.
function _climbToRow(el) {
  const TOGGLE_SEL = "[role='checkbox'], [role='radio'], [role='switch'], " +
                     "input[type='checkbox'], input[type='radio']";
  let cur = el;
  for (let i = 0; cur && cur !== document.body && i < 10; i++) {
    if (cur.querySelector && cur.querySelector(TOGGLE_SEL)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Filter out elements that are in the DOM but not actually rendered.
// Meta animates wizard transitions by leaving the previous step's
// elements in place for ~200ms while sliding them out, so a naive text
// match can grab a hidden "Next" button from the previous screen and
// click it (no-op), then proceed past a step that never actually
// advanced.
function _isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") < 0.05) return false;
  } catch (_) {}
  return true;
}

function _directText(el) {
  // Concatenated text of direct child text nodes only (ignore deeply
  // nested descendants). Catches the case where Meta wraps a label in
  // its own <span> next to a description in a sibling <span>.
  let out = "";
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
  }
  return out.trim();
}

function findByText(text, within = document) {
  // Two-sweep search. First sweep is strict: each match must have a
  // clickable ancestor (button / role=button / tabindex / cursor). This
  // is what we want when the page has BOTH a heading and a real button
  // with the same text — the button wins.
  // Second sweep is lenient: any visible element whose text matches is
  // returned. The synthesized click event still bubbles to ancestor
  // handlers, so it works when Meta renders interactive rows without
  // accessibility markers (no role, no tabindex, no cursor:pointer set
  // directly).
  return _findByText(text, within, false) || _findByText(text, within, true);
}

function _findByText(text, within, lenient) {
  const target = String(text).trim().toLowerCase();
  if (!target) return null;
  const all = within.querySelectorAll("*");
  const tryReturn = (el) => {
    const c = _climbToClickable(el);
    if (c && _isVisible(c)) return c;
    if (lenient && _isVisible(el)) return el;
    return null;
  };
  // Pass 1: a leaf node whose direct text equals the target — this is
  // typically the <span> inside a row that holds just "Google Drive"
  // or "JSON".
  for (const el of all) {
    if (_directText(el).toLowerCase() !== target) continue;
    const r = tryReturn(el); if (r) return r;
  }
  // Pass 2: any element whose total textContent equals the target.
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t !== target) continue;
    const r = tryReturn(el); if (r) return r;
  }
  // Pass 3: an element whose first line equals the target (rich rows
  // like "Google Drive\nAll available information").
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (!t) continue;
    const firstLine = t.split(/\n|·|·/)[0].trim();
    if (firstLine !== target || t.length >= 300) continue;
    const r = tryReturn(el); if (r) return r;
  }
  // Pass 4: substring match in a reasonably-bounded element.
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (!t.includes(target)) continue;
    if (t.length >= Math.max(target.length + 80, 120)) continue;
    const r = tryReturn(el); if (r) return r;
  }
  return null;
}

// Find the parent row containing a label.
//
// Same robustness approach as findByText: walk every element, find the
// LEAF whose direct text equals the target, then climb up to the
// nearest clickable ancestor (which is the row we want to click). The
// older first-line approach failed when Meta wrapped the label in
// multiple span layers — the parent's first line was empty whitespace
// or the screen-reader hint, not the visible label.
function findRowByLabel(text, within = document) {
  // Strict sweep first (clickable ancestor or row-with-toggle), then
  // lenient sweep (any visible matching element). See findByText for
  // why the lenient pass exists.
  return _findRowByLabel(text, within, false) || _findRowByLabel(text, within, true);
}

function _findRowByLabel(text, within, lenient) {
  const target = String(text).trim().toLowerCase();
  if (!target) return null;
  const all = within.querySelectorAll("*");
  // Three-tier: prefer a clickable ancestor (Format / Date range / etc.
  // — the whole row IS the click target). Else a container that wraps
  // a toggle (Customize Information items, where the label and
  // checkbox are siblings). Else, in lenient mode, the element itself.
  const tryReturn = (el) => {
    const clickable = _climbToClickable(el);
    if (clickable && _isVisible(clickable)) return clickable;
    const row = _climbToRow(el);
    if (row && _isVisible(row)) return row;
    if (lenient && _isVisible(el)) return el;
    return null;
  };

  // Pass 0: aria-label exact match. Meta puts the row's label on the
  // outer interactive div for accessibility — strongest signal.
  for (const el of all) {
    if (!el.getAttribute) continue;
    const al = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (al !== target) continue;
    const r = tryReturn(el); if (r) return r;
  }

  // Pass 1: leaf node with direct text equal to target.
  for (const el of all) {
    if (_directText(el).toLowerCase() !== target) continue;
    const r = tryReturn(el); if (r) return r;
  }

  // Pass 2: any element whose total textContent first line is the
  // target. Bound length to avoid returning the whole page wrapper.
  // 500-char bound generous enough for "Format\nHTML\nThis format
  // allows you to import your data into another site or app." (~80
  // chars) plus padding for surrounding rows that get included in
  // textContent walks.
  const collected = [];
  for (const el of all) {
    const t = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (!t) continue;
    const firstLine = t.split(/\n|·|·/)[0].trim();
    if (firstLine === target && t.length < 500 && _isVisible(el)) {
      collected.push({ el, length: t.length });
    }
  }
  if (collected.length) {
    // Smallest match = most specific (the row itself, not its container).
    collected.sort((a, b) => a.length - b.length);
    const r = tryReturn(collected[0].el);
    if (r) return r;
  }

  // Pass 3: starts-with match for "Format HTML"-style single-line rows.
  for (const el of all) {
    const t = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (!t) continue;
    const firstLine = t.split(/\n|·|·/)[0].trim();
    if (firstLine.startsWith(target + " ") && t.length < 500) {
      const r = tryReturn(el); if (r) return r;
    }
  }

  // Diagnostic: log up to 3 elements that contain the target as a
  // substring so the user / dev can see what Meta is actually
  // rendering. Helps when the matcher fails on a new Meta layout.
  const debug = [];
  for (const el of all) {
    const t = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (t.includes(target) && t.length < 1000 && debug.length < 3) {
      debug.push({ tag: el.tagName, role: el.getAttribute && el.getAttribute("role"),
                   firstLine: t.split("\n")[0].slice(0, 80), len: t.length });
    }
  }
  if (debug.length) {
    // JSON.stringify so the diagnostic survives copy-paste from the console
    // (Chrome's "Copy message" renders raw objects as [object Object]).
    console.warn(
      `[IG Tracker] findRowByLabel('${text}') failed. Closest candidates: ` +
      JSON.stringify(debug)
    );
  }
  return null;
}

// Detect which wizard screen we're currently on. Used to make runWizard()
// idempotent across the OAuth redirect — when Meta sends us out to
// accounts.google.com and back, the content script reloads from scratch,
// and we need to jump straight to the Confirm screen instead of replaying
// "Create export" → "Export to external service" → "Google Drive" etc.
// Page-text excluding the panels we inject. Reads ALL of body, not
// just <main>, because Meta renders dialog/modal screens (Confirm
// your export, manage requests, etc.) via React Portals — those land
// as siblings of <main> directly under <body>. An earlier <main>-only
// implementation missed all modal content; detection saw the sidebar
// landing text under <main> and classified the page as 'start' even
// when a confirm-export modal was open, so the start handler ran
// against page elements whose actual click target lived in the
// modal it couldn't see.
//
// We walk body.children, skipping our injected nodes (status panel,
// manual prompt, toast) so they don't contaminate detection. Result
// is what the user actually sees, modal included.
const _IGT_INJECTED_IDS = new Set([
  "igtracker-export-status",
  "igtracker-manual-prompt",
  "igtracker-toast",
]);
function _wizardPageText() {
  const body = document.body;
  if (!body) return "";
  let out = "";
  for (const child of Array.from(body.children)) {
    if (_IGT_INJECTED_IDS.has(child.id)) continue;
    out += (child.innerText || "") + "\n";
  }
  return out;
}

async function detectCurrentScreen(timeoutMs = 3000) {
  // Poll until we recognize a screen or the window elapses.
  // We match against page heading phrases that only appear on one
  // specific wizard step, and order from most-distinctive to most-
  // general so partial-overlap pages don't get misclassified (e.g.,
  // the Accounts Center sidebar contains the word "Connected" — that
  // shouldn't pull howOften into the connect bucket).
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const text = _wizardPageText().toLowerCase();

    // Confirm screen: has multiple editable rows on a single page.
    if (text.includes("date range") && text.includes("customize information")) {
      return "confirm";
    }
    // How-often screen: distinctive heading.
    if (text.includes("choose how often") ||
        text.includes("how often you want to export")) {
      return "howOften";
    }
    // Connect screen: explicit "Connect to Google Drive" heading/CTA.
    if (text.includes("connect to google drive")) {
      return "connect";
    }
    // Manage-requests start screen: the May 2026 layout shows a
    // tabbed "Current activity / Past activity" view with a
    // "Create export" CTA. Identifying this before chooseService
    // is critical — the existing-request descriptions inside this
    // modal say "Google Drive", which would otherwise trip the
    // chooseService matcher's (google drive && dropbox) fallback.
    if (text.includes("current activity") &&
        text.includes("past activity") &&
        text.includes("create export")) {
      return "start";
    }
    // Service-selection screen: list of providers (Google Drive, Dropbox, …).
    if (text.includes("choose an external service") ||
        text.includes("choose external service") ||
        (text.includes("google drive") && text.includes("dropbox"))) {
      return "chooseService";
    }
    // Where screen: distinctive heading "Choose where to export". Older
    // variants surfaced the option labels themselves in body text
    // ("Export to external service" + "Download to your device") — keep
    // those as a fallback so old rollouts still detect.
    if (text.includes("choose where to export") ||
        text.includes("where do you want to export") ||
        (text.includes("export to external service") &&
         text.includes("download to your device"))) {
      return "chooseWhere";
    }
    // Start screen — last resort, runs after all the more-specific
    // wizard screens have been ruled out. Three variants seen in the
    // wild as of May 2026:
    //
    //   (a) Legacy: a standalone "Create export" CTA on /dyi/
    //   (b) Mid-2026: a "Download or transfer your information" tile
    //   (c) Late May 2026: an Accounts Center landing where /dyi/
    //       shows the sidebar + a tile labeled "Export your
    //       information" — clicking it deep-links into the wizard.
    //
    // The matchers below cover all three; the click handler tries
    // multiple CTAs (including "Export your information" as the
    // tile's label for variant c).
    if (text.includes("create export") ||
        text.includes("download or transfer your information") ||
        text.includes("export your information")) {
      return "start";
    }
    await sleep(300);
  }
  return "unknown";
}

// Click an element with a full pointer/mouse event sequence. Most
// React handlers want pointerdown/up + mousedown/up to look like a
// real interaction. We then fire a SINGLE click via el.click() so
// the click event is "trusted" and we don't double-dispatch — an
// earlier version dispatched both a synthetic click event AND
// el.click(), which made server actions like "Start export" submit
// twice and queue two exports.
function clickElement(el) {
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: x, clientY: y, button: 0,
  };
  try { el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" })); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  try { el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" })); } catch (_) {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  try { el.click(); } catch (_) {
    // el.click() can fail on some non-button elements; fall back to a
    // synthesized click event in that case so we don't silently no-op.
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  return true;
}

// Trusted-click via chrome.debugger. Synthetic clicks (the function
// above) carry isTrusted=false, which Meta's wizard React components
// silently reject. The chrome.debugger API in the SW dispatches
// Input.dispatchMouseEvent commands from the browser side, producing
// events that arrive at the page with isTrusted=true — the only way
// to bypass Meta's gates without a native automation framework.
//
// On failure (debugger attach blocked because DevTools is open, no
// tab id, etc.) we fall back to clickElement(). Many of the wizard's
// non-gated screens still work fine with synthetic events, so the
// fallback isn't lost work.
async function _trustedClick(el) {
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  // Brief pause so layout settles after scroll — coords would be off
  // if we read getBoundingClientRect mid-scroll.
  await new Promise((r) => setTimeout(r, 80));
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    console.log("[IG Tracker] trusted-click: element has zero size, falling back");
    return clickElement(el);
  }
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  // Coords are viewport (page-relative-to-visible). Send to SW for
  // dispatch via chrome.debugger.
  const resp = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "trusted-click", x, y }, (r) => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(r || { ok: false, error: "no response" });
      });
    } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });
  if (resp.ok) return true;
  console.log(`[IG Tracker] trusted-click failed (${resp.error}) — falling back to synthetic`);
  return clickElement(el);
}

// Compact summary of an element for diagnostic logs. Useful when a
// click looked like it should have advanced the wizard but didn't —
// shows what we actually targeted so we can tell whether the matcher
// grabbed the wrong element or the click silently failed.
function _describe(el) {
  if (!el) return "null";
  const role = el.getAttribute && el.getAttribute("role");
  const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50);
  return `<${el.tagName.toLowerCase()}${role ? ` role=${role}` : ""}> "${txt}"`;
}

// Main flow. Stage 1 (Create export → Connect) is driven by a screen-
// detection loop: at each iteration we ask "what screen are we on right
// now?" and click the right thing for that screen. This is robust to
// Meta's animated transitions (the previous step's button can linger
// in the DOM) and to OAuth-related re-entry — when the post-redirect
// run starts on Confirm, we drop straight into Stage 2.
//
// Stage 2 (Confirm screen) runs sequentially since each row click leads
// directly back to Confirm with the field set.
// Wait until detectCurrentScreen returns something different from
// `prevScreen`. Returns the new screen name. If the timeout elapses
// while still on the same screen, returns the same `prevScreen`.
async function waitForScreenChange(prevScreen, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(400);
    const now = await detectCurrentScreen();
    if (now !== prevScreen) return now;
  }
  return prevScreen;
}

// Keep-tab-awake bundle. Chrome aggressively throttles JavaScript in
// background tabs (1s timer minimum, suspended rAF, etc.), which
// breaks the wizard's pacing when the user switches away. Three
// tricks stacked:
//   1. Override the Page Visibility API so the page itself never sees
//      "hidden". Doesn't unthrottle Chrome timers, but stops Meta's
//      own React lazy-render from kicking in.
//   2. Suppress visibilitychange events that pages listen for.
//   3. AudioContext at near-zero gain — Chrome treats tabs with
//      running audio as audible, which exempts them from timer
//      throttling. Autoplay policy requires a user gesture, so we
//      arm it on the first user click; once started it survives tab
//      switches.
function _initKeepAwake() {
  if (window.__igtKeepAlive) return;
  window.__igtKeepAlive = true;
  try {
    Object.defineProperty(document, "hidden",          { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "webkitHidden",          { configurable: true, get: () => false });
    Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
  } catch (_) { /* some browsers reject re-defining */ }
  document.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), { capture: true });
  document.addEventListener("webkitvisibilitychange", (e) => e.stopImmediatePropagation(), { capture: true });
  // Don't create the AudioContext here — Chrome's autoplay policy
  // requires a real user gesture for both construction and resume().
  // _armKeepAwake() lazy-creates on the first gesture-tied call.
  //
  // Only attempt arming on TRUSTED events (e.isTrusted=true) — i.e.
  // events the user actually performed in the browser. Synthetic
  // clicks dispatched by our own clickElement() during the wizard
  // run would otherwise trigger arming, fail the autoplay check,
  // and spam the console with "AudioContext was not allowed to
  // start" warnings on every wizard click.
  const tryArm = (e) => { if (e.isTrusted) _armKeepAwake().catch(() => {}); };
  document.addEventListener("click",        tryArm, { capture: true });
  document.addEventListener("keydown",      tryArm, { capture: true });
  document.addEventListener("pointerdown",  tryArm, { capture: true });
  _updateWizardAwakeIndicator();
}
async function _armKeepAwake() {
  // Lazy-create on first gesture. Chrome's autoplay policy treats
  // AudioContext construction as a media-output operation; it has
  // to happen inside (or after) a user gesture or it throws.
  if (!window.__igtKeepAliveCtx) {
    try {
      const Cls = window.AudioContext || window.webkitAudioContext;
      if (!Cls) return false;
      const ctx = new Cls();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      window.__igtKeepAliveCtx = ctx;
      try { ctx.addEventListener("statechange", _updateWizardAwakeIndicator); } catch (_) {}
      console.log(`[IG Tracker] keepalive: AudioContext lazy-created, state=${ctx.state}`);
    } catch (e) {
      console.log("[IG Tracker] keepalive: lazy-create failed:", e.message);
      _updateWizardAwakeIndicator();
      return false;
    }
  }
  const ctx = window.__igtKeepAliveCtx;
  if (!ctx) return false;
  if (ctx.state === "running") return true;
  try {
    await ctx.resume();
    console.log(`[IG Tracker] keepalive: ARMED, AudioContext state=${ctx.state}`);
    _updateWizardAwakeIndicator();
    return ctx.state === "running";
  } catch (e) {
    console.log("[IG Tracker] keepalive: resume failed:", e.message);
    _updateWizardAwakeIndicator();
    return false;
  }
}

async function runWizard() {
  console.log("[IG Tracker] Auto-export starting…");
  _initKeepAwake();
  _setStatus({ state: "running", step: "Stage 1: navigating wizard", detail: "Detecting current screen…" });

  // Stage 1: at each iteration, detect the current screen, click the
  // right thing, then explicitly wait for the screen to advance before
  // looping. The explicit wait prevents the "click again before the
  // first click took effect" pattern that was making the loop appear
  // to spin without progress.
  let stuckCount = 0;
  for (let i = 0; i < 12; i++) {
    // First iteration after a page load — give the page much longer
    // to render. Post-OAuth re-entry on the tyi/?code=… URL can stay
    // "loading" for 20-30s while Meta exchanges the OAuth code for a
    // Drive token before painting the Confirm screen.
    const initialTimeout = (i === 0) ? 25000 : 4000;
    const screen = await detectCurrentScreen(initialTimeout);
    console.log(`[IG Tracker] Step ${i}: screen=${screen}`);
    _setStatus({ step: `Step ${i}: ${screen}`, detail: "" });

    if (screen === "confirm") break;

    if (screen === "unknown") {
      if (i === 0) {
        // Page is still loading. Try multiple slower retries before
        // giving up. Each retry waits longer so a really slow
        // post-OAuth landing eventually catches.
        for (let retry = 1; retry <= 3; retry++) {
          const waitMs = 5000 + retry * 3000; // 8s, 11s, 14s
          console.log(`[IG Tracker] Screen unknown — retry ${retry}/3 after ${waitMs}ms wait`);
          await sleep(waitMs);
          const probe = await detectCurrentScreen(10000);
          if (probe !== "unknown") {
            console.log(`[IG Tracker] Settled to screen=${probe} after ${retry} retries.`);
            // Restart the outer loop with the known screen. For
            // probe=="confirm" the outer loop's `if (screen === "confirm") break;`
            // exits Stage 1 and falls through to Stage 2 (the row
            // editing). The previous `return` here was a bug — it
            // skipped Stage 2 entirely on post-OAuth confirm
            // landings, leaving the export with Meta defaults
            // (HTML / Last year / All available information) instead
            // of the user's saved settings.
            i = -1; // restart loop with known screen
            break;
          }
        }
        if (i !== -1) {
          // Couldn't identify the screen after all retries. Capture
          // diagnostics: text snippet, DOM size, button/input counts,
          // page title. Lets us tell whether the page is actually
          // empty (Meta's OAuth exchange stalled / failed) or has
          // content we just can't classify.
          // Use the panel-excluding text reader for the same reason
          // detectCurrentScreen does — otherwise the snippet shows
          // our own status panel ("⏵ IG Export running…") instead of
          // the actual wizard content.
          const snippet = _wizardPageText().slice(0, 200).replace(/\s+/g, " ");
          const htmlLen = document.body?.outerHTML?.length || 0;
          const btnCount = document.querySelectorAll("button, [role='button']").length;
          const inputCount = document.querySelectorAll("input").length;
          console.warn(
            `[IG Tracker] Couldn't identify starting screen. ` +
            `text="${snippet}", html=${htmlLen}b, buttons=${btnCount}, inputs=${inputCount}, ` +
            `title="${document.title}", url="${window.location.href.slice(0, 120)}"`
          );

          // Auto-reload escape hatch. Two stuck-page conditions both
          // recover by reloading:
          //
          // (a) Post-OAuth redirect with empty body: Meta's auth
          //     exchange stalled. Drop the code/state params before
          //     reload so Meta starts fresh instead of replaying a
          //     used code.
          // (b) Direct landing on the wizard URL but Meta rendered
          //     the Accounts Center shell instead of the wizard
          //     (innerText empty, DOM huge, title is "Account
          //     settings | Meta"). Meta's SPA sometimes fails to
          //     deep-link into the wizard subview on first paint —
          //     a plain reload usually paints the wizard correctly.
          //
          // Both gated by a per-tab session flag so we never loop.
          const urlHasOAuthCode =
            window.location.search.includes("code=") &&
            window.location.search.includes("state=");
          const pageIsBlank = htmlLen < 5000 || (snippet === "" && btnCount < 3);
          const alreadyReloaded = sessionStorage.getItem("igtracker_oauth_reloaded") === "1";
          // Stuck-shell signal: empty visible text but lots of HTML +
          // some buttons (i.e., shell rendered, wizard didn't).
          const stuckShell = snippet === "" && htmlLen > 100000 && btnCount > 0;

          if (urlHasOAuthCode && pageIsBlank && !alreadyReloaded) {
            console.warn("[IG Tracker] Empty page after OAuth redirect — auto-reloading to clean URL");
            sessionStorage.setItem("igtracker_oauth_reloaded", "1");
            // Strip the OAuth params so Meta starts fresh instead of
            // re-attempting to exchange a now-used code.
            const cleanUrl = window.location.origin + window.location.pathname;
            window.location.replace(cleanUrl);
            return;
          }
          if (stuckShell && !alreadyReloaded) {
            console.warn("[IG Tracker] Wizard URL loaded but shell-only (no wizard) — reloading once");
            sessionStorage.setItem("igtracker_oauth_reloaded", "1");
            window.location.reload();
            return;
          }

          throw new Error("Couldn't identify starting screen.");
        }
        continue;
      }
      console.log("[IG Tracker] Screen unknown — likely OAuth in progress. Bailing; will resume on next page load.");
      return;
    }

    if (screen === "start") {
      // The May 2026 layout makes start a TWO-STEP flow:
      //   1. Click a tile / link in the Accounts Center landing
      //      ("View or export your information", "Export your
      //      information", etc.) — opens a "Create export" modal.
      //   2. Click "Create export" inside the modal — actually
      //      starts the wizard and navigates to chooseWhere.
      // Older layouts skipped step 1 (Create export was right on
      // /dyi/), so we handle both: if Create export is already
      // visible we go straight to step 2; otherwise we run step 1
      // first and then step 2.
      //
      // The advancement signal is "did chooseWhere appear?" — a much
      // more specific phrase than 'started page no longer has
      // initial text', which was breaking before because the modal
      // overlays the body and the body still contains start phrases.
      const navCandidates = [
        "View or export your information",
        "Get started",
        "Export your information",
        "Download or transfer your information",
      ];
      const hasCreateExport = () => !!findByText("Create export");
      const advancedPastStart = () => {
        const t = _wizardPageText().toLowerCase();
        return t.includes("choose where to export") ||
               t.includes("where do you want to export") ||
               (t.includes("export to external service") &&
                t.includes("download to your device")) ||
               t.includes("choose how often") ||
               t.includes("choose an external service") ||
               (t.includes("google drive") && t.includes("dropbox")) ||
               t.includes("date range");
      };
      let advanced = false;

      // Step 1: open the Create-export modal if it isn't already open.
      if (!hasCreateExport()) {
        console.log("[IG Tracker] start: step 1 — opening wizard modal");
        for (const lbl of navCandidates) {
          const el = findByText(lbl);
          if (!el) continue;
          let cur = el;
          for (let level = 0; level < 6; level++) {
            if (!cur || cur === document.body) break;
            console.log(`[IG Tracker] start: nav click "${lbl}" L${level} → ${_describe(cur)}`);
            await _trustedClick(cur);
            await sleep(700);
            if (hasCreateExport() || advancedPastStart()) {
              console.log(`[IG Tracker] start: modal opened (or skipped to next screen) after "${lbl}" L${level}`);
              break;
            }
            cur = cur.parentElement;
          }
          if (hasCreateExport() || advancedPastStart()) break;
        }
      }

      // Step 2: click "Create export" inside the modal.
      if (advancedPastStart()) {
        advanced = true;
      } else if (hasCreateExport()) {
        console.log("[IG Tracker] start: step 2 — clicking Create export");
        const ce = findByText("Create export");
        if (ce) {
          let cur = ce;
          for (let level = 0; level < 6; level++) {
            if (!cur || cur === document.body) break;
            console.log(`[IG Tracker] start: Create-export click L${level} → ${_describe(cur)}`);
            await _trustedClick(cur);
            await sleep(800);
            if (advancedPastStart()) {
              advanced = true;
              console.log(`[IG Tracker] start: advanced past start after Create-export L${level}`);
              break;
            }
            cur = cur.parentElement;
          }
        }
      }

      if (!advanced) {
        console.warn("[IG Tracker] start: auto-attempts exhausted — manual fallback");
        const detail = hasCreateExport()
          ? "Click the blue 'Create export' button — the rest will resume automatically."
          : "Click the 'Export your information' tile — the rest will resume.";
        _setStatus({
          state: "needs-help",
          step: "👆 Manual step needed",
          detail,
        });
        _showManualPrompt();
        const t0 = Date.now();
        while (Date.now() - t0 < 5 * 60 * 1000) {
          await sleep(1500);
          await _abortIfStopped();
          if (advancedPastStart()) {
            console.log("[IG Tracker] start: user advanced manually, resuming");
            _hideManualPrompt();
            _setStatus({ state: "running", step: "Resuming…", detail: "Picking up from here." });
            advanced = true;
            break;
          }
        }
        if (!advanced) {
          _hideManualPrompt();
          throw new Error("Manual start timed out");
        }
      }
    } else if (screen === "chooseWhere") {
      await stepClickAny([
        "Export to external service",
        "Send to destination",
        "Send to a destination",
        "Transfer to a destination",
        "External service",
        "To an external service",
      ]);
    } else if (screen === "chooseService") {
      await stepClickAny(["Google Drive", "Drive", "Google"]);
      await _settle();
      await stepClickAny(["Next", "Continue"]);
    } else if (screen === "howOften") {
      // "Choose how often" has 4 pill toggles: Once / Daily / Monthly
      // / Yearly. Meta ships the selected state via CSS classes that
      // don't always reflect into aria-pressed/aria-checked, so the
      // earlier "is Once selected?" detection was unreliable.
      //
      // Instead, drive off the actual blocker: the Next button. If
      // Next is enabled we're good — just advance. If Next is
      // disabled, we need a frequency selected. Try Once; re-check;
      // if Next is STILL disabled (we either missed the click or
      // deselected a preselected pill), click Once again to land on
      // a definite selected state.
      const findNextBtn = () => findByText("Next") || findByText("Continue");
      const nextDisabled = () => {
        const n = findNextBtn();
        if (!n) return true;
        let cur = n;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          if (!cur.getAttribute) continue;
          if (cur.getAttribute("aria-disabled") === "true") return true;
          if (cur.disabled === true) return true;
        }
        try {
          const cs = getComputedStyle(n);
          if (cs.pointerEvents === "none") return true;
          if (parseFloat(cs.opacity || "1") < 0.5) return true;
        } catch (_) {}
        return false;
      };
      const findOnce = () => {
        for (const lbl of ["Just once", "Only once", "One time", "Once"]) {
          const el = findByText(lbl);
          if (el) return { el, lbl };
        }
        return null;
      };

      const dStart = nextDisabled();
      console.log(`[IG Tracker] howOften: entry — Next disabled=${dStart}, found="${_describe(findNextBtn())}"`);
      if (!dStart) {
        console.log("[IG Tracker] howOften: Next already enabled — advancing");
      } else {
        // Walk up parents and click each level until Next actually
        // enables. Diagnostic in the v1.0.64 log showed the matcher
        // returning a leaf <span> "Once" — clicking it bubbles but
        // React's pill onClick is on a deeper ancestor that the leaf
        // span isn't a descendant of in the React fiber tree (or the
        // pill's handler doesn't bind to bubbled clicks). Walking the
        // ancestor chain and clicking each one in turn is the
        // brute-force fix that doesn't need to know which exact
        // element is wired up.
        const first = findOnce();
        if (first) {
          let cur = first.el;
          let advanced = false;
          for (let level = 0; level < 7; level++) {
            if (!cur || cur === document.body) break;
            console.log(`[IG Tracker] howOften: click attempt L${level} → ${_describe(cur)}`);
            await _trustedClick(cur);
            await sleep(800);
            if (!nextDisabled()) {
              console.log(`[IG Tracker] howOften: Next ENABLED after L${level} click`);
              advanced = true;
              break;
            }
            cur = cur.parentElement;
          }
          if (!advanced) {
            // Hidden-radio fallback: if Meta's pill is wrapping an
            // <input type="radio">, set checked + dispatch change
            // directly — that bypasses any onClick handler shenanigans.
            console.log("[IG Tracker] howOften: walking-click failed — trying hidden radio");
            const radios = document.querySelectorAll("input[type='radio']");
            for (const r of radios) {
              const txt = (r.closest("label")?.innerText || r.parentElement?.innerText || "").toLowerCase();
              if (/once|just\s+once/i.test(txt)) {
                console.log(`[IG Tracker] howOften: found hidden radio for Once — checking it`);
                _setReactValue && r; // (no-op; radios don't use the React value setter)
                r.checked = true;
                r.dispatchEvent(new Event("input", { bubbles: true }));
                r.dispatchEvent(new Event("change", { bubbles: true }));
                await sleep(800);
                break;
              }
            }
          }
          console.log(`[IG Tracker] howOften: post-attempts Next disabled=${nextDisabled()}`);
        } else {
          console.log("[IG Tracker] howOften: no 'Once' option visible — proceeding to Next");
        }
      }
      // Click Next via trusted-click first (the standard stepClickAny
      // uses synthetic clicks that React rejects on this pill row's
      // Next button). We re-find the Next button so the matcher's
      // current location is up to date.
      const nextForFirstClick = findNextBtn();
      if (nextForFirstClick) {
        console.log(`[IG Tracker] howOften: trusted-click Next → ${_describe(nextForFirstClick)}`);
        await _trustedClick(nextForFirstClick);
        await sleep(900);
      } else {
        await stepClickAny(["Next", "Continue"]);
      }
      const isOnHowOften = () => {
        const t = _wizardPageText().toLowerCase();
        return t.includes("choose how often") ||
               t.includes("how often you want to export");
      };
      await sleep(2000);
      if (isOnHowOften()) {
        console.log("[IG Tracker] howOften: Next click didn't advance — walking Next ancestors");
        const nextEl = findNextBtn();
        if (nextEl) {
          let cur = nextEl;
          for (let level = 0; level < 6; level++) {
            if (!cur || cur === document.body) break;
            console.log(`[IG Tracker] howOften: Next click L${level} → ${_describe(cur)}`);
            await _trustedClick(cur);
            await sleep(700);
            if (!isOnHowOften()) { console.log(`[IG Tracker] howOften: advanced after Next L${level}`); break; }
            cur = cur.parentElement;
          }
        }
        if (isOnHowOften()) {
          console.log("[IG Tracker] howOften: still stuck — sending Enter keypress");
          const focused = document.activeElement || document.body;
          for (const ev of ["keydown", "keypress", "keyup"]) {
            focused.dispatchEvent(new KeyboardEvent(ev, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          }
          await sleep(1200);
        }
        // Manual-fallback: synthetic clicks just don't trigger Meta's
        // React handler on this pill component (suspected
        // isTrusted check on the onClick). Stop hammering the page —
        // surface a big prompt asking the user to click Once + Next
        // manually, then watch for the screen to change and resume
        // Stage 2 automatically. 5-minute window so the user can be
        // away from the desk briefly.
        if (isOnHowOften()) {
          console.warn("[IG Tracker] howOften: all auto-attempts exhausted — entering manual-fallback mode");
          _setStatus({
            state: "needs-help",
            step: "👆 Manual step needed: click 'Once' then 'Next'",
            detail: "Meta won't let me click this one screen automatically. Click Once + Next yourself and the rest of the export will resume.",
          });
          _showManualPrompt();
          const t0 = Date.now();
          while (Date.now() - t0 < 5 * 60 * 1000) {
            await sleep(1500);
            await _abortIfStopped();
            if (!isOnHowOften()) {
              console.log("[IG Tracker] howOften: user advanced manually, resuming Stage 2");
              _hideManualPrompt();
              _setStatus({ state: "running", step: "Resuming…", detail: "Thanks, picking up from here." });
              break;
            }
          }
          if (isOnHowOften()) {
            _hideManualPrompt();
            throw new Error("Manual howOften timed out — click Once + Next within 5 minutes next time");
          }
        }
      }
    } else if (screen === "connect") {
      await stepClickAny(["Connect", "Continue"]);
      // OAuth may take several seconds to redirect — wait longer here.
      // If we leave the page (script dies) the post-redirect run picks
      // up at confirm. If we stay (already authed), screen becomes
      // confirm shortly.
    }

    // Explicit wait for the page to advance. Connect needs a longer
    // budget because OAuth redirect can take 5–10s.
    const budget = (screen === "connect") ? WAIT_AFTER_CONNECT_MS : WAIT_AFTER_CLICK_MS;
    const newScreen = await waitForScreenChange(screen, budget);
    if (newScreen === screen) {
      stuckCount += 1;
      console.warn(`[IG Tracker] Screen still '${screen}' after click — retrying (${stuckCount}/2).`);
      if (stuckCount >= 2) {
        throw new Error(`Stuck on screen '${screen}' — click didn't advance the wizard.`);
      }
    } else {
      stuckCount = 0;
      console.log(`[IG Tracker] Advanced: ${screen} → ${newScreen}`);
    }
  }

  // Stage 2: Confirm screen — set Format → JSON, Date range → All time,
  // Customize → only Followers and following, fill notify email, Start.
  //
  // Extra settle period before Stage 2 begins. Post-OAuth the page
  // navigates back to tyi/ and the Confirm screen re-mounts; clicking
  // Format too eagerly can hit a stale row from the previous render
  // and silently no-op. A second of breathing room here is well worth
  // the cost on a 30+ second flow.
  await sleep(1500);
  _setStatus({ step: "Stage 2: setting Format → JSON" });
  await stepClickRow("Format");
  await stepClick("JSON");
  await stepClick("Save");

  _setStatus({ step: "Stage 2: setting Date range → All time" });
  await stepClickRow("Date range");
  await stepClick("All time");
  await stepClick("Save");

  _setStatus({ step: "Stage 2: Customize → Followers and following only" });
  await stepClickRow("Customize information");
  await uncheckAll();
  await _settle();
  await checkLabel("Followers and following");
  await stepClick("Save");

  _setStatus({ step: "Stage 2: filling Notify email" });
  // Notify row may not appear on every wizard variant; tolerate missing.
  try {
    await stepClickRow("Notify");
    // Wait for the dialog to fully render before searching for the input.
    await _settle();
    const stored = await chrome.storage.local.get(["notificationEmail"]);
    const email = (stored.notificationEmail || "").trim();
    if (email) {
      const input = findEmailInput();
      if (input) {
        input.scrollIntoView({ block: "center", behavior: "instant" });
        input.focus();
        await sleep(120);
        await typeRealistic(input, email);
        await _settle();
      } else {
        console.warn("[IG Tracker] Notify: couldn't find email input field");
      }
    }
    await stepClick("Save");
  } catch (e) {
    console.log("[IG Tracker] Notify step skipped:", e.message);
  }

  // Terminal step. Meta has shipped this CTA as "Start export",
  // "Submit request", and "Confirm" across rollouts.
  _setStatus({ step: "Stage 2: clicking Start export" });
  await stepClickAny([
    "Start export",
    "Submit request",
    "Confirm",
    "Done",
  ]);
  await consumeWizardFlag();
  console.log("[IG Tracker] Wizard reached final step. Watching for password prompt…");
  _setStatusFinal("done", "Export submitted ✓", "Watching for password prompt if Meta asks.");
  // Tell the SW to detach the debugger — clears Chrome's yellow
  // "is debugging this browser" infobar now that we're done. The
  // password watchdog (still running) doesn't need trusted clicks;
  // password forms accept synthetic input fine.
  try { chrome.runtime.sendMessage({ type: "wizard-detach-debugger" }); } catch (_) {}
}

// Find the email input on the Notify dialog. Meta doesn't always tag
// it with type="email" — the "Add new email" field renders as a
// generic text input. Cast a wide net: prefer fields that look
// email-y by attribute, fall back to the first visible text input.
function findEmailInput() {
  const candidates = Array.from(document.querySelectorAll(
    "input:not([disabled]):not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit'])"
  )).filter(_isVisible);
  for (const c of candidates) {
    const type = (c.getAttribute("type") || "").toLowerCase();
    const name = (c.getAttribute("name") || "").toLowerCase();
    const ph   = (c.getAttribute("placeholder") || "").toLowerCase();
    const al   = (c.getAttribute("aria-label") || "").toLowerCase();
    if (type === "email" ||
        /email/.test(name) || /email/.test(ph) || /email/.test(al) ||
        /add new email/.test(ph) || /add new email/.test(al)) {
      return c;
    }
  }
  return candidates[0] || null;
}

async function stepClick(text) {
  const el = await waitFor(() => findByText(text), { label: `click: ${text}` });
  console.log(`[IG Tracker] Click "${text}" → ${_describe(el)}`);
  clickElement(el);
  await _settle();
}

async function stepClickRow(label) {
  const el = await waitFor(() => findRowByLabel(label), { label: `row: ${label}` });
  console.log(`[IG Tracker] Open row "${label}" → ${_describe(el)}`);
  clickElement(el);
  await _settle();
}

// Click whichever of a list of candidate labels matches first. Used
// when Meta has shipped multiple variants of the same CTA — e.g. the
// Start screen has been "Create export", "Start a new export", and
// "New export" across different rollouts.
async function stepClickAny(labels) {
  const el = await waitFor(() => {
    for (const label of labels) {
      const x = findByText(label);
      if (x) return x;
    }
    return null;
  }, { label: `click any: ${labels.join(" | ")}` });
  console.log(`[IG Tracker] Click any-of [${labels.join(", ")}] → ${_describe(el)}`);
  clickElement(el);
  await _settle();
}

async function uncheckAll() {
  // Multi-pass uncheck: clicking a box can re-render its parent block
  // and reveal new checked boxes (e.g., a section that was collapsed
  // expands as Meta updates the form state). Keep iterating until a
  // pass finds nothing checked, or we hit the safety cap.
  const SELECTOR = (
    "[role='checkbox'][aria-checked='true'], " +
    "[role='checkbox'][aria-checked='mixed'], " +
    "input[type='checkbox']:checked"
  );
  for (let pass = 0; pass < 6; pass++) {
    const checkedBoxes = Array.from(document.querySelectorAll(SELECTOR));
    if (checkedBoxes.length === 0) {
      if (pass === 0) console.log("[IG Tracker] uncheckAll: nothing was checked");
      break;
    }
    console.log(`[IG Tracker] uncheckAll pass ${pass + 1}: ${checkedBoxes.length} box(es)`);
    for (const box of checkedBoxes) {
      box.scrollIntoView({ block: "center", behavior: "instant" });
      box.click();
      await sleep(50);
    }
    await _settle();
  }
}

async function checkLabel(label) {
  // Find the row, then click the toggle inside it. When the row
  // contains multiple toggles (a flat-grid layout where many labels
  // and checkboxes share the same parent), pick the toggle nearest
  // the label text by rendered position.
  const row = findRowByLabel(label);
  if (!row) throw new Error(`Couldn't find row: ${label}`);
  const TOGGLE_SEL = "[role='checkbox'], [role='radio'], [role='switch'], " +
                     "input[type='checkbox'], input[type='radio']";
  const toggles = Array.from(row.querySelectorAll(TOGGLE_SEL)).filter(_isVisible);
  let cb = null;
  if (toggles.length === 1) {
    cb = toggles[0];
  } else if (toggles.length > 1) {
    const target = String(label).trim().toLowerCase();
    let labelEl = null;
    for (const el of row.querySelectorAll("*")) {
      if (_directText(el).toLowerCase() === target) { labelEl = el; break; }
    }
    if (labelEl) {
      const lr = labelEl.getBoundingClientRect();
      const lcx = (lr.left + lr.right) / 2;
      const lcy = (lr.top + lr.bottom) / 2;
      let best = null;
      for (const t of toggles) {
        const tr = t.getBoundingClientRect();
        const dist = Math.hypot((tr.left + tr.right) / 2 - lcx,
                                (tr.top + tr.bottom) / 2 - lcy);
        if (!best || dist < best.dist) best = { t, dist };
      }
      cb = best ? best.t : toggles[0];
    } else {
      cb = toggles[0];
    }
  }
  if (cb) {
    if (cb.getAttribute("aria-checked") !== "true" && !cb.checked) {
      cb.click();
    }
  } else {
    // No toggle found — last resort, click the row itself in case the
    // whole row is the toggle target.
    row.click();
  }
  await _settle();
}

// Watch for a password input + Submit button appearing anywhere on the
// page. If we have a saved password and the field appears, type it in
// with realistic per-key delays and click Submit.
async function passwordWatchdog() {
  const stored = await chrome.storage.local.get(["igPassword"]);
  const password = stored.igPassword || "";
  if (!password) return; // no autofill; user types manually

  const t0 = Date.now();
  const MAX_WATCH_MS = 300000; // 5 minutes
  while (Date.now() - t0 < MAX_WATCH_MS) {
    const pw = document.querySelector("input[type='password']:not([data-igt-filled])");
    if (pw) {
      console.log("[IG Tracker] Password field detected — autofilling.");
      pw.dataset.igtFilled = "1";
      pw.focus();
      await sleep(150);
      await typeRealistic(pw, password);
      // React validates the password length asynchronously after input;
      // give it a moment to enable the Continue button before we click.
      await sleep(800);
      // Search Continue scoped to the password dialog (its closest
      // [role='dialog'] ancestor) so we don't pick up an underlying-page
      // Continue button while the modal is open.
      const dialog = pw.closest("[role='dialog']") || document;
      const submit =
        findByText("Continue", dialog) ||
        findByText("Confirm", dialog) ||
        findByText("Submit", dialog) ||
        findByText("Save", dialog) ||
        findByText("Continue") ||
        findByText("Confirm");
      if (submit) {
        console.log(`[IG Tracker] Submitting password → ${_describe(submit)}`);
        clickElement(submit);
      } else {
        console.warn("[IG Tracker] Password typed but Continue button not found.");
      }
      return;
    }
    await sleep(500);
  }
}

// Type text into an input the way React expects. Setting el.value
// directly bypasses React's controlled-input value tracking, so the
// component's internal state stays empty and form-validation buttons
// (like "Continue" on the password dialog) stay disabled. Using the
// native value-setter from HTMLInputElement.prototype mutates the
// underlying DOM property in a way React's input tracker observes.
const _nativeInputValueSetter =
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function _setReactValue(el, value) {
  if (_nativeInputValueSetter) {
    _nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
}

async function typeRealistic(el, text) {
  _setReactValue(el, "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  let buf = "";
  for (const ch of text) {
    buf += ch;
    _setReactValue(el, buf);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    await sleep(60 + Math.random() * 80);
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  // Blur is what triggers many React form validators to mark the
  // field as "touched" and enable the submit button.
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

// Ring buffer of [IG Tracker] console messages so the popup's
// "Copy debug log" can pull them out without DevTools.
const _DEBUG_LOG = [];
const _DEBUG_LOG_MAX = 300;
function _logCapture(level, args) {
  try {
    const first = args[0];
    if (typeof first !== "string" || !first.includes("[IG Tracker]")) return;
    const text = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    _DEBUG_LOG.push(`${new Date().toISOString()} [${level}] ${text}`);
    if (_DEBUG_LOG.length > _DEBUG_LOG_MAX) {
      _DEBUG_LOG.splice(0, _DEBUG_LOG.length - _DEBUG_LOG_MAX);
    }
  } catch { /* ignore */ }
}
{
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...a) => { _logCapture("log", a); origLog(...a); };
  console.warn = (...a) => { _logCapture("warn", a); origWarn(...a); };
  console.error = (...a) => { _logCapture("error", a); origError(...a); };
}

// One-shot commands from the popup. Each runs a single discrete step
// of the wizard so the user can drive most of it manually and just
// click the IG Tracker button when they're on the right screen.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "get-debug-log") {
    sendResponse({
      ok: true,
      url: window.location.href,
      count: _DEBUG_LOG.length,
      log: _DEBUG_LOG.join("\n"),
    });
    return false;
  }
  const handler = ONE_SHOT_HANDLERS[msg.type];
  if (!handler) return false;
  (async () => {
    try {
      const r = await handler(msg);
      sendResponse({ ok: true, ...(r || {}) });
    } catch (e) {
      console.warn(`[IG Tracker] ${msg.type} failed:`, e.message);
      showToast(`IG Tracker: ${e.message}`);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

const ONE_SHOT_HANDLERS = {
  "toggle-followers-only": async () => {
    await uncheckAll();
    await _settle();
    await checkLabel("Followers and following");
    showToast("Only 'Followers and following' is now checked.");
  },
  "set-format-json": async () => {
    // Click the JSON radio. Page must be on the Format selection screen.
    await stepClick("JSON");
    showToast("Format set to JSON. Click Save.");
  },
  "set-date-all-time": async () => {
    await stepClick("All time");
    showToast("Date range set to All time. Click Save.");
  },
  "fill-email": async (msg) => {
    const email = String(msg.email || "").trim();
    if (!email) throw new Error("No email saved — set one in the popup first.");
    const input = findEmailInput();
    if (!input) throw new Error("Couldn't find an email field on this page.");
    input.scrollIntoView({ block: "center", behavior: "instant" });
    input.focus();
    await sleep(120);
    await typeRealistic(input, email);
    showToast(`Filled notification email: ${email}`);
  },
};

(async function main() {
  if (!(await shouldRun())) {
    // Even when we don't actively drive the wizard, we should still be ready
    // to fill in the password if the user reaches that screen manually.
    passwordWatchdog().catch((e) => console.warn("[IG Tracker] watchdog failed:", e));
    return;
  }
  // Start watching for the password before driving the wizard, so we don't
  // miss the prompt while we're clicking through earlier steps.
  passwordWatchdog().catch((e) => console.warn("[IG Tracker] watchdog failed:", e));
  try {
    await runWizard();
    console.log("[IG Tracker] Wizard auto-fill complete.");
  } catch (e) {
    console.warn("[IG Tracker] Wizard auto-fill stopped:", e.message);
    _setStatusFinal("error", "Stopped", `${e.message} — click manually from here.`, 60000);
    showToast(`IG Tracker auto-export stopped: ${e.message}. Click manually from here.`);
    // Best-effort detach so the yellow infobar disappears even when
    // the wizard errored mid-flight.
    try { chrome.runtime.sendMessage({ type: "wizard-detach-debugger" }); } catch (_) {}
  }
})();

// Big, dismissable overlay for the howOften manual-click fallback.
// Draws attention without blocking interaction with the underlying
// pills (pointer-events: none on the panel, auto on the inner card so
// only the close button is interactive). Disappears once the wizard
// detects the page has advanced past howOften.
function _showManualPrompt() {
  if (document.getElementById("igtracker-manual-prompt")) return;
  const prompt = document.createElement("div");
  prompt.id = "igtracker-manual-prompt";
  prompt.style.cssText = `
    position: fixed; inset: 0; pointer-events: none;
    z-index: 2147483646; display: flex;
    align-items: flex-start; justify-content: center;
    padding-top: 80px;
    font-family: -apple-system, sans-serif;
  `;
  prompt.innerHTML = `
    <div style="
      pointer-events: auto;
      background: linear-gradient(135deg, #5078ff, #7d5cff);
      color: white; padding: 20px 28px; border-radius: 14px;
      box-shadow: 0 12px 32px rgba(80,120,255,0.4);
      max-width: 460px; text-align: center;
      animation: igt-pulse 1.5s ease-in-out infinite;
    ">
      <div style="font-size: 16px; font-weight: 700; margin-bottom: 8px;">
        👆 One manual click needed
      </div>
      <div style="font-size: 13px; line-height: 1.5; opacity: 0.95;">
        Meta blocks automated clicks on this one screen. <br>
        Click <b>"Once"</b> then <b>"Next"</b> below — the rest of the
        export will resume automatically.
      </div>
    </div>
    <style>
      @keyframes igt-pulse {
        0%, 100% { transform: translateY(0); box-shadow: 0 12px 32px rgba(80,120,255,0.4); }
        50%      { transform: translateY(-3px); box-shadow: 0 18px 40px rgba(80,120,255,0.55); }
      }
    </style>
  `;
  document.body.appendChild(prompt);
}
function _hideManualPrompt() {
  document.getElementById("igtracker-manual-prompt")?.remove();
}

function showToast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #18181b; color: #f1f1f3; padding: 12px 18px;
    border-radius: 8px; border: 1px solid #2a2a30;
    z-index: 2147483647; font-family: -apple-system, sans-serif;
    font-size: 13px; max-width: 80vw;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// Persistent status panel — shows the wizard's current step and last
// action without disappearing. The console log used to be the only
// signal, which was useless when the user wasn't watching DevTools.
// Sticks to the top-right; user can dismiss with the × button.
function _statusPanel() {
  let panel = document.getElementById("igtracker-export-status");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "igtracker-export-status";
  panel.style.cssText = `
    position: fixed; top: 16px; right: 16px;
    background: #18181b; color: #f1f1f3;
    padding: 10px 14px; border-radius: 8px;
    border: 1px solid #2a2a30;
    box-shadow: 0 6px 18px rgba(0,0,0,0.35);
    z-index: 2147483647; min-width: 240px; max-width: 360px;
    font-family: -apple-system, sans-serif; font-size: 12px;
    line-height: 1.4;
  `;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="font-weight:600;color:#5078ff;">⏵ IG Export</span>
      <span id="igts-state" style="margin-left:auto;font-size:11px;color:#8f8f99;">starting…</span>
      <button id="igts-close" style="background:transparent;border:none;color:#8f8f99;cursor:pointer;font-size:14px;padding:0 2px;">×</button>
    </div>
    <div id="igts-step" style="font-weight:500;color:#f1f1f3;"></div>
    <div id="igts-detail" style="color:#a1a1aa;font-size:11px;margin-top:2px;"></div>
    <div id="igts-awake" style="
      margin-top: 8px; font-size: 10px; color: #8f8f99;
    "></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector("#igts-close").addEventListener("click", () => panel.remove());
  // Reflect the AudioContext state passively. Auto-arm tries to
  // start it without needing a button; this just shows the result.
  _updateWizardAwakeIndicator();
  return panel;
}
function _updateWizardAwakeIndicator() {
  const ind = document.getElementById("igts-awake");
  if (!ind) return;
  const state = window.__igtKeepAliveCtx?.state;
  if (state === "running") {
    ind.innerHTML = `<span style="color:#86efac;">🔊 Background mode armed</span> — switch away anytime`;
  } else if (state === "suspended") {
    ind.innerHTML = `<span style="color:#fcd34d;">💤 Click anywhere in this tab</span> to enable background mode`;
  } else {
    ind.textContent = "";
  }
}
function _setStatus({ state, step, detail } = {}) {
  try {
    const panel = _statusPanel();
    if (state) {
      const el = panel.querySelector("#igts-state");
      el.textContent = state;
      el.style.color = state === "done" ? "#34d399"
                     : state === "error" ? "#f87171"
                     : "#8f8f99";
    }
    if (step != null) panel.querySelector("#igts-step").textContent = step;
    if (detail != null) panel.querySelector("#igts-detail").textContent = detail;
  } catch (_) { /* DOM not ready, ignore */ }
}
// Wrap _setStatus calls so they auto-disappear N seconds after a
// terminal state (done/error). Keeps the panel visible long enough
// for the user to see the outcome without leaving permanent clutter.
function _setStatusFinal(state, step, detail, dismissAfterMs = 30000) {
  _setStatus({ state, step, detail });
  const panel = document.getElementById("igtracker-export-status");
  if (panel) setTimeout(() => panel.remove(), dismissAfterMs);
}
