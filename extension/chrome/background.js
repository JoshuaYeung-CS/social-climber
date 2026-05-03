// Service worker. Two jobs:
//
// 1. Standard install / activate boilerplate.
//
// 2. Proxy fetches from content scripts to the local tracker. Reason:
//    instagram.com is HTTPS, the local tracker is HTTP, and Chrome blocks
//    HTTP fetches initiated from HTTPS pages as "mixed content" — even
//    when the extension has host_permissions for the target. The fix is
//    to make the fetch from the service worker (an extension-origin
//    context, not a page-origin context); mixed-content rules don't
//    apply there. Content scripts call chrome.runtime.sendMessage and
//    we return the parsed body.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "tracker-fetch") return false;
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
  // Return true to keep the channel open for the async response.
  return true;
});
