// Google OAuth auto-click: when the user is sent to accounts.google.com
// during a Meta data-export flow, this script handles the two screens
// they typically encounter:
//
//   1. Account picker ("Choose an account to continue to Meta") — auto-
//      click the account row whose email matches `googleAccountEmail`
//      stored in chrome.storage. Skipped if no email is saved or no
//      matching account is shown — we never guess.
//   2. Consent screen ("Meta wants to access…") — auto-click Continue
//      / Allow if `autosubmitGoogle` is enabled.
//
// Both behaviors are opt-in via the popup, and we only ever act on
// Meta-branded OAuth pages so we can't accidentally click somewhere
// the user is doing unrelated Google sign-ins.

const META_MARKERS = [
  "meta wants access",
  "meta wants to access",
  "meta will be able to",
  "meta will receive",
  "to continue to meta",
];

function pageMentionsMeta() {
  const txt = (document.body?.innerText || "").toLowerCase();
  return META_MARKERS.some(m => txt.includes(m));
}

function findContinueButton() {
  // Google's OAuth pages render Continue / Allow as a real <button>,
  // but the "already trusted" consolidation screen uses a div with
  // role="button" inside a sticky footer. Cast a wider net.
  const TARGETS = ["continue", "allow", "confirm"];
  const candidates = document.querySelectorAll(
    "button, a[role='button'], div[role='button'], [role='button']"
  );
  // Pass 1: exact match (case-insensitive).
  for (const b of candidates) {
    const t = (b.textContent || "").trim().toLowerCase();
    if (TARGETS.includes(t)) return b;
  }
  // Pass 2: aria-label exact match.
  for (const b of candidates) {
    const al = (b.getAttribute && b.getAttribute("aria-label") || "").trim().toLowerCase();
    if (TARGETS.includes(al)) return b;
  }
  // Pass 3: short button-like elements containing the target word.
  // Bound text length to avoid matching wrappers that mention "Continue"
  // in a body paragraph somewhere.
  for (const b of candidates) {
    const t = (b.textContent || "").trim().toLowerCase();
    if (t.length < 30 && TARGETS.some(target => t.includes(target))) return b;
  }
  return null;
}

function _isClickable(el) {
  if (!el) return false;
  if (el.tagName === "BUTTON" || el.tagName === "A") return true;
  const role = el.getAttribute && el.getAttribute("role");
  if (role && /^(button|link|menuitem|option|tab)$/.test(role)) return true;
  if (el.tabIndex !== undefined && el.tabIndex >= 0) return true;
  try {
    if (getComputedStyle(el).cursor === "pointer") return true;
  } catch (_) {}
  return false;
}

function _climbToClickable(el) {
  let cur = el;
  for (let i = 0; cur && cur !== document.body && i < 8; i++) {
    if (_isClickable(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Find the account row on the Google account-picker matching the given
// email. Strategy:
//   1) Look for an element with data-email / data-identifier / aria-label
//      attribute whose value matches the target (most precise — Google
//      uses these on the chooser).
//   2) Fall back to text-content match — any element whose visible text
//      includes the email, then climb to a clickable ancestor.
function findAccountRow(email) {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;
  // Pass 1: data-attributes that Google uses for account identity.
  for (const el of document.querySelectorAll("[data-email], [data-identifier], [aria-label]")) {
    const v = (
      el.getAttribute("data-email") ||
      el.getAttribute("data-identifier") ||
      el.getAttribute("aria-label") ||
      ""
    ).toLowerCase();
    if (v === target || v.includes(target)) {
      return _climbToClickable(el) || el;
    }
  }
  // Pass 2: visible text that includes the email. Bound length to skip
  // the whole-page wrapper and any list-container that contains all
  // accounts at once.
  for (const el of document.querySelectorAll("*")) {
    const txt = (el.textContent || "").toLowerCase();
    if (!txt.includes(target)) continue;
    if (txt.length > 300) continue;
    return _climbToClickable(el) || el;
  }
  return null;
}

(async function main() {
  const stored = await chrome.storage.local.get([
    "autosubmitGoogle",
    "googleAccountEmail",
  ]);
  const targetEmail = (stored.googleAccountEmail || "").trim();
  const wantPickAccount = !!targetEmail;
  // If the user opted into account-picking, also auto-click Continue —
  // configuring an account email means they want the whole OAuth flow
  // hands-free. The autosubmitGoogle toggle still works as an
  // independent opt-in for users who don't set an email.
  const wantContinue = !!stored.autosubmitGoogle || wantPickAccount;
  if (!wantContinue && !wantPickAccount) return;
  console.log(`[IG Tracker] OAuth helper active (pickEmail=${targetEmail || "—"}, autoContinue=${wantContinue})`);

  // Single polling loop that handles both screens (account picker
  // → consent). Google's OAuth flow uses SPA navigation between these
  // screens — the document doesn't reload, so the content script
  // doesn't get re-injected; we have to keep polling and detect the
  // newly-rendered Continue button after the picker click.
  let pickDone = !wantPickAccount;
  let lastWarn = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!pageMentionsMeta()) {
      if (i > 0 && i % 10 === 0) {
        console.log(`[IG Tracker] OAuth: waiting for Meta-branded page text… (iter ${i})`);
      }
      continue;
    }

    if (!pickDone) {
      const row = findAccountRow(targetEmail);
      if (row) {
        console.log(`[IG Tracker] Auto-picking Google account ${targetEmail}.`);
        row.click();
        pickDone = true;
        // Keep looping — the consent screen mounts via SPA nav, no
        // page reload, so we need to find Continue on a later iter.
        continue;
      } else if (i - lastWarn > 6) {
        console.warn(`[IG Tracker] OAuth: account row for ${targetEmail} not found yet; still waiting.`);
        lastWarn = i;
      }
    }

    if (wantContinue) {
      const btn = findContinueButton();
      if (btn) {
        console.log("[IG Tracker] Auto-clicking Google OAuth Continue.");
        btn.click();
        return;
      }
    }
  }
  console.warn("[IG Tracker] OAuth: gave up after polling — page never matched, or click target not found.");
})();
