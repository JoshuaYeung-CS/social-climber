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
  const stored = await chrome.storage.local.get(["trackerUrl", "vaultUrl", "showOverlay"]);
  return {
    trackerUrl: (stored.trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, ""),
    vaultUrl: (stored.vaultUrl || "").replace(/\/$/, ""),
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

// Find the largest currently-visible media element on the page. Used by
// the Save to Vault button to capture whatever the user is actually
// looking at (post viewer, story player, profile pic). Returns the
// element + a guess at the kind based on the URL pattern.
function findSaveableMedia() {
  const candidates = Array.from(document.querySelectorAll("main img, main video, [role='dialog'] img, [role='dialog'] video"));
  // Prefer videos (story / reel content) over images, and bigger over smaller.
  let best = null;
  let bestArea = 0;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    // Exclude profile-pic header image — it's tiny relative to the post.
    const isProfilePic = (el.alt || "").toLowerCase().includes("profile picture");
    if (isProfilePic && bestArea > 0) continue;
    const area = r.width * r.height + (el.tagName === "VIDEO" ? 1_000_000 : 0);
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  if (!best) return null;
  const path = window.location.pathname;
  let kind = "post";
  if (/^\/stories\/highlights\//.test(path)) kind = "highlight";
  else if (/^\/stories\//.test(path))         kind = "story";
  else if (/^\/reel\//.test(path))            kind = "reel";
  else if (/^\/p\//.test(path))               kind = "post";
  else if (/^\/[^/]+\/?$/.test(path))         kind = "post"; // profile page — best guess
  return {
    element: best,
    src: best.src || best.currentSrc,
    media_type: best.tagName === "VIDEO" ? "video" : "image",
    kind,
  };
}

// Save the currently visible media to the vault. Fetches the bytes via
// the background service worker (so cookies / signed URLs work, and we
// dodge mixed-content blocking), base64-encodes, and POSTs to the vault.
async function saveToVault(username) {
  if (!_settings.vaultUrl) {
    alert("Vault URL isn't set. Open the extension popup → Vault URL → Save settings.");
    return;
  }
  const cap = findSaveableMedia();
  if (!cap || !cap.src) {
    alert("Couldn't find a media element on this page. Try opening a post / story / reel first.");
    return;
  }

  // Fetch the bytes via the SW (avoids mixed-content + uses page cookies).
  const r = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "tracker-fetch-bytes", url: cap.src },
      (resp) => resolve(resp || { ok: false, error: "no response" })
    );
  });
  if (!r.ok || !r.body) {
    alert(`Couldn't download media: ${r.error || "unknown error"}`);
    return;
  }

  // Probe the vault first so we can fail loudly if it's locked.
  const health = await bgFetch(`${_settings.vaultUrl}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    alert("Vault is offline. Mount the encrypted volume and run `python -m vault` first.");
    return;
  }

  const save = await bgFetch(`${_settings.vaultUrl}/api/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: cap.kind,
      username: username,
      ig_url: window.location.href,
      ig_id: (window.location.pathname.match(/\/(?:p|reel|stories(?:\/highlights)?)\/([^/]+)/) || [])[1] || null,
      media_url: cap.src,
      media_type: cap.media_type,
      media_bytes_b64: r.body,
    }),
  });
  if (save.ok) {
    alert(`Saved to vault: ${cap.kind} from @${username}`);
  } else {
    alert(`Save failed: ${save.error || save.status || "unknown"}`);
  }
}

// Send an observed-profile snapshot back to the local tracker. Fire-and-
// forget — we don't await, the UI render shouldn't block on this. Only
// posts when we actually picked up SOMETHING from the DOM (otherwise
// we'd be sending empty rows that overwrite real data with NULLs).
function sendProfileObservation(username, profile, privacyDom, extra = {}) {
  const buttonState = extra.follow_button_state || detectFollowButtonState();
  const hasAnything = profile.posts || profile.followers || profile.following
    || profile.bio || profile.display_name || profile.verified
    || profile.profile_pic || profile.external_link
    || privacyDom === "private"
    || buttonState;
  if (!hasAnything) return;
  // is_private: only send TRUE when DOM actually showed the banner. Don't
  // send FALSE on banner-absent — could be a private account we follow.
  const is_private = privacyDom === "private" ? true : null;
  // is_unavailable: when we successfully extract profile data (counts,
  // bio, etc.) the page is loading normally → not unavailable. Sending
  // false explicitly clears any stale is_unavailable=true from a prior
  // observation if the account came back online.
  const is_unavailable = false;
  bgFetch(`${_settings.trackerUrl}/api/profile-observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      ...profile,
      is_private,
      is_unavailable,
      follow_button_state: buttonState,
      button_state_changed: !!extra.button_state_changed,
    }),
  }).catch(() => {});
}

// Watch the Follow / Requested / Following button for state changes. Used
// after the initial overlay render so we can react when the user clicks
// Follow on a private profile (button changes Follow → Requested) or
// Follow on a public one (Follow → Following). Both events are valuable
// to the tracker before the next official IG export reflects them.
function watchFollowButtonChanges(username) {
  const main = document.querySelector("main");
  if (!main) return null;
  let lastState = detectFollowButtonState();
  const observer = new MutationObserver(() => {
    const next = detectFollowButtonState();
    if (next && next !== lastState) {
      const wasNeutral = lastState === null || lastState === "not_following" || lastState === "follow_back_available";
      const newRelationship = wasNeutral && (next === "requested" || next === "following");
      if (newRelationship) {
        // POST a state-changed observation so the tracker records the
        // event timestamp (won't wait for the next export).
        sendProfileObservation(
          username,
          extractProfileFromDOM(),
          detectPrivacyFromDOM(),
          { follow_button_state: next, button_state_changed: true }
        );
        // Update overlay: show the green flash + re-fetch lookup so the
        // panel content reflects the just-recorded state (drops "Never
        // seen in any snapshot" → shows "you sent a follow request").
        if (_panelEl && _lastUsername === username && _panelOpen) {
          flashRequestedConfirmation(_panelEl, next);
          // Wait a tick so the observation write has reached the DB,
          // then re-fetch + render.
          setTimeout(() => {
            if (_panelEl && _lastUsername === username && _panelOpen) {
              fetchLookup(username).then((fresh) => {
                if (fresh && _panelEl && _lastUsername === username) {
                  renderPanel(_panelEl, username, fresh);
                  // Re-flash since renderPanel just wiped the overlay body.
                  flashRequestedConfirmation(_panelEl, next);
                }
              });
            }
          }, 350);
        }
      } else {
        // State changed (e.g. Following → Follow if user unfollowed) — record
        // the new state but don't flash the confirmation.
        sendProfileObservation(
          username,
          extractProfileFromDOM(),
          detectPrivacyFromDOM(),
          { follow_button_state: next, button_state_changed: true }
        );
      }
      lastState = next;
    }
  });
  observer.observe(main, { childList: true, subtree: true, characterData: true });
  return observer;
}

// Briefly highlight the overlay to confirm the request/follow was recorded.
function flashRequestedConfirmation(panel, state) {
  const body = panel.querySelector(".igt-body");
  if (!body) return;
  const note = document.createElement("div");
  note.className = "igt-flash";
  note.textContent = state === "requested"
    ? "✓ recorded: you sent a follow request"
    : "✓ recorded: you started following them";
  body.insertBefore(note, body.firstChild);
  setTimeout(() => { note.remove(); }, 4000);
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

// Read the current state of the Follow / Following / Requested button on
// the profile header. Returns one of:
//   "not_following"    — button says "Follow"
//   "requested"        — button says "Requested" (you sent a request that
//                        hasn't been accepted yet — happens for private
//                        accounts you tap Follow on)
//   "following"        — you currently follow them (button says "Following")
//   "follow_back_available" — button says "Follow back" (rare; appears on
//                              accounts who follow you that you don't yet)
//   null               — couldn't find the button (own profile, error, etc.)
function detectFollowButtonState() {
  try {
    const main = document.querySelector("main");
    const header = main?.querySelector("header") || document.querySelector("header");
    if (!header) return null;
    const candidates = header.querySelectorAll("button, [role='button']");
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (t === "Follow") return "not_following";
      if (t === "Requested") return "requested";
      if (t === "Following") return "following";
      if (t === "Follow back" || t === "Follow Back") return "follow_back_available";
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Detect IG's "Sorry, this page isn't available" / "User not found" state.
// The page is rendered for: deleted accounts, renamed accounts (URL stale),
// suspended accounts, accounts that blocked you, typos. All warrant the
// same response: tag "unavailable" in the tracker (the existing bucket
// auto-clears if they reappear in your followers, so this is reversible).
function detectAccountUnavailable() {
  try {
    const text = document.body?.innerText || "";
    if (/Sorry,\s*this\s+page\s+isn'?t\s+available/i.test(text)) return true;
    if (/User\s+not\s+found/i.test(text)) return true;
    if (/The\s+link\s+you\s+followed\s+may\s+be\s+broken/i.test(text)) return true;
    if (/page\s+may\s+have\s+been\s+removed/i.test(text)) return true;
  } catch (e) {
    // ignore
  }
  return false;
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
// Pull header-level profile info (counts, display name, verified badge,
// profile pic, bio) from the profile page DOM. Pure DOM reading — never
// triggers a network request to Instagram. Safe across all profile
// states (logged in / out, follow / not follow, private / public).
//
// IG's class names are obfuscated and rotate weekly, so we lean on
// stable structural elements (`header`) and stable text patterns
// ("X posts", "Y followers") rather than CSS selectors that'd break.
function extractProfileFromDOM() {
  const out = {};
  // If IG is showing "page not available", the longest text on the page is
  // the error message — naive extraction would write it as the bio. Bail
  // early; the unavailable-tag flow signals the state instead.
  if (detectAccountUnavailable()) return out;
  try {
    const main = document.querySelector("main");
    const header = main?.querySelector("header") || document.querySelector("header") || main || document.body;
    const headerText = header?.innerText || "";

    // Counts row — "1,234 posts", "5.5K followers", "1.2M following".
    // Restrict regex to the header so post captions in the grid below
    // ("...followers receive..." in a caption) don't poison the match.
    const countRe = /([\d.,]+(?:\s*[KMB])?)\s+(posts?|followers?|following)/gi;
    let m;
    while ((m = countRe.exec(headerText)) !== null) {
      const word = m[2].toLowerCase().replace(/s$/, "");
      const key = word === "post" ? "posts" : word === "follower" ? "followers" : "following";
      if (!out[key]) out[key] = m[1].replace(/\s+/g, "").trim();
    }

    // Verified badge: aria-label or title varies by locale, "Verified"
    // is consistent in English. Limit to the header to avoid matching
    // verification badges on tagged users in the grid below.
    if (header.querySelector?.('svg[aria-label*="Verified" i], [title*="Verified" i]')) {
      out.verified = true;
    }

    // Display name. IG uses an h2 (sometimes h1) in the header that's the
    // user's typed-in name, distinct from the @username slug.
    const heading = header.querySelector?.("h1, h2");
    if (heading) {
      const t = (heading.textContent || "").trim();
      // Reject if it's just the username (already shown), too long
      // (probably wrong element), or empty.
      const isUsername = t.replace(/[._]/g, "").toLowerCase() ===
        (window.location.pathname.split("/").filter(Boolean)[0] || "").replace(/[._]/g, "").toLowerCase();
      if (t && t.length < 80 && !isUsername) {
        out.display_name = t;
      }
    }

    // Bio: the next text block after the counts row, before the post grid.
    // IG renders it as a span/div with no consistent class, but it's the
    // longest free-form text in the header. Pick the longest header text
    // node that's not the display name and isn't the counts row itself.
    const bioCandidate = Array.from(header.querySelectorAll?.("span, div") || [])
      .map((el) => (el.innerText || "").trim())
      .filter((t) => t.length > 12 && t.length < 320 && !/posts|followers|following/i.test(t.split("\n")[0]))
      .filter((t) => t !== out.display_name)
      .sort((a, b) => b.length - a.length);
    if (bioCandidate.length > 0) out.bio = bioCandidate[0];

    // Profile pic — alt text reliably contains "profile picture".
    const pic = main?.querySelector?.('img[alt*="profile picture" i]');
    if (pic?.src) out.profile_pic = pic.src;

    // External link in bio (e.g. linktree). IG renders it with a target=_blank.
    const ext = header.querySelector?.('a[target="_blank"][href]:not([href*="instagram.com"])');
    if (ext?.href) out.external_link = ext.href;
  } catch (e) {
    // DOM access can throw during early lifecycle. Caller treats {} as "no data".
  }
  return out;
}

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

    // We deliberately don't return "public" from the DOM. A private
    // account you ALREADY FOLLOW renders the same way a public account
    // does — posts visible, no banner — so the absence of the banner
    // can't prove public. The lookup endpoint's snapshot-derived
    // likely_public inference handles that case via observation: if you
    // followed someone with no prior pending entry, that's the public
    // signal, not anything visible in the current DOM.
  } catch (e) {
    // DOM access can throw during very early page lifecycle — fall through.
  }
  return null;
}

async function handleUnavailable(panel, username, data) {
  // Auto-tag as unavailable if not already. Idempotent — toggleTag
  // is a no-op if the bucket already contains this user. The existing
  // bucket logic auto-clears the flag if the account ever reappears in
  // your followers (proof of life), so this is safely reversible.
  const tags = data?.tags || {};
  if (!tags.unavailable) {
    toggleTag(username, "unavailable", true).catch(() => {});
  }
  // Record is_unavailable=true so the bucket-status logic in the lists
  // view stops saying "PAGE BACK" for this account. The snapshot still
  // has them in following (IG keeps them there), but the live page
  // check is authoritative.
  bgFetch(`${_settings.trackerUrl}/api/profile-observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, is_unavailable: true }),
  }).catch(() => {});
  panel.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Collapse">⇲</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      <div class="igt-username">${escapeHtml(username)}</div>
      <div class="igt-rel igt-rel-warn">page not available</div>
      <ul class="igt-lines">
        <li>IG returned "Sorry, this page isn't available"</li>
        <li>${tags.unavailable ? "already tagged ✕ unavailable" : "auto-tagged ✕ unavailable in your tracker"}</li>
        <li class="igt-muted">tag will auto-clear if they reappear in your followers</li>
      </ul>
      <a class="igt-link" href="${_settings.trackerUrl}/?lookup=${encodeURIComponent(username)}" target="_blank" rel="noopener">↗ open in tracker</a>
    </div>
  `;
  bindHeaderActions(panel);
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

  // IG showed "page not available". Auto-tag the account as unavailable
  // (idempotent — checks the existing tag state first) and short-circuit
  // the normal panel render to a clear "page gone" state.
  if (detectAccountUnavailable()) {
    handleUnavailable(panel, username, data);
    return;
  }

  // "Never seen in any snapshot" — but ONLY when we have no other source
  // of info to render. Three live-data sources can rescue us from the
  // empty state:
  //   1. Backend observation (profile was previously visited via extension)
  //   2. DOM extract right now (profile is loaded in the browser; we have
  //      counts / bio / display name on the page even if the snapshot DB
  //      has never seen this user before — public accounts the user just
  //      navigated to are the common case)
  //   3. Live follow-button state (just clicked Follow on a never-seen
  //      profile — observation in flight, but the DOM already shows
  //      "Requested" so we can render anyway)
  const livePagePresent = !!(
    document.querySelector("main header")
  );
  const liveProfile = livePagePresent ? extractProfileFromDOM() : {};
  const liveButtonState = livePagePresent ? detectFollowButtonState() : null;
  const hasLiveObservation = data.observation && (
    data.observation.follow_button_state ||
    data.observation.is_private === true ||
    data.observation.is_unavailable === true ||
    data.observation.follower_count != null
  );
  const hasLiveDOMData = !!(
    liveProfile.posts ||
    liveProfile.followers ||
    liveProfile.following ||
    liveProfile.bio ||
    liveProfile.display_name ||
    liveProfile.verified ||
    liveButtonState === "requested" ||
    liveButtonState === "following"
  );
  if (data.found === false
      && !data.currently_follower
      && !data.currently_following
      && !data.currently_pending
      && !data.currently_incoming_request
      && !hasLiveObservation
      && !hasLiveDOMData) {
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
  // Observation-derived live state — meaningful when the snapshot data
  // doesn't yet reflect the action (e.g. you just clicked Follow on a
  // never-seen-before account; export hasn't run yet).
  const obsBtnState = data.observation?.follow_button_state;
  if (obsBtnState === "requested" && !data.currently_pending) {
    lines.push(`🔵 you sent a follow request (pending acceptance)`);
  } else if (obsBtnState === "following" && !data.currently_following) {
    lines.push(`🟢 you started following them`);
  }

  // Observed privacy from the actual IG page DOM beats inferred privacy
  // from snapshot history: if IG is showing "This Account is Private",
  // it definitely is. If the page is rendering a public-style header
  // (post count + post grid + "Follow" button without "Account is
  // Private" message), it's definitely public.
  // Upgrade "likely_private" → "private" when we have direct contact
  // evidence: you currently follow them (private accounts only let you
  // follow via accepted request) or you have a pending request to them
  // (request-required → private, period). The DOM banner check is the
  // strongest signal but only fires for private profiles you don't
  // already follow.
  const observedPrivacy = detectPrivacyFromDOM();
  const userFollows = !!data.currently_following;
  const userHasPending = !!data.currently_pending;
  if (observedPrivacy === "private") {
    lines.push(`🔒 private (banner shown)`);
  } else if (data.privacy === "likely_private" && (userFollows || userHasPending)) {
    lines.push(`🔒 private`);
  } else if (data.privacy === "likely_private") {
    lines.push(`🔒 likely private`);
  } else if (data.privacy === "likely_public" && (userFollows || userHasPending)) {
    lines.push(`🌐 public`);
  } else if (data.privacy === "likely_public") {
    lines.push(`🌐 likely public`);
  }

  // Live page facts — counts, verified badge, account category.
  // Reuse the live extract from the early empty-state check above, so we
  // don't walk the DOM twice. Falls back to a fresh extract if the empty-
  // state check skipped it (livePagePresent was false).
  const profile = (typeof liveProfile !== "undefined" && Object.keys(liveProfile).length)
    ? liveProfile
    : extractProfileFromDOM();
  // Persist what we observed back to the local tracker DB so the rest of
  // the app (lookup, lists) can show these facts even when not on the IG
  // page. Fire-and-forget — doesn't block the render.
  sendProfileObservation(username, profile, observedPrivacy);
  const countsParts = [];
  if (profile.posts)      countsParts.push(`${profile.posts} posts`);
  if (profile.followers)  countsParts.push(`${profile.followers} followers`);
  if (profile.following)  countsParts.push(`${profile.following} following`);
  if (countsParts.length) lines.push(countsParts.join(" · "));
  if (profile.bio)        lines.push(profile.bio.length > 110 ? profile.bio.slice(0, 110) + "…" : profile.bio);
  if (profile.external_link) {
    let host = profile.external_link;
    try { host = new URL(profile.external_link).hostname; } catch { /* keep raw */ }
    lines.push(`↗ ${host}`);
  }
  if (data.aliases && data.aliases.length > 1) {
    lines.push(`renamed: ${data.aliases.join(" → ")}`);
  }

  const tagBtns = Object.keys(TAG_SYMS).map((flag) => {
    const on = !!tags[flag];
    return `<button class="igt-tag ${on ? "on" : ""}" data-flag="${flag}" title="${TAG_LABELS[flag]}">${TAG_SYMS[flag]}</button>`;
  }).join("");

  // Save-to-vault button only appears when the user has set a vault URL
  // in the popup. Without that, the vault feature is fully invisible —
  // the main tracker app's identity is unchanged.
  const saveBtn = _settings.vaultUrl
    ? `<button class="igt-vault-btn" data-action="save-vault" title="Save current visible media to your encrypted vault">💾 Save to vault</button>`
    : "";

  panel.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Collapse">⇲</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      <div class="igt-username">${escapeHtml(username)}${profile.verified ? ' <span class="igt-check" title="Verified">✓</span>' : ""}</div>
      ${profile.display_name ? `<div class="igt-display-name">${escapeHtml(profile.display_name)}</div>` : ""}
      <div class="igt-rel igt-rel-${relKind}">${escapeHtml(rel)}</div>
      ${lines.length ? `<ul class="igt-lines">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
      <div class="igt-tags">${tagBtns}</div>
      ${saveBtn}
      <a class="igt-link" href="${_settings.trackerUrl}/?lookup=${encodeURIComponent(username)}" target="_blank" rel="noopener">↗ open in tracker</a>
    </div>
  `;
  bindHeaderActions(panel);
  panel.querySelector("[data-action='save-vault']")?.addEventListener("click", () => {
    saveToVault(username);
  });
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
let _followBtnObserver = null;

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

  // Tear down any prior follow-button observer (from a previous profile)
  // and start a fresh one for this username. Catches the user clicking
  // Follow on the IG page → button state changes → we record it.
  if (_followBtnObserver) { _followBtnObserver.disconnect(); _followBtnObserver = null; }
  _followBtnObserver = watchFollowButtonChanges(username);

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
