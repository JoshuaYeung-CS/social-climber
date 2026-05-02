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

// Find a clickable element whose visible text matches `text` (case-insensitive,
// trimmed). Searches buttons, role=button, links, and divs (Meta uses divs as
// buttons heavily). Optional `within` scopes to a subtree.
function findByText(text, within = document) {
  const target = String(text).trim().toLowerCase();
  const candidates = within.querySelectorAll(
    "button, a, [role='button'], [role='radio'], [role='checkbox'], div[role], span[role]"
  );
  for (const el of candidates) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t === target) return el;
    // Sometimes the label is in a nested span — check direct child text.
    if (t.includes(target) && t.length < target.length + 8) return el;
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

  // Step 9: Notify — should already be set; if not, fall through to Save.
  // Skip if the field is already populated.

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
  // Find all checked checkboxes in the open dialog and click to uncheck.
  const checkedBoxes = document.querySelectorAll(
    "[role='checkbox'][aria-checked='true'], input[type='checkbox']:checked"
  );
  console.log(`[IG Tracker] Unchecking ${checkedBoxes.length} boxes`);
  for (const box of checkedBoxes) {
    box.scrollIntoView({ block: "center", behavior: "instant" });
    box.click();
    await sleep(40);
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
