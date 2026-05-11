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

  // Fetch via the background service worker. Content scripts share
  // origin with the host page so a direct fetch() of im.vsco.co
  // triggers a CORS preflight; VSCO's CDN doesn't return the headers
  // needed to pass it, so the request fails with "Failed to fetch".
  // The SW runs in extension-origin context and the manifest's
  // host_permissions for *.vsco.co/* let it bypass CORS — we just ask
  // it to fetch on our behalf and hand us the bytes.
  async function _fetchAsBase64(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "fetch-vsco-bytes", url }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response from background" });
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  // Persist a structured per-run entry so the popup can show the log
  // after the tab has been auto-closed by the queue runner. Capped at
  // the last 30 runs so storage doesn't grow unbounded.
  async function _appendArchiveLog(entry) {
    try {
      const s = await chrome.storage.local.get(["vscoArchiveLog"]);
      const log = Array.isArray(s.vscoArchiveLog) ? s.vscoArchiveLog : [];
      log.unshift(entry);
      while (log.length > 30) log.pop();
      await chrome.storage.local.set({ vscoArchiveLog: log });
    } catch (_) { /* storage is best-effort */ }
  }

  async function archiveCurrentProfile() {
    const startedAt = Date.now();
    const username = _vscoUserFromPath();
    if (!username) {
      console.log("[VSCO Archive] not on a profile page");
      return { ok: false, error: "not a profile page" };
    }
    // Prefer the mid-scroll accumulator if it's populated — it dedups
    // virtualization-evicted tiles that a single end-of-scroll walk
    // would miss. Falls back to a fresh DOM walk when called directly
    // from the on-page button (no scroll-and-harvest preceded it).
    const items = (_collectedMedia && _collectedMedia.size > 0)
      ? Array.from(_collectedMedia.values())
      : _collectMediaUrls();
    if (!items.length) {
      console.log("[VSCO Archive] no media found on page");
      await _appendArchiveLog({
        ts: startedAt, username, total: 0, saved: 0, failed: 0, skipped: 0,
        errors: [{ stage: "collect", error: "no media found in DOM" }],
      });
      return { ok: false, error: "no media found" };
    }
    console.log(`[VSCO Archive] @${username}: ${items.length} candidate items`);
    let saved = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      _updateProgress(`Archiving ${i + 1}/${items.length} from @${username}…`, saved, failed, skipped);
      const fetched = await _fetchAsBase64(it.url);
      if (!fetched.ok) {
        failed += 1;
        errors.push({ stage: "fetch", media_id: it.media_id, url: it.url, error: fetched.error });
        console.warn(`[VSCO Archive] fetch failed for ${it.media_id}: ${fetched.error}`);
        continue;
      }
      // Route the save POST through the SW. Content scripts are in
      // vsco.co's HTTPS origin, and Chrome blocks HTTP fetches from
      // there as mixed content — every direct POST to localhost
      // failed with "Failed to fetch". The SW runs in extension
      // origin and isn't subject to that block.
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: "save-vsco-bytes",
            payload: {
              username,
              media_id: it.media_id,
              ext: it.ext,
              bytes_b64: fetched.body,
            },
          }, (r) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(r || { ok: false, status: 0, error: "no response from background" });
          });
        } catch (e) {
          resolve({ ok: false, status: 0, error: e?.message || String(e) });
        }
      });
      const body = resp.body || {};
      if (!resp.ok) {
        failed += 1;
        const errMsg = resp.error || body.detail || `HTTP ${resp.status}`;
        errors.push({ stage: "save", media_id: it.media_id, error: errMsg });
        console.warn(`[VSCO Archive] save failed for ${it.media_id}: ${errMsg}`);
      } else if (body.skipped === "duplicate") {
        skipped += 1;
        console.log(`[VSCO Archive] ${it.media_id}.${it.ext} (duplicate, skipped)`);
      } else {
        saved += 1;
        console.log(`[VSCO Archive] saved ${it.media_id}.${it.ext} (${body.size || "?"} bytes)`);
      }
    }
    _updateProgress(`Done · ${saved} saved · ${skipped} dup · ${failed} failed`, saved, failed, skipped, /*done=*/true);
    await _appendArchiveLog({
      ts: startedAt, username, total: items.length, saved, failed, skipped,
      durationMs: Date.now() - startedAt,
      // Diagnostics: tells us at-a-glance whether the scroll loop is
      // pulling enough tiles and whether Load More is firing.
      collected: _collectedMedia ? _collectedMedia.size : null,
      errors: errors.slice(0, 20),
    });
    return { ok: true, saved, failed, skipped, total: items.length };
  }

  // Find a "Load more" pagination button. VSCO's gallery sometimes
  // renders the button as a <button>, sometimes as a <div role=button>,
  // and the visible-only check that used to be here failed when the
  // button was offscreen (rect 0×0) — which is the common case for
  // long galleries. New strategy: scan everything that looks
  // button-shaped, match exact "load more" text (case-insensitive),
  // ignore visibility, and let the caller scrollIntoView before
  // clicking. Skip our own overlay.
  function _findLoadMoreButton() {
    const candidates = document.querySelectorAll(
      'button, a, [role="button"], [data-testid*="load"], [class*="LoadMore"], [class*="loadmore"]'
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text !== "load more" && text !== "load more posts") continue;
      if (el.closest("#vsco-archive-btn, #vsco-archive-progress")) continue;
      return el;
    }
    return null;
  }

  // Scroll every plausible container to its bottom and dispatch a
  // real scroll/wheel event after — some sites gate their lazy-load
  // on user-style events, not programmatic .scrollTop assignment.
  function _scrollEverything() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    try {
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight + 4) {
          const r = el.getBoundingClientRect();
          if (r.height < 200) continue;
          el.scrollTop = el.scrollHeight;
        }
      }
      // Synthetic scroll + wheel at the document level so
      // IntersectionObservers / scroll-event listeners see motion.
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
      try {
        window.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaY: 800,
        }));
      } catch (_) { /* WheelEvent not constructible in some hosts, ignore */ }
    } catch (_) { /* DOM transient, retry */ }
  }

  // Module-level accumulator used by archiveCurrentProfile. VSCO
  // virtualizes its gallery — tiles scrolled past get unmounted from
  // DOM, so a single end-of-scroll DOM walk only sees the bottom 15.
  // We harvest mid-scroll into this Map (keyed by media_id) so every
  // tile that ever materialized is captured.
  let _collectedMedia = null;
  function _harvestVisibleMedia() {
    if (!_collectedMedia) return 0;
    let added = 0;
    for (const it of _collectMediaUrls()) {
      if (!_collectedMedia.has(it.media_id)) {
        _collectedMedia.set(it.media_id, it);
        added += 1;
      }
    }
    return added;
  }

  // Exhaust the gallery: scroll every plausible container, harvest
  // newly-rendered tiles into _collectedMedia each pass, click "Load
  // more" if present, repeat until two consecutive passes produce no
  // new tiles AND no scroll growth. Hard ceiling of 80 passes (~2min).
  async function _scrollAllImagesIntoView() {
    _collectedMedia = new Map();
    _harvestVisibleMedia();  // first pass: whatever's already on screen
    const MAX_PASSES = 80;
    let lastHeight = 0;
    let stable = 0;
    let loadMoreClicks = 0;
    for (let i = 0; i < MAX_PASSES; i++) {
      _scrollEverything();
      await new Promise((r) => setTimeout(r, 700));
      const harvested = _harvestVisibleMedia();
      const btn = _findLoadMoreButton();
      if (btn) {
        _updateProgress(`Loading more (pass ${i + 1}, ${_collectedMedia.size} so far)…`, 0, 0, 0);
        try {
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          await new Promise((r) => setTimeout(r, 200));
          btn.click();
          loadMoreClicks += 1;
        } catch (_) { /* button gone between probe + click, retry */ }
        await new Promise((r) => setTimeout(r, 1500));
        _harvestVisibleMedia();
        stable = 0;
        lastHeight = document.body.scrollHeight;
        continue;
      }
      const h = document.body.scrollHeight;
      if (h === lastHeight && harvested === 0) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
        lastHeight = h;
      }
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 400));
    console.log(`[VSCO Archive] scroll done: ${_collectedMedia.size} tiles collected, ${loadMoreClicks} Load More click(s)`);
    return { collected: _collectedMedia.size, loadMoreClicks };
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

  // Auto-archive-on-load handshake for the popup's "incognito sweep"
  // flow. The popup wrote a queue of URLs (with timestamps) to
  // chrome.storage.local; if this tab's URL matches a fresh entry,
  // dequeue ourselves, scroll-and-archive, then ask the background SW
  // to close us.
  //
  // Two safety guards make this safe in adversarial conditions:
  //   - Incognito only. The queue is only honored from incognito tabs;
  //     a regular tab that happens to navigate to a queued URL never
  //     fires. Guarantees the archive only ever happens in the no-
  //     cookie window we explicitly opened.
  //   - 10-minute freshness window. Entries older than 10 min are
  //     ignored and pruned. If the user closes the window mid-sweep,
  //     stale entries can't lie in wait and ambush a future tab.
  const QUEUE_TTL_MS = 10 * 60 * 1000;
  async function _maybeAutoArchive() {
    if (!chrome.extension?.inIncognitoContext) return;
    const user = _vscoUserFromPath();
    if (!user) return;
    const canonical = `https://vsco.co/${user}/gallery`;
    const alt = `https://vsco.co/${user}`;
    let queue;
    try {
      const s = await chrome.storage.local.get(["vscoAutoArchiveQueue"]);
      queue = s.vscoAutoArchiveQueue;
    } catch (_) { return; }
    if (!queue || typeof queue !== "object") return;
    const ts = queue[canonical] || queue[alt];
    const now = Date.now();
    if (!ts || (now - ts) > QUEUE_TTL_MS) return;
    delete queue[canonical];
    delete queue[alt];
    // Also opportunistically prune any other expired entries so the
    // store doesn't grow unbounded if a sweep ever gets interrupted.
    for (const [k, v] of Object.entries(queue)) {
      if (!v || (now - v) > QUEUE_TTL_MS) delete queue[k];
    }
    try { await chrome.storage.local.set({ vscoAutoArchiveQueue: queue }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
    const btn = _ensureButton();
    btn.dataset.running = "1";
    btn.textContent = "Auto-archiving…";
    try {
      _updateProgress("Loading gallery…", 0, 0, 0);
      await _scrollAllImagesIntoView();
      const r = await archiveCurrentProfile();
      // Only close if every item landed cleanly. Any failures, leave
      // the tab open so the user can inspect — the in-page overlay
      // shows the summary and devtools console has the per-item log.
      // The structured log also lives in chrome.storage.local now so
      // the popup can read it after this tab is gone.
      if (r && r.ok && r.failed === 0 && r.saved > 0) {
        try { chrome.runtime.sendMessage({ type: "close-my-tab" }); } catch (_) {}
      } else {
        _updateProgress(
          `Tab kept open — ${r ? (r.failed || 0) : "?"} failed. Check the popup's VSCO log.`,
          r ? r.saved : 0, r ? r.failed : 0, r ? r.skipped : 0, /*done=*/true,
        );
      }
    } finally {
      btn.dataset.running = "0";
      btn.textContent = "📥 Archive to IG Tracker";
    }
  }
  setTimeout(_maybeAutoArchive, 600);

  // Public API
  window.__VscoArchive = {
    archiveCurrentProfile,
    collect: _collectMediaUrls,
    userFromPath: _vscoUserFromPath,
  };
})();
