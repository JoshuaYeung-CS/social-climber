// VSCO archive companion — runs on https://vsco.co/* and mirrors the
// IG-side bytes-collection pattern. Why this lives in the browser and
// not the server: vsco.co + im.vsco.co (CDN) are both behind Cloudflare's
// bot-protection. Plain HTTP from the server gets 403. The browser
// already passed Cloudflare's JS challenge when it loaded the page, so
// it owns the cookies that let it fetch the CDN bytes; we just hand
// the decoded bytes to the local tracker for persistence.
//
// Privacy notes:
//   - VSCO has no "viewer list" feature (unlike IG Stories). The owner
//     of a profile cannot see who viewed/scraped their gallery.
//   - VSCO's own analytics still see your IP. If you want maximum
//     anonymity, browse logged out and/or in an incognito window.
//
// Public API (set on window so popup / future runner can call):
//   window.__VscoArchive.archiveCurrentProfile() — scans the page and
//     posts every visible photo to the local tracker, deduped by
//     media_id. Returns {ok, saved, failed, total}.

(function () {
  if (window.__VscoArchive) return;  // re-injection guard
  const SETTINGS_KEY = "trackerUrl";
  const DEFAULT_TRACKER_URL = "http://127.0.0.1:8000";

  // Limits matched to the server-side `_VSCO_MAX_BYTES`. Keeps a
  // runaway base64 encode from ballooning RAM if a video sneaks
  // through that's larger than expected.
  const MAX_BYTES = 30 * 1024 * 1024;

  // Username comes from the URL: vsco.co/<user>/gallery, vsco.co/<user>,
  // vsco.co/<user>/journal etc. We only archive when the path's first
  // segment looks like a real username — reserves like /m/, /spaces/,
  // /studio/ etc. should be excluded so the overlay button doesn't
  // misfire on non-profile pages.
  const RESERVED = new Set([
    "m", "spaces", "studio", "feed", "search", "discover", "explore",
    "settings", "account", "login", "join", "user", "users",
    "membership", "about", "privacy", "terms", "help", "legal",
    "ai-lab", "blog", "stories", "support", "company",
    "products", "solutions", "resources", "downloads", "campaigns",
  ]);
  function _vscoUserFromPath() {
    const parts = (location.pathname || "").split("/").filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0];
    if (RESERVED.has(first.toLowerCase())) return null;
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(first)) return null;
    return first;
  }

  // Extract a stable per-photo id from a CDN URL. VSCO's CDN paths look
  // like: https://im.vsco.co/aws-us-west-2/<bucket>/<photoId>/vsco_<hash>.jpg
  // or sometimes /<photoId>/<size>/<photoId>.jpg. We pull the longest
  // alnum segment from the path as the id — stable across resolutions
  // since VSCO uses the same photo id at every size. Falls back to a
  // sanitized last-segment if the heuristic finds nothing.
  function _mediaIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      // Strip extension off the last segment; prefer the longest
      // alphanumeric run in the path as the canonical id.
      const segments = u.pathname.split("/").filter(Boolean);
      let best = "";
      for (const seg of segments) {
        const stem = seg.replace(/\.[^.]+$/, "");
        // VSCO photo ids are typically 24+ char base32-ish slugs.
        if (/^[A-Za-z0-9_-]{12,}$/.test(stem) && stem.length > best.length) {
          best = stem;
        }
      }
      if (best) return best;
      // Fallback: sanitize the last segment.
      const last = (segments[segments.length - 1] || "").replace(/\.[^.]+$/, "");
      const safe = last.replace(/[^A-Za-z0-9_-]/g, "_");
      return safe || null;
    } catch {
      return null;
    }
  }

  function _extFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const m = u.pathname.match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
      if (!m) return "jpg";
      const ext = m[1].toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "mp4", "mov"].includes(ext)) {
        return ext === "jpeg" ? "jpg" : ext;
      }
      return "jpg";
    } catch { return "jpg"; }
  }

  // Walk the DOM for VSCO CDN media. VSCO renders both an <img> and an
  // adjacent <video> for video posts (the img is the poster frame).
  // We collect both; the server-side dedup-by-bytes means a video
  // poster won't double-write the slot. Largest visible size wins per
  // media_id so we don't down-archive when both a thumb and a full
  // are rendered.
  function _collectMediaUrls() {
    const found = new Map();  // media_id -> { url, ext, area }
    const consider = (raw, areaEstimate, ext) => {
      if (!raw) return;
      // Skip obvious profile-pic / icon URLs by pathname signal. VSCO
      // uses different CDN folders for avatars vs media; let media id
      // length be the filter — avatars have shorter ids.
      const id = _mediaIdFromUrl(raw);
      if (!id || id.length < 12) return;
      const prev = found.get(id);
      if (!prev || areaEstimate > prev.area) {
        found.set(id, { url: raw, ext: ext || _extFromUrl(raw), area: areaEstimate });
      }
    };
    for (const el of document.querySelectorAll("img, video")) {
      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      // Drop avatars / micro thumbnails — anything under 60×60 is UI
      // chrome, not gallery media.
      if (r.width < 60 || r.height < 60) continue;
      if (el.tagName === "VIDEO") {
        const src = el.src || el.currentSrc;
        const poster = el.getAttribute("poster");
        if (src && /^https?:/.test(src)) consider(src, area + 1_000_000, "mp4");
        if (poster && /^https?:/.test(poster)) consider(poster, area, _extFromUrl(poster));
      } else {
        const src = el.src || el.currentSrc;
        if (src && /^https?:/.test(src)) consider(src, area, _extFromUrl(src));
        // VSCO also renders srcset on its gallery imgs — picking the
        // largest candidate gives us a higher-res file than the
        // displayed thumbnail.
        const srcset = el.getAttribute("srcset");
        if (srcset) {
          for (const part of srcset.split(",")) {
            const url = part.trim().split(/\s+/)[0];
            if (url && /^https?:/.test(url)) consider(url, area, _extFromUrl(url));
          }
        }
      }
    }
    return Array.from(found.entries()).map(([id, v]) => ({
      media_id: id, url: v.url, ext: v.ext,
    }));
  }

  async function _fetchAsBase64(url) {
    try {
      const r = await fetch(url, { credentials: "include", mode: "cors" });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const blob = await r.blob();
      if (blob.size > MAX_BYTES) {
        return { ok: false, error: `too large (${blob.size} bytes)` };
      }
      const buf = await blob.arrayBuffer();
      // Manual base64 encode — btoa requires a binary string;
      // construct via Uint8Array chunks to avoid the spread-stack
      // overflow on big files.
      const bytes = new Uint8Array(buf);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return { ok: true, body: btoa(binary), size: blob.size };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function _trackerUrl() {
    try {
      const s = await chrome.storage.local.get([SETTINGS_KEY]);
      return (s[SETTINGS_KEY] || DEFAULT_TRACKER_URL).replace(/\/$/, "");
    } catch {
      return DEFAULT_TRACKER_URL;
    }
  }

  async function archiveCurrentProfile() {
    const username = _vscoUserFromPath();
    if (!username) {
      console.log("[VSCO Archive] not on a profile page");
      return { ok: false, error: "not a profile page" };
    }
    const items = _collectMediaUrls();
    if (!items.length) {
      console.log("[VSCO Archive] no media found on page");
      return { ok: false, error: "no media found" };
    }
    const trackerUrl = await _trackerUrl();
    console.log(`[VSCO Archive] @${username}: ${items.length} candidate items`);
    let saved = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      _updateProgress(`Archiving ${i + 1}/${items.length} from @${username}…`, saved, failed, skipped);
      const fetched = await _fetchAsBase64(it.url);
      if (!fetched.ok) {
        failed += 1;
        console.warn(`[VSCO Archive] fetch failed for ${it.media_id}: ${fetched.error}`);
        continue;
      }
      try {
        const resp = await fetch(`${trackerUrl}/api/vsco-media-bytes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            media_id: it.media_id,
            ext: it.ext,
            bytes_b64: fetched.body,
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          failed += 1;
          console.warn(`[VSCO Archive] save failed for ${it.media_id}: ${body.detail || resp.statusText}`);
        } else if (body.skipped === "duplicate") {
          skipped += 1;
          console.log(`[VSCO Archive] ${it.media_id}.${it.ext} (duplicate, skipped)`);
        } else {
          saved += 1;
          console.log(`[VSCO Archive] saved ${it.media_id}.${it.ext} (${body.size} bytes)`);
        }
      } catch (e) {
        failed += 1;
        console.warn(`[VSCO Archive] POST error: ${e?.message || e}`);
      }
    }
    _updateProgress(`Done · ${saved} saved · ${skipped} dup · ${failed} failed`, saved, failed, skipped, /*done=*/true);
    return { ok: true, saved, failed, skipped, total: items.length };
  }

  // ---------- minimal overlay ----------
  // Floating button bottom-right of the page. Visible only on profile
  // pages. Click → run archiveCurrentProfile() and show progress.
  let _btnEl = null;
  let _progressEl = null;

  function _ensureButton() {
    if (_btnEl && document.body.contains(_btnEl)) return _btnEl;
    const el = document.createElement("button");
    el.id = "vsco-archive-btn";
    el.className = "vsco-archive-btn";
    el.textContent = "📥 Archive to IG Tracker";
    el.title = "Save every visible photo to your local IG Tracker archive";
    el.addEventListener("click", () => {
      if (el.dataset.running === "1") return;
      el.dataset.running = "1";
      el.textContent = "Archiving…";
      archiveCurrentProfile().finally(() => {
        el.dataset.running = "0";
        el.textContent = "📥 Archive to IG Tracker";
      });
    });
    document.body.appendChild(el);
    _btnEl = el;
    return el;
  }

  function _updateProgress(text, saved, failed, skipped, done) {
    if (!_progressEl) {
      _progressEl = document.createElement("div");
      _progressEl.id = "vsco-archive-progress";
      _progressEl.className = "vsco-archive-progress";
      document.body.appendChild(_progressEl);
    }
    _progressEl.textContent = text;
    _progressEl.classList.toggle("vsco-archive-done", !!done);
    if (done) {
      setTimeout(() => {
        if (_progressEl && _progressEl.classList.contains("vsco-archive-done")) {
          _progressEl.remove();
          _progressEl = null;
        }
      }, 6000);
    }
  }

  function _onLocationChange() {
    const user = _vscoUserFromPath();
    if (user) _ensureButton();
    else if (_btnEl) { _btnEl.remove(); _btnEl = null; }
  }

  // VSCO is a Next.js app — patch history methods so we react to SPA
  // navigations the same way the IG side does.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () {
    const r = origPush.apply(this, arguments);
    setTimeout(_onLocationChange, 50);
    return r;
  };
  history.replaceState = function () {
    const r = origReplace.apply(this, arguments);
    setTimeout(_onLocationChange, 50);
    return r;
  };
  window.addEventListener("popstate", () => setTimeout(_onLocationChange, 50));

  // Initial pass — wait briefly for VSCO's hydration to finish so
  // gallery images are present in the DOM by the time we attach.
  setTimeout(_onLocationChange, 400);

  // Public API
  window.__VscoArchive = {
    archiveCurrentProfile,
    collect: _collectMediaUrls,
    userFromPath: _vscoUserFromPath,
  };
})();
