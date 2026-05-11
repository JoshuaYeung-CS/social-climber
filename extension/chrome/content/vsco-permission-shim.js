// VSCO permission-prompt shim. Runs in the page's MAIN world at
// document_start so we land before VSCO's app bundle executes. Two
// reasons this exists:
//
//   1. VSCO calls navigator.registerProtocolHandler() to register
//      itself as the default handler for "web+vsco:" links. Chrome
//      surfaces that as an "Access other apps and services on this
//      device" prompt at the top of the page. Annoying once, but in
//      incognito (where the archive flow runs) permission state isn't
//      persisted — the prompt re-appears on every gallery load and
//      obscures content while it's up.
//
//   2. The override is a no-op replacement, not a refusal. We don't
//      want a thrown error to abort VSCO's bootstrap; we just want
//      the call to silently succeed without producing UI.
//
// MAIN world is required because content scripts otherwise run in an
// isolated world — Navigator.prototype patches don't reach the page's
// own JS realm.
(function () {
  try {
    const proto = (typeof Navigator !== "undefined") ? Navigator.prototype : null;
    if (proto && proto.registerProtocolHandler) {
      proto.registerProtocolHandler = function () { /* swallow */ };
    }
    // Belt-and-suspenders: VSCO may also try unregisterProtocolHandler
    // (no-prompt) or the older window.external.AddSearchProvider; null
    // those out too so the page can't trigger any other permission UI.
    if (proto && proto.unregisterProtocolHandler) {
      proto.unregisterProtocolHandler = function () { /* swallow */ };
    }
  } catch (_) { /* ignore — non-fatal */ }
})();
