// Auto-fills Meta's "Download or transfer your information" wizard with
// the saved preferences (JSON, followers + following only, all time, Google
// Drive). Runs only when the popup explicitly requested an auto-export
// (chrome.storage.local.wizardRunRequested timestamp set in last 60s) so
// the user can still navigate the page manually without it taking over.
//
// Approach: at each step we describe the click as a target (button text,
// label content, or aria-label) and let a polling loop find and click it.
// Meta changes the underlying class names regularly, but the visible text
// they use ("Create export", "Next", "Save", category names) is stable.
//
// Per-step waits use both DOM-mutation observation and polling (max 10s
// per step) so we tolerate slow renders without spinning forever.

const STEP_TIMEOUT_MS = 10000;
const SETTLE_MS = 250;

// Fast-fail if no recent run request — user might just be on the page
// for other reasons (e.g. checking past exports).
async function shouldRun() {
  const stored = await chrome.storage.local.get(["wizardRunRequested"]);
  if (!stored.wizardRunRequested) return false;
  const age = Date.now() - stored.wizardRunRequested;
  // Consume the flag so we don't auto-run on accidental refreshes.
  await chrome.storage.local.set({ wizardRunRequested: 0 });
  return age < 60000; // 60 seconds
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

function _climbToClickable(el) {
  let cur = el;
  for (let i = 0; cur && cur !== document.body && i < 10; i++) {
    if (_isClickable(cur)) return cur;
    cur = cur.parentElement;
  }
  return el; // fall back to the original element if no clickable ancestor
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
  const target = String(text).trim().toLowerCase();
  if (!target) return null;
  const all = within.querySelectorAll("*");
  // Pass 1: a leaf node whose direct text equals the target — this is
  // typically the <span> inside a row that holds just "Google Drive"
  // or "JSON".
  for (const el of all) {
    const dt = _directText(el).toLowerCase();
    if (dt === target) return _climbToClickable(el);
  }
  // Pass 2: any element whose total textContent equals the target.
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t === target) return _climbToClickable(el);
  }
  // Pass 3: an element whose first line equals the target (rich rows
  // like "Google Drive\nAll available information").
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (!t) continue;
    const firstLine = t.split(/\n|·|·/)[0].trim();
    if (firstLine === target && t.length < 300) return _climbToClickable(el);
  }
  // Pass 4: substring match in a reasonably-bounded element.
  for (const el of all) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t.includes(target) && t.length < Math.max(target.length + 80, 120)) {
      return _climbToClickable(el);
    }
  }
  return null;
}

// Find the parent row containing a label, then the toggle/checkbox in it.
function findRowByLabel(text, within = document) {
  const target = String(text).trim().toLowerCase();
  const all = within.querySelectorAll("div, label, li");
  for (const el of all) {
    const direct = el.querySelector(":scope > div, :scope > span, :scope > label");
    const ownText = (el.textContent || "").trim().toLowerCase();
    // Match if the row's first line is the target, not just contains it.
    const firstLine = ownText.split("\n")[0].trim();
    if (firstLine === target || firstLine.startsWith(target + " ")) {
      return el;
    }
  }
  return null;
}

function clickElement(el) {
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.click();
  return true;
}

// Main flow. Each step waits for its trigger to appear, clicks it, then
// waits for the next page to render. Steps are idempotent — if we land on
// step 3 because the user already passed steps 1-2 manually, we skip.
async function runWizard() {
  console.log("[IG Tracker] Auto-export starting…");

  // Step 1: Create export
  await stepClick("Create export");

  // Step 2: Choose where to export
  await stepClick("Export to external service");

  // Step 3: Choose external service → Google Drive → Next
  await stepClick("Google Drive");
  await sleep(SETTLE_MS);
  await stepClick("Next");

  // Step 4: How often → Once is the default-selected; just press Next
  await stepClick("Next");

  // Step 5: Connect to Google Drive (Meta-side confirm; OAuth handled separately)
  await stepClick("Connect");

  // After Connect, Meta sends you to accounts.google.com if you need
  // re-auth. The google-oauth content script handles auto-clicking
  // Continue there if the user enabled that setting; otherwise the user
  // confirms manually. Either way we'll come back to the Confirm screen.

  // Step 6: Confirm screen — set Format → JSON
  // Click "Format" row, then "JSON", then "Save".
  await stepClickRow("Format");
  await stepClick("JSON");
  await stepClick("Save");

  // Step 7: Date range → All time → Save
  await stepClickRow("Date range");
  await stepClick("All time");
  await stepClick("Save");

  // Step 8: Customize information → uncheck everything, then check only
  // "Followers and following" under Connections, then Save.
  await stepClickRow("Customize information");
  await uncheckAll();
  await sleep(SETTLE_MS);
  await checkLabel("Followers and following");
  await stepClick("Save");

  // Step 9: Notify → fill in saved email if available, otherwise click
  // any pre-suggested method. Tolerant of being already-set (Save will
  // just close the row); tolerant of being missing (the row may not
  // appear on every wizard variant).
  try {
    await stepClickRow("Notify");
    const stored = await chrome.storage.local.get(["notificationEmail"]);
    const email = (stored.notificationEmail || "").trim();
    if (email) {
      const input = document.querySelector(
        "input[type='email']:not([disabled]), input[name*='email' i]:not([disabled])"
      );
      if (input) {
        input.scrollIntoView({ block: "center", behavior: "instant" });
        input.focus();
        await sleep(80);
        await typeRealistic(input, email);
        await sleep(SETTLE_MS);
      }
    }
    await stepClick("Save");
  } catch (e) {
    console.log("[IG Tracker] Notify step skipped:", e.message);
  }

  // Step 10: Start export
  await stepClick("Start export");

  // Step 11: Password verify (sometimes). Handled by passwordWatchdog().
  console.log("[IG Tracker] Wizard reached final step. Watching for password prompt…");
}

async function stepClick(text) {
  const el = await waitFor(() => findByText(text), { label: `click: ${text}` });
  console.log(`[IG Tracker] Click: ${text}`);
  clickElement(el);
  await sleep(SETTLE_MS);
}

async function stepClickRow(label) {
  const el = await waitFor(() => findRowByLabel(label), { label: `row: ${label}` });
  console.log(`[IG Tracker] Open row: ${label}`);
  clickElement(el);
  await sleep(SETTLE_MS);
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
    await sleep(SETTLE_MS);
  }
}

async function checkLabel(label) {
  // Find the row, then click whatever toggle is inside.
  const row = findRowByLabel(label);
  if (!row) throw new Error(`Couldn't find row: ${label}`);
  const cb = row.querySelector("[role='checkbox'], input[type='checkbox']");
  if (cb) {
    if (cb.getAttribute("aria-checked") !== "true" && !cb.checked) {
      cb.click();
    }
  } else {
    // Some toggles wrap the whole row
    row.click();
  }
  await sleep(SETTLE_MS);
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
      await sleep(120);
      await typeRealistic(pw, password);
      await sleep(180);
      // Find Submit / Continue / Confirm button.
      const submit = findByText("Confirm") || findByText("Continue") || findByText("Submit") || findByText("Save");
      if (submit) {
        console.log("[IG Tracker] Submitting password.");
        submit.click();
      }
      return;
    }
    await sleep(500);
  }
}

async function typeRealistic(el, text) {
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  for (const ch of text) {
    el.value += ch;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    await sleep(60 + Math.random() * 80);
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

// One-shot commands from the popup. Each runs a single discrete step
// of the wizard so the user can drive most of it manually and just
// click the IG Tracker button when they're on the right screen.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
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
    await sleep(SETTLE_MS);
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
    // Meta's Notify dialog uses different input types per region/version.
    // Cast a wider net: type=email, type=text with email-y placeholder,
    // any text input that's currently visible inside an open dialog.
    const candidates = Array.from(document.querySelectorAll(
      "input:not([disabled]):not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit'])"
    ));
    let input = null;
    // Prefer ones that look explicitly like an email field.
    for (const c of candidates) {
      const type = (c.getAttribute("type") || "").toLowerCase();
      const name = (c.getAttribute("name") || "").toLowerCase();
      const ph   = (c.getAttribute("placeholder") || "").toLowerCase();
      const al   = (c.getAttribute("aria-label") || "").toLowerCase();
      if (type === "email" || /email/.test(name) || /email/.test(ph) || /email/.test(al)) {
        input = c; break;
      }
    }
    // Fall back to the first visible text input on the page (the Notify
    // dialog's "Add new email" field renders as a generic text input).
    if (!input) {
      for (const c of candidates) {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { input = c; break; }
      }
    }
    if (!input) throw new Error("Couldn't find an email field on this page.");
    input.scrollIntoView({ block: "center", behavior: "instant" });
    input.focus();
    await sleep(80);
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
    // Show a small toast so the user knows where it got stuck.
    showToast(`IG Tracker auto-export stopped: ${e.message}. Click manually from here.`);
  }
})();

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
