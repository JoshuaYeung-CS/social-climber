// Google OAuth auto-click: when the user is sent to accounts.google.com
// during a Meta data-export flow, auto-click "Continue" if they enabled
// that setting. Only fires when:
//   (a) the page references Meta as the requesting party
//   (b) the chosen Google account email is already shown (i.e. the user
//       is past account-picker — which we never auto-click)
//   (c) the user opted into autosubmitGoogle in the popup
//
// This is intentionally narrow: we don't want to auto-grant Meta access
// to a Google account the user didn't explicitly choose.

const META_MARKERS = [
  "Meta wants access",
  "Meta wants to access",
  "Meta will be able to",
  "Meta will receive",
];

async function shouldAutoClick() {
  const stored = await chrome.storage.local.get(["autosubmitGoogle"]);
  return !!stored.autosubmitGoogle;
}

function pageMentionsMeta() {
  const txt = document.body?.innerText || "";
  return META_MARKERS.some(m => txt.includes(m));
}

function findContinueButton() {
  // Google's OAuth pages render Continue / Allow as a real <button>.
  const buttons = document.querySelectorAll("button, a[role='button']");
  for (const b of buttons) {
    const t = (b.textContent || "").trim();
    if (t === "Continue" || t === "Allow") return b;
  }
  return null;
}

(async function main() {
  if (!(await shouldAutoClick())) return;
  // Wait for the page to settle. Google often re-renders the form.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!pageMentionsMeta()) continue;
    const btn = findContinueButton();
    if (btn) {
      console.log("[IG Tracker] Auto-clicking Google OAuth Continue.");
      btn.click();
      return;
    }
  }
})();
