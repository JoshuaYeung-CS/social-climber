// Service worker. Currently minimal — exists so chrome.storage events can
// fan out to content scripts if needed. Most state lives in chrome.storage.local
// directly, accessed by both popup and content scripts.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
