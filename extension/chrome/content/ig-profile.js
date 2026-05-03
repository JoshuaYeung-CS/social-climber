// Profile overlay for instagram.com. When the user navigates to a profile
// page, fetches that profile's history from the local IG Tracker app and
// renders a small panel pinned to the top-right of the IG page.
//
// Instagram is a single-page app, so we can't rely on document_idle alone —
// we also watch URL changes via a MutationObserver on the document title
// (which IG updates per route). On every URL change, we re-evaluate.

const TAG_SYMS = {
  favorite: "★",
  want_remove: "✦",
  watchlist: "↺",
  disabled: "⚠",
  unavailable: "✕",
  random_request: "🎲",
};
const TAG_LABELS = {
  favorite: "Favorite",
  want_remove: "Want to remove",
  watchlist: "Wait-back",
  disabled: "Disabled",
  unavailable: "Unavailable",
  random_request: "Random request",
};

// IG paths that look like /<word>/ but aren't usernames.
const RESERVED = new Set([
  "explore", "reels", "direct", "p", "accounts", "accountscenter",
  "tv", "stories", "web", "about", "developer", "legal", "press",
  "ads", "blog", "creators", "directory", "fragment", "graphql",
  "static", "ajax", "api", "_n", "_u",
]);

let _settings = null;
let _lastUsername = null;
let _panelOpen = true;
let _panelEl = null;

function isProfilePath(pathname) {
  // Match /<username>/ or /<username>/<subpath>/ but exclude reserved roots.
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 1) return null;
  const first = parts[0];
  if (RESERVED.has(first.toLowerCase())) return null;
  // Usernames are alnum + period + underscore, 1–30 chars per IG rules.
  if (!/^[A-Za-z0-9._]{1,30}$/.test(first)) return null;
  return first;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(["trackerUrl", "showOverlay"]);
  return {
    trackerUrl: (stored.trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, ""),
    showOverlay: stored.showOverlay !== false,
  };
}

// All HTTP to the local tracker is delegated to the background service
// worker. Fetching directly from this content script would hit Chrome's
// mixed-content block (instagram.com is HTTPS, the tracker is HTTP).
async function bgFetch(url, init) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "tracker-fetch", url, init },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: "no response" });
      }
    );
  });
}

async function fetchLookup(username) {
  const r = await bgFetch(
    `${_settings.trackerUrl}/api/lookup?account=${encodeURIComponent(username)}`
  );
  if (!r.ok) return null;
  return r.body;
}

async function toggleTag(username, flag, value) {
  const r = await bgFetch(`${_settings.trackerUrl}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: username, flag, value }),
  });
  if (!r.ok) return null;
  return r.body;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  if (isNaN(d)) return iso;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Snapshot labels look like "2026-03-26_22-00-25"; render as a short date.
function fmtSnapshotLabel(label) {
  if (!label) return "";
  const m = String(label).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return label;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  if (isNaN(d)) return label;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtDateTime(ts) {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  if (isNaN(d)) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-US", sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "igtracker-overlay";
  panel.className = "igtracker-overlay";
  document.body.appendChild(panel);
  return panel;
}

// Read the actual IG profile page to determine if the account is public
// or private — much more reliable than the snapshot-history inference,
// when we have a page rendered in front of us. Returns "private" |
// "public" | null. Three signals checked, ordered most-to-least specific:
//
//   1. The "This Account is Private" / "This profile is private" banner
//      Instagram renders on private profiles you don't follow. If present
//      → private with high confidence.
//   2. JSON-LD <script> embedded in the head with profile metadata. Some
//      private accounts' og:description / structured data still expose
//      whether they're a personal-private account.
//   3. Presence of the post grid (article/img tiles) on the page body.
//      If posts are rendered AND no privacy banner → public. Note: a
//      private account you follow ALSO shows posts, so this signal alone
//      can't prove public — we only emit "public" when there's no
//      privacy banner AND posts are visible AND the page passes a few
//      sanity checks.
function detectPrivacyFromDOM() {
  try {
    const text = document.body?.innerText || "";
    // Highest-confidence signal: the literal banner text.
    if (/this\s+account\s+is\s+private/i.test(text)) return "private";
    if (/this\s+profile\s+is\s+private/i.test(text)) return "private";

    // Open-graph / structured data sometimes flags private accounts.
    const og = document.querySelector('meta[property="og:title"]')?.content || "";
    // Locked-emoji tends to appear in private profile titles for some locales.
    if (/🔒/.test(og)) return "private";

    // Public detection: presence of post-grid images with the alt-text
    // pattern IG uses, AND the page body contains a "posts"/"followers"
    // counts line. Both must be true to avoid false positives on the
    // logged-out splash page or transient render states.
    const postImages = document.querySelectorAll('main img[alt*="Photo by"], main img[alt*="Post by"]').length;
    const hasCounters = /\d[\d,. KMm]*\s+(posts|followers|following)/i.test(text);
    if (postImages > 0 && hasCounters) return "public";
  } catch (e) {
    // DOM access can throw during very early page lifecycle — fall through.
  }
  return null;
}

function renderEmpty(panel, username, reason) {
  panel.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Collapse">⇲</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      <div class="igt-username">${escapeHtml(username)}</div>
      <div class="igt-muted">${escapeHtml(reason)}</div>
    </div>
  `;
  bindHeaderActions(panel);
}

function renderCollapsed(panel, username, badge) {
  panel.classList.add("collapsed");
  panel.innerHTML = `
    <button class="igt-pill" data-action="expand" title="Expand">${badge || "tracker"} · @${escapeHtml(username)}</button>
  `;
  panel.querySelector("[data-action=expand]").addEventListener("click", () => {
    _panelOpen = true;
    panel.classList.remove("collapsed");
    refreshOverlay(username);
  });
}

function renderPanel(panel, username, data) {
  panel.classList.remove("collapsed");

  if (!data) {
    renderEmpty(panel, username, "Tracker offline or not running.");
    return;
  }
  if (data.found === false && !data.currently_follower && !data.currently_following && !data.currently_pending && !data.currently_incoming_request) {
    renderEmpty(panel, username, "Never seen in any snapshot.");
    return;
  }

  const tags = data.tags || {};
  const followsYou = !!data.currently_follower;
  const youFollow = !!data.currently_following;
  const pending = !!data.currently_pending;
  const incoming = !!data.currently_incoming_request;

  // Relationship pill.
  let rel = "no current relation", relKind = "muted";
  if (youFollow && followsYou) { rel = "mutual"; relKind = "good"; }
  else if (youFollow && incoming) { rel = "requesting to follow back"; relKind = "pending"; }
  else if (youFollow && !followsYou) { rel = "doesn't follow back"; relKind = "warn"; }
  else if (followsYou && !youFollow) { rel = "follows you only"; relKind = "info"; }
  else if (pending) { rel = "request pending"; relKind = "info"; }

  // Story lines from snapshot history.
  const lines = [];
  const fs = data.first_followed_snapshot;
  const ls = data.last_followed_snapshot;
  const fr = data.first_follower_snapshot;
  const lr = data.last_follower_snapshot;
  if (fs?.label) lines.push(`first followed you ${fmtSnapshotLabel(fs.label)}`);
  if (fr?.label) lines.push(`first appeared in your followers ${fmtSnapshotLabel(fr.label)}`);
  if (data.follow_runs_count && data.follow_runs_count > 1) {
    lines.push(`you followed them across ${data.follow_runs_count} separate runs`);
  }
  if (data.follower_runs_count && data.follower_runs_count > 1) {
    lines.push(`they followed you across ${data.follower_runs_count} separate runs`);
  }
  if (data.ever_was_follower && !followsYou) {
    if (lr?.label) lines.push(`last seen as follower ${fmtSnapshotLabel(lr.label)}`);
  }
  // Observed privacy from the actual IG page DOM beats inferred privacy
  // from snapshot history: if IG is showing "This Account is Private",
  // it definitely is. If the page is rendering a public-style header
  // (post count + post grid + "Follow" button without "Account is
  // Private" message), it's definitely public.
  const observedPrivacy = detectPrivacyFromDOM();
  if (observedPrivacy === "private") lines.push(`🔒 private (confirmed)`);
  else if (observedPrivacy === "public") lines.push(`🌐 public (confirmed)`);
  else if (data.privacy === "likely_private") lines.push(`🔒 likely private`);
  else if (data.privacy === "likely_public") lines.push(`🌐 likely public`);
  if (data.aliases && data.aliases.length > 1) {
    lines.push(`renamed: ${data.aliases.join(" → ")}`);
  }

  const tagBtns = Object.keys(TAG_SYMS).map((flag) => {
    const on = !!tags[flag];
    return `<button class="igt-tag ${on ? "on" : ""}" data-flag="${flag}" title="${TAG_LABELS[flag]}">${TAG_SYMS[flag]}</button>`;
  }).join("");

  panel.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Collapse">⇲</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      <div class="igt-username">${escapeHtml(username)}</div>
      <div class="igt-rel igt-rel-${relKind}">${escapeHtml(rel)}</div>
      ${lines.length ? `<ul class="igt-lines">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
      <div class="igt-tags">${tagBtns}</div>
      <a class="igt-link" href="${_settings.trackerUrl}/?lookup=${encodeURIComponent(username)}" target="_blank" rel="noopener">↗ open in tracker</a>
    </div>
  `;
  bindHeaderActions(panel);
  panel.querySelectorAll(".igt-tag").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const flag = btn.dataset.flag;
      const on = !btn.classList.contains("on");
      btn.classList.toggle("on", on);
      const result = await toggleTag(username, flag, on);
      if (result === null) {
        // revert
        btn.classList.toggle("on", !on);
      }
    });
  });
}

function bindHeaderActions(panel) {
  panel.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "collapse") {
        _panelOpen = false;
        const username = panel.querySelector(".igt-username")?.textContent || "";
        renderCollapsed(panel, username);
      } else if (action === "close") {
        panel.remove();
        _panelEl = null;
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

let _privacyRecheckTimer = null;

async function refreshOverlay(username) {
  if (!_settings.showOverlay) return;
  if (!_panelEl) _panelEl = buildPanel();
  if (!_panelOpen) {
    renderCollapsed(_panelEl, username);
    return;
  }
  // Show loading state immediately so the user knows the extension responded.
  _panelEl.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Collapse">⇲</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      <div class="igt-username">${escapeHtml(username)}</div>
      <div class="igt-muted">loading…</div>
    </div>
  `;
  bindHeaderActions(_panelEl);
  const data = await fetchLookup(username);
  renderPanel(_panelEl, username, data);

  // IG is a SPA — the DOM for the new profile may still be settling when we
  // first run the privacy detector. If we couldn't read it on first pass,
  // schedule a re-render in 1.5s so the panel can pick up the now-loaded
  // "Account is Private" banner / post grid. The lookup data isn't
  // re-fetched (server-side data is stable) — we only re-render to refresh
  // the DOM-derived privacy line.
  if (_privacyRecheckTimer) clearTimeout(_privacyRecheckTimer);
  if (detectPrivacyFromDOM() === null) {
    _privacyRecheckTimer = setTimeout(() => {
      // Bail if the user navigated away or closed the overlay.
      if (_panelEl && _lastUsername === username && _panelOpen) {
        renderPanel(_panelEl, username, data);
      }
    }, 1500);
  }
}

function onLocationMaybeChanged() {
  const username = isProfilePath(window.location.pathname);
  if (!username) {
    if (_panelEl) { _panelEl.remove(); _panelEl = null; }
    _lastUsername = null;
    return;
  }
  if (username === _lastUsername) return;
  _lastUsername = username;
  refreshOverlay(username);
}

(async function main() {
  _settings = await loadSettings();
  if (!_settings.showOverlay) return;

  // IG is a SPA — its history.pushState calls don't fire popstate. Patch
  // those + watch popstate so we re-render on every navigation.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () {
    const r = origPush.apply(this, arguments);
    setTimeout(onLocationMaybeChanged, 50);
    return r;
  };
  history.replaceState = function () {
    const r = origReplace.apply(this, arguments);
    setTimeout(onLocationMaybeChanged, 50);
    return r;
  };
  window.addEventListener("popstate", () => setTimeout(onLocationMaybeChanged, 50));

  // Initial pass.
  setTimeout(onLocationMaybeChanged, 200);

  // Listen for live setting changes from the popup so the overlay can be
  // toggled on/off without reloading the page.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.showOverlay) {
      _settings.showOverlay = changes.showOverlay.newValue !== false;
      if (!_settings.showOverlay && _panelEl) {
        _panelEl.remove();
        _panelEl = null;
      } else if (_settings.showOverlay) {
        _lastUsername = null;
        onLocationMaybeChanged();
      }
    }
    if (changes.trackerUrl) {
      _settings.trackerUrl = (changes.trackerUrl.newValue || "http://127.0.0.1:8000").replace(/\/$/, "");
      _lastUsername = null;
      onLocationMaybeChanged();
    }
  });
})();
