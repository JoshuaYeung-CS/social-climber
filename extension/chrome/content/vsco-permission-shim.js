// VSCO permission-prompt shim. Runs in the page's MAIN world at
// document_start so we land before VSCO's app bundle executes. The
// goal: silently no-op any API call that would raise Chrome's
// "Access other apps and services on this device" prompt (or any
// other permission prompt VSCO triggers on every gallery load —
// incognito doesn't persist permission state so each new sweep
// surfaces them again).
//
// Override strategy: defineProperty with a getter and a no-op setter,
// configurable:false. This survives any later reassignment by VSCO's
// bundle (a plain assignment fails silently in non-strict mode and
// throws in strict — both fine for our purposes).
//
// Logging: every blocked call goes to console with [VSCO shim] prefix
// so we can confirm from devtools that the shim actually fired (and
// know which API VSCO is calling, in case it's something we missed).
(function () {
  const tag = "[VSCO shim]";
  // Log to both console.log AND console.warn so it survives any
  // console.clear() VSCO might call after their app boots.
  const log = (...a) => { try { console.log(tag, ...a); } catch (_) {} };
  log("loaded at", document.readyState, "url:", location.href);

  function noop() { /* swallowed */ }

  function override(target, name) {
    if (!target) return;
    try {
      const existed = !!target[name];
      Object.defineProperty(target, name, {
        get: () => function () {
          try { log("blocked", name, "args:", Array.from(arguments)); } catch (_) {}
          return undefined;
        },
        set: () => { try { log("attempted re-define of", name); } catch (_) {} },
        configurable: false,
      });
      log("installed override for", name, existed ? "(replaced existing)" : "(was undefined)");
    } catch (e) {
      log("override failed for", name, e && e.message);
    }
  }

  // Candidate APIs that can raise the "Access other apps and services"
  // family of prompts. Override aggressively; harmless if VSCO never
  // calls a given one.
  if (typeof Navigator !== "undefined" && Navigator.prototype) {
    override(Navigator.prototype, "registerProtocolHandler");
    override(Navigator.prototype, "unregisterProtocolHandler");
    // Web Share — triggers a system share sheet in some browsers and
    // an analog permission UI elsewhere. We don't want VSCO surfacing
    // any of these mid-archive.
    override(Navigator.prototype, "share");
  }

  // Stub Permissions API .request so any speculative permission grant
  // by VSCO returns "denied" without surfacing UI. Safe because we
  // don't want any of these granted in incognito anyway.
  try {
    if (navigator.permissions && navigator.permissions.request) {
      const origRequest = navigator.permissions.request.bind(navigator.permissions);
      navigator.permissions.request = function () {
        log("Permissions.request blocked", Array.from(arguments));
        return Promise.resolve({ state: "denied" });
      };
    }
  } catch (_) { /* old browser, ignore */ }

  // VSCO declares a PWA manifest at <link rel="manifest" href="...">.
  // Chrome's incognito mode reads that manifest's protocol_handlers /
  // url_handlers fields on the fly and prompts the user — "Access
  // other apps and services on this device" — every gallery load
  // because incognito doesn't remember the previous decision. The
  // registerProtocolHandler API override doesn't catch this path
  // because Chrome consumes the manifest directly without going
  // through page JS.
  //
  // Strip the <link rel="manifest"> element the instant it appears
  // (and on every mutation in case VSCO re-injects). The page itself
  // doesn't need the manifest to function — only the install UI does.
  function _stripManifestLinks() {
    try {
      for (const link of document.querySelectorAll('link[rel="manifest"], link[rel~="manifest"]')) {
        log("stripping manifest link", link.href);
        link.parentNode && link.parentNode.removeChild(link);
      }
    } catch (_) { /* ignore */ }
  }
  // documentElement exists at document_start; observe it for child
  // additions in head/body until the page is hydrated. Then disconnect
  // after a generous window — no need to keep observing forever.
  try {
    const root = document.documentElement;
    if (root) {
      const obs = new MutationObserver(_stripManifestLinks);
      obs.observe(root, { childList: true, subtree: true });
      // First synchronous pass in case the head already has it parsed
      // by the time we reach this line.
      _stripManifestLinks();
      // Disconnect after 30s — by then VSCO's bundle has booted and
      // any further manifest re-injection is unlikely.
      setTimeout(() => { try { obs.disconnect(); } catch (_) {} }, 30000);
    }
  } catch (e) {
    log("manifest-strip observer failed", e && e.message);
  }
})();
