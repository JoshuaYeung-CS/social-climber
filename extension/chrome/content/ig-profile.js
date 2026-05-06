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
  need_archive: "📦",
};
const TAG_LABELS = {
  favorite: "Favorite",
  want_remove: "Want to remove",
  watchlist: "Wait-back",
  disabled: "Disabled",
  unavailable: "Unavailable",
  random_request: "Random request",
  now_public: "Was private, now public (you confirmed)",
  need_archive: "Need to archive",
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
// Which categories Archive-selected walks. Persisted to
// chrome.storage.local.archiveCategories so the toggle state sticks
// across page navigations and profiles. Defaults: posts/reels/tagged/
// highlights ON, story OFF — Story is opt-in because it can capture
// frames the user might prefer not to save (the live-story has higher
// stakes than evergreen posts).
let _archiveCategories = {
  posts: true, reels: true, tagged: true, highlights: true, story: false,
};
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
  const stored = await chrome.storage.local.get([
    "trackerUrl", "vaultUrl", "showOverlay", "autoArchiveMedia",
    "archiveCategories",
  ]);
  if (stored.archiveCategories && typeof stored.archiveCategories === "object") {
    // Merge stored selection over defaults so newly-introduced categories
    // (e.g. story, added later) still get their default state instead
    // of being undefined.
    _archiveCategories = { ..._archiveCategories, ...stored.archiveCategories };
  }
  return {
    trackerUrl: (stored.trackerUrl || "http://127.0.0.1:8000").replace(/\/$/, ""),
    vaultUrl: (stored.vaultUrl || "").replace(/\/$/, ""),
    showOverlay: stored.showOverlay !== false,
    autoArchiveMedia: !!stored.autoArchiveMedia,
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

// In-script LRU + TTL cache for /api/lookup. Same profile visited in
// multiple tabs (or the same tab refreshed) hits this cache instead
// of round-tripping the SW + tracker server. TTL kept short (60s)
// so a freshly-imported snapshot's data still becomes visible after
// the user lingers on the profile.
const _LOOKUP_CACHE = new Map();
const _LOOKUP_CACHE_TTL_MS = 60_000;
const _LOOKUP_CACHE_MAX = 200;

async function fetchLookup(username) {
  const now = Date.now();
  const cached = _LOOKUP_CACHE.get(username);
  if (cached && (now - cached.at) < _LOOKUP_CACHE_TTL_MS) {
    return cached.body;
  }
  const r = await bgFetch(
    `${_settings.trackerUrl}/api/lookup?account=${encodeURIComponent(username)}`
  );
  if (!r.ok) return null;
  // LRU eviction by size: keep the most-recent N entries.
  if (_LOOKUP_CACHE.size >= _LOOKUP_CACHE_MAX) {
    const firstKey = _LOOKUP_CACHE.keys().next().value;
    if (firstKey) _LOOKUP_CACHE.delete(firstKey);
  }
  _LOOKUP_CACHE.set(username, { body: r.body, at: now });
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
// Pick the kind label for the current path. Used by the vault save
// flow + by the multi-slide archive helper for diagnostic logging.
function _detectMediaKind(path) {
  if (/^\/stories\/highlights\//.test(path)) return "highlight";
  if (/^\/stories\//.test(path))             return "story";
  if (/^\/reel\//.test(path))                return "reel";
  if (/^\/p\//.test(path))                   return "post";
  if (/^\/[^/]+\/(p|reel)\//.test(path)) {
    return /\/reel\//.test(path) ? "reel" : "post";
  }
  return "post";
}

// Find every non-trivial img/video on the page that could plausibly
// be archived. Returns a sorted list (largest first). Story / highlight
// viewers don't render their content under <main> or [role=dialog],
// so we cast a wider net and rely on the size + alt-text filters to
// drop UI chrome (profile pic thumb, emoji icons, story rail avatars).
function _collectMediaCandidates() {
  // Strict pass first — covers feed posts, profile-grid post modals,
  // and reels viewer.
  const strict = Array.from(document.querySelectorAll(
    "main img, main video, [role='dialog'] img, [role='dialog'] video"
  ));
  // Wide pass — for stories / highlights / any layout we don't yet
  // know about. Deduplicated against the strict set.
  const wide = Array.from(document.querySelectorAll("img, video"));
  const seen = new Set();
  const out = [];
  for (const el of strict.concat(wide)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) continue; // drop avatars / icons
    const isProfilePic = (el.alt || "").toLowerCase().includes("profile picture");
    if (isProfilePic) continue;
    const src = el.src || el.currentSrc;
    if (!src) continue;
    // VIDEO bonus so the player wins over a poster image when both render.
    const area = r.width * r.height + (el.tagName === "VIDEO" ? 1_000_000 : 0);
    // Fallback for MSE-backed videos: blob: URLs created via
    // MediaSource can't be refetched (their backing data is a stream,
    // not a Blob), so a fetch will throw "Failed to fetch". Save the
    // poster (still frame) URL as a fallback target — IG sets
    // `poster=<https-url>` to a regular CDN JPEG. Worse than the full
    // video, but a recognizable thumbnail beats nothing.
    let fallbackSrc = null;
    if (el.tagName === "VIDEO") {
      const poster = el.getAttribute("poster") || "";
      if (poster && /^https?:/.test(poster)) fallbackSrc = poster;
    }
    out.push({
      element: el,
      src,
      fallbackSrc,
      media_type: el.tagName === "VIDEO" ? "video" : "image",
      area,
    });
  }
  // Largest first, so caller can take [0] for the single-best case.
  out.sort((a, b) => b.area - a.area);
  return out;
}

// Carousels and posts with a single image/video both go through this:
// returns ALL save-worthy slides on the page, dedup'd by src. For
// non-carousel posts the result has length 1; for carousels each
// rendered slide shows up. Off-screen carousel slides are still in
// the DOM (IG renders them so swipe works smoothly), so we capture
// them too — covers "only the first slide saves" complaints.
// Cdninstagram URLs encode the same image at multiple resolutions
// via the `stp` query param (e.g. `dst-jpg_e35_p1080x1080` vs
// `_p640x640`) but share the same /v/<id>.jpg pathname. Strict
// dedup-by-full-URL would treat them as separate slides and inflate
// the count. Use pathname-only as the dedup key so resolution
// variants of the same slide collapse to one entry.
function _dedupKey(src) {
  if (typeof src !== "string") return String(src);
  if (src.startsWith("blob:") || src.startsWith("data:")) return src;
  try {
    const u = new URL(src);
    return u.origin + u.pathname;
  } catch {
    return src;
  }
}

function findAllSaveableMedia() {
  const cands = _collectMediaCandidates();
  // Dedup by image pathname (collapsing resolution variants — see
  // _dedupKey). Keep the largest-area variant from each group so
  // the saved file is the highest-resolution one IG rendered.
  const groups = new Map();
  for (const c of cands) {
    const key = _dedupKey(c.src);
    const existing = groups.get(key);
    if (!existing || c.area > existing.area) {
      groups.set(key, c);
    }
  }
  const kind = _detectMediaKind(window.location.pathname);
  return Array.from(groups.values()).map((c) => ({ ...c, kind }));
}

// Single-best for callers that only want one (vault save still works
// post-by-post, not slide-by-slide). Returns the same shape as before.
function findSaveableMedia() {
  const all = findAllSaveableMedia();
  return all.length ? all[0] : null;
}

// Capture the current frame of a <video> element as a base64 JPEG.
// Fallback for IG story / highlight videos: their src is a `blob:`
// URL backed by MediaSource Extensions, which can't be re-fetched
// (the data is a streaming pipe, not a Blob). The video is being
// painted live in the browser, though, so we can copy that frame
// onto an off-screen canvas and read out the bytes. Result: one
// still frame per video story instead of nothing.
function _captureVideoFrameAsBase64(el) {
  // Canvas-based fallback for any media element: <video> (uses
  // currently-displayed frame) or <img> (uses naturalWidth/Height).
  // Used when the source URL can't be re-fetched (MSE blob: URLs)
  // or the network fetch fails for any reason. drawImage works on
  // both element types — we just need their intrinsic dimensions.
  try {
    if (!el) return null;
    let w = 0, h = 0;
    if (el.tagName === "VIDEO") {
      w = el.videoWidth; h = el.videoHeight;
    } else if (el.tagName === "IMG") {
      w = el.naturalWidth || el.width;
      h = el.naturalHeight || el.height;
    } else {
      return null;
    }
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // drawImage on a same-origin video/img copies whatever's currently
    // displayed. Tainted-canvas exceptions only fire for cross-origin
    // images without crossorigin=anonymous; IG's cdninstagram CDN is
    // CORS-friendly via the page origin, so this works for both.
    ctx.drawImage(el, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    const idx = dataUrl.indexOf(",");
    if (idx === -1) return null;
    return dataUrl.slice(idx + 1);
  } catch (e) {
    console.warn(`[IG Tracker] canvas frame grab failed: ${e.message}`);
    return null;
  }
}

// Fetch media bytes and return them base64-encoded. Two paths:
//   - blob: URLs: IG uses MediaSource Extensions for story / reel
//     videos, exposing them via blob:https://www.instagram.com/...
//     URLs that ONLY resolve inside the page document — the service
//     worker can't fetch them ("Failed to fetch"). The content
//     script shares the page's blob context, so fetching here works.
//   - everything else: route through the SW so we get IG's cookies
//     and dodge mixed-content blocks (instagram.com is HTTPS, our
//     tracker is HTTP, and pages can't fetch HTTP from HTTPS, but
//     the SW context can).
async function _fetchAsBase64(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    try {
      const r = await fetch(url);
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const buf = await r.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      return { ok: true, body: btoa(bin) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "tracker-fetch-bytes", url },
        (resp) => resolve(resp || { ok: false })
      );
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });
}

// Locate a carousel arrow by aria-label. IG renders Next as
// `aria-label="Next"` and Previous as `aria-label="Go back"` (the
// label is removed from the DOM when you're on the first/last slide).
function _findCarouselArrow(label) {
  const sel = `button[aria-label="${label}"], [role="button"][aria-label="${label}"]`;
  for (const b of document.querySelectorAll(sel)) {
    if (b.disabled) continue;
    if (b.getAttribute("aria-disabled") === "true") continue;
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    return b;
  }
  return null;
}

function _findCarouselNextButton() {
  return (
    _findCarouselArrow("Next") ||
    _findCarouselArrow("Next slide") ||
    _findCarouselArrow("See next story") ||
    _findCarouselArrow("Next photo") ||
    _findCarouselArrow("Forward")
  );
}

// Story / highlight viewers don't expose aria-labelled arrows the
// way carousel posts do — IG navigates them via tap-zones or the
// arrow keys. Sending a synthesized keyboard event is reliable across
// all the rollouts I've seen, and IG's React handler picks it up the
// same way as a real key press.
function _navigateStory(direction) {
  const key = direction === "next" ? "ArrowRight" : "ArrowLeft";
  const code = direction === "next" ? "ArrowRight" : "ArrowLeft";
  const opts = { key, code, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", opts));
  document.dispatchEvent(new KeyboardEvent("keyup", opts));
  // Some IG viewers listen on window not document.
  window.dispatchEvent(new KeyboardEvent("keydown", opts));
  window.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// IG sometimes interrupts highlight / story navigation with a
// "View as <user>? — they'll see you viewed their story" interstitial,
// blocking the actual viewer behind a "View story" button. The same
// pattern shows up occasionally for posts ("View post"). Find any
// such "view"-class button and click it so the underlying media
// can mount. Returns true if anything was clicked.
async function _dismissConsentInterstitial() {
  // IG renders these as <div role="button"> not <button>, so search
  // both. Visible-text matching is the only stable signal — the
  // class names are obfuscated and aria-labels are inconsistent.
  const candidates = Array.from(
    document.querySelectorAll('button, [role="button"], div[tabindex="0"]')
  );
  const target = candidates.find((b) => {
    const t = (b.textContent || "").trim();
    if (!t || t.length > 30) return false; // exclude paragraphs / large blocks
    // Must be visibly on screen.
    const r = b.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    return /^(view story|view post|view|continue)$/i.test(t);
  });
  if (!target) return false;
  console.log(`[IG Tracker] archive: dismissing consent interstitial ("${(target.textContent || "").trim()}")`);
  try { clickElement(target); } catch { try { target.click(); } catch {} }
  // Give IG a moment to swap the interstitial out for the real viewer.
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

// Compact summary of a button for diagnostic logs.
function _describeBtn(b) {
  if (!b) return "null";
  const al = b.getAttribute && b.getAttribute("aria-label");
  const r = b.getBoundingClientRect();
  return `<${b.tagName.toLowerCase()} aria="${al || ""}" pos=${Math.round(r.left)},${Math.round(r.top)}>`;
}

function _findCarouselPrevButton() {
  // IG has shipped both labels for the back arrow over time.
  return _findCarouselArrow("Go back") || _findCarouselArrow("Previous");
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
  // Fire-and-forget: when we've got a profile_pic URL, also try to
  // download and persist the bytes locally. The IG CDN URL has a
  // short-lived signed token (~hours), so a URL stored in observation
  // expires; the local copy under data/profile_pics/<username>.jpg
  // is the stable handle. The server endpoint skips the write when the
  // local file is <24h old, so this is cheap on repeat visits.
  if (profile.profile_pic) {
    downloadAndStoreProfilePic(username, profile.profile_pic).catch(() => null);
  }
  // Auto-detect VSCO links in the bio / external link and append
  // them to the account's note. Idempotent: skips if the note
  // already mentions vsco.co. Fire-and-forget.
  maybeAddVscoToNote(username, profile).catch(() => null);
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

// Look for a VSCO URL anywhere in the observed profile. Checks
// (in priority order): the explicit external_link, the bio text,
// and the display_name. Returns a normalized https URL or null.
function _findVscoLink(profile) {
  const candidates = [profile.external_link, profile.bio, profile.display_name];
  for (const raw of candidates) {
    if (!raw) continue;
    // Match either a full URL or a bare vsco.co/handle reference.
    const m = String(raw).match(/(?:https?:\/\/)?(?:www\.)?vsco\.co\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)*/i);
    if (m) {
      const url = m[0].startsWith("http") ? m[0] : "https://" + m[0];
      return url;
    }
  }
  return null;
}

// If the profile has a VSCO link AND the user's existing note for
// this account doesn't already mention vsco.co, append the link to
// the note. Doesn't overwrite existing free-form text.
async function maybeAddVscoToNote(username, profile) {
  if (!extensionAlive()) return;
  const vsco = _findVscoLink(profile);
  if (!vsco) return;
  // Read existing note.
  const existing = await bgFetch(`${_settings.trackerUrl}/api/note/${encodeURIComponent(username)}`).catch(() => null);
  const cur = (existing?.body?.note || "").trim();
  // Skip if the note already references VSCO at all (the user might
  // have written their own VSCO note already; don't append again).
  if (/vsco\.co/i.test(cur)) return;
  const newNote = cur ? `${cur}\n${vsco}` : vsco;
  await bgFetch(`${_settings.trackerUrl}/api/note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, note: newNote }),
  }).catch(() => null);
  console.log(`[IG Tracker] Auto-added VSCO link to @${username}: ${vsco}`);
}

async function downloadAndStoreProfilePic(username, picUrl) {
  if (!extensionAlive() || !picUrl) return;
  // Use the tracker-fetch-bytes channel (background SW) so we can
  // bypass mixed-content + carry IG cookies for the CDN fetch.
  const r = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "tracker-fetch-bytes", url: picUrl },
        (resp) => resolve(resp || { ok: false })
      );
    } catch {
      resolve({ ok: false });
    }
  });
  if (!r.ok || !r.body) return;
  await bgFetch(`${_settings.trackerUrl}/api/profile-pic-bytes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, bytes_b64: r.body }),
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
      // Unfollow / cancel-request: a relationship existed and was
      // dropped. Worth surfacing to the user the same way we
      // celebrate new follows — both are signals they care about
      // (especially when testing "do business accounts follow back"
      // hypotheses where the user unfollows after no follow-back).
      const wasRelated = lastState === "following" || lastState === "requested";
      const isNowNeutral = next === "not_following" || next === "follow_back_available";
      const droppedRelationship = wasRelated && isNowNeutral;
      if (newRelationship || droppedRelationship) {
        const flashFn = newRelationship
          ? () => flashRequestedConfirmation(_panelEl, next)
          : () => flashUnfollowConfirmation(_panelEl, lastState);
        if (_panelEl && _lastUsername === username && _panelOpen) flashFn();
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
          flashFn();
        });
      } else {
        // Other state changes (e.g. requested → following when account
        // accepts the request — caught by IG's UI before our snapshot
        // does). Record but no flash.
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

// Red counterpart for unfollow / cancel-request. Same UX shape so the
// user gets symmetric feedback regardless of which direction the
// relationship moved.
function flashUnfollowConfirmation(panel, prevState) {
  const body = panel.querySelector(".igt-body");
  if (!body) return;
  const note = document.createElement("div");
  note.className = "igt-flash igt-flash-red";
  note.textContent = prevState === "requested"
    ? "✗ recorded: you canceled the follow request"
    : "✗ recorded: you unfollowed them";
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

    // Account category text — IG renders this above or under the bio
    // for business/creator accounts (e.g. "Restaurant", "Public
    // figure", "Personal blog", "Athlete"). Personal accounts don't
    // show one. Stable list of common categories taken from IG's
    // public taxonomy; we match against this allow-list rather than
    // any text containing those words to avoid false positives from
    // bio content. Used as a fallback when the network interceptor
    // hasn't populated _profileMeta yet (cold page load).
    const KNOWN_CATEGORIES = [
      "Public figure", "Personal blog", "Digital creator", "Artist",
      "Musician/band", "Athlete", "Actor", "Author", "Blogger",
      "Photographer", "Health/beauty", "Restaurant", "Cafe", "Bar",
      "Hotel", "Shopping & retail", "Clothing (brand)", "Brand",
      "Product/service", "Business service", "Community",
      "Entrepreneur", "Education", "Gym/physical fitness centre",
      "Sports team", "Comedian", "Writer", "Influencer",
      "Content creator", "Video creator", "Designer", "Creator",
    ];
    const headerSpans = Array.from(header.querySelectorAll?.("span, div") || []);
    for (const el of headerSpans) {
      const t = (el.innerText || "").trim();
      if (t.length > 0 && t.length < 60 &&
          KNOWN_CATEGORIES.some((c) => c.toLowerCase() === t.toLowerCase())) {
        out.category = t;
        break;
      }
    }
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
  } else if ((obsBtnState === "not_following" || obsBtnState === "follow_back_available") &&
             data.observation?.button_state_changed &&
             (data.ever_followed || data.ever_requested) &&
             !data.currently_following && !data.currently_pending) {
    // Unfollow / cancel-request signal. Conditions:
    //   - latest observation captured a state change to a non-related state
    //   - history shows a prior relationship (ever_followed / ever_requested)
    //   - current snapshot doesn't show an active relationship
    // Surfaced as a persistent line so the user can spot which
    // accounts they've recently dropped — useful for the "do
    // business accounts follow back" experiment where they're
    // tracking which unrequited follows they cleaned up.
    const verb = data.ever_followed ? "unfollowed them" : "canceled the follow request";
    lines.push(`🔴 you ${verb}`);
  }

  // Archived-media indicator — populated by the server's lookup
  // endpoint, which scans data/media/<user>/. Lets the user spot
  // accounts they've already saved before so they don't re-archive.
  // Pairs with the 📦 need_archive tag (which is the "I want to
  // save this later" intent) — the count line below confirms when
  // the intent has been acted on.
  if (data.archived_media_count && data.archived_media_count > 0) {
    const count = data.archived_media_count;
    const kb = Math.round((data.archived_media_bytes || 0) / 1024);
    const sizeStr = kb > 1024
      ? `${(kb / 1024).toFixed(1)} MB`
      : `${kb} KB`;
    lines.push(`📦 ${count} item${count === 1 ? "" : "s"} archived (${sizeStr})`);
    // Auto-clear the "need_archive" intent once archiving has
    // actually happened — the flag is a todo marker, not a state.
    // Once items exist on disk, the todo is complete; flipping it
    // off here keeps the global need_archive list as a clean
    // backlog of accounts still waiting. Fire-and-forget; the
    // server's set_flag is idempotent.
    if (tags?.need_archive) {
      toggleTag(username, "need_archive", false).catch(() => {});
    }
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
  // Show "archive all" whenever we're on a profile page. We DON'T
  // gate on tile presence at render-time because the grid often
  // hasn't lazy-loaded yet when the overlay first paints — gating
  // would hide the button on first render, then it'd never come
  // back. The handler tolerates "no tiles found" gracefully.
  const onProfilePage = /^\/[^/]+\/?$/.test(window.location.pathname)
    && !/^\/(p|reel|stories|explore|reels|direct|accounts)\//.test(window.location.pathname);
  // Category selector for Archive — Posts / Reels / Tagged / Highlights /
  // Story. Each pill is independently toggleable so the user can
  // archive any subset (e.g. just Reels for a profile that posts a lot
  // of long videos, or just Highlights for a private friend whose
  // posts they already saved manually). Selection persists per-user.
  const cats = _archiveCategories;
  const catPill = (key, icon, label) => {
    const on = cats[key] ? "on" : "";
    return `<button class="igt-cat-pill ${on}" data-cat="${key}" title="${label}">${icon} ${label}</button>`;
  };
  const archiveAllBtn = onProfilePage
    ? `<div class="igt-cat-row">
         ${catPill("posts",      "📷", "Posts")}
         ${catPill("reels",      "🎬", "Reels")}
         ${catPill("tagged",     "🏷️", "Tagged")}
         ${catPill("highlights", "⭐", "Highlights")}
         ${catPill("story",      "📖", "Story")}
       </div>
       <button class="igt-vault-btn" data-action="archive-all" title="Archive every tile from the categories selected above. Click a pill to toggle it on/off.">📦 Archive selected</button>`
    : "";

  panel.innerHTML = `
    <div class="igt-head">
      <span class="igt-title">IG Tracker</span>
      <button class="igt-icon" data-action="collapse" title="Minimize">−</button>
      <button class="igt-icon" data-action="close" title="Close">✕</button>
    </div>
    <div class="igt-body">
      ${profile.profile_pic ? (() => {
        // Prefer the locally-stored copy at /api/profile-pic/<username>
        // when available — the IG CDN URL is signed and expires after
        // hours, so previously-observed pics break click-to-enlarge.
        // The local URL falls back to the IG CDN if the file isn't
        // there yet (404), via the onerror handler.
        const localUrl = `${_settings.trackerUrl}/api/profile-pic/${encodeURIComponent(username)}`;
        const fallback = escapeHtml(profile.profile_pic);
        return `<a class="igt-pic-link" href="${localUrl}" target="_blank" rel="noopener" title="Click to open at full size"><img class="igt-pic" src="${localUrl}" onerror="this.onerror=null;this.src='${fallback}';this.parentElement.href='${fallback}';" alt="${escapeHtml(username)} profile picture" /></a>`;
      })() : ""}
      <div class="igt-username">${escapeHtml(username)}${profile.verified ? ' <span class="igt-check" title="Verified">✓</span>' : ""}${(() => {
        // Account-type pill: business/creator/personal, from network
        // interceptor (canonical) with a DOM-category fallback. Useful
        // for the "business accounts rarely follow back" hypothesis —
        // user can scan profiles and see the flag at a glance.
        const meta = _profileMeta.get(username);
        // account_type: 1=personal, 2=business, 3=creator. Prefer it
        // when present; otherwise fall back to the boolean flags.
        let kind = null, label = null;
        if (meta) {
          if (meta.account_type === 2 || meta.is_business) {
            kind = "business"; label = "🏢 Business";
          } else if (meta.account_type === 3 ||
                     (meta.is_professional_account && !meta.is_business)) {
            kind = "creator"; label = "🎨 Creator";
          }
        }
        // DOM fallback: business/creator accounts show their category
        // text (e.g. "Restaurant", "Public figure") in a small element
        // under the bio. If we found one in the live profile, show
        // "Business" generically — we can't tell creator from
        // business without the network signal, so default to business.
        if (!kind && profile.category) { kind = "business"; label = "🏢 Business"; }
        if (!kind) return "";
        const cat = (meta?.category || profile.category || "").toString();
        const tip = cat
          ? `${kind === "business" ? "Business account" : "Creator account"} · ${cat}`
          : (kind === "business" ? "Business account" : "Creator account");
        return ` <span class="igt-acct-pill igt-acct-${kind}" title="${escapeHtml(tip)}">${label}</span>`;
      })()}</div>
      ${profile.display_name ? `<div class="igt-display-name">${escapeHtml(profile.display_name)}</div>` : ""}
      <div class="igt-rel igt-rel-${relKind}">${escapeHtml(rel)}</div>
      ${lines.length ? `<ul class="igt-lines">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
      <div class="igt-tags">${tagBtns}</div>
      ${saveBtn}
      ${archiveAllBtn}
      <a class="igt-link" href="${_settings.trackerUrl}/?lookup=${encodeURIComponent(username)}" target="_blank" rel="noopener">↗ open in tracker</a>
    </div>
  `;
  bindHeaderActions(panel);
  panel.querySelector("[data-action='save-vault']")?.addEventListener("click", () => {
    saveToVault(username);
  });
  panel.querySelector("[data-action='archive-all']")?.addEventListener("click", async () => {
    // Arm the silent AudioContext synchronously inside the click
    // handler so Chrome's autoplay policy is satisfied (the user
    // gesture is live for the duration of this handler). With this
    // in place, archiving keeps running at full speed even if you
    // immediately switch tabs — no separate button required.
    await _archiveArmAudio();
    archiveAllVisiblePosts(username, { ..._archiveCategories });
  });
  // Category-pill toggles. Click flips the pill's on-state, persists
  // to storage, and re-styles in place (no full overlay rebuild —
  // keeps the user's drag position + scroll context).
  panel.querySelectorAll(".igt-cat-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.cat;
      _archiveCategories[key] = !_archiveCategories[key];
      btn.classList.toggle("on", _archiveCategories[key]);
      try {
        await chrome.storage.local.set({ archiveCategories: _archiveCategories });
      } catch { /* storage write best-effort */ }
    });
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
    // Even when not on a profile, the URL might be a single-post /
    // reel page where we want to auto-archive media if the setting
    // is on. Fire the archive check independently of the overlay.
    if (_settings?.autoArchiveMedia) maybeArchiveCurrentMedia();
    return;
  }
  if (username === _lastUsername) return;
  _lastUsername = username;
  refreshOverlay(username);
  if (_settings?.autoArchiveMedia) maybeArchiveCurrentMedia();
}

// Auto-archive: when the user lands on a single-post / single-reel /
// single-story page, fetch the largest visible media element and post
// the bytes to the local tracker. Idempotent server-side (skips if
// the file already exists) so re-visits don't re-download.
// Parse a media id out of an IG path. Returns {kind, id} or null.
// Supports:
//   /p/<id>/                          — post
//   /reel/<id>/                       — reel
//   /<user>/p/<id>/                   — modal post
//   /<user>/reel/<id>/                — modal reel
//   /stories/highlights/<album-id>/   — highlight album (the album id
//                                       is stable; individual stories
//                                       within share the album path)
//   /stories/<user>/<story-id>/       — single story
function _parseMediaPath(path) {
  // Normalize the URL group ("p") to the descriptive kind ("post") that
  // the rest of the code (canStep, story-narrowing, _detectMediaKind)
  // expects. Without this, parsed.kind ended up as "p" and canStep
  // silently evaluated to false on every post URL.
  const norm = (k) => (k === "p" ? "post" : k);
  let m = path.match(/^\/(p|reel)\/([^\/]+)\/?/);
  if (m) return { kind: norm(m[1]), id: m[2], username: null };
  m = path.match(/^\/([^/]+)\/(p|reel)\/([^\/]+)\/?/);
  if (m) return { kind: norm(m[2]), id: m[3], username: m[1] };
  m = path.match(/^\/stories\/highlights\/([^\/]+)\/?/);
  if (m) return { kind: "highlight", id: `highlight-${m[1]}`, username: null };
  m = path.match(/^\/stories\/([^/]+)\/([^\/]+)\/?/);
  if (m) return { kind: "story", id: `story-${m[2]}`, username: m[1] };
  return null;
}

// Auto-scroll the profile grid to lazy-load every post tile IG
// has. Stops when 3 consecutive scrolls reveal no new tiles, or
// after a sanity cap. Called by archiveAllVisiblePosts BEFORE the
// archive loop, since once we start navigating to per-post URLs
// the profile grid re-renders and we lose our scroll position.
// Full pointer/mouse event sequence — IG's React handlers attach to
// pointerdown/mousedown, not just click, so a bare el.click() can
// silently no-op. Used by archive-all to actually open IG's post
// modal (rather than navigating, which loses the modal route).
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
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  return true;
}

// Random delay in [minMs, maxMs] — used to make archive-all look
// less like a script. Fixed-cadence patterns are the easiest thing
// for IG's anti-automation heuristics to spot, so every wait gets
// jittered.
function _humanDelay(minMs, maxMs) {
  const span = Math.max(0, maxMs - minMs);
  return new Promise((r) => setTimeout(r, minMs + Math.random() * span));
}

// Collect every <a> in <main> whose href looks like a post or reel
// permalink — under EITHER URL shape:
//   /p/<id>/          (older, top-level)
//   /reel/<id>/
//   /<user>/p/<id>/   (newer, user-prefixed — current IG default)
//   /<user>/reel/<id>/
// We delegate the URL-shape check to _parseMediaPath so we use the
// same logic as the archive flow itself.
function _collectPostLinks() {
  return Array.from(document.querySelectorAll("main a[href]")).filter((a) => {
    const href = a.getAttribute("href") || "";
    if (!href) return false;
    const parsed = _parseMediaPath(href);
    return !!parsed && (parsed.kind === "post" || parsed.kind === "reel");
  });
}

async function _autoScrollToLoadAllTiles({
  toastFn = null,
  maxScrolls = 80,
} = {}) {
  let lastCount = -1;
  let stableScrolls = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = _collectPostLinks().length;
    if (toastFn) toastFn(`Loading more posts… (${count} so far)`);
    if (count === lastCount) {
      stableScrolls += 1;
      if (stableScrolls >= 3) break; // 3 in a row with no growth → end of grid
    } else {
      stableScrolls = 0;
      lastCount = count;
    }
    // Don't always slam to the bottom — sometimes scroll partially
    // (like a real user reading rows). Lazy-load triggers as soon as
    // the viewport bottom intersects the lazy-load sentinel.
    const targetY = document.documentElement.scrollHeight * (0.85 + Math.random() * 0.15);
    window.scrollTo({ top: targetY, behavior: "instant" });
    // 2-4s between scrolls — humans glance at the grid as they go.
    await _humanDelay(2000, 4000);
  }
  return lastCount;
}

// Walk a profile and archive whichever categories are selected. The
// caller passes a {posts, reels, tagged, highlights, story} object;
// any false key skips that category entirely (no scroll, no walk).
// At least one category must be true; everything-off is a no-op.
async function archiveAllVisiblePosts(username, categories) {
  if (!extensionAlive()) return;
  if (_archiveAllInFlight) {
    console.log("[IG Tracker] archive-all: already running, ignoring re-click");
    return;
  }
  // Default to all-on if caller didn't specify. Story stays off by
  // default — it's opt-in.
  const cats = {
    posts:      categories?.posts      ?? true,
    reels:      categories?.reels      ?? true,
    tagged:     categories?.tagged     ?? true,
    highlights: categories?.highlights ?? true,
    story:      categories?.story      ?? false,
  };
  if (!Object.values(cats).some(Boolean)) {
    console.log("[IG Tracker] archive-all: no categories selected, nothing to do");
    return;
  }
  _archiveAllInFlight = true;
  _installArchiveAudioFallback();
  let completedSuccessfully = false;
  try {
    const result = await _archiveAllVisiblePostsImpl(username, cats);
    completedSuccessfully = true;
    return result;
  } finally {
    _archiveAllInFlight = false;
    // Belt-and-suspenders: even if _updateProgressPanel({done:true})
    // never fired (impl threw mid-run, panel was closed manually,
    // etc.), we shouldn't leave a silent AudioContext running on
    // the page. Idempotent — no-op if already disarmed.
    _archiveDisarmAudio();
    // Ping server with completion marker only if we ran to natural
    // end. If the script was killed mid-run (extension reload,
    // window closed by runner budget timer, navigation away), we
    // never reach this — the marker file isn't written, and the
    // queue endpoint sees an unmarked partial archive and re-queues
    // it. The marker is written via /api/archive-complete which
    // creates data/media/<u>/.archive_complete.
    if (completedSuccessfully) {
      try {
        await bgFetch(`${_settings.trackerUrl}/api/archive-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        });
        console.log(`[IG Tracker] archive-all: marked @${username} complete`);
      } catch (e) {
        console.warn(`[IG Tracker] archive-all: complete-ping failed for @${username}:`, e?.message || e);
      }
      // Signal the SW directly so the auto-archive runner (in
      // completion mode) can advance to the next account immediately
      // instead of waiting for the full tab budget. Best-effort: if
      // the SW is dormant or the message fails, the budget timer
      // still fires the close fallback.
      try {
        chrome.runtime.sendMessage({ type: "archive-runner-complete", username });
      } catch (_) { /* SW unreachable, fall back to budget timer */ }
    }
  }
}

async function _archiveAllVisiblePostsImpl(username, categories) {
  const profilePath = `/${username}/`;
  const startScrollY = window.scrollY;
  const progress = _ensureProgressPanel();

  // Make sure we're on the canonical profile path before tab-walking.
  if (window.location.pathname !== profilePath) {
    history.pushState({}, "", profilePath);
    await _humanDelay(2000, 4000);
  }

  // Collected items across all tabs, dedup'd by href.
  const seenHref = new Set();
  const collectedItems = []; // {href, el, source}

  // collectFromCurrentView is parameterized by what to pick up, since
  // each tab visit can yield posts/reels (the grid) AND highlights
  // (the row above the grid, only mounted on the Posts tab). We pass
  // pickGrid / pickHighlights / pickStory flags so the same function
  // serves Posts / Reels / Tagged / Story landings.
  const collectFromCurrentView = async (sourceLabel, { pickGrid, pickHighlights, pickStory } = {}) => {
    _updateProgressPanel(progress, {
      title: `Loading ${sourceLabel}…`,
      sub: "Auto-scrolling tiles into the DOM",
    });
    const loaded = await _autoScrollToLoadAllTiles({
      toastFn: (msg) => _updateProgressPanel(progress, { sub: `${sourceLabel}: ${msg}` }),
    });
    console.log(`[IG Tracker] archive-all: ${sourceLabel} scroll done, ${loaded} tiles`);
    window.scrollTo({ top: 0, behavior: "instant" });
    await _humanDelay(600, 1200);
    let added = 0;
    if (pickGrid) {
      for (const a of _collectPostLinks()) {
        const href = a.getAttribute("href");
        if (!href || seenHref.has(href)) continue;
        seenHref.add(href);
        collectedItems.push({ href, el: a, source: sourceLabel });
        added += 1;
      }
    }
    if (pickHighlights) {
      for (const a of document.querySelectorAll('a[href^="/stories/highlights/"]')) {
        const href = a.getAttribute("href");
        if (!href || seenHref.has(href)) continue;
        seenHref.add(href);
        collectedItems.push({ href, el: a, source: `${sourceLabel} (highlight)` });
        added += 1;
      }
    }
    if (pickStory) {
      // Live story: clickable profile pic with story ring, rendered
      // as `a[href^="/stories/<username>/"]` (NOT /stories/highlights/).
      // We accept any /stories/<user>/ link as the story entry point —
      // clicking it opens the story viewer at slide 1, and the per-
      // item archiver walks through.
      const storyPrefix = `/stories/${username}/`;
      for (const a of document.querySelectorAll(`a[href^="${storyPrefix}"]`)) {
        const href = a.getAttribute("href");
        if (!href || seenHref.has(href)) continue;
        // Skip highlights (they have /highlights/ in path, but the
        // selector above already excludes those — defensive check).
        if (href.includes("/highlights/")) continue;
        seenHref.add(href);
        collectedItems.push({ href, el: a, source: `${sourceLabel} (story)` });
        added += 1;
      }
    }
    return added;
  };

  // ---- Posts tab (default landing) ----
  // Scan grid only if Posts is on; scan highlights/story alongside if
  // those are on (the row + story ring live above the Posts grid).
  if (categories.posts || categories.highlights || categories.story) {
    const postsAdded = await collectFromCurrentView("Posts", {
      pickGrid: categories.posts,
      pickHighlights: categories.highlights,
      pickStory: categories.story,
    });
    console.log(`[IG Tracker] archive-all: +${postsAdded} from Posts tab`);
  } else {
    console.log("[IG Tracker] archive-all: skipping Posts tab (none of posts/highlights/story selected)");
  }

  // ---- Reels tab ----
  if (categories.reels) {
    const reelsTabHref = `${profilePath}reels/`;
    const reelsTab = document.querySelector(`a[href="${reelsTabHref}"]`);
    if (reelsTab) {
      _updateProgressPanel(progress, { title: "Switching to Reels…", sub: "" });
      try { clickElement(reelsTab); } catch { history.pushState({}, "", reelsTabHref); }
      await _humanDelay(2500, 4500);
      const reelsAdded = await collectFromCurrentView("Reels", { pickGrid: true });
      console.log(`[IG Tracker] archive-all: +${reelsAdded} from Reels tab`);
    } else {
      console.log("[IG Tracker] archive-all: no Reels tab (none posted, or hidden)");
    }
  } else {
    console.log("[IG Tracker] archive-all: skipping Reels (not selected)");
  }

  // ---- Tagged tab ----
  if (categories.tagged) {
    const taggedTabHref = `${profilePath}tagged/`;
    const taggedTab = document.querySelector(`a[href="${taggedTabHref}"]`);
    if (taggedTab) {
      _updateProgressPanel(progress, { title: "Switching to Tagged…", sub: "" });
      try { clickElement(taggedTab); } catch { history.pushState({}, "", taggedTabHref); }
      await _humanDelay(2500, 4500);
      const taggedAdded = await collectFromCurrentView("Tagged", { pickGrid: true });
      console.log(`[IG Tracker] archive-all: +${taggedAdded} from Tagged tab`);
    } else {
      console.log("[IG Tracker] archive-all: no Tagged tab");
    }
  } else {
    console.log("[IG Tracker] archive-all: skipping Tagged (not selected)");
  }

  // ---- Back to Posts so tile-click navigation has a clean baseline ----
  // Use a real in-page-link click rather than pushState. pushState
  // changes the URL but doesn't trigger IG's React re-render, so the
  // Posts-tab DOM never mounts and the loop's first iteration finds
  // no live <a> elements (then falls back to pushState which also
  // doesn't render a modal — total dead end).
  if (window.location.pathname !== profilePath) {
    const backLink =
      document.querySelector(`header a[href="${profilePath}"]`) ||
      document.querySelector(`nav a[href="${profilePath}"]`) ||
      document.querySelector(`a[href="${profilePath}"]`);
    if (backLink) {
      console.log("[IG Tracker] archive-all: returning to Posts tab via in-page link");
      try { clickElement(backLink); } catch {
        history.pushState({}, "", profilePath);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
    } else {
      console.log("[IG Tracker] archive-all: no profile link found, falling back to pushState");
      history.pushState({}, "", profilePath);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }
    // Wait longer here than other transitions — the Posts grid needs
    // to lazy-load tiles before the loop's per-iteration querySelector
    // can find them.
    await _humanDelay(3000, 5000);
  }

  if (collectedItems.length === 0) {
    _updateProgressPanel(progress, { title: "Nothing to archive", sub: "No tiles found across any tab." });
    _archiveDisarmAudio();
    setTimeout(() => progress.remove(), 4000);
    return;
  }

  // Re-resolve element references for items we collected from
  // OTHER tabs — those <a> nodes are gone now that we've returned
  // to Posts. For those we'll fall back to history.pushState.
  // Posts-tab tiles still have their elements live in the DOM.
  const tileEls = collectedItems.map((it) => {
    const live = document.querySelector(`a[href="${it.href}"]`);
    return { ...it, el: live || null };
  });

  console.log(`[IG Tracker] archive-all: ${tileEls.length} unique items collected (posts/reels/tagged/highlights)`);

  // Phase 3: for each tile, click → wait for modal → archive →
  // press Escape to close → return to profile → next.
  let saved = 0, failed = 0, slidesTotal = 0;
  for (let i = 0; i < tileEls.length; i++) {
    const { href, source } = tileEls[i];
    if (!extensionAlive()) break;
    // Re-resolve the live element on every iteration. Each
    // iteration likely re-rendered the profile DOM (because we
    // navigated away to a post/highlight, then back), so the
    // captured ref from before the loop is detached. Falling back
    // to the captured ref means clicking nothing.
    const el = document.querySelector(`a[href="${href}"]`);
    _updateProgressPanel(progress, {
      title: `Archiving ${i + 1}/${tileEls.length}`,
      sub: `${saved} done · ${slidesTotal} slides · ${failed} failed · @${username} ${source ? "(" + source + ")" : ""}`,
      pct: i / tileEls.length,
    });
    console.log(`[IG Tracker] archive-all: ${i + 1}/${tileEls.length} (${source || "?"}) → ${href}`);

    // Click the live <a> when we have one, regardless of kind —
    // post / reel / highlight thumbnails all open the right modal /
    // viewer when clicked. Synthetic clicks DO trigger IG's React
    // route handlers when dispatched on the actual <a> in the DOM
    // (the previous "clickElement is not defined" failure was masking
    // this — once defined, the click navigates). Fall back to pushState
    // + a synthetic popstate for items whose live element no longer
    // exists (e.g. tiles collected from a tab that's since been
    // re-rendered) — popstate is what IG's router listens for to
    // detect external history changes.
    const pathBefore = window.location.pathname;
    if (el) {
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        await _humanDelay(400, 800);
        clickElement(el);
      } catch (e) {
        console.warn(`[IG Tracker] archive-all: click failed for ${href}: ${e.message}`);
        history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
    } else {
      console.log(`[IG Tracker] archive-all: no live element for ${href} — pushState + popstate`);
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }
    // Pre-archive wait: 4-7s — let the modal mount, the carousel
    // controls render, and the first slide image load.
    await _humanDelay(4000, 7000);

    // Did the URL change to the expected post/reel/highlight? Match
    // by parsed kind+id rather than full path — IG shows the same
    // post under multiple URL shapes (`/uchh.zz/p/abc/`,
    // `/p/abc/`, `/p/abc/?img_index=1`) and a literal endsWith would
    // think "/p/abc" doesn't match expected "/uchh.zz/p/abc".
    const stripSlash = (s) => s.replace(/\/+$/, "");
    const expectedParsed = _parseMediaPath(href);
    const currentParsed = _parseMediaPath(window.location.pathname);
    const matchesByParse =
      expectedParsed && currentParsed &&
      expectedParsed.kind === currentParsed.kind &&
      expectedParsed.id === currentParsed.id;
    if (!matchesByParse) {
      console.warn(`[IG Tracker] archive-all: navigation didn't take (was '${pathBefore}', now '${window.location.pathname}'), forcing pushState`);
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      await _humanDelay(2000, 4000);
    }

    // For posts/reels: even if the URL is correct, the modal might
    // not have mounted (synthetic click on <a> doesn't always fire
    // IG's React modal handler). If no dialog is present, try
    // clicking the inner image — some IG variants attach the
    // modal-open handler to a child div, not the anchor.
    const isPostOrReel = href.includes("/p/") || href.includes("/reel/");
    if (isPostOrReel && el && document.querySelectorAll('[role="dialog"]').length === 0) {
      const liveStill = document.querySelector(`a[href="${href}"]`);
      const inner = (liveStill || el).querySelector('img, div[role="button"], [tabindex]');
      if (inner) {
        console.log(`[IG Tracker] archive-all: no modal yet — retrying click on inner element`);
        try { clickElement(inner); } catch (e) {
          console.warn(`[IG Tracker] archive-all: inner-element click failed: ${e.message}`);
        }
        await _humanDelay(3000, 5000);
      }
    }

    try {
      const r = await maybeArchiveCurrentMedia({ manual: true, fallbackUsername: username });
      if (r && r.ok) {
        saved += 1;
        slidesTotal += (r.saved || 0);
      } else {
        failed += 1;
      }
    } catch (e) {
      console.warn(`[IG Tracker] archive-all: error on ${href}: ${e.message}`);
      failed += 1;
    }

    // Close the viewer/modal with Escape. For posts this returns us
    // to the profile grid (modal closes); for highlights/stories
    // Escape navigates to the main feed (/) instead — IG doesn't
    // remember the profile as a back target from the story viewer.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
    await _humanDelay(1000, 2500);

    // ALWAYS go back to the profile before the next iteration. After
    // a highlight Escape leaves us on /, after a post it leaves us
    // on /<user>/ — but in both cases we want a fresh profile DOM
    // so the next tile click finds live <a> elements. Try clicking
    // the profile link in the page header first (real navigation,
    // most reliable); fall back to pushState + popstate dispatch.
    // (stripSlash is already declared earlier in this loop iteration.)
    if (stripSlash(window.location.pathname) !== stripSlash(profilePath)) {
      const profileLink =
        document.querySelector(`header a[href="${profilePath}"]`) ||
        document.querySelector(`nav a[href="${profilePath}"]`) ||
        document.querySelector(`a[href="${profilePath}"]`);
      if (profileLink) {
        console.log(`[IG Tracker] archive-all: returning to profile via in-page link`);
        try { clickElement(profileLink); } catch {
          history.pushState({}, "", profilePath);
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        }
      } else {
        console.log(`[IG Tracker] archive-all: returning to profile via pushState+popstate (no link found)`);
        history.pushState({}, "", profilePath);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
      await _humanDelay(2000, 3500);
    }

    // Post-archive pause: 5-10s before the next.
    await _humanDelay(5000, 10000);

    // Long rest every 8-12 posts.
    if ((i + 1) % (8 + Math.floor(Math.random() * 5)) === 0 && i < tileEls.length - 1) {
      const restMs = 15000 + Math.random() * 15000;
      _updateProgressPanel(progress, {
        sub: `Resting ${Math.round(restMs / 1000)}s to look human…`,
      });
      await new Promise((r) => setTimeout(r, restMs));
    }
  }

  setTimeout(() => window.scrollTo(0, startScrollY), 800);
  _updateProgressPanel(progress, {
    title: "Done",
    sub: `${saved} items saved · ${slidesTotal} slides total · ${failed} failed (posts + reels + tagged + highlights)`,
    pct: 1,
    done: true,
  });
}

// Larger, in-your-face progress panel for archive-all. Shows a title,
// a subline, and a progress bar at the top of the page. Sticks
// around for the full run; stays visible 8s after completion.
// Keep-tab-awake helper for archive runs. Conservative version of
// what the export wizard does — silent AudioContext only, NO Page
// Visibility API spoofing.
//
// Why no visibility override on Instagram: IG uses document.hidden
// for legitimate behavior we don't want to fool. Specifically:
//   - Story viewers — IG starts a "story-viewed" timer when the tab
//     becomes visible. Spoofing visible=true would mark stories as
//     viewed even when the user isn't actually watching, leaking
//     the user's viewing pattern to accounts they didn't intend to
//     signal interest in.
//   - Video / reel autoplay — visible tabs autoplay; hidden tabs
//     pause. Spoofing would burn battery + bandwidth on videos the
//     user can't see.
//   - IG's own internal polling — it backs off when tab is hidden;
//     spoofing would over-poll their endpoints.
//
// Audio-only is enough on its own: Chrome's timer-throttling
// exempts tabs producing audio output, regardless of visibility.
// AudioContext at near-zero gain produces audio output (silent to
// humans, audible to Chrome's audibility detector) without any
// effect on IG's behavior.
let _archiveAudioCtx = null;

async function _archiveArmAudio() {
  if (_archiveAudioCtx?.state === "running") return true;
  // Lazy-create the AudioContext only when this function is called —
  // and only when called from inside a user gesture (otherwise Chrome's
  // autoplay policy throws on construction). The "Archive selected"
  // click handler is the canonical caller and runs in a live gesture.
  if (!_archiveAudioCtx) {
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
      _archiveAudioCtx = ctx;
      try { ctx.addEventListener("statechange", _updateAwakeIndicator); } catch (_) {}
    } catch (e) {
      console.log("[IG Tracker] archive keepalive: lazy-create failed:", e.message);
      _updateAwakeIndicator();
      return false;
    }
  }
  try {
    await _archiveAudioCtx.resume();
    console.log(`[IG Tracker] archive keepalive: ARMED, state=${_archiveAudioCtx.state}`);
    _updateAwakeIndicator();
    return _archiveAudioCtx.state === "running";
  } catch (e) {
    console.log("[IG Tracker] archive keepalive: resume failed:", e.message);
    _updateAwakeIndicator();
    return false;
  }
}

function _archiveDisarmAudio() {
  if (_archiveAudioCtx) {
    try { _archiveAudioCtx.close(); } catch (_) {}
    _archiveAudioCtx = null;
    console.log("[IG Tracker] archive keepalive: disarmed");
  }
}

// Fallback: if auto-arm at the click handler failed for any reason
// (Chrome's autoplay policy got stricter, the click event flow was
// async, etc.), the next click anywhere in the page satisfies the
// gesture requirement and re-attempts arming. Capture phase so we
// fire even if some other handler stops propagation.
let _archiveAudioFallbackInstalled = false;
function _installArchiveAudioFallback() {
  if (_archiveAudioFallbackInstalled) return;
  _archiveAudioFallbackInstalled = true;
  // Only attempt on trusted (real user) events. Synthetic clicks
  // dispatched by archive-all's tile-clicking would otherwise hit
  // this and spam Chrome with autoplay-policy warnings — and worse,
  // could create the AudioContext outside a real gesture, leaving
  // it permanently suspended.
  const tryArm = async (e) => {
    if (!e.isTrusted) return;
    if (_archiveAudioCtx && _archiveAudioCtx.state === "running") return;
    await _archiveArmAudio();
  };
  document.addEventListener("click", tryArm, { capture: true });
  document.addEventListener("keydown", tryArm, { capture: true });
  document.addEventListener("pointerdown", tryArm, { capture: true });
}

function _ensureProgressPanel() {
  let panel = document.getElementById("igtracker-archive-progress");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "igtracker-archive-progress";
  panel.style.cssText = `
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    background: #18181b; color: #f1f1f3;
    padding: 14px 22px; border-radius: 10px;
    border: 1px solid #2a2a30;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 2147483647; min-width: 320px; max-width: 480px;
    font-family: -apple-system, sans-serif;
  `;
  panel.innerHTML = `
    <div id="igt-prog-title" style="font-size:14px;font-weight:600;margin-bottom:4px;">
      📦 Archiving…
    </div>
    <div id="igt-prog-sub" style="font-size:12px;color:#a1a1aa;line-height:1.4;"></div>
    <div style="margin-top:10px;height:4px;background:#27272a;border-radius:2px;overflow:hidden;">
      <div id="igt-prog-bar" style="height:100%;width:0%;background:#5078ff;transition:width 200ms ease;"></div>
    </div>
    <div id="igt-prog-awake" style="
      margin-top: 8px; font-size: 10px; color: #8f8f99;
      display: flex; align-items: center; gap: 4px;
    "></div>
  `;
  document.body.appendChild(panel);
  // Reflect the AudioContext state — running means we're throttling-
  // exempt and the user can switch tabs; suspended means an interaction
  // is needed before background mode kicks in. Auto-updates as the
  // archive flow arms it (which happens at the click handler that
  // started this run, so it should already be running by now).
  _updateAwakeIndicator();
  return panel;
}

function _updateAwakeIndicator() {
  const ind = document.getElementById("igt-prog-awake");
  if (!ind) return;
  const state = _archiveAudioCtx?.state;
  if (state === "running") {
    ind.innerHTML = `<span style="color:#86efac;">🔊 Background mode armed</span> — switch away anytime`;
  } else if (state === "suspended") {
    ind.innerHTML = `<span style="color:#fcd34d;">💤 Click anywhere in this tab</span> to enable background mode`;
  } else {
    ind.textContent = "";
  }
}

function _updateProgressPanel(panel, { title, sub, pct, done } = {}) {
  if (!panel) return;
  if (title) panel.querySelector("#igt-prog-title").textContent = title;
  if (sub != null) panel.querySelector("#igt-prog-sub").textContent = sub;
  if (pct != null) panel.querySelector("#igt-prog-bar").style.width = `${Math.round(pct * 100)}%`;
  if (done) {
    panel.querySelector("#igt-prog-bar").style.background = "#34d399";
    // Tear down the silent audio so we don't leave a paused-but-armed
    // AudioContext attached to the page after archiving finishes.
    _archiveDisarmAudio();
    setTimeout(() => panel.remove(), 12000);
  }
}

// Backwards-compat: a few earlier code paths still call showOverlayToast.
function showOverlayToast(text) {
  let toast = document.getElementById("igtracker-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "igtracker-toast";
    toast.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: #18181b; color: #f1f1f3;
      padding: 10px 16px; border-radius: 8px;
      border: 1px solid #2a2a30; font-size: 13px;
      font-family: -apple-system, sans-serif;
      z-index: 2147483647; max-width: 360px;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.remove(), 6000);
}

// Re-entry guards. Concurrent archive runs corrupt the page state
// because both invocations press Next/ArrowRight on the same DOM and
// each adds the other's revealed media to its own caps array. Symptom:
// each highlight ended up with one extra slide that was actually the
// post's slide1, because an auto-archive fired mid-stepper and the
// path-change leak captured profile-grid media.
//   _archiveInFlight     — true while one maybeArchiveCurrentMedia is running
//   _archiveAllInFlight  — true for the duration of archive-all (suppresses
//                          auto-archive triggered by archive-all's own
//                          pushState/popstate calls)
let _archiveInFlight = false;
let _archiveAllInFlight = false;

// ---------- GraphQL story manifest cache ----------
//
// The MAIN-world interceptor (content/ig-network-interceptor.js)
// posts story-shaped objects from IG's GraphQL responses to this
// window. We cache them keyed by every numeric id we can pull out
// of the response (album_id, reel_id, user pk, story pk). When
// archiving a highlight, we look up the album_id from the URL —
// `/stories/highlights/<albumId>/` — and use the canonical item
// list instead of DOM-walking. This gets us:
//   - Real CDN MP4 URLs for video stories (not unfetchable blobs)
//   - The exact item count (no "did we miss one?")
//   - Stable `pk` per story for filename dedup across runs
const _storyManifest = new Map(); // numericId -> [{pk, media_type, image_url, video_url, taken_at}, ...]
const _storyManifestSeenAt = new Map(); // numericId -> last update epoch ms

// Post manifests work the same way but keyed by SHORTCODE (the /p/<code>/
// value) rather than numeric id. Each entry stores a flat list of slides
// for carousels (or a single slide for non-carousels) plus the resolved
// username so the archiver doesn't have to scrape it from the DOM.
const _postManifest = new Map(); // shortcode -> { slides: [...], username, pk, media_type }
const _postManifestSeenAt = new Map();

// Account-type cache keyed by username, populated by the network
// interceptor whenever IG returns a profile-shaped object. Lets the
// overlay show a "Business" / "Creator" pill so the user can spot
// likely-low-follow-back accounts before requesting.
//   { is_business, is_professional_account, account_type, category }
const _profileMeta = new Map();

function _registerManifestItems(numericIds, items) {
  if (!items || !items.length) return;
  const now = Date.now();
  for (const id of numericIds) {
    // Replace rather than append — IG's responses contain the full
    // album each time, so the latest response wins.
    _storyManifest.set(id, items);
    _storyManifestSeenAt.set(id, now);
  }
}

function _registerPostManifest(post) {
  if (!post || !post.shortcode || !Array.isArray(post.slides)) return;
  _postManifest.set(post.shortcode, post);
  _postManifestSeenAt.set(post.shortcode, Date.now());
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "igtracker-net") return;
  // The interceptor sends both individual items and grouped albums.
  // Groups are more reliable for the highlight case because they
  // tell us exactly which items belong to which album.
  if (Array.isArray(d.groups)) {
    for (const g of d.groups) {
      if (g.numericIds && g.items) _registerManifestItems(g.numericIds, g.items);
    }
  }
  // Loose individual-item fallback for endpoints we don't recognize:
  // we can't associate them with an album, but we still cache them
  // by their own pk so we can match later.
  if (Array.isArray(d.items)) {
    for (const it of d.items) {
      if (it.pk) _registerManifestItems([String(it.pk)], [it]);
    }
  }
  // Post manifests: the interceptor extracts every post-shaped object
  // from IG's GraphQL/API responses. We index by shortcode so the
  // post archiver can look them up by URL (/p/<shortcode>/).
  if (Array.isArray(d.posts)) {
    for (const p of d.posts) _registerPostManifest(p);
  }
  if (Array.isArray(d.profiles)) {
    let currentUserUpdated = false;
    for (const p of d.profiles) {
      if (!p || !p.username) continue;
      // Merge over any existing entry — IG returns these from many
      // endpoints (your profile fetch, suggested users, search) and
      // some carry richer fields than others. Last write wins for
      // any single field, but absent fields don't clobber present
      // ones from a prior response.
      const prior = _profileMeta.get(p.username) || {};
      _profileMeta.set(p.username, {
        is_business: p.is_business ?? prior.is_business ?? false,
        is_professional_account: p.is_professional_account ?? prior.is_professional_account ?? false,
        account_type: p.account_type ?? prior.account_type ?? null,
        category: p.category ?? prior.category ?? null,
      });
      if (p.username === _lastUsername) currentUserUpdated = true;
    }
    // If the current profile's metadata just landed (or was upgraded
    // with new fields), nudge the overlay to re-render so the
    // Business / Creator pill shows up without the user having to
    // navigate away and back. Otherwise the pill only appears when
    // the GraphQL response beats the overlay paint, which is racy
    // on first visit.
    if (currentUserUpdated && _panelOpen && _panelEl && _lastUsername) {
      const stillSameUser = _lastUsername;
      fetchLookup(stillSameUser).then((fresh) => {
        if (!fresh || !_panelEl || _lastUsername !== stillSameUser || !_panelOpen) return;
        renderPanel(_panelEl, stillSameUser, fresh);
      }).catch(() => {});
    }
  }
});

async function _waitForStoryManifest(albumId, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const items = _storyManifest.get(String(albumId));
    if (items && items.length) return items;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function _waitForPostManifest(shortcode, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const post = _postManifest.get(String(shortcode));
    if (post && post.slides && post.slides.length) return post;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Save a post slide directly via the SW. Same approach as
// _archiveManifestItem (highlights) — fetch the real CDN URL through
// the SW, save by IG's stable per-slide pk so re-archives dedup.
//
// Tries every candidate URL the manifest captured (largest-first).
// IG's signed CDN URLs occasionally fail — expired sigs, transient
// 5xx, edge-case CORS — and the smaller-resolution variants are
// served by different cache nodes that often succeed when the largest
// one doesn't. Trying each in turn means a single bad URL drops the
// resolution we save at, not the slide entirely.
async function _archivePostSlide(username, groupId, slide, slideIndex) {
  const isVideo = slide.media_type === 2 &&
                  (slide.video_url || (slide.video_urls && slide.video_urls.length));
  const urls = isVideo
    ? (slide.video_urls && slide.video_urls.length
        ? slide.video_urls
        : (slide.video_url ? [slide.video_url] : []))
    : (slide.image_urls && slide.image_urls.length
        ? slide.image_urls
        : (slide.image_url ? [slide.image_url] : []));
  if (!urls.length) return { ok: false, error: "no usable url" };
  const ext = isVideo ? "mp4" : "jpg";
  // Posts use slide<N> for filename — slide order is meaningful and
  // stable within a carousel. Carousel slides have their own pks too,
  // but slide<N> matches the existing post layout convention so users
  // can tell at a glance which is the cover.
  const slideId = `${groupId}/slide${slideIndex + 1}`;
  console.log(`[IG Tracker] manifest-archive (post): fetching ${isVideo ? "video" : "image"} slide${slideIndex + 1} pk=${slide.pk} for @${username} (${urls.length} candidate URL(s))`);
  let fetched = null;
  let lastError = null;
  for (let attempt = 0; attempt < urls.length; attempt++) {
    const r = await _fetchAsBase64(urls[attempt]);
    if (r.ok && r.body) { fetched = r; break; }
    lastError = r.error || "fetch failed";
    if (attempt < urls.length - 1) {
      console.log(`[IG Tracker] manifest-archive (post): URL ${attempt + 1}/${urls.length} failed (${lastError}), trying next size`);
    }
  }
  if (!fetched) {
    return { ok: false, error: lastError || "fetch failed" };
  }
  const resp = await bgFetch(`${_settings.trackerUrl}/api/media-bytes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, media_id: slideId, ext, bytes_b64: fetched.body }),
  });
  if (!resp.ok) {
    const detail = (resp.body && resp.body.detail) || resp.error || `HTTP ${resp.status}`;
    return { ok: false, error: detail };
  }
  const body = resp.body || {};
  const summary = body.size ? `${body.size} bytes` : (body.skipped || "ok");
  console.log(`[IG Tracker] manifest-archive (post): saved @${username}/${slideId}.${ext} (${summary})`);
  return { ok: true, ext, summary };
}

// Save a story manifest item directly via the SW. Bypasses DOM
// walking entirely. Returns {ok, error, ext, summary}.
async function _archiveManifestItem(username, groupId, item) {
  // Stable per-story id: IG's pk is unique per story, persists across
  // sessions, and never changes. Re-archiving the same album writes to
  // the same filenames → server's idempotent check skips identical
  // bytes, dedup is automatic.
  const isVideo = item.media_type === 2 && item.video_url;
  const url = isVideo ? item.video_url : item.image_url;
  if (!url) return { ok: false, error: "no usable url" };
  const ext = isVideo ? "mp4" : "jpg";
  const slideId = `${groupId}/${item.pk}`;
  console.log(`[IG Tracker] manifest-archive: fetching ${isVideo ? "video" : "image"} pk=${item.pk} for @${username}`);
  // Manifest URLs are real CDN URLs — route through the SW for cookies + CORS.
  const fetched = await _fetchAsBase64(url);
  if (!fetched.ok || !fetched.body) {
    return { ok: false, error: fetched.error || "fetch failed" };
  }
  const resp = await bgFetch(`${_settings.trackerUrl}/api/media-bytes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, media_id: slideId, ext, bytes_b64: fetched.body }),
  });
  if (!resp.ok) {
    const detail = (resp.body && resp.body.detail) || resp.error || `HTTP ${resp.status}`;
    return { ok: false, error: detail };
  }
  const body = resp.body || {};
  const summary = body.size ? `${body.size} bytes` : (body.skipped || "ok");
  console.log(`[IG Tracker] manifest-archive: saved @${username}/${slideId}.${ext} (${summary})`);
  return { ok: true, ext, summary };
}

async function maybeArchiveCurrentMedia({ manual = false, fallbackUsername = null } = {}) {
  if (!extensionAlive()) return { ok: false, error: "extension reloaded" };
  if (!manual && !_settings?.autoArchiveMedia) return { ok: false, error: "auto-archive disabled" };
  if (!manual && _archiveAllInFlight) {
    console.log("[IG Tracker] archive skip: archive-all is running, suppressing auto-archive");
    return { ok: false, error: "archive-all in progress" };
  }
  if (_archiveInFlight) {
    console.log(`[IG Tracker] archive skip: another archive run is already in progress (manual=${manual})`);
    return { ok: false, error: "another archive in progress" };
  }
  _archiveInFlight = true;
  try {
    return await _maybeArchiveCurrentMediaImpl({ manual, fallbackUsername });
  } finally {
    _archiveInFlight = false;
  }
}

async function _maybeArchiveCurrentMediaImpl({ manual = false, fallbackUsername = null } = {}) {
  const path = window.location.pathname;
  const parsed = _parseMediaPath(path);
  if (!parsed) {
    const msg = `path '${path}' isn't a post, reel, story, or highlight`;
    console.log(`[IG Tracker] archive skip: ${msg}`);
    return { ok: false, error: msg };
  }
  // Save layout (server-side path):
  //   posts:      data/media/<user>/post_<postid>/slide<N>.jpg
  //   reels:      data/media/<user>/reel_<reelid>/slide<N>.jpg
  //   highlights: data/media/<user>/highlight_<albumid>/<ts>_slide<N>.jpg
  //   stories:    data/media/<user>/story_<storyid>/<ts>_slide<N>.jpg
  // The "groupId" is the parent folder for all slides of this post /
  // reel / highlight / story. Per-slide naming is decided below in the
  // save loop — posts use slide<N>, highlights use the CDN filename
  // so re-archives dedup against existing files.
  const isVolatile = parsed.kind === "story" || parsed.kind === "highlight";
  // For highlight album_id: parsed.id is already "highlight-<album>";
  // strip the prefix so the folder name is just "highlight_<album>".
  const cleanId = parsed.id.replace(/^(highlight|story)-/, "");
  const groupId = `${parsed.kind}_${cleanId}`;
  console.log(`[IG Tracker] ${manual ? "manual" : "auto"}-archive: ${path} → ${groupId}`);

  // ---------- Manifest path (preferred for posts/reels) ----------
  // Same architecture as the highlight manifest below: the MAIN-world
  // interceptor captures post-shaped objects from IG's GraphQL/API
  // responses and indexes them by shortcode. When we navigate to a
  // post URL, IG fetches the post details — our interceptor sees
  // the response and caches the canonical slide list. We then save
  // each slide via real CDN URLs without needing the modal to
  // mount in the DOM.
  //
  // This is the proper fix for the "every post has the same N
  // grid thumbnails" bug: even when IG's React fails to mount the
  // post modal, the GraphQL fetch still happens, so we have the
  // real data regardless of DOM state.
  if (parsed.kind === "post" || parsed.kind === "reel") {
    const post = await _waitForPostManifest(parsed.id, 4000);
    if (post && post.slides && post.slides.length) {
      // Username preference: caller-passed > manifest's user.username >
      // _lastUsername > "unknown".
      const username =
        fallbackUsername ||
        post.username ||
        _lastUsername ||
        "unknown";
      console.log(`[IG Tracker] manifest-archive (post): ${post.slides.length} slide(s) found for ${parsed.id}, kind=${parsed.kind}, media_type=${post.media_type}`);
      let savedCount = 0;
      let failed = 0;
      for (let i = 0; i < post.slides.length; i++) {
        const r = await _archivePostSlide(username, groupId, post.slides[i], i);
        if (r.ok) savedCount += 1;
        else { failed += 1; console.warn(`[IG Tracker] manifest-archive (post): failed slide${i + 1}: ${r.error}`); }
      }
      if (savedCount > 0) {
        return {
          ok: true,
          username,
          media_id: groupId,
          slides: post.slides.length,
          saved: savedCount,
          summary: `${savedCount}/${post.slides.length} slides (manifest)`,
        };
      }
      console.warn(`[IG Tracker] manifest-archive (post): 0/${post.slides.length} saved, falling back to DOM walk`);
    } else {
      console.log(`[IG Tracker] manifest-archive (post): no manifest cached for ${parsed.id} after wait, falling back to DOM walk`);
    }
  }

  // ---------- Manifest path (preferred for highlights) ----------
  // The MAIN-world network interceptor caches story manifests keyed
  // by album_id from IG's GraphQL responses. If we have one for this
  // album, fetch each item directly via real CDN URLs — no stepper,
  // no canvas frame grabs, real MP4s for video stories. Falls through
  // to the DOM-walking flow below if the manifest isn't available
  // (older IG variant, network not yet observed, etc.).
  if (parsed.kind === "highlight" || parsed.kind === "story") {
    const manifestItems = await _waitForStoryManifest(cleanId, 4000);
    if (manifestItems && manifestItems.length) {
      // Resolve username — order of preference:
      //   1. parsed.username (story URLs include it)
      //   2. fallbackUsername passed in by archive-all (always reliable
      //      since archive-all knows whose profile it's archiving)
      //   3. _lastUsername (last profile we visited; gets nulled when
      //      we navigate to a non-profile path like /stories/...)
      // Highlight URLs (`/stories/highlights/<id>/`) don't carry the
      // user, so without #2, racing the location-change observer was
      // landing some highlights on @unknown.
      const username =
        parsed.username || fallbackUsername || _lastUsername || "unknown";
      console.log(`[IG Tracker] manifest-archive: ${manifestItems.length} item(s) found for ${cleanId}, kind=${parsed.kind}`);
      let savedCount = 0;
      let failed = 0;
      for (const item of manifestItems) {
        const r = await _archiveManifestItem(username, groupId, item);
        if (r.ok) savedCount += 1; else { failed += 1; console.warn(`[IG Tracker] manifest-archive: failed pk=${item.pk}: ${r.error}`); }
      }
      if (savedCount > 0) {
        return {
          ok: true,
          username,
          media_id: groupId,
          slides: manifestItems.length,
          saved: savedCount,
          summary: `${savedCount}/${manifestItems.length} slides (manifest)`,
        };
      }
      // If 0 saved despite manifest existing, fall through to DOM walk
      // — better than returning empty.
      console.warn(`[IG Tracker] manifest-archive: 0/${manifestItems.length} saved, falling back to DOM walk`);
    } else {
      console.log(`[IG Tracker] manifest-archive: no manifest cached for ${cleanId} after wait, falling back to DOM walk`);
    }
  }

  // Wait briefly for the page to render the media element. On manual
  // press, the user is already viewing the media so a shorter wait
  // is fine; for auto we wait longer to give lazy-loaded video time
  // to mount.
  await new Promise((r) => setTimeout(r, manual ? 400 : 1500));
  // IG shows a "View as <user>? — they'll see you viewed their story"
  // interstitial when navigating directly to a highlight or story URL
  // (and occasionally a similar one for posts). The actual media is
  // hidden until the user clicks "View story" / "View" — so dismiss
  // it before scanning. We try repeatedly because the interstitial
  // sometimes mounts a beat after the URL changes.
  await _dismissConsentInterstitial();

  // Modal-mount guard for posts/reels. When archive-all clicks a
  // profile tile but IG's React doesn't mount the post modal, the
  // URL changes to /p/<id>/ but the profile-grid DOM stays — and
  // findAllSaveableMedia returns the grid's cover thumbnails. The
  // archiver would then save those thumbs as the post's slides,
  // producing the "every post folder has the same N images" bug.
  // Detect this by counting <article> elements: the post modal
  // contains exactly one article with the post; the profile grid
  // shows many tiles which IG renders as separate articles. We also
  // count post-permalink anchors visible on the page — anything
  // ≥ 4 is a strong signal we're still on the grid.
  if (parsed.kind === "post" || parsed.kind === "reel") {
    const articleCount = document.querySelectorAll("article").length;
    const postLinkCount = document.querySelectorAll(
      'main a[href*="/p/"], main a[href*="/reel/"]'
    ).length;
    const dialogPresent = document.querySelectorAll('[role="dialog"]').length > 0;
    if (!dialogPresent && (articleCount > 2 || postLinkCount >= 4)) {
      const msg = `post modal didn't mount (articles=${articleCount}, post-links=${postLinkCount}, no dialog) — refusing to save profile-grid thumbnails as slides`;
      console.warn(`[IG Tracker] archive: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  let caps = findAllSaveableMedia();
  // For posts/reels, prefer media inside [role="dialog"] when a
  // dialog is present — the post modal lives there, and the grid
  // behind it gets correctly excluded. Falls back to the un-scoped
  // scan if no dialog (standalone /p/<id>/ page where the post is
  // rendered directly in <main>).
  if ((parsed.kind === "post" || parsed.kind === "reel") &&
      document.querySelectorAll('[role="dialog"]').length > 0) {
    const dialogScoped = caps.filter((c) =>
      c.element.closest('[role="dialog"]')
    );
    if (dialogScoped.length > 0) {
      console.log(`[IG Tracker] archive: scoped to dialog — ${dialogScoped.length}/${caps.length} candidates retained`);
      caps = dialogScoped;
    }
  }
  // One retry if nothing was found yet — handles slow-loading reels.
  // If still nothing, try the consent-dismiss again (interstitial may
  // have mounted late) and re-scan.
  if (caps.length === 0) {
    await new Promise((r) => setTimeout(r, 1200));
    await _dismissConsentInterstitial();
    caps = findAllSaveableMedia();
  }
  if (caps.length === 0) {
    // Diagnostic: report what's on the page so we can tell whether
    // (a) the modal/viewer never mounted (DOM is wrong), or
    // (b) it mounted but our filters reject every element.
    const allImgs = document.querySelectorAll("img").length;
    const allVids = document.querySelectorAll("video").length;
    const dialogs = document.querySelectorAll('[role="dialog"]').length;
    const dialogMedia = document.querySelectorAll('[role="dialog"] img, [role="dialog"] video').length;
    const mainMedia = document.querySelectorAll('main img, main video').length;
    const msg = `no media element found on page (page has ${allImgs}img+${allVids}vid; main:${mainMedia}; dialogs:${dialogs}, dialog-media:${dialogMedia}; path=${window.location.pathname})`;
    console.warn(`[IG Tracker] archive: ${msg}`);
    return { ok: false, error: msg };
  }

  // Carousel step-through: posts can have up to 10 slides, but IG
  // only lazy-loads the current slide + a couple adjacent ones, so
  // an initial scan misses slides 4-10. Programmatically click the
  // "Next" arrow until it disappears (= we're on the last slide),
  // collecting every newly-loaded src into the cap list. Stories
  // and highlights have a different navigation model (tap to advance,
  // single src per view) so we skip the stepper for those.
  // Stepping enabled for posts, reels, AND highlights/stories. For
  // highlights we narrow to the centered media on every step so
  // neighboring album thumbnails don't pollute the captures, and the
  // path-change guard breaks the loop if "Next" carries us into a
  // different album (the URL pathname changes when that happens).
  const canStep =
    parsed.kind === "post" ||
    parsed.kind === "reel" ||
    parsed.kind === "story" ||
    parsed.kind === "highlight";
  const isStoryLike = parsed.kind === "story" || parsed.kind === "highlight";

  // For stories/highlights the initial scan also needs narrowing —
  // the same neighbor-album-cover problem the per-step narrowing
  // solves. Run it once before the stepper kicks in.
  const _findCenteredCandidate = () => {
    const all = findAllSaveableMedia();
    if (!all.length) return null;
    const vw = window.innerWidth;
    const vcx = vw / 2;
    let best = null;
    let bestScore = -Infinity;
    for (const c of all) {
      const r = c.element.getBoundingClientRect();
      const cx = (r.left + r.right) / 2;
      if (cx < 0 || cx > vw) continue;
      const distFromCenter = Math.abs(cx - vcx);
      const score = c.area - distFromCenter * 5000;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };
  if (isStoryLike) {
    const c = _findCenteredCandidate();
    caps = c ? [c] : [];
    console.log(`[IG Tracker] archive: story/highlight — initial scan narrowed to centered (${caps.length} slide)`);
  }

  // Pause auto-advance on stories/highlights so the player doesn't
  // race the stepper. Best-effort — harmless if no pause button.
  if (isStoryLike) {
    const pauseBtn = document.querySelector(
      'button[aria-label="Pause"], [role="button"][aria-label="Pause"]'
    );
    if (pauseBtn) {
      try { pauseBtn.click(); console.log("[IG Tracker] archive: paused story auto-advance"); } catch {}
    }
  }

  // Snapshot the URL path at start. If the user navigates away
  // mid-step, abort the stepper.
  const startPath = window.location.pathname;
  if (canStep) {
    // Dedup by pathname (resolution variants of the same image
    // collapse to one entry; otherwise we'd over-count slides).
    const seenKeys = new Set(caps.map((c) => _dedupKey(c.src)));
    console.log(`[IG Tracker] archive: stepper start — initial scan found ${caps.length} slide(s), kind=${parsed.kind}`);
    for (const c of caps) console.log(`[IG Tracker] archive:   initial src ${_dedupKey(c.src)}`);

    const scanForNew = () => {
      let foundNew = 0;
      // For stories/highlights: only consider the currently-centered
      // media. Otherwise the neighboring album-cover thumbnails IG
      // renders at the screen edges keep getting added on every step.
      const candidates = isStoryLike
        ? (() => { const c = _findCenteredCandidate(); return c ? [c] : []; })()
        : findAllSaveableMedia();
      for (const c of candidates) {
        const k = _dedupKey(c.src);
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          caps.push(c);
          foundNew += 1;
          console.log(`[IG Tracker] archive:   +new src ${k}`);
        }
      }
      return foundNew;
    };

    // Stage 1: walk BACKWARD. SKIP this entirely for stories/
    // highlights — ArrowLeft on story 1 of an album navigates to
    // the *previous album*, which we never want. The user can open
    // the highlight at the first story; we walk forward from there.
    if (!isStoryLike) {
      for (let step = 0; step < 24; step++) {
        if (window.location.pathname !== startPath) {
          console.log("[IG Tracker] archive: stepper bail — path changed");
          break;
        }
        const prevBtn = _findCarouselPrevButton();
        if (!prevBtn) {
          console.log(`[IG Tracker] archive: backward step ${step + 1}: no Previous button (reached slide 1 or no carousel)`);
          break;
        }
        console.log(`[IG Tracker] archive: backward step ${step + 1}: clicking Previous (${_describeBtn(prevBtn)})`);
        prevBtn.click();
        await new Promise((r) => setTimeout(r, 650));
        // Same path-change-mid-step guard as the forward stepper.
        if (window.location.pathname !== startPath) {
          console.log(`[IG Tracker] archive: backward stepper bail — path changed mid-step, discarding step`);
          break;
        }
        const found = scanForNew();
        console.log(`[IG Tracker] archive: backward step ${step + 1}: +${found} new, total=${caps.length}`);
      }
    }

    // Stage 2: walk FORWARD. Story/highlight stepping uses a much
    // longer dwell:
    //   - Short stories (3-5s) can finish before our scan runs if we
    //     step too fast — the auto-advance fires while we're still
    //     waiting and the player jumps ahead two stories.
    //   - Video stories need their first frame loaded before our
    //     canvas-frame fallback can read it.
    //   - The pause click at the start helps but isn't 100% reliable
    //     across IG variants.
    // 2200ms with the explicit pause + the canvas frame grab gives
    // every story a fair shot at getting captured.
    const stepDelay = isStoryLike ? 2200 : 650;
    let fwStuck = 0;
    for (let step = 0; step < 24; step++) {
      if (window.location.pathname !== startPath) {
        console.log("[IG Tracker] archive: stepper bail — path changed");
        break;
      }
      let nextBtn = _findCarouselNextButton();
      // Late-render guard: on the legacy /p/<id>/ post layout the
      // carousel arrows can mount after the initial slide image
      // resolves. If we're on step 1 with only 1 slide collected
      // and there's no Next button visible, give the page another
      // moment and re-check before declaring the post single-slide.
      // This was making archive-all save only the cover when IG
      // navigated to /p/<id>/ instead of /<user>/p/<id>/.
      if (!nextBtn && !isStoryLike && step === 0 && caps.length <= 1) {
        console.log("[IG Tracker] archive: no Next button on step 1 — waiting 2s for late-mounting arrows");
        await new Promise((r) => setTimeout(r, 2000));
        nextBtn = _findCarouselNextButton();
        if (nextBtn) {
          console.log(`[IG Tracker] archive: late-mounted Next button found ${_describeBtn(nextBtn)}`);
          // Also re-scan the initial slides — IG's lazy-loader may
          // have populated more slide imgs while we were waiting.
          scanForNew();
        }
      }
      if (!nextBtn && !isStoryLike) {
        console.log(`[IG Tracker] archive: forward step ${step + 1}: no Next button (reached last slide)`);
        break;
      }
      if (nextBtn) {
        console.log(`[IG Tracker] archive: forward step ${step + 1}: clicking Next (${_describeBtn(nextBtn)})`);
        nextBtn.click();
      } else {
        console.log(`[IG Tracker] archive: forward step ${step + 1}: ArrowRight keypress (no aria-button found)`);
        _navigateStory("next");
      }
      await new Promise((r) => setTimeout(r, stepDelay));
      // Re-check the path AFTER navigating but BEFORE scanning. IG
      // wraps from the last story of one album to the first story of
      // the *next* album (URL changes). If we scanned that DOM, we'd
      // capture the next album's media as if it belonged to this
      // album. Bail without scanning. (Same applies to posts when
      // "Next" closes the modal and lands us back on the profile.)
      if (window.location.pathname !== startPath) {
        console.log(`[IG Tracker] archive: stepper bail — path changed mid-step (now '${window.location.pathname}'), discarding step`);
        break;
      }
      const found = scanForNew();
      console.log(`[IG Tracker] archive: forward step ${step + 1}: +${found} new, total=${caps.length}`);
      if (isStoryLike) {
        if (found === 0) { if (++fwStuck >= 2) break; } else { fwStuck = 0; }
      }
    }
    console.log(`[IG Tracker] archive: stepper end — ${caps.length} unique slide(s) total`);
  }
  // Username from URL > article anchor > caller-provided fallback >
  // last-rendered profile. The fallback covers archive-all where we
  // know whose profile we're walking but the location-change observer
  // may have nulled _lastUsername during the navigation to the post
  // / highlight URL.
  const firstCap = caps[0];
  const username =
    parsed.username ||
    ((firstCap.element.closest("article")?.querySelector('a[href^="/"]')?.getAttribute("href") || "")
        .replace(/^\//, "").replace(/\/$/, "").split("/")[0]) ||
    fallbackUsername ||
    _lastUsername ||
    "unknown";

  // Save every slide. Carousel posts have multiple <img>/<video> in
  // the DOM (IG renders them all so swipe is instant) and the user
  // wants every slide, not just the visible one. For single-image
  // posts caps.length === 1 and this is just one round-trip.
  //
  // Naming:
  //   posts/reels:        post_<id>/slide<N>.jpg     — slide order is stable
  //   highlights/stories: <kind>_<id>/<imgid>.jpg    — IG's CDN filename is
  //                                                    a stable per-image id;
  //                                                    re-archiving the same
  //                                                    highlight overwrites
  //                                                    in place instead of
  //                                                    creating duplicate
  //                                                    timestamped folders.
  // Falls back to slide<N> for canvas-grabbed video frames (no CDN
  // URL); those still duplicate across runs but most highlight slides
  // are CDN images and dedup correctly.
  const _slideFingerprint = (cap) => {
    const fromUrl = (url) => {
      if (!url || url.startsWith("blob:") || url.startsWith("data:")) return null;
      try {
        const u = new URL(url);
        const last = (u.pathname.split("/").pop() || "").replace(/\.[^.]+$/, "");
        const safe = last.replace(/[^A-Za-z0-9_]/g, "_");
        return safe || null;
      } catch { return null; }
    };
    return fromUrl(cap.src) || fromUrl(cap.fallbackSrc) || null;
  };
  const results = [];
  let savedCount = 0;
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];
    let slideId;
    if (isVolatile) {
      // Highlight/story: use the CDN filename as the per-slide id;
      // fall back to position-based slide<N> for canvas-grabbed
      // frames where there's no source URL to fingerprint.
      const fp = _slideFingerprint(cap) || `slide${i + 1}`;
      slideId = `${groupId}/${fp}`;
    } else {
      // Post/reel: stable slide order, just number them.
      slideId = `${groupId}/slide${i + 1}`;
    }
    const isBlob = cap.src.startsWith("blob:");
    console.log(`[IG Tracker] archive: fetching ${cap.media_type} ${i + 1}/${caps.length} for @${username}${isBlob ? " (blob)" : ""}`);
    let fetched = await _fetchAsBase64(cap.src);
    let usedFallback = false;
    // MSE-backed video blobs can't be refetched. Try fallbacks in order:
    //   1. The element's `poster` attribute (an https CDN URL) — best
    //      quality, fetched via SW.
    //   2. A live canvas frame grab — works even when there's no
    //      poster (IG story players often omit it). One still image
    //      per video story is a reasonable compromise.
    if ((!fetched.ok || !fetched.body) && cap.fallbackSrc) {
      console.log(`[IG Tracker] archive: primary fetch failed for slide ${i + 1}, trying poster image`);
      fetched = await _fetchAsBase64(cap.fallbackSrc);
      usedFallback = true;
    }
    if (!fetched.ok || !fetched.body) {
      // Last-resort canvas frame grab. Works for <video> AND <img>
      // (the latter handles same-page blob: image URLs that can't
      // be re-fetched, plus CORS / signed-URL-expiry failures on
      // CDN images). One still per slide is worse than the original
      // bytes but better than silently dropping the slide.
      console.log(`[IG Tracker] archive: fallback fetch failed for slide ${i + 1}, capturing canvas frame from ${cap.element.tagName}`);
      const frame = _captureVideoFrameAsBase64(cap.element);
      if (frame) {
        fetched = { ok: true, body: frame };
        usedFallback = true;
      }
    }
    if (!fetched.ok || !fetched.body) {
      console.warn(`[IG Tracker] archive: fetch failed for slide ${i + 1} (${fetched.error || "unknown"})`);
      results.push({ slide: i + 1, ok: false, error: fetched.error });
      continue;
    }
    // If we fell back (poster or canvas grab), the bytes are a JPEG
    // even though the original element was a <video>.
    const ext = (cap.media_type === "video" && !usedFallback) ? "mp4" : "jpg";
    const resp = await bgFetch(`${_settings.trackerUrl}/api/media-bytes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, media_id: slideId, ext, bytes_b64: fetched.body }),
    });
    if (!resp.ok) {
      const detail = (resp.body && resp.body.detail) || resp.error || `HTTP ${resp.status}`;
      console.warn(`[IG Tracker] archive: POST failed for slide ${i + 1} (${detail})`);
      results.push({ slide: i + 1, ok: false, error: detail });
      continue;
    }
    const body = resp.body || {};
    const summary = body.size ? `${body.size} bytes` : (body.skipped || "ok");
    console.log(`[IG Tracker] archive: saved @${username}/${slideId}.${ext} (${summary})`);
    results.push({ slide: i + 1, ok: true, ext, summary });
    savedCount += 1;
  }
  if (savedCount === 0) {
    return { ok: false, error: results[0]?.error || "all slides failed" };
  }
  return {
    ok: true,
    username,
    media_id: groupId,
    slides: caps.length,
    saved: savedCount,
    summary: caps.length > 1 ? `${savedCount}/${caps.length} slides` : results[0]?.summary,
  };
}

// Ring buffer of recent IG-Tracker console messages, so the popup's
// "Copy debug log" button can pull them out as text without the user
// needing to open DevTools and screenshot. Wraps console.log/warn/
// error to push timestamped entries into _DEBUG_LOG, but only when
// the message is one of ours (starts with "[IG Tracker]") — we don't
// want to capture all of Instagram's first-party console noise.
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
    const ts = new Date().toISOString();
    _DEBUG_LOG.push(`${ts} [${level}] ${text}`);
    if (_DEBUG_LOG.length > _DEBUG_LOG_MAX) {
      _DEBUG_LOG.splice(0, _DEBUG_LOG.length - _DEBUG_LOG_MAX);
    }
  } catch { /* ignore — capture is best-effort */ }
}
{
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...a) => { _logCapture("log", a); origLog(...a); };
  console.warn = (...a) => { _logCapture("warn", a); origWarn(...a); };
  console.error = (...a) => { _logCapture("error", a); origError(...a); };
}

// Listen for one-shot commands from the popup. Currently:
//   archive-current-media — manual trigger for the current /p/ or
//     /reel/ page. Useful when auto-archive is off, when you scrolled
//     into a reel via the in-page reels feed (which doesn't change
//     the URL), or when the auto pass missed the media.
//   get-debug-log — returns the captured [IG Tracker] console output
//     as a single newline-joined string, for the popup's Copy button.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "archive-current-media") {
    (async () => {
      try {
        const r = await maybeArchiveCurrentMedia({ manual: true });
        sendResponse(r || { ok: false, error: "no result" });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "get-debug-log") {
    sendResponse({
      ok: true,
      url: window.location.href,
      count: _DEBUG_LOG.length,
      log: _DEBUG_LOG.join("\n"),
    });
    return false;
  }
  return false;
});

// True when this tab was opened by the auto-archive runner. The
// runner appends `#igtracker-runner=archive` to the profile URL so
// the content script can:
//   1. Override document.visibilityState (safe in this context — we
//      only land on profile roots, never story/highlight URLs that
//      track viewer identity)
//   2. Auto-fire archiveAllVisiblePosts after the overlay renders,
//      without needing a real user gesture (which we can't synthesize
//      from a service worker anyway).
const _IS_RUNNER_TAB = (() => {
  try {
    const h = window.location.hash || "";
    return /(?:^|[#&])igtracker-runner=archive(?:&|$)/.test(h);
  } catch { return false; }
})();

if (_IS_RUNNER_TAB) {
  // Visibility override: gives this tab full-speed timers even when
  // its window is minimized. Only applied in runner-flagged tabs so
  // normal user browsing still respects IG's hidden-tab semantics
  // (story-view timers, autoplay, polling backoff).
  try {
    Object.defineProperty(document, "hidden",          { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  } catch (_) { /* re-defining can fail in some Chrome builds */ }
  console.log("[IG Tracker] runner tab detected — visibility override on");
}

// Runner mode auto-trigger. Lives in its OWN IIFE so it runs even when
// the user has toggled "Show profile overlay" OFF — the overlay-gated
// main() below would early-return and never reach the runner code.
// Loads settings independently, then fires archiveAllVisiblePosts
// directly (no overlay needed for the archive flow itself).
if (_IS_RUNNER_TAB) {
  (async function runnerBoot() {
    console.log("[IG Tracker] runner: boot start, url=" + window.location.href);
    try {
      _settings = await loadSettings();
      console.log("[IG Tracker] runner: settings loaded, archiveCategories=" + JSON.stringify(_archiveCategories));
    } catch (e) {
      console.error("[IG Tracker] runner: loadSettings failed:", e);
      return;
    }
    // Wait for IG's grid to render a few tiles before kicking off
    // archive-all (which scrolls + downloads). 3s seems to be enough
    // for cold-loaded profiles.
    await new Promise((r) => setTimeout(r, 3000));
    const username = isProfilePath(window.location.pathname);
    if (!username) {
      console.warn("[IG Tracker] runner: not on a profile path (" + window.location.pathname + "), abort");
      return;
    }
    const cats = { ..._archiveCategories };
    if (Object.values(cats).every((v) => !v)) {
      console.warn("[IG Tracker] runner: NO archive categories enabled — toggle at least one of posts/reels/tagged/highlights via the overlay or chrome.storage.local.archiveCategories");
      return;
    }
    console.log(`[IG Tracker] runner: archiving @${username} with categories ${JSON.stringify(cats)}`);
    try {
      const result = await archiveAllVisiblePosts(username, cats);
      console.log(`[IG Tracker] runner: archive-all returned for @${username}`, result);
    } catch (e) {
      console.error("[IG Tracker] runner: archive-all threw:", e);
    }
  })();
}

(async function main() {
  _settings = await loadSettings();
  if (!_settings.showOverlay) return;
  // Runner tabs are a strict-archive context — don't run any of the
  // overlay UI / per-profile fetches. The runnerBoot IIFE earlier in
  // this file does the only work needed (auto-fire archive-all).
  // Skipping main() for runner tabs cuts ~6 fetches and a full DOM
  // mount per opened tab, which compounds when the runner has 10
  // accounts queued in quick succession.
  if (_IS_RUNNER_TAB) return;
  // Defer initial setup by 400ms so IG.com's own page paint completes
  // first. Without this, the content script's dispatcher races IG's
  // hydration and the page feels janky for the first second. Real-
  // world impact: the overlay fade-in delay is unnoticeable, but IG's
  // initial paint becomes immediate.
  await new Promise((r) => setTimeout(r, 400));

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

  // Story-page defensive URL poll. IG cycles between story slides
  // by pushing `/stories/<user>/<id1>/` → `/stories/<user>/<id2>/`
  // → ... but the pushState/replaceState hook above doesn't always
  // fire on these transitions (IG sometimes mutates history without
  // going through the patched method, observed in DevTools as
  // history.length increments without our hook seeing it). The poll
  // catches every story id change with sub-second latency so the
  // auto-archive saves each slide. Server-side dedup makes re-fires
  // free for already-archived ids.
  //
  // The _archiveInFlight guard inside maybeArchiveCurrentMedia would
  // otherwise drop story-N if story-(N-1)'s save is still running
  // (CDN fetch ~500-1000ms, story duration ~5-15s, so possible if
  // user taps fast). We avoid setting _lastPolledStoryPath while a
  // previous archive is in flight — next tick (same path) the
  // condition fires again and onLocationMaybeChanged retries.
  let _lastPolledStoryPath = "";
  setInterval(() => {
    const path = window.location.pathname;
    if (!/^\/stories\/[^/]+\/[^/]+\/?$/.test(path)) {
      _lastPolledStoryPath = "";
      return;
    }
    if (path === _lastPolledStoryPath) return;
    if (!_archiveInFlight) _lastPolledStoryPath = path;
    onLocationMaybeChanged();
  }, 500);

  // Initial pass.
  setTimeout(onLocationMaybeChanged, 200);

  // (Runner-mode auto-trigger lives in its own IIFE earlier in this
  // file, outside the showOverlay gate, so it works even if the
  // overlay is hidden.)

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
