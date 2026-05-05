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
  // Danger guard: did the user click "Export to device" / similar
  // mid-run? The user-click tracker sets `_userPickedDeviceDuringRun`
  // when it sees one, so we halt cleanly before the wizard submits
  // to the wrong destination. Without this, an accidental tap on
  // "Export to device" silently re-caches device on Meta's side and
  // unwinds whatever destination work was already done.
  if (_userPickedDeviceDuringRun) {
    throw new Error("You clicked 'Export to device' during the wizard — halted to prevent submitting to device. Re-run after fixing destination.");
  }
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

// Walk the DOM including any shadow roots. Meta sometimes mounts
// modal content inside a shadow DOM, which document.querySelectorAll
// won't traverse — _allDeep collects everything, including elements
// inside ::shadow boundaries. Used by findByText / findRowByLabel
// when the standard light-DOM walk yields nothing.
function _allDeep(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const r = stack.pop();
    if (!r) continue;
    const nodes = r.querySelectorAll ? r.querySelectorAll("*") : [];
    for (const n of nodes) {
      out.push(n);
      if (n.shadowRoot) stack.push(n.shadowRoot);
    }
  }
  return out;
}

// True if `el` is inside one of our injected UI panels (status panel,
// manual prompt, toast). Used to filter findByText results so we never
// match against text rendered by our own overlays — a v1.0.92 bug had
// _clickButtonByText("Google Drive") matching the status panel's
// "Auto-fix: switching destination to Google Drive" text and clicking
// our own UI instead of Meta's.
function _isInIgtInjected(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.id && _IGT_INJECTED_IDS.has(cur.id)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function _findByText(text, within, lenient) {
  const target = String(text).trim().toLowerCase();
  if (!target) return null;
  // Light-DOM pass first (cheaper). If nothing matches we fall to
  // _allDeep which descends into shadow roots.
  let all = within.querySelectorAll("*");
  let r = _findByTextScan(target, Array.from(all), lenient);
  if (r) return r;
  // Shadow-DOM scan.
  return _findByTextScan(target, _allDeep(within), lenient);
}

function _findByTextScan(target, all, lenient) {
  const tryReturn = (el) => {
    if (_isInIgtInjected(el)) return null;  // ignore matches in our own panels
    const c = _climbToClickable(el);
    if (c && _isVisible(c) && !_isInIgtInjected(c)) return c;
    if (lenient && _isVisible(el)) return el;
    return null;
  };
  // Pass 0: aria-label exact match. Meta sometimes renders buttons
  // with the label set via accessibility (aria-label) rather than
  // visible text — particularly on icon-prefixed buttons or React
  // components that put the text in a sibling element. Without this
  // pass, findByText was returning null for elements that DOM-look
  // empty but are clearly labeled "Create export" or "Export your
  // information" to the accessibility tree.
  for (const el of all) {
    if (!el.getAttribute) continue;
    const al = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (al !== target) continue;
    const r = tryReturn(el); if (r) return r;
  }
  // Pass 0b: aria-label substring match for the target inside a
  // longer label (e.g., aria-label="Create export — start a new
  // download" still matches target "create export").
  for (const el of all) {
    if (!el.getAttribute) continue;
    const al = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!al.includes(target)) continue;
    if (al.length > Math.max(target.length + 60, 80)) continue;
    const r = tryReturn(el); if (r) return r;
  }
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
    if (_isInIgtInjected(el)) return null;
    const clickable = _climbToClickable(el);
    if (clickable && _isVisible(clickable) && !_isInIgtInjected(clickable)) return clickable;
    const row = _climbToRow(el);
    if (row && _isVisible(row) && !_isInIgtInjected(row)) return row;
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
    // chooseWhere — SPECIFIC heading. Checked BEFORE the manage-
    // requests start pattern because when the bot clicks Create-
    // export on the manage-requests modal, the chooseWhere modal
    // opens ON TOP of it, but the underlying modal's text
    // ("Current activity" + "Past activity" + "Create export") is
    // still in the DOM. Without this ordering, detectCurrentScreen
    // returned "start" after a successful click → waitForScreenChange
    // saw no advance → "Stuck on screen 'start'" even though the
    // click had actually worked.
    if (text.includes("choose where to export") ||
        text.includes("where do you want to export")) {
      return "chooseWhere";
    }
    // chooseService — SPECIFIC heading only here. The (drive &&
    // dropbox) fallback is checked AFTER the start matcher, since
    // the manage-requests modal mentions Google Drive in existing-
    // request descriptions and would otherwise misclassify start.
    if (text.includes("choose an external service") ||
        text.includes("choose external service")) {
      return "chooseService";
    }
    // Manage-requests start screen: the May 2026 layout shows a
    // tabbed "Current activity / Past activity" view with a
    // "Create export" CTA.
    if (text.includes("current activity") &&
        text.includes("past activity") &&
        text.includes("create export")) {
      return "start";
    }
    // Service-selection fallback: providers list visible without an
    // explicit heading. Last because of the manage-requests false-
    // positive risk noted above.
    if (text.includes("google drive") && text.includes("dropbox")) {
      return "chooseService";
    }
    // chooseWhere fallback for older rollouts that surfaced the
    // option labels themselves rather than the heading.
    if (text.includes("export to external service") &&
        text.includes("download to your device")) {
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
// Ring buffer of recent bot-fired click coordinates AND element refs.
// Used by the user-click tracker to distinguish "user clicked here"
// from "we clicked here." Two matching paths:
//
//   1. Coord match — works for trusted-clicks dispatched via
//      chrome.debugger.Input.dispatchMouseEvent, which carry real
//      clientX/Y values.
//   2. Element identity match — works for synthetic `el.click()`
//      fallbacks, which produce click events with clientX=0,
//      clientY=0 (no coords) → coord match would falsely flag them
//      as user clicks. We also store the clicked element ref and
//      check `ev.target === el || el.contains(ev.target)`.
//
// Without #2, every time `_trustedClick` fell back to clickElement,
// the resulting click event was logged as a "user click" with the
// element's bounding rect — making it look like the user had clicked
// somewhere they hadn't. (Specifically, this is what made it look
// like the user accidentally clicked "Export to device" when
// actually our bot's synthetic click on a wrapper landed on it.)
const _BOT_CLICKS = [];
const _BOT_CLICK_WINDOW_MS = 400;
function _markBotClick(x, y, el) {
  const now = Date.now();
  _BOT_CLICKS.push({ x, y, el: el || null, ts: now });
  // Trim entries older than 5s.
  const cutoff = now - 5000;
  while (_BOT_CLICKS.length && _BOT_CLICKS[0].ts < cutoff) _BOT_CLICKS.shift();
}
function _wasRecentBotClick(ev) {
  const now = Date.now();
  for (const bc of _BOT_CLICKS) {
    if (now - bc.ts > _BOT_CLICK_WINDOW_MS) continue;
    // Coord match — only meaningful when ev has real coords
    // (trusted-click via chrome.debugger).
    if (ev.clientX > 0 || ev.clientY > 0) {
      const dx = Math.abs(bc.x - ev.clientX);
      const dy = Math.abs(bc.y - ev.clientY);
      if (dx <= 6 && dy <= 6) return true;
    }
    // Element identity match — covers synthetic el.click() events
    // (which have clientX=0,clientY=0) and click-bubbling cascades.
    if (bc.el && ev.target) {
      if (ev.target === bc.el) return true;
      try {
        if (bc.el.contains(ev.target) || ev.target.contains(bc.el)) return true;
      } catch (_) { /* dom errors */ }
    }
  }
  return false;
}

// Passive user-click tracker. Capture-phase click listener that logs
// every click NOT fired by us. Two states the guard cares about:
//
//   1. `__igtWizardRunning` — wizard is driving a screen.
//      Halt immediately on any "Export to device" / dest-direction
//      click (those re-cache device on Meta's side).
//   2. `__igtInDestFix` — we're inside _navigateBackToFixDest,
//      the most fragile sequence. Halt on ANY user click — even
//      benign-looking ones like the destination header — because
//      anything that changes page state during the multi-strategy
//      attempt invalidates the verification (proven by the v1.0.105
//      log: user clicked the destination header during the 1.5s
//      between S1 and S2, collapsing the chooser, so S2 found rect
//      (0,0)).
let _userPickedDeviceDuringRun = false;
let _userClickedDuringDestFix = false;
function _isDangerDeviceText(txt) {
  const t = (txt || "").trim().toLowerCase();
  if (!t) return false;
  // Whole-button match — these are the actual chooser button labels
  // we want to catch. Don't substring-match: "device" appears in
  // descriptive text too ("on your device", "device storage", etc.).
  return t === "export to device"
      || t === "download to device"
      || t === "download to your device"
      || t === "save to device"
      || t === "save to your device"
      || t === "export to your device";
}
function _initUserClickTracker() {
  if (window.__igtClickTracker) return;
  window.__igtClickTracker = true;
  document.addEventListener("click", (ev) => {
    try {
      if (_isInIgtInjected(ev.target)) return;
      // Only count truly user-initiated events. Meta's React dispatches
      // its own click events internally (isTrusted=false) — those would
      // otherwise look like user clicks. Bot clicks via chrome.debugger
      // are isTrusted=true but still get filtered via element/coord
      // identity match below; real user clicks are isTrusted=true and
      // typically don't match a recent bot click.
      if (!ev.isTrusted) return;
      if (_wasRecentBotClick(ev)) return;
      const el = ev.target;
      const tag = (el.tagName || "").toLowerCase();
      const role = el.getAttribute && el.getAttribute("role");
      const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const r = el.getBoundingClientRect();
      const pos = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      // Build a simple selector path (3 levels up) so we can spot
      // distinctive ancestor classes if we want to replay.
      const path = [];
      let cur = el;
      for (let i = 0; cur && cur !== document.body && i < 3; i++, cur = cur.parentElement) {
        const rl = cur.getAttribute && cur.getAttribute("role");
        path.push(`${(cur.tagName || "").toLowerCase()}${rl ? `[role=${rl}]` : ""}`);
      }
      // hasFocus() tells us if the IG tab is the active foreground
      // tab. If the user is on a different tab (e.g. Netflix), this
      // returns false. A click event arriving with hasFocus=false is
      // a phantom — couldn't have been a real user click on this tab.
      // Bot's `chrome.debugger` clicks also fire with hasFocus=false
      // when the tab is backgrounded, but those should be filtered
      // by `_wasRecentBotClick` already.
      const focused = (typeof document.hasFocus === "function") ? document.hasFocus() : null;
      const visState = document.visibilityState || "?";
      console.log(`[IG Tracker] [user click] <${tag}${role ? ` role=${role}` : ""}> "${txt}" @ ${pos} path=${path.join(">")} focused=${focused} vis=${visState} ts=${ev.timeStamp}`);
      // Danger guard: if the wizard is running AND user clicked a
      // device-direction button, flag it so _abortIfStopped halts.
      // BUT: only halt if the tab actually had focus when the click
      // fired. If hasFocus=false, the user can't be the source — the
      // event is a phantom (or chrome.debugger residue we missed).
      // Treating phantoms as halts caused the user (who was watching
      // Netflix in another tab) to get falsely accused of clicking
      // device. v1.0.111 log proved this — danger fired on a
      // backgrounded tab.
      if (window.__igtWizardRunning) {
        let probe = el;
        let dangerMatched = false;
        for (let i = 0; probe && i < 4; i++, probe = probe.parentElement) {
          const probeTxt = (probe.innerText || probe.textContent || "").trim();
          if (_isDangerDeviceText(probeTxt)) { dangerMatched = true; break; }
        }
        if (dangerMatched) {
          if (focused === false) {
            console.warn(`[IG Tracker] [user click] phantom danger — click on 'Export to device' but tab NOT focused (hasFocus=${focused}). Ignoring; not halting wizard.`);
          } else {
            _userPickedDeviceDuringRun = true;
            console.warn(`[IG Tracker] [user click] DANGER — clicked device-direction button while wizard running (hasFocus=${focused}). Wizard will halt.`);
            _setStatus({
              state: "needs-help",
              step: "⚠ You clicked 'Export to device' — wizard halting",
              detail: "Don't click destination buttons while the bot is running. Run again from the start.",
            });
          }
        }
      }
      // Stricter guard: while the multi-strategy dest-fix is running,
      // ANY user click invalidates the test. The v1.0.105 log proved
      // this: user clicked the destination header between S1 and S2,
      // collapsed the chooser, so we couldn't tell if S1 worked. Set
      // the flag; _navigateBackToFixDest's loop will detect it and
      // halt with a clear message.
      if (window.__igtInDestFix) {
        _userClickedDuringDestFix = true;
        console.warn(`[IG Tracker] [user click] during dest-fix — wizard will halt. Don't click anything during the auto-fix sequence.`);
      }
    } catch (_) { /* never break the user's click */ }
  }, { capture: true });
}

function clickElement(el) {
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  _markBotClick(x, y, el);
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
  // Hard halt before any click if the danger guard fired. The
  // _abortIfStopped check only runs in _settle() — the start-screen
  // click loop doesn't go through _settle between clicks, so without
  // this gate the wizard happily continues after a "you clicked
  // device" event was already flagged. v1.0.106 log proved this:
  // danger fired at 08:58:50.768, wizard kept clicking at .51.760+.
  if (_userPickedDeviceDuringRun) {
    throw new Error("Danger flag set (you clicked 'Export to device' during the wizard) — halted before next click.");
  }
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
  _markBotClick(x, y, el);
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

// Walk up from `el` to the closest ancestor that looks clickable —
// role="button" / role="link" / <button> / <a> / a div with explicit
// onclick or cursor:pointer. Returns the ancestor, or `el` if none.
// Used so we click on the actual button container Meta wires the
// React handler to, not on the inner <span> with the label text.
function _findClickableAncestor(el) {
  let cur = el;
  for (let i = 0; cur && cur !== document.body && i < 8; i++, cur = cur.parentElement) {
    const role = cur.getAttribute && cur.getAttribute("role");
    if (role === "button" || role === "link") return cur;
    const tn = (cur.tagName || "").toLowerCase();
    if (tn === "button" || tn === "a") return cur;
    if (cur.onclick) return cur;
    try {
      const cs = getComputedStyle(cur);
      if (cs.cursor === "pointer") return cur;
    } catch (_) {}
  }
  return el;
}

// Snapshot of every visible button-like element on screen, with text
// + role + aria-disabled + bounding rect. Logged on Stage 2 anomalies
// so we can see exactly what Meta rendered when the wizard got stuck —
// the previous logs only showed which matchers fired, not which
// targets were actually present and clickable.
function _traceVisibleButtons(label = "buttons") {
  try {
    const sel = "[role='button'], [role='link'], button, a";
    const all = Array.from(document.querySelectorAll(sel)).filter(_isVisible);
    const items = all.slice(0, 30).map((el) => {
      const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const ad = el.getAttribute("aria-disabled");
      const dis = el.disabled === true || ad === "true";
      const r = el.getBoundingClientRect();
      const pos = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      return `  · [${role}${dis ? " disabled" : ""}] "${txt}" @ ${pos}`;
    });
    console.log(`[IG Tracker] trace(${label}): ${all.length} visible button-like elements${all.length > 30 ? " (showing 30)" : ""}\n${items.join("\n")}`);
  } catch (e) {
    console.log(`[IG Tracker] trace(${label}) failed: ${e.message}`);
  }
}

// Dump a structured JSON snapshot of every visible element in a region
// of interest, used to diagnose dest-fix failures offline. Captures
// tag, role, all attributes, computed cursor + pointer-events,
// position, parent chain (up to 5 levels), and text — everything we
// need to reverse-engineer Meta's React handler placement without a
// live browser. Output goes to the [IG Tracker] debug log.
function _dumpDOMSnapshot(label, opts = {}) {
  const maxElements = opts.maxElements || 60;
  const matchText = opts.matchText;            // optional: only elements containing this text
  try {
    const all = Array.from(document.querySelectorAll("*"));
    const out = [];
    for (const el of all) {
      if (out.length >= maxElements) break;
      if (_isInIgtInjected(el)) continue;
      if (!_isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || "").trim();
      if (matchText && !txt.toLowerCase().includes(matchText.toLowerCase())) continue;
      // Skip the giant body wrapper, sidebar items, etc.
      if (txt.length > 250) continue;
      const r = el.getBoundingClientRect();
      const attrs = {};
      try {
        for (const a of el.attributes) attrs[a.name] = a.value.slice(0, 60);
      } catch (_) {}
      let cursor = "", pe = "";
      try {
        const cs = getComputedStyle(el);
        cursor = cs.cursor;
        pe = cs.pointerEvents;
      } catch (_) {}
      const parents = [];
      let p = el.parentElement;
      for (let i = 0; p && p !== document.body && i < 5; i++, p = p.parentElement) {
        const role = p.getAttribute && p.getAttribute("role");
        const cls = (p.className || "").toString().slice(0, 30);
        parents.push(`${(p.tagName || "").toLowerCase()}${role ? `[role=${role}]` : ""}${cls ? `.${cls}` : ""}`);
      }
      out.push({
        tag: (el.tagName || "").toLowerCase(),
        text: txt.replace(/\s+/g, " ").slice(0, 60),
        rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        attrs,
        cursor,
        pe,
        parents: parents.join(">"),
      });
    }
    console.log(`[IG Tracker] dom-snapshot(${label}): ${out.length} elements\n${JSON.stringify(out, null, 2)}`);
  } catch (e) {
    console.log(`[IG Tracker] dom-snapshot(${label}) failed: ${e.message}`);
  }
}

// Did the destination chooser advance? Returns true if the page state
// indicates a successful click — either the confirm header now shows
// drive (and not device), OR a service chooser appeared (Google Drive
// button visible), OR connect/howOften appeared.
function _destFixAdvanced() {
  const t = _wizardPageText();
  const hasDeviceHeader = /(?:export|download|save)\s+to\s+(?:your\s+)?device\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i.test(t);
  const hasDriveHeader = /(?:export|send|transfer)\s+to\s+(?:google\s+)?drive\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i.test(t);
  if (hasDriveHeader && !hasDeviceHeader) return "drive-on-confirm";
  if (findByText("Google Drive") && !findByText("Export to external service")) return "service-chooser-open";
  if (/choose how often|how often you want to export/i.test(t)) return "howOften";
  if (/connect to google drive/i.test(t)) return "connect";
  return null;
}

// Find a button by its visible text and click it via trusted-click
// targeting the button's clickable ancestor (not the inner label).
// Returns true if a click was issued. Reserved for cases where we
// know the EXACT button we want (e.g., "Export to external service",
// "Google Drive") — never use for wrong-direction labels.
// Strict button matcher: prefers actual <button> / [role=button]
// elements whose visible text matches `text` exactly or starts with it.
// findByText's pass-by-pass walk can return a `<div>` whose cursor is
// 'pointer' (passing _isClickable) but is NOT the React-bound click
// target — clicking that div fires a no-op while the real button
// container goes untouched. v1.0.98 hit this exact bug: clicking
// "Export to external service" returned a wrapper <div>, the click
// did nothing useful, and the chooser collapsed without selecting.
function _findStrictButton(text) {
  const target = String(text).trim().toLowerCase();
  if (!target) return null;
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
  for (const b of buttons) {
    if (_isInIgtInjected(b)) continue;
    if (!_isVisible(b)) continue;
    const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
    if (txt === target) return b;
    // Multi-line button (e.g. "Notify\njoshua@..." or "Format HTML") — accept
    // a starts-with match if the button text begins with our target.
    if (txt.startsWith(target + "\n") || txt.startsWith(target + " ")) return b;
  }
  // Aria-label fallback.
  for (const b of buttons) {
    if (_isInIgtInjected(b)) continue;
    if (!_isVisible(b)) continue;
    const al = (b.getAttribute("aria-label") || "").trim().toLowerCase();
    if (al === target) return b;
  }
  return null;
}

async function _clickButtonByText(text) {
  // Strict button match first — picks up the real <button> / [role=button]
  // element so the trusted-click hits whatever React wired the handler to.
  const strict = _findStrictButton(text);
  if (strict) {
    console.log(`[IG Tracker] _clickButtonByText("${text}") → ${_describe(strict)} [strict]`);
    await _trustedClick(strict);
    return true;
  }
  // Loose fallback for elements that don't carry a button role
  // (Meta sometimes renders custom interactive divs with no role).
  const el = findByText(text);
  if (!el) return false;
  const target = _findClickableAncestor(el);
  console.log(`[IG Tracker] _clickButtonByText("${text}") → ${_describe(target)} [loose]`);
  await _trustedClick(target);
  return true;
}

// Click at a viewport coordinate computed as an offset from a known-
// findable reference button. Useful when the target button can't be
// reliably matched / climbed-to (e.g., Meta's React handler is bound
// to a wrapper our matchers don't reach), but a NEIGHBOURING button
// IS findable. We grab the reference's bounding rect and click at
// (refCenterX + dx, refCenterY + dy) directly via chrome.debugger.
// This bypasses the element-search entirely — the click lands at a
// real viewport position the same way a user's real cursor would.
//
// For example, on the destination chooser, "Export to device" is
// findable (strict button match works), and "Export to external
// service" is exactly 53px below it (same x). Calling this with
// (refButtonText="Export to device", dx=0, dy=53) hits the external
// service button directly.
async function _clickAtOffsetFromButton(refButtonText, dx, dy) {
  const ref = _findStrictButton(refButtonText);
  if (!ref) {
    console.warn(`[IG Tracker] _clickAtOffsetFromButton: ref "${refButtonText}" not found`);
    return false;
  }
  ref.scrollIntoView({ block: "center", behavior: "instant" });
  // Settle the scroll before reading rect.
  await sleep(120);
  const rect = ref.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2 + dx);
  const y = Math.round(rect.top + rect.height / 2 + dy);
  console.log(`[IG Tracker] _clickAtOffsetFromButton: ref "${refButtonText}" rect=(${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}) → click @ (${x},${y}) [dx=${dx} dy=${dy}]`);
  _markBotClick(x, y, null);
  // Direct chrome.debugger dispatch — bypasses all element search.
  const resp = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "trusted-click", x, y }, (r) => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(r || { ok: false, error: "no response" });
      });
    } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });
  if (!resp.ok) {
    console.warn(`[IG Tracker] _clickAtOffsetFromButton: trusted-click failed (${resp.error})`);
    return false;
  }
  return true;
}

// Find the back-arrow button on the Meta wizard modal — the "<" at
// top-left that navigates to the previous step. Uses two strategies:
//
//   (a) Aria-label match. Meta usually labels the back button as
//       "Back" or "Go back" for accessibility. Strongest signal.
//   (b) Geometry fallback. If aria-label isn't there, find the
//       smallest empty-text button at the top-left of the modal —
//       small (20–60px), positioned near the top of the viewport,
//       on the left half. Avoids matching the "X" close button (top
//       right) or the global Meta-header X (extreme top-right).
function _findBackArrow() {
  // Aria-label first.
  for (const el of document.querySelectorAll("[aria-label]")) {
    if (_isInIgtInjected(el)) continue;
    const al = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (al === "back" || al === "go back" || al === "previous") {
      const c = _findClickableAncestor(el);
      if (c && _isVisible(c)) return c;
    }
  }
  // Geometry fallback. Prefer the LEFT-MOST empty/short-text button
  // in the upper-left quadrant of the viewport.
  let best = null;
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
  for (const b of buttons) {
    if (_isInIgtInjected(b)) continue;
    if (!_isVisible(b)) continue;
    const txt = (b.innerText || b.textContent || "").trim();
    if (txt.length > 3) continue;       // empty or single-char like "<"
    const r = b.getBoundingClientRect();
    if (r.top < 0 || r.top > 220) continue;     // top of viewport only
    if (r.left > window.innerWidth / 2) continue;  // left half only
    if (r.width < 20 || r.width > 80) continue;    // small button
    if (r.height < 20 || r.height > 80) continue;
    if (!best || r.left < best.r.left) best = { el: b, r };
  }
  return best ? best.el : null;
}

// Find the destination header row on the confirm modal — the box
// containing text like "joshuajyeung • Instagram • Export to Device
// · Once". Used by the dest-fix when the chooseWhere chooser is
// collapsed (Layout B) and we need to click the header to open it.
//
// Strategy: scan all visible elements for ones whose text matches the
// active-destination header pattern (the same regex `detectActive
// Destination` uses). Of those, prefer the SMALLEST text-content
// element that still contains a clickable wrapper — that's typically
// the row container, not the whole modal body.
function _findDestinationHeaderRow() {
  const re = /(?:export|download|send|save|transfer)\s+to\s+(?:[^\n·•]+?)\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i;

  // Strict pass: look for an actual <button> or [role='button']
  // whose innerText matches the active-destination pattern. The
  // user-click log proved Meta's "Create export" structure is
  // <div role=none><div role=button><div>...</div></div></div>
  // — the React-bound click target is the role=button MIDDLE
  // wrapper. The destination row likely follows the same pattern.
  // Picking the smallest matching button = the row, not a larger
  // container.
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
  let bestBtn = null;
  let bestBtnLen = Infinity;
  for (const b of buttons) {
    if (_isInIgtInjected(b)) continue;
    if (!_isVisible(b)) continue;
    const txt = (b.innerText || b.textContent || "").trim();
    if (!txt || txt.length > 300) continue;
    if (!re.test(txt)) continue;
    if (txt.length < bestBtnLen) {
      bestBtn = b;
      bestBtnLen = txt.length;
    }
  }
  if (bestBtn) {
    console.log(`[IG Tracker] _findDestinationHeaderRow: strict match → ${_describe(bestBtn)}`);
    return bestBtn;
  }

  // Lenient fallback: smallest text-matching element, then climb up
  // PREFERRING role=button / <button> / role=link / <a> over any
  // cursor:pointer wrapper. Previous _climbToClickable returned the
  // first ancestor matching ANY clickable signal — usually a
  // cursor:pointer wrapper div, NOT the role=button — so the click
  // hit a wrapper that doesn't fire React's handler.
  const all = Array.from(document.querySelectorAll("*"));
  let bestEl = null;
  for (const el of all) {
    if (_isInIgtInjected(el)) continue;
    if (!_isVisible(el)) continue;
    const txt = (el.innerText || el.textContent || "").trim();
    if (!txt || txt.length > 200) continue;
    if (!re.test(txt)) continue;
    if (!bestEl || txt.length < bestEl.txt.length) {
      bestEl = { el, txt };
    }
  }
  if (!bestEl) return null;
  // Custom climb: STRONG hit (role=button / <button> / role=link / <a>)
  // wins immediately. WEAK hit (cursor:pointer etc.) is kept as
  // fallback if no strong hit shows up before document.body.
  let cur = bestEl.el;
  let strongHit = null;
  let weakHit = null;
  for (let i = 0; cur && cur !== document.body && i < 10; i++, cur = cur.parentElement) {
    if (_isInIgtInjected(cur) || !_isVisible(cur)) continue;
    const role = cur.getAttribute && cur.getAttribute("role");
    const tag = (cur.tagName || "").toLowerCase();
    if (role === "button" || role === "link" || tag === "button" || tag === "a") {
      strongHit = cur;
      break;
    }
    if (!weakHit && _isClickable(cur)) weakHit = cur;
  }
  const target = strongHit || weakHit || bestEl.el;
  console.log(`[IG Tracker] _findDestinationHeaderRow: ${strongHit ? "lenient-strong" : weakHit ? "lenient-weak" : "leaf"} → ${_describe(target)}`);
  return target;
}

// Switch destination to Google Drive when the confirm modal is on
// device. Meta ships TWO confirm-modal layouts:
//
//   Layout A — chooser INLINE: both "Export to device" and
//   "Export to external service" buttons are visible on the confirm
//   modal alongside the other rows. Click external service directly.
//
//   Layout B — chooser COLLAPSED: only the destination header
//   ("joshuajyeung • Instagram • Export to Device · Once") is shown.
//   Clicking that header opens a "Choose where to export" sub-modal
//   on top, which has the two buttons. Then click external service.
//
// We try A first (cheap text check). If external service isn't on
// the page, fall back to B: find the destination header by its
// "Export to <X> · Once" text and click it to open the chooser.
async function _navigateBackToFixDest() {
  // Activate the stricter user-click guard for the duration of the
  // multi-strategy dest-fix. Any user click during this window
  // invalidates verification, so we want to halt fast and clearly.
  window.__igtInDestFix = true;
  _userClickedDuringDestFix = false;
  try {
    return await _navigateBackToFixDestInner();
  } finally {
    window.__igtInDestFix = false;
  }
}

async function _navigateBackToFixDestInner() {
  // Layout A: chooser already inline. Try MULTIPLE click strategies
  // in sequence, checking after each whether the page advanced.
  // Stops at the first one that works. Each strategy targets the
  // same goal ("click Export to external service") via a different
  // mechanism — covers the case where one strategy hits a wrapper
  // that doesn't fire React's handler while another does.
  if (findByText("Export to external service")) {
    console.log("[IG Tracker] dest-fix: Layout A — chooser inline, running multi-strategy");
    _traceVisibleButtons("dest-fix Layout A entry");

    const strategies = [
      // Strategy 1: strict button match + trusted-click. Targets the
      // <button>/[role=button] element directly.
      {
        name: "strict-button",
        fn: async () => {
          const btn = _findStrictButton("Export to external service");
          if (!btn) return false;
          console.log(`[IG Tracker] dest-fix S1 strict-button → ${_describe(btn)}`);
          await _trustedClick(btn);
          return true;
        },
      },
      // Strategy 2: fixed-offset click below "Export to device" via
      // direct chrome.debugger dispatch at viewport coords.
      {
        name: "fixed-offset",
        fn: async () => {
          if (!_findStrictButton("Export to device")) return false;
          console.log(`[IG Tracker] dest-fix S2 fixed-offset (53px below 'Export to device')`);
          return await _clickAtOffsetFromButton("Export to device", 0, 53);
        },
      },
      // Strategy 3: walk ancestors of the matched leaf, clicking each
      // until one fires React's handler. Same pattern as howOften.
      {
        name: "ancestor-walk",
        fn: async () => {
          const leaf = findByText("Export to external service");
          if (!leaf) return false;
          let cur = leaf;
          for (let lvl = 0; cur && cur !== document.body && lvl < 6; lvl++, cur = cur.parentElement) {
            console.log(`[IG Tracker] dest-fix S3 ancestor-walk L${lvl} → ${_describe(cur)}`);
            await _trustedClick(cur);
            await sleep(700);
            if (_destFixAdvanced()) return true;
          }
          return false;
        },
      },
      // Strategy 4: dispatch an explicit pointermove + click event
      // sequence on the strict button to simulate hover-then-click,
      // in case Meta's React component requires a hover state first.
      {
        name: "pointer-sequence",
        fn: async () => {
          const btn = _findStrictButton("Export to external service");
          if (!btn) return false;
          const r = btn.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          console.log(`[IG Tracker] dest-fix S4 pointer-sequence → ${_describe(btn)} @ (${cx},${cy})`);
          // Synthesize a richer event sequence including hover.
          const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
          try { btn.dispatchEvent(new PointerEvent("pointerover",  { ...opts, pointerType: "mouse" })); } catch (_) {}
          try { btn.dispatchEvent(new PointerEvent("pointerenter", { ...opts, pointerType: "mouse" })); } catch (_) {}
          try { btn.dispatchEvent(new MouseEvent("mouseover", opts)); } catch (_) {}
          try { btn.dispatchEvent(new MouseEvent("mouseenter", opts)); } catch (_) {}
          await sleep(80);
          await _trustedClick(btn);
          return true;
        },
      },
    ];

    let advanced = false;
    for (const s of strategies) {
      // Halt immediately if user clicked anything during dest-fix.
      // (See _userClickedDuringDestFix wiring above.)
      if (_userClickedDuringDestFix) {
        console.warn(`[IG Tracker] dest-fix: user click detected — halting before strategy "${s.name}"`);
        _setStatusFinal("error", "You clicked during auto-fix — halted",
          "Don't click anything while the bot is running the destination fix. Re-run from popup.", 60000);
        return false;
      }
      console.log(`[IG Tracker] dest-fix: trying strategy "${s.name}"`);
      try {
        const ok = await s.fn();
        if (!ok) { console.log(`[IG Tracker] dest-fix: strategy "${s.name}" couldn't run`); continue; }
      } catch (e) {
        console.warn(`[IG Tracker] dest-fix: strategy "${s.name}" threw: ${e.message}`);
        continue;
      }
      // IMMEDIATE check before any wait — captures whether the click
      // had instant effect (no time for user interference).
      const immediate = _destFixAdvanced();
      if (immediate) {
        console.log(`[IG Tracker] dest-fix: strategy "${s.name}" advanced IMMEDIATELY → ${immediate}`);
        advanced = true;
        break;
      }
      // Short wait for delayed React renders, then re-check. Capped
      // at 400ms — short enough that a slow user can't easily click
      // during it. Trace immediately after click so log shows the
      // post-click state regardless.
      _traceVisibleButtons(`after strategy "${s.name}" (immediate)`);
      await sleep(400);
      // User-click check before re-evaluating — if user clicked
      // during the 400ms, the post-wait state is contaminated.
      if (_userClickedDuringDestFix) {
        console.warn(`[IG Tracker] dest-fix: user click during wait after "${s.name}" — halting`);
        return false;
      }
      const result = _destFixAdvanced();
      if (result) {
        console.log(`[IG Tracker] dest-fix: strategy "${s.name}" advanced after wait → ${result}`);
        advanced = true;
        break;
      } else {
        console.log(`[IG Tracker] dest-fix: strategy "${s.name}" clicked but page didn't advance`);
      }
    }

    if (!advanced) {
      console.warn("[IG Tracker] dest-fix: all 4 strategies failed on Layout A");
      _dumpDOMSnapshot("dest-fix Layout A all-failed", { matchText: "export to external" });
      _dumpDOMSnapshot("dest-fix Layout A all-failed (device button area)", { matchText: "export to device" });
      return false;
    }
    await sleep(500);
  } else {
    // Layout B: chooser collapsed. Programmatic click on the
    // destination header has been proven to NOT open the chooser
    // (multiple runs across v1.0.92–107: identical button traces
    // before and after the click — no state change). Meta's React
    // doesn't bind a click handler to any of the destination-header
    // divs that's reachable via chrome.debugger Input.dispatchMouseEvent.
    //
    // Pragmatic fallback: halt with a clear prompt asking the user
    // to click the destination row ONCE (their real cursor click
    // does work — we've seen it succeed in past logs). Poll for the
    // chooser to appear (Layout A becomes visible). Once it does,
    // resume into the multi-strategy click below.
    console.warn("[IG Tracker] dest-fix: Layout B (chooser collapsed) — programmatic header click is known-broken");
    console.log("[IG Tracker] dest-fix: surfacing manual prompt; waiting for chooser to open");
    _setStatus({
      state: "needs-help",
      step: "👆 Click the destination row at the top of the modal",
      detail: "Click 'Export to Device · Once' at the top — that opens the destination chooser. Bot resumes automatically.",
    });
    _showManualPrompt(
      "Click the destination row",
      'At the top of the confirm modal, click the row that says <b>"Export to Device · Once"</b>. That opens a chooser with two options. The bot will take over from there.'
    );
    const t0 = Date.now();
    let chooserOpen = false;
    while (Date.now() - t0 < 5 * 60 * 1000) {
      await sleep(800);
      // If the user closes / cancels the wizard, exit cleanly.
      try { await _abortIfStopped(); } catch (e) {
        _hideManualPrompt();
        throw e;
      }
      if (findByText("Export to external service")) { chooserOpen = true; break; }
    }
    _hideManualPrompt();
    if (!chooserOpen) {
      console.warn("[IG Tracker] dest-fix: chooser didn't open within 5 min — giving up");
      return false;
    }
    console.log("[IG Tracker] dest-fix: chooser opened — running multi-strategy click");
    _setStatus({ state: "running", step: "Resuming…", detail: "Chooser is open — clicking external service." });
    // Recursively call the same function — now that "Export to
    // external service" is visible, the Layout A branch will run
    // and execute the 4-strategy multi-fix.
    return await _navigateBackToFixDestInner();
  }
  _traceVisibleButtons("after Export-to-external click");

  // Step 2: drive whatever comes next until destination is drive on
  // confirm. Could be a service chooser inline, a separate screen, or
  // straight back to confirm with drive selected. Try up to 12
  // iterations.
  for (let i = 0; i < 12; i++) {
    const t = _wizardPageText();

    // Success: confirm header now shows Drive (and not device).
    const hasDeviceHeader = /(?:export|download|save)\s+to\s+(?:your\s+)?device\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i.test(t);
    const hasDriveHeader = /(?:export|send|transfer)\s+to\s+(?:google\s+)?drive\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i.test(t);
    if (hasDriveHeader && !hasDeviceHeader) {
      console.log(`[IG Tracker] dest-fix: confirm now shows Drive after iter ${i} ✓`);
      return true;
    }

    // Service chooser: pick Google Drive if visible.
    if (findByText("Google Drive")) {
      console.log(`[IG Tracker] dest-fix: iter ${i} — clicking Google Drive`);
      await _clickButtonByText("Google Drive");
      await sleep(1200);
      // After picking Drive, click Next/Continue/Save if present.
      for (const lbl of ["Next", "Continue", "Save", "Done"]) {
        if (await _clickButtonByText(lbl)) {
          console.log(`[IG Tracker] dest-fix: iter ${i} — clicked "${lbl}" after Google Drive`);
          await sleep(1500);
          break;
        }
      }
      continue;
    }

    // howOften screen mid-flow.
    if (/choose how often|how often you want to export/i.test(t)) {
      console.log(`[IG Tracker] dest-fix: iter ${i} — howOften, clicking Next`);
      if (!(await _clickButtonByText("Next"))) {
        await _clickButtonByText("Continue");
      }
      await sleep(2000);
      continue;
    }

    // connect screen mid-flow.
    if (/connect to google drive/i.test(t)) {
      console.log(`[IG Tracker] dest-fix: iter ${i} — connect, clicking Connect`);
      await _clickButtonByText("Connect");
      await sleep(8000);
      continue;
    }

    // Nothing actionable yet — give the page a beat.
    console.log(`[IG Tracker] dest-fix: iter ${i} — waiting (no actionable element)`);
    await sleep(1200);
  }
  console.warn("[IG Tracker] dest-fix: hit iteration cap without reaching drive");
  _traceVisibleButtons("dest-fix: final state");
  return false;
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
  // Activate the danger-click guard. _initUserClickTracker() is
  // called from main(), but we use this flag specifically to scope
  // the danger check to "wizard is currently driving" — outside of
  // a run, the user clicking "Export to device" is fine and shouldn't
  // interrupt anything.
  window.__igtWizardRunning = true;
  _userPickedDeviceDuringRun = false;
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
        // Specific markers from later screens only. We deliberately
        // do NOT use `(google drive && dropbox)` or bare `date range`
        // here, because the May 2026 manage-requests modal contains
        // existing-request descriptions that mention "Google Drive"
        // and a destination list that includes "Dropbox" — both
        // present even though we're still on start. False positive
        // would set advanced=true and skip the Create-export click.
        return t.includes("choose where to export") ||
               t.includes("where do you want to export") ||
               t.includes("choose how often") ||
               t.includes("how often you want to export") ||
               t.includes("choose an external service") ||
               t.includes("connect to google drive") ||
               (t.includes("date range") && t.includes("customize information"));
      };
      let advanced = false;

      // Step 1: open the Create-export modal if it isn't already open.
      // Wait + retry up to 4 seconds for at least ONE candidate to be
      // findable before declaring step 1 exhausted. Without this, we
      // sometimes raced page layout and exhausted in 200ms with all
      // candidates returning null even though the elements were
      // about to render.
      if (!hasCreateExport()) {
        console.log("[IG Tracker] start: step 1 — opening wizard modal");
        const findAnyNav = () => {
          for (const lbl of navCandidates) {
            const el = findByText(lbl);
            if (el) return { el, lbl };
          }
          return null;
        };
        let firstSeen = findAnyNav();
        const t0 = Date.now();
        while (!firstSeen && !hasCreateExport() && Date.now() - t0 < 4000) {
          await sleep(400);
          firstSeen = findAnyNav();
        }
        if (!firstSeen && !hasCreateExport()) {
          console.warn(`[IG Tracker] start: step 1 — no candidate findable after ${Date.now() - t0}ms; matchers all null`);
        }
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
      // Capped at 2 ancestor levels. After each click, POLL up to
      // 3 seconds for advancement instead of using a fixed 400ms
      // sleep — Meta's React render can take 1-2s in a backgrounded
      // or busy tab, and the fixed sleep was missing transitions
      // that DID succeed (user's screenshot showed "Step 0: start"
      // status while the page was already on chooseWhere — bot's
      // L0 click had worked but the check ran before the new
      // screen had rendered).
      if (advancedPastStart()) {
        advanced = true;
      } else if (hasCreateExport()) {
        console.log("[IG Tracker] start: step 2 — clicking Create export");
        const ce = findByText("Create export");
        if (ce) {
          let cur = ce;
          for (let level = 0; level < 2; level++) {
            if (!cur || cur === document.body) break;
            console.log(`[IG Tracker] start: Create-export click L${level} → ${_describe(cur)}`);
            await _trustedClick(cur);
            // Poll for advancement up to 3s, exiting as soon as it
            // happens. 100ms granularity catches fast renders;
            // 3s ceiling catches slow tabs.
            const tStart = Date.now();
            while (Date.now() - tStart < 3000) {
              if (advancedPastStart()) break;
              await sleep(100);
            }
            if (advancedPastStart()) {
              advanced = true;
              console.log(`[IG Tracker] start: advanced past start after Create-export L${level} (${Date.now() - tStart}ms wait)`);
              break;
            }
            cur = cur.parentElement;
          }
        }
      }

      if (!advanced) {
        console.warn("[IG Tracker] start: auto-attempts exhausted — manual fallback");
        // Look at what's actually on the page right now and tailor
        // the prompt to that. The previous prompt always said "Click
        // Create export" even when the user had already advanced and
        // was looking at the chooser ("Choose where to export") —
        // confusing.
        const pageText = _wizardPageText().toLowerCase();
        let title, detailHtml;
        if (pageText.includes("choose where to export") ||
            (pageText.includes("export to external service") && pageText.includes("export to device"))) {
          title = "Click 'Export to external service'";
          detailHtml = 'Pick <b>"Export to external service"</b>, then on the next screen choose <b>Google Drive</b> → <b>Next</b>. The bot will resume.';
        } else if (pageText.includes("choose an external service") ||
                   (pageText.includes("google drive") && pageText.includes("dropbox"))) {
          title = "Pick 'Google Drive'";
          detailHtml = 'Click <b>Google Drive</b> in the list, then <b>Next</b>. The bot will resume.';
        } else if (pageText.includes("choose how often")) {
          title = "Click 'Once' then 'Next'";
          detailHtml = 'Pick <b>Once</b>, then <b>Next</b>. The bot will resume.';
        } else if (pageText.includes("connect to google drive")) {
          title = "Click 'Connect'";
          detailHtml = 'Click the blue <b>Connect</b> button to authorize Google Drive. The bot resumes after the OAuth handoff.';
        } else if (pageText.includes("create export")) {
          title = "Click 'Create export'";
          detailHtml = 'Click the big blue <b>"Create export"</b> button. The wizard will pick up from there.';
        } else {
          title = "Click whichever button is on screen";
          detailHtml = "I can't tell which screen you're on right now. Click whatever's visible — the bot will resume from the next recognized state.";
        }
        _setStatus({
          state: "needs-help",
          step: "👆 " + title,
          detail: "Couldn't auto-click. Bot resumes once you advance.",
        });
        _showManualPrompt(title, detailHtml);
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
      // Choose where to export: pick "Export to external service".
      // Trusted-click on the row's clickable ancestor — synthetic
      // clicks are silently rejected by Meta's React gate here, which
      // is why this step appeared to be a no-op for the user (they
      // had to click it manually).
      _traceVisibleButtons("chooseWhere entry");
      let whereOk = false;
      for (const lbl of [
        "Export to external service",
        "Send to destination",
        "Send to a destination",
        "Transfer to a destination",
        "External service",
        "To an external service",
      ]) {
        if (await _clickButtonByText(lbl)) { whereOk = true; break; }
      }
      if (!whereOk) console.warn("[IG Tracker] chooseWhere: no candidate button found");
      await _settle();
    } else if (screen === "chooseService") {
      // Pick Google Drive from the radio list, then click Next.
      // Same trusted-click switch as chooseWhere.
      _traceVisibleButtons("chooseService entry");
      let serviceOk = false;
      for (const lbl of ["Google Drive"]) {
        if (await _clickButtonByText(lbl)) { serviceOk = true; break; }
      }
      if (!serviceOk) console.warn("[IG Tracker] chooseService: Google Drive not found");
      await _settle();
      await sleep(600);
      // Wait for Next to enable (radio takes a moment to register).
      const nextEnabled = () => {
        const n = findByText("Next") || findByText("Continue");
        if (!n) return false;
        let cur = n;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
          if (!cur.getAttribute) continue;
          if (cur.getAttribute("aria-disabled") === "true") return false;
          if (cur.disabled === true) return false;
        }
        try {
          const cs = getComputedStyle(n);
          if (cs.pointerEvents === "none") return false;
          if (parseFloat(cs.opacity || "1") < 0.5) return false;
        } catch (_) {}
        return true;
      };
      const t0 = Date.now();
      while (!nextEnabled() && Date.now() - t0 < 4000) {
        await sleep(300);
      }
      if (!(await _clickButtonByText("Next"))) {
        await _clickButtonByText("Continue");
      }
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
          _showManualPrompt(
            "Click 'Once' then 'Next'",
            'Meta blocks automated clicks on this one screen.<br>Click <b>"Once"</b> then <b>"Next"</b> below — the rest will resume automatically.'
          );
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
      // "Connect to Google Drive" → trusted-click the Connect button.
      // Same isTrusted-gate concern as chooseWhere/chooseService.
      _traceVisibleButtons("connect entry");
      if (!(await _clickButtonByText("Connect"))) {
        await _clickButtonByText("Continue");
      }
      // OAuth may take several seconds to redirect — the explicit wait
      // below uses WAIT_AFTER_CONNECT_MS for this reason. If we leave
      // the page (script dies) the post-redirect run picks up at
      // confirm. If we stay (already authed), screen becomes confirm
      // shortly.
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
  // Poll for the Format row to be findable before starting Stage 2.
  // The screen detector flags `confirm` as soon as the modal heading
  // text appears, but the row buttons can take a moment longer to
  // mount. The poll exits AS SOON AS Format is findable (often
  // within ~200ms on a normal render), with an 8s cap for the rare
  // mid-transition case. v1.0.109 log without this guard: 15 row-
  // search timeouts because the bot started Stage 2 too eagerly.
  const stage2Ready = Date.now();
  while (Date.now() - stage2Ready < 8000) {
    if (findRowByLabel("Format")) break;
    await sleep(200);
  }
  const readyMs = Date.now() - stage2Ready;
  if (!findRowByLabel("Format")) {
    console.warn(`[IG Tracker] Stage 2: Format row not findable after ${readyMs}ms — proceeding anyway`);
  } else if (readyMs > 0) {
    console.log(`[IG Tracker] Stage 2: rows ready after ${readyMs}ms — starting`);
  }

  // Destination safety check (position-based). The active destination
  // heading on the confirm modal is shown at the very top of the
  // dialog ("Export to Google Drive · Once" / "Download to your
  // device · Once"). Past activity / available downloads sections
  // appear LATER in the body text and may mention either destination
  // for historical reasons.
  //
  // Strategy: find the FIRST occurrence of any "export to X" /
  // "download to X" phrase in the body text. Whichever appears first
  // is the active destination. This ignores past-request mentions
  // entirely, since those come after the active heading.
  //
  // We also actively attempt to FIX a wrong destination by clicking
  // into the destination row and selecting Google Drive — only abort
  // if the fix fails too.
  // Detect the active destination on the confirm modal. The previous
  // implementation scanned body text for "export to X" needles —
  // unreliable because past-request descriptions and option lists also
  // contain those phrases. Today's bug: detector said "drive" because
  // some past-request text contained "export to google drive" earlier
  // in the body, while the actual selected destination shown to the
  // user was "Export to Device · Once". Bot proceeded → submitted to
  // device.
  //
  // New approach: match the EXACT active-destination header pattern,
  // which is "<verb> to <destination> · <frequency>" with the trailing
  // " · Once/Daily/Monthly/Yearly" frequency. Past requests in the
  // listing don't use this exact pattern (they say things like
  // "specific information transfer to Google Drive" without a
  // trailing frequency separator), so this discriminator is reliable.
  //
  // Plus a paranoid safety net: if the body text contains the literal
  // active-destination format with "device" anywhere, treat it as
  // device regardless of what else we found. False positives here just
  // halt the export, which is recoverable; a wrong-destination submit
  // is not.
  const detectActiveDestination = () => {
    const t = _wizardPageText();
    const re = /(?:export|send|download|save|transfer)\s+to\s+([^\n·•]+?)\s*[·•]\s*(once|daily|monthly|yearly)\b/gi;
    const matches = [...t.matchAll(re)];
    let kind = null, needle = null, idx = -1;
    if (matches.length > 0) {
      // First match wins — the active destination heading is at the
      // top of the modal and renders before any past-request listing.
      const m = matches[0];
      const target = m[1].trim().toLowerCase();
      if (target.includes("device")) kind = "device";
      else if (target.includes("google drive") || /\bdrive\b/.test(target)) kind = "drive";
      else if (target.includes("dropbox")) kind = "dropbox";
      else kind = "unknown:" + target.slice(0, 40);
      needle = m[0].toLowerCase();
      idx = m.index;
    }
    // Safety net: even if we matched drive, scan for any clear "device"
    // active-destination pattern. If found, return device — better to
    // over-halt than wrong-submit.
    const deviceRe = /(?:export|download|save)\s+to\s+(?:your\s+)?device\s*[·•]\s*(?:once|daily|monthly|yearly)\b/i;
    if (deviceRe.test(t) && kind !== "device") {
      console.warn("[IG Tracker] dest-detect: safety net triggered — body has 'X to device · Once' pattern, overriding to device");
      kind = "device";
      needle = "device-safety-net";
    }
    return { kind, needle, idx };
  };

  let destInfo = detectActiveDestination();
  console.log(`[IG Tracker] Stage 2: active destination detection — kind=${destInfo.kind} needle="${destInfo.needle}" pos=${destInfo.idx}`);

  if (destInfo.kind && destInfo.kind !== "drive") {
    // Destination is wrong. We've spent days trying every
    // programmatic switch we could think of — strict button click,
    // ancestor walk, fixed-offset coordinates, pointer-event
    // sequences, dom-snapshot analysis — and none reliably trigger
    // Meta's React handler from chrome.debugger.Input.dispatchMouseEvent.
    // The honest path: halt cleanly, wait for the user to do the
    // one click manually, then resume.
    console.warn(`[IG Tracker] Stage 2: dest=${destInfo.kind} on confirm — halting, asking user to switch manually`);
    _setStatus({
      state: "needs-help",
      step: "👆 Switch destination to Google Drive",
      detail: `Click the destination row at the top of the modal (says '${destInfo.needle || "Export to Device · Once"}'), then pick 'Export to external service' → 'Google Drive' → Next. Bot resumes when destination shows Google Drive.`,
    });
    _showManualPrompt(
      "Switch destination to Google Drive",
      'Click the destination row at top (currently <b>device</b>), then pick <b>"Export to external service"</b> → <b>"Google Drive"</b> → Next. The bot will pick up and submit once it sees Google Drive.'
    );
    const t0 = Date.now();
    let resolved = false;
    while (Date.now() - t0 < 5 * 60 * 1000) {
      await sleep(1500);
      try { await _abortIfStopped(); } catch (e) {
        _hideManualPrompt();
        throw e;
      }
      const re = detectActiveDestination();
      if (re.kind === "drive") {
        console.log("[IG Tracker] Stage 2: user switched destination to Google Drive ✓");
        resolved = true;
        break;
      }
    }
    _hideManualPrompt();
    if (!resolved) {
      _setStatusFinal(
        "error",
        `BLOCKED — destination is ${destInfo.kind}`,
        "Destination wasn't switched to Google Drive within 5 minutes. Cancel this export, switch destination manually, re-run.",
        300000,
      );
      throw new Error(`Stage 2 destination is ${destInfo.kind} on confirm — manual switch timed out`);
    }
    _setStatus({ state: "running", step: "Resuming…", detail: "Destination is Google Drive — picking up." });
  } else if (destInfo.kind === "drive") {
    console.log("[IG Tracker] Stage 2: active destination verified Google Drive ✓");
  } else {
    // No destination phrase found at all — could be a layout we
    // don't recognize. Surface a warning but don't auto-abort, in
    // case the user's Meta layout uses different wording.
    console.warn("[IG Tracker] Stage 2: no destination phrase detected — proceeding cautiously");
    _setStatus({
      state: "needs-help",
      step: "⚠ Verify destination before continuing",
      detail: "Couldn't detect destination from page text. Glance at the modal — if it says 'export to your device', cancel now.",
    });
  }

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

  // Last-line-of-defense destination check, right before submission.
  // If anything between the start-of-Stage-2 check and now changed
  // the active destination away from Google Drive (extra unlikely
  // given how synchronous our flow is, but worth one final sanity
  // probe), we abort instead of submitting to the wrong destination.
  const finalDest = detectActiveDestination();
  if (finalDest.kind && finalDest.kind !== "drive") {
    console.warn(`[IG Tracker] Stage 2: FINAL CHECK — destination is ${finalDest.kind}, refusing to click Start export`);
    _setStatusFinal(
      "error",
      `BLOCKED — destination is ${finalDest.kind}`,
      `Right before clicking Start export the destination was detected as ${finalDest.kind}. NOT submitting. Cancel this export, manually pick Google Drive, re-run.`,
      300000,
    );
    throw new Error(`Final-check destination is ${finalDest.kind}, not Google Drive — refused to submit`);
  }
  console.log(`[IG Tracker] Stage 2: final-check destination = ${finalDest.kind || 'unknown'} — proceeding with Start export`);

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
      // Mark the click as bot-fired so the user-click tracker doesn't
      // log it as "user click". HTMLInputElement.click() fires an
      // isTrusted=true event (Chrome special case), so the isTrusted
      // filter alone doesn't catch it — we need element identity.
      const r = box.getBoundingClientRect();
      _markBotClick(r.left + r.width / 2, r.top + r.height / 2, box);
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
      const cbr = cb.getBoundingClientRect();
      _markBotClick(cbr.left + cbr.width / 2, cbr.top + cbr.height / 2, cb);
      cb.click();
    }
  } else {
    // No toggle found — last resort, click the row itself in case the
    // whole row is the toggle target.
    const rr = row.getBoundingClientRect();
    _markBotClick(rr.left + rr.width / 2, rr.top + rr.height / 2, row);
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
  // Always-on user-click tracker. Logs every user click on the wizard
  // page to the [IG Tracker] debug log so it shows up in "Copy debug
  // log" output. Filters out bot-fired clicks via _markBotClick coord
  // matching. Helps diagnose "I had to do X manually — where exactly
  // did I click?" by capturing element/role/text/path for replay.
  _initUserClickTracker();
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
    // Clear the run flag on failure. Without this, the flag's 20-min
    // TTL keeps triggering re-runs every time the user navigates or
    // reloads the page — exactly the "why does it keep running again
    // and again" complaint. One failed run = stop. User must click
    // "Run automatic export now" again to retry.
    try { await consumeWizardFlag(); } catch (_) {}
  } finally {
    // Always disarm the wizard-running flag so danger-click guard
    // only fires while we're actively driving.
    window.__igtWizardRunning = false;
  }
})();

// Big, dismissable overlay for the howOften manual-click fallback.
// Draws attention without blocking interaction with the underlying
// pills (pointer-events: none on the panel, auto on the inner card so
// only the close button is interactive). Disappears once the wizard
// detects the page has advanced past howOften.
// Show a big-overlay manual prompt with caller-supplied instruction
// text. Both `title` and `detailHtml` are required because we use this
// from multiple screens and the wrong instruction is worse than none —
// previously the prompt hard-coded "Click Once then Next" (a howOften
// hint), which then got shown on the start screen too and confused the
// user (they were looking at a "Create export" button, not Once/Next).
function _showManualPrompt(title = "One manual click needed", detailHtml = "Resume automatically once you advance the wizard.") {
  // If a prompt is already up, refresh its text so a later callsite
  // can override an earlier (now-stale) instruction.
  let prompt = document.getElementById("igtracker-manual-prompt");
  if (!prompt) {
    prompt = document.createElement("div");
    prompt.id = "igtracker-manual-prompt";
    prompt.style.cssText = `
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483646; display: flex;
      align-items: flex-start; justify-content: center;
      padding-top: 80px;
      font-family: -apple-system, sans-serif;
    `;
    document.body.appendChild(prompt);
  }
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
        👆 ${title}
      </div>
      <div style="font-size: 13px; line-height: 1.5; opacity: 0.95;">
        ${detailHtml}
      </div>
    </div>
    <style>
      @keyframes igt-pulse {
        0%, 100% { transform: translateY(0); box-shadow: 0 12px 32px rgba(80,120,255,0.4); }
        50%      { transform: translateY(-3px); box-shadow: 0 18px 40px rgba(80,120,255,0.55); }
      }
    </style>
  `;
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
