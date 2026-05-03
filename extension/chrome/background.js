// Service worker. One job: proxy fetches from content scripts to the
// local tracker. Reason: instagram.com is HTTPS, the local tracker is
// HTTP, and Chrome blocks HTTP fetches initiated from HTTPS pages as
// "mixed content" — even when the extension has host_permissions for
// the target. The fix is to make the fetch from the service worker
// (an extension-origin context, not a page-origin context); mixed-
// content rules don't apply there. Content scripts call
// chrome.runtime.sendMessage and we return the parsed body.
//
// MV3 extension service workers don't need install/activate handlers —
// they activate automatically on first event. Skip skipWaiting +
// clients.claim, which raise InvalidStateError in this context.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  // Standard JSON / text fetch — for tracker + vault API calls.
  if (msg.type === "tracker-fetch") {
    (async () => {
      try {
        const init = msg.init || {};
        const r = await fetch(msg.url, init);
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        sendResponse({ ok: r.ok, status: r.status, body });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  // Binary-blob fetch — used by Save-to-Vault. The SW issues the request
  // (avoiding mixed-content blocks since instagram.com is HTTPS) with the
  // page's cookies, reads the bytes, and base64-encodes for transport
  // back to the content script which POSTs them to the vault.
  if (msg.type === "tracker-fetch-bytes") {
    (async () => {
      try {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) {
          sendResponse({ ok: false, status: r.status, error: `HTTP ${r.status}` });
          return;
        }
        const buf = await r.arrayBuffer();
        // Base64 the bytes — chrome.runtime.sendMessage requires JSON-safe payload.
        let binary = "";
        const chunk = new Uint8Array(buf);
        const CHUNK_SIZE = 0x8000;
        for (let i = 0; i < chunk.length; i += CHUNK_SIZE) {
          binary += String.fromCharCode.apply(null, chunk.subarray(i, i + CHUNK_SIZE));
        }
        const b64 = btoa(binary);
        sendResponse({ ok: true, status: r.status, body: b64 });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  return false;
});
