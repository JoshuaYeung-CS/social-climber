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
  now_public: "🌐",
};
const TAG_LABELS = {
  favorite: "Favorite",
  want_remove: "Want to remove",
  watchlist: "Wait-back",
  disabled: "Disabled",
  unavailable: "Unavailable",
  random_request: "Random request",
  now_public: "Was private, now public (you confirmed)",
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
// Set to true once we detect the extension was reloaded out from under us
// (chrome.runtime.id becomes undefined when the SW is gone). Old content
// scripts in long-lived IG tabs still run, but every chrome.* call throws
// "Extension context invalidated". Once flipped, we stop calling chrome.*
// and tear down observers so the page goes silent until reload.
let _extensionDead = false;

function extensionAlive() {
  if (_extensionDead) return false;
  try {
    if (!chrome?.runtime?.id) {
      handleExtensionDeath();
      return false;
    }
    return true;
  } catch (e) {
    handleExtensionDeath();
    return false;
  }
}

function handleExtensionDeath() {
  if (_extensionDead) return;
  _extensionDead = true;
  if (_followBtnObserver) {
    try { _followBtnObserver.disconnect(); } catch {}
    _followBtnObserver = null;
  }
  if (_privacyRecheckTimer) {
    clearTimeout(_privacyRecheckTimer);
    _privacyRecheckTimer = null;
  }
  // Surface a tiny notice in the existing panel if it's still on screen so
  // the user knows the overlay went stale until they refresh the page.
  if (_panelEl) {
    try {
      const body = _panelEl.querySelector(".igt-body");
      if (body && !_panelEl.querySelector(".igt-dead-notice")) {
        const note = document.createElement("div");
        note.className = "igt-dead-notice igt-muted";
        note.style.marginTop = "8px";
        note.textContent = "extension reloaded — refresh page to reconnect";
        body.appendChild(note);
      }
    } catch {}
  }
}

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
  if (!extensionAlive()) {
    return { ok: false, error: "extension context invalidated" };
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "tracker-fetch", url, init },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (/Extension context invalidated|message port closed/i.test(err.message || "")) {
              handleExtensionDeath();
            }
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        }
      );
    } catch (e) {
      handleExtensionDeath();
      resolve({ ok: false, error: e.message || String(e) });
    }
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
  if (!extensionAlive()) {
    alert("Extension was reloaded — refresh this page to reconnect.");
    return;
  }
  const r = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "tracker-fetch-bytes", url: cap.src },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (/Extension context invalidated|message port closed/i.test(err.message || "")) {
              handleExtensionDeath();
            }
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        }
      );
    } catch (e) {
      handleExtensionDeath();
      resolve({ ok: false, error: e.message || String(e) });
    }
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
// Returns the bgFetch promise so callers can await — used by the
// follow-button observer which needs to refetch lookup AFTER the POST
// has actually landed in the DB. Otherwise the callback re-renders with
// the old (un-bridged) snapshot data and the panel stays stuck on
// "Never seen in any snapshot" even though the green flash already fired.
function sendProfileObservation(username, profile, privacyDom, extra = {}) {
  const buttonState = extra.follow_button_state || detectFollowButtonState();
  const hasAnything = profile.posts || profile.followers || profile.following
    || profile.bio || profile.display_name || profile.verified
    || profile.profile_pic || profile.external_link
    || privacyDom === "private"
    || buttonState;
  if (!hasAnything) return Promise.resolve(null);
  const is_private = privacyDom === "private" ? true : null;
  const is_unavailable = false;
  return bgFetch(`${_settings.trackerUrl}/api/profile-observation`, {
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
  }).catch(() => null);
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
    if (!extensionAlive()) {
      try { observer.disconnect(); } catch {}
      return;
    }
    const next = detectFollowButtonState();
    if (next && next !== lastState) {
      const wasNeutral = lastState === null || lastState === "not_following" || lastState === "follow_back_available";
      const newRelationship = wasNeutral && (next === "requested" || next === "following");
      if (newRelationship) {
        // Show the green flash immediately so feedback is fast.
        if (_panelEl && _lastUsername === username && _panelOpen) {
          flashRequestedConfirmation(_panelEl, next);
        }
        // POST the observation, AWAIT the round trip, then refetch +
        // re-render. Without the await, the lookup ran before the DB
        // write landed and the panel stayed stuck on "Never seen".
        sendProfileObservation(
          username,
          extractProfileFromDOM(),
          detectPrivacyFromDOM(),
          { follow_button_state: next, button_state_changed: true }
        ).then(() => {
          if (!_panelEl || _lastUsername !== username || !_panelOpen) return;
          return fetchLookup(username);
        }).then((fresh) => {
          if (!fresh || !_panelEl || _lastUsername !== username || !_panelOpen) return;
          renderPanel(_panelEl, username, fresh);
          // Re-flash since renderPanel just rebuilt the overlay body.
          flashRequestedConfirmation(_panelEl, next);
        });
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
function matchFollowState(s) {
  const t = (s || "").trim();
  if (!t) return null;
  // Order matters: "follow back" must be tested before "follow", and
  // "following" before "follow", since they share prefixes.
  if (/^follow\s*back\b/.test(t)) return "follow_back_available";
  if (/^following\b/.test(t)) return "following";
  if (/^requested\b/.test(t)) return "requested";
  if (/^follow\b/.test(t)) return "not_following";
  return null;
}

function detectFollowButtonState() {
  try {
    const main = document.querySelector("main");
    const header = main?.querySelector("header") || document.querySelector("header");
    if (!header) return null;
    const candidates = header.querySelectorAll("button, [role='button']");
    for (const el of candidates) {
      // Prefer aria-label on the button itself — IG sets these cleanly,
      // and they don't get polluted by nested SVG icons.
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const ariaState = matchFollowState(aria);
      if (ariaState) return ariaState;

      // Fall back to textContent. IG embeds SVG icons with their own
      // aria-labels (e.g. "Down chevron icon") which textContent
      // concatenates without separators — "Following" + chevron icon
      // becomes the literal string "FollowingDown chevron icon". Strip
      // these known accessory phrases (and the unicode chevron variants
      // that show up on some routes) before matching.
      let t = (el.textContent || "").replace(/\s+/g, " ").toLowerCase().trim();
      t = t
        .replace(/down chevron icon|up chevron icon|chevron icon|chevron/g, "")
        .replace(/[▼▾⌵⌄▾▼v]+/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      const txtState = matchFollowState(t);
      if (txtState) return txtState;
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
    // IG renders it as a span/div with no consistent class. Reject any
    // candidate that contains a counts-row fragment ("5 posts", "1.5k
    // followers", etc.) — those are ancestors of the actual bio that
    // accidentally swallow the entire header. Also reject text that
    // contains the "Followed by …" mutual-followers line, the username,
    // or the display name. After filtering, take the longest remaining.
    const username = (window.location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    const looksLikeCountsRow = (t) => /\b\d[\d.,]*\s*(?:k|m|b)?\s+(?:posts?|followers?|following)\b/i.test(t);
    const looksLikeMutualLine = (t) => /^followed\s+by\b/i.test(t.trim());
    const bioCandidate = Array.from(header.querySelectorAll?.("span, div, h1") || [])
      .map((el) => (el.innerText || "").trim())
      .filter((t) => t.length > 0 && t.length < 320)
      .filter((t) => !looksLikeCountsRow(t))
      .filter((t) => !looksLikeMutualLine(t))
      .filter((t) => t.toLowerCase() !== username)
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
      <button class="igt-icon" data-action="collapse" title="Minimize">−</button>
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
      <button class="igt-icon" data-action="collapse" title="Minimize">−</button>
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
  // Client-side bridge: the live page is the source of truth for the
  // user→target direction. If the IG button says "Following" / "Requested"
  // but the lookup says no relation (export hasn't refreshed, or the
  // observation POST from this page hasn't landed yet), trust the live
  // button. The next refresh will see the same state via the backend
  // bridge once the observation row is recorded.
  const liveBtnForBridge = livePagePresent ? (liveButtonState || detectFollowButtonState()) : null;
  let youFollow = !!data.currently_following;
  let pending = !!data.currently_pending;
  if (!youFollow && !pending) {
    if (liveBtnForBridge === "following") youFollow = true;
    else if (liveBtnForBridge === "requested") pending = true;
  }
  const incoming = !!data.currently_incoming_request;

  // Relationship pill.
  let rel = "no current relation", relKind = "muted";
  if (youFollow && followsYou) { rel = "mutual"; relKind = "good"; }
  else if (youFollow && incoming) { rel = "requesting to follow back"; relKind = "pending"; }
  else if (youFollow && !followsYou) { rel = "doesn't follow back"; relKind = "warn"; }
  else if (followsYou && !youFollow) { rel = "follows you only"; relKind = "info"; }
  else if (pending) { rel = "request pending"; relKind = "info"; }
  else {
    // No current relation — but check for prior interaction so the pill
    // distinguishes "complete stranger" from "we have history together."
    // Promotes the most-specific past-state we can derive from the
    // lookup: previously-mutual > one-sided follow > pending-only.
    const wasFollowing = !!data.ever_followed;
    const wasFollower = !!data.ever_was_follower;
    const wasPending = !!data.ever_requested;
    if (wasFollowing && wasFollower) { rel = "↺ previously mutual"; relKind = "info"; }
    else if (wasFollower) { rel = "↺ they followed you before"; relKind = "info"; }
    else if (wasFollowing) { rel = "↺ you followed them before"; relKind = "info"; }
    else if (wasPending) { rel = "↺ you requested before"; relKind = "muted"; }
  }

  // Story lines from snapshot history.
  const lines = [];
  const fs = data.first_followed_snapshot;
  const ls = data.last_followed_snapshot;
  const fr = data.first_follower_snapshot;
  const lr = data.last_follower_snapshot;
  if (fs?.label) lines.push(`you first followed them ${fmtSnapshotLabel(fs.label)}`);
  if (fr?.label) lines.push(`they first appeared in your followers ${fmtSnapshotLabel(fr.label)}`);
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
  // Privacy display rule:
  //   now_public tagged    → "🌐 public (you confirmed)" — user verified.
  //   ever-pending evidence → "🔒 private" — pending only happens for
  //     private accounts, so any pending observation in any snapshot
  //     proves the account had a pending phase. The rare private→public
  //     flip case is handled via the now_public tag (one-click manual
  //     override), so we don't need to hedge the default label.
  //   likely_public         → "🌐 likely public" — kept hedged because
  //     a brief pending phase could escape between snapshots, so the
  //     "no pending observed" inference isn't airtight even with
  //     pre-follow coverage.
  //   (unlabeled)           → unknown.
  if (tags.now_public) {
    lines.push(`🌐 public (you confirmed)`);
  } else if (observedPrivacy === "private") {
    lines.push(`🔒 private`);
  } else if (data.privacy === "likely_private") {
    lines.push(`🔒 private`);
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
      <button class="igt-icon" data-action="collapse" title="Minimize">−</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      ${profile.profile_pic ? `<a class="igt-pic-link" href="${escapeHtml(profile.profile_pic)}" target="_blank" rel="noopener" title="Click to open at full size"><img class="igt-pic" src="${escapeHtml(profile.profile_pic)}" alt="${escapeHtml(username)} profile picture" /></a>` : ""}
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

// Drag-to-move support. Mousedown on the header (avoiding the icon
// buttons) starts a drag; document-level mousemove/mouseup track and
// commit position. Position is INTENTIONALLY not persisted across
// SPA-navigations: refreshOverlay resets to the CSS default (top:76px,
// right:16px) so each new profile starts at the same place.
let _drag = null;

function attachDragHandle(panel) {
  const head = panel.querySelector(".igt-head");
  if (!head) return;
  head.style.cursor = "move";
  head.style.userSelect = "none";
  head.addEventListener("mousedown", (e) => {
    // Don't initiate drag from clicks on the close/minimize icons.
    if (e.target.closest("[data-action]")) return;
    if (e.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    _drag = { panel, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panel.style.right = "auto";
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    e.preventDefault();
  });
}

function resetPanelPosition(panel) {
  // Clear inline overrides so the CSS rule (top:76px; right:16px) takes
  // back over. Called on every refreshOverlay so the panel always lands
  // at the same starting place when you navigate to a new profile.
  panel.style.left = "";
  panel.style.top = "";
  panel.style.right = "";
}

document.addEventListener("mousemove", (e) => {
  if (!_drag) return;
  const p = _drag.panel;
  let nx = e.clientX - _drag.dx;
  let ny = e.clientY - _drag.dy;
  nx = Math.max(0, Math.min(window.innerWidth - p.offsetWidth, nx));
  ny = Math.max(0, Math.min(window.innerHeight - p.offsetHeight, ny));
  p.style.left = nx + "px";
  p.style.top = ny + "px";
}, true);

document.addEventListener("mouseup", () => { _drag = null; }, true);

function bindHeaderActions(panel) {
  attachDragHandle(panel);
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
  resetPanelPosition(_panelEl);
  if (!_panelOpen) {
    renderCollapsed(_panelEl, username);
    return;
  }
  // Show loading state immediately so the user knows the extension responded.
  _panelEl.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Minimize">−</button>
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
