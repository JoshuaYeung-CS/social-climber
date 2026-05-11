// VSCO network interceptor. Runs in MAIN world at document_start so
// it lands before VSCO's app bundle wires up its own fetch/XHR
// callers. Job: sniff responses from VSCO's internal API
// (media-grpc-api.vsco.co + api.vsco.co + vsco.co/api/*) and
// extract every CDN media URL we see, then forward them to the
// isolated-world content script via CustomEvent.
//
// Why this exists: DOM scraping only catches tiles that have
// rendered, and only at the resolution VSCO inlined into <img>
// (?w=300 thumbnails). API responses carry the canonical
// aws-us-west-2 URL for every media item the page knows about —
// regardless of whether the tile has scrolled into view, and at
// full original resolution.
//
// Why byte-grep instead of protobuf parsing: VSCO's gRPC-Web
// payloads are binary protobuf with no public .proto. URLs are
// ASCII strings inside the blob; a regex over the decoded bytes
// extracts them without needing to know the schema. Crude but
// stable across VSCO API version bumps.

(function () {
  if (window.__VscoNetInstalled) return;
  window.__VscoNetInstalled = true;

  const log = (...a) => { try { console.log("[VSCO net]", ...a); } catch (_) {} };

  // id -> { url, canonical }. Canonical = AWS-bucket-rooted URL
  // (https://im.vsco.co/aws-us-west-2/...) which is the original
  // upload; non-canonical = i.vsco.co resizer endpoint which
  // re-encodes at lower quality.
  const captured = new Map();

  function _emit(id, info) {
    try {
      window.dispatchEvent(new CustomEvent("vsco-tracker:media", {
        detail: { id, url: info.url, canonical: !!info.canonical },
      }));
    } catch (_) {}
  }

  function _mediaIdFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const segments = u.pathname.split("/").filter(Boolean);
      let best = "";
      for (const seg of segments) {
        const stem = seg.replace(/\.[^.]+$/, "");
        if (/^[A-Za-z0-9_-]{12,}$/.test(stem) && stem.length > best.length) {
          best = stem;
        }
      }
      return best || null;
    } catch { return null; }
  }

  // Regex notes:
  //   - both i.vsco.co (resizer) and im.vsco.co (canonical) CDN hosts
  //   - allow path segments + query string chars commonly seen
  //   - URLs in protobuf payloads aren't followed by a \0 sentinel —
  //     they're length-prefixed — so we cap with a maximal munch that
  //     stops at non-URL bytes (whitespace, quote, backslash, control)
  const URL_RE = /https?:\/\/(?:im|i)\.vsco\.co\/[A-Za-z0-9_\-./?=&%:]+/g;

  function _scanAndStore(text) {
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      const u = m[0];
      // Trim trailing punctuation that shouldn't be part of the URL
      // but might appear next to it in the binary stream.
      const clean = u.replace(/[.,;:!?)\]}'"]+$/, "");
      const id = _mediaIdFromUrl(clean);
      if (!id || id.length < 12) continue;
      // Skip non-photo CDN paths (logos, branding) — same filter the
      // DOM walker uses.
      if (/\/(assets|static|brand|footer|logos?)\b/i.test(clean)) continue;
      if (/(logo|powered[_-]by|favicon|sprite)/i.test(clean)) continue;
      const isCanonical = /\/aws-/.test(clean);
      const prev = captured.get(id);
      if (!prev || (isCanonical && !prev.canonical)) {
        captured.set(id, { url: clean, canonical: isCanonical });
        _emit(id, { url: clean, canonical: isCanonical });
      }
    }
  }

  async function _sniffFetchResponse(reqUrl, response) {
    try {
      // Clone before consuming — page is about to read this body too.
      const clone = response.clone();
      const buf = await clone.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Read bytes as latin-1 string (preserves all 256 byte values),
      // so URL ASCII chars round-trip cleanly even in binary blobs.
      let text = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      _scanAndStore(text);
    } catch (_) { /* ignore — best-effort */ }
  }

  const VSCO_API_RE = /(?:media-grpc-api|api)\.vsco\.co|vsco\.co\/api\//i;

  // Patch fetch
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = (typeof input === "string") ? input : (input?.url || "");
    const promise = origFetch(input, init);
    if (VSCO_API_RE.test(url)) {
      promise.then((r) => _sniffFetchResponse(url, r)).catch(() => {});
    }
    return promise;
  };

  // Patch XHR for the older code paths VSCO might still use.
  const XOpen = XMLHttpRequest.prototype.open;
  const XSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vscoUrl = url;
    return XOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const u = this.__vscoUrl;
    if (u && VSCO_API_RE.test(u)) {
      this.addEventListener("load", () => {
        try {
          let text = "";
          if (this.responseType === "arraybuffer") {
            const r = this.response;
            if (r instanceof ArrayBuffer) {
              const bytes = new Uint8Array(r);
              const CHUNK = 0x8000;
              for (let i = 0; i < bytes.length; i += CHUNK) {
                text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
              }
            }
          } else if (this.responseType === "blob") {
            // Skip — blob would require async read; rare path for VSCO.
          } else {
            text = this.responseText || "";
          }
          if (text) _scanAndStore(text);
        } catch (_) {}
      });
    }
    return XSend.apply(this, arguments);
  };

  // Replay handshake. The isolated-world content script loads at
  // document_idle, well after the page's first API calls. When it
  // signals readiness, emit everything we've captured so far so
  // nothing it missed lives only in our captured map.
  window.addEventListener("vsco-tracker:request-replay", () => {
    for (const [id, info] of captured) _emit(id, info);
  });

  log("interceptor installed");
})();
