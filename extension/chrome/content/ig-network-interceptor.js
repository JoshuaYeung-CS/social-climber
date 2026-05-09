// Page-context (MAIN world) network interceptor — runs at document_start
// so it patches window.fetch and XMLHttpRequest BEFORE IG's app code
// runs and binds its own references.
//
// Why MAIN world: content scripts run in an isolated JS world; patching
// our copy of window.fetch wouldn't affect the page's copy. With
// world: "MAIN" + run_at: "document_start", we patch the same window
// IG uses.
//
// We listen for IG's story / highlight GraphQL responses, deep-walk
// the JSON for story-item shapes, and forward them to the isolated
// content script via window.postMessage. The isolated script keeps a
// cache of album_id → [items], which the highlight archiver consults
// instead of DOM-walking. The big payoff: video stories ship as
// real MP4 URLs in the GraphQL response (not unfetchable blob: URLs),
// so we can save full video bytes via the SW instead of canvas-
// grabbing a single still frame.
(function () {
  if (window.__igTrackerNetIntercepted) return;
  window.__igTrackerNetIntercepted = true;

  // --- Walk any JSON response for story-shaped items. Story items in
  // IG's responses always have .pk + .image_versions2.candidates[],
  // regardless of nesting depth or which endpoint returned them.
  // Also collect the album/reel id when we can find it (a parent
  // object with `.id` matching highlight format, or `.reel_pk`).
  function walkForItems(node, into) {
    if (!node || typeof node !== "object") return;
    if (node.pk &&
        node.image_versions2 &&
        Array.isArray(node.image_versions2.candidates)) {
      into.push(node);
    }
    if (Array.isArray(node)) {
      for (const x of node) walkForItems(x, into);
    } else {
      for (const k in node) walkForItems(node[k], into);
    }
  }

  // Try to locate album-id → items associations. IG nests these
  // differently across endpoints; we look for any object that has
  // BOTH an id-like field AND an items array of story-shaped items.
  function findAlbumGroups(node, groups, ancestors) {
    if (!node || typeof node !== "object") return;
    ancestors = ancestors || [];
    // Pattern 1: { id: "highlight:NNN", items: [...] } or similar
    // Pattern 2: { id/reel_id/pk: NNN, items: [...] }
    if (Array.isArray(node.items) && node.items.length) {
      const sample = node.items[0];
      if (sample &&
          sample.pk &&
          sample.image_versions2 &&
          Array.isArray(sample.image_versions2.candidates)) {
        const idCandidates = [
          node.id, node.reel_id, node.pk, node.media_id,
          node.user?.pk, node.owner?.id,
        ].filter(Boolean).map(String);
        // Extract just the trailing digits (the album_id we use in URLs)
        const numericIds = idCandidates
          .map((s) => {
            const m = s.match(/(\d{6,})/);
            return m ? m[1] : null;
          })
          .filter(Boolean);
        groups.push({ idCandidates, numericIds, items: node.items });
      }
    }
    if (Array.isArray(node)) {
      for (const x of node) findAlbumGroups(x, groups, ancestors);
    } else {
      for (const k in node) findAlbumGroups(node[k], groups, ancestors);
    }
  }

  // --- Post / reel walker ---
  // IG ships post data under TWO parallel schemas across rollouts:
  //
  // (A) v1 / xdt_api shape (snake_case):
  //   { pk, id, code, media_type, image_versions2: { candidates: [...] },
  //     video_versions: [...], carousel_media: [...] }
  //   media_type: 1=image, 2=video, 8=carousel
  //
  // (B) GraphQL shortcode_media shape (camelCase, edges):
  //   { id, shortcode, __typename, is_video, video_url, display_url,
  //     display_resources: [...],
  //     edge_sidecar_to_children: { edges: [{ node: {...} }] } }
  //   __typename: "GraphImage" | "GraphVideo" | "GraphSidecar"
  //
  // We match either: (.code OR .shortcode) AND any of the media-bearing
  // field names. The flatten function below handles both schemas
  // transparently.
  function findPostItems(node, into, depth) {
    if (!node || typeof node !== "object" || depth > 20) return;
    depth = depth || 0;
    const code = (typeof node.code === "string" && node.code) ||
                 (typeof node.shortcode === "string" && node.shortcode) ||
                 null;
    const looksLikePost =
      code && /^[A-Za-z0-9_-]{5,}$/.test(code) &&
      (node.image_versions2 ||
       Array.isArray(node.carousel_media) ||
       node.display_url ||
       node.edge_sidecar_to_children ||
       (node.__typename && /^Graph(Image|Video|Sidecar)$/.test(node.__typename)));
    if (looksLikePost) {
      into.push(node);
      // Don't recurse — carousel children are nested inside but we
      // explicitly walk them in flattenPostSlides.
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) findPostItems(x, into, depth + 1);
    } else {
      for (const k in node) findPostItems(node[k], into, depth + 1);
    }
  }

  function flattenPostSlides(post) {
    // Returns [{pk, media_type, image_url, video_url, image_urls, video_urls}, ...]
    // in carousel order. image_urls/video_urls are largest-first lists
    // of every candidate URL we can find — the archiver tries them in
    // order so a single failed CDN URL (expired sig, transient 5xx,
    // CORS edge case) falls back to the next size instead of dropping
    // the whole slide. image_url/video_url remain set to the best
    // candidate for callers that want a single URL.
    const sortedUrls = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return [];
      const sorted = [...arr].sort((a, b) =>
        (b.width || b.config_width || 0) * (b.height || b.config_height || 0) -
        (a.width || a.config_width || 0) * (a.height || a.config_height || 0)
      );
      const out = [];
      for (const c of sorted) {
        const u = c?.url || c?.src;
        if (u && !out.includes(u)) out.push(u);
      }
      return out;
    };
    const shapeOne = (obj, fallbackPk) => {
      // v1 video detection: media_type === 2 + video_versions array.
      // GraphQL video detection: __typename === GraphVideo OR is_video true.
      const isVideo =
        obj.media_type === 2 ||
        obj.__typename === "GraphVideo" ||
        obj.is_video === true;
      // Image URLs: combine v1 candidates + GraphQL display_resources
      // + bare display_url. Largest-first, deduped.
      const imageUrls = [];
      for (const u of sortedUrls(obj.image_versions2?.candidates)) {
        if (!imageUrls.includes(u)) imageUrls.push(u);
      }
      for (const u of sortedUrls(obj.display_resources)) {
        if (!imageUrls.includes(u)) imageUrls.push(u);
      }
      if (obj.display_url && !imageUrls.includes(obj.display_url)) {
        imageUrls.push(obj.display_url);
      }
      // Video URLs: v1 video_versions plus GraphQL top-level video_url.
      const videoUrls = [];
      if (isVideo) {
        for (const u of sortedUrls(obj.video_versions)) {
          if (!videoUrls.includes(u)) videoUrls.push(u);
        }
        if (obj.video_url && !videoUrls.includes(obj.video_url)) {
          videoUrls.push(obj.video_url);
        }
      }
      return {
        pk: String(obj.pk || obj.id || fallbackPk || "unknown"),
        media_type:
          obj.media_type ??
          (obj.__typename === "GraphVideo" ? 2 :
           obj.__typename === "GraphSidecar" ? 8 :
           obj.__typename === "GraphImage" ? 1 :
           (obj.is_video ? 2 : 1)),
        image_url: imageUrls[0] || null,
        video_url: videoUrls[0] || null,
        image_urls: imageUrls,
        video_urls: videoUrls,
      };
    };
    // v1 carousel: carousel_media[]
    if (Array.isArray(post.carousel_media) && post.carousel_media.length) {
      return post.carousel_media.map((c, i) =>
        shapeOne(c, `${post.pk || post.id}_${i}`)
      );
    }
    // GraphQL carousel: edge_sidecar_to_children.edges[].node
    if (post.edge_sidecar_to_children &&
        Array.isArray(post.edge_sidecar_to_children.edges)) {
      return post.edge_sidecar_to_children.edges.map((e, i) =>
        shapeOne(e.node || {}, `${post.id}_${i}`)
      );
    }
    // Single-media post (image / video / reel).
    return [shapeOne(post, post.pk || post.id)];
  }

  // Walk the response for profile-info objects. IG's user payloads
  // always carry .username + at least one of the account-type signals
  // (is_business, is_professional_account, account_type, category).
  // We pick those out so the overlay can show "Business" / "Creator"
  // pills without having to wait for the DOM to render the category
  // line under the bio (which IG only paints on certain rollouts).
  function findProfileInfos(node, into, depth) {
    if (!node || typeof node !== "object" || depth > 12) return;
    depth = depth || 0;
    if (typeof node.username === "string" && node.username && (
        typeof node.is_business !== "undefined" ||
        typeof node.is_professional_account !== "undefined" ||
        typeof node.account_type !== "undefined" ||
        typeof node.category !== "undefined" ||
        typeof node.category_name !== "undefined" ||
        typeof node.business_category_name !== "undefined")) {
      into.push({
        username: node.username,
        // is_business: true when the account is on a Business plan.
        // is_professional_account: superset — true for Business AND
        // Creator. Track both so the overlay can distinguish.
        is_business: node.is_business === true,
        is_professional_account: node.is_professional_account === true,
        // account_type: 1=personal, 2=business, 3=creator (v1 only;
        // GraphQL doesn't always include it).
        account_type: typeof node.account_type === "number" ? node.account_type : null,
        category:
          node.category ||
          node.category_name ||
          node.business_category_name ||
          null,
      });
    }
    if (Array.isArray(node)) {
      for (const x of node) findProfileInfos(x, into, depth + 1);
    } else {
      for (const k in node) findProfileInfos(node[k], into, depth + 1);
    }
  }

  function postManifest(url, data) {
    try {
      const allItems = [];
      walkForItems(data, allItems);
      const albumGroups = [];
      findAlbumGroups(data, albumGroups);
      const postItems = [];
      findPostItems(data, postItems, 0);
      const profileInfos = [];
      findProfileInfos(data, profileInfos, 0);
      if (allItems.length === 0 && albumGroups.length === 0 &&
          postItems.length === 0 && profileInfos.length === 0) return;
      // Strip down to just what the archiver needs — a stable per-item
      // shape with the highest-quality URL extracted up front.
      // Carry user.username and user.pk along: the entry-URL fallback
      // path in the archiver (when IG sits on `/stories/<user>/` and
      // never navigates to a specific story id) needs to scan the
      // cached manifests for items belonging to the visited user.
      // Without these fields, the manifest is only addressable by
      // the URL-derived id we don't have in the entry-URL case.
      const shape = (it) => {
        const candidates = it.image_versions2?.candidates || [];
        const sortedImg = [...candidates].sort((a, b) =>
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        );
        const bestImage = sortedImg[0]?.url || null;
        const videos = it.video_versions || [];
        const sortedVid = [...videos].sort((a, b) =>
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        );
        const bestVideo = sortedVid[0]?.url || null;
        return {
          pk: String(it.pk),
          media_type: it.media_type,    // 1 = image, 2 = video
          taken_at: it.taken_at,
          image_url: bestImage,
          video_url: bestVideo,
          user_username: it.user?.username || it.owner?.username || null,
          user_pk: it.user?.pk ? String(it.user.pk) : (it.owner?.id ? String(it.owner.id) : null),
        };
      };
      const message = {
        source: "igtracker-net",
        url,
        items: allItems.map(shape),
        groups: albumGroups.map((g) => ({
          ids: g.idCandidates,
          numericIds: g.numericIds,
          items: g.items.map(shape),
        })),
        // Post manifests are keyed by shortcode (the /p/<code>/ value),
        // contain a flat list of slides for carousels. The archiver
        // looks these up when navigating to a post URL. Shortcode
        // lives at .code (v1) or .shortcode (GraphQL); username at
        // .user (v1) or .owner (GraphQL).
        posts: postItems.map((p) => ({
          shortcode: p.code || p.shortcode,
          pk: String(p.pk || p.id || ""),
          media_type:
            p.media_type ??
            (p.__typename === "GraphVideo" ? 2 :
             p.__typename === "GraphSidecar" ? 8 :
             p.__typename === "GraphImage" ? 1 : null),
          slides: flattenPostSlides(p),
          username:
            p.user?.username ||
            p.owner?.username ||
            null,
        })),
        profiles: profileInfos,
      };
      window.postMessage(message, "*");
    } catch (e) {
      // Best-effort; never let an interceptor error break the page.
    }
  }

  // --- Patch window.fetch ---
  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const url = typeof input === "string"
      ? input
      : (input && input.url) || "";
    const promise = origFetch.apply(this, arguments);
    // Filter to IG's API endpoints — graphql + api/v1 covers the
    // story / reels / highlight queries. Ignore everything else
    // (image bytes, JS bundles, telemetry) so we don't burn cycles.
    if (url && (url.includes("/graphql/") ||
                url.includes("/api/v1/") ||
                url.includes("/api/graphql"))) {
      promise.then((response) => {
        // Clone so we don't drain the body the page is about to read.
        try {
          const clone = response.clone();
          clone.text().then((txt) => {
            try {
              const data = JSON.parse(txt);
              postManifest(url, data);
            } catch { /* not JSON */ }
          }).catch(() => {});
        } catch { /* clone failed */ }
      }).catch(() => {});
    }
    return promise;
  };

  // --- Patch XHR (some IG endpoints still use XHR under the hood) ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igtUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    const url = xhr.__igtUrl || "";
    if (url && (url.includes("/graphql/") ||
                url.includes("/api/v1/") ||
                url.includes("/api/graphql"))) {
      xhr.addEventListener("load", () => {
        try {
          const txt = xhr.responseText;
          if (!txt) return;
          const data = JSON.parse(txt);
          postManifest(url, data);
        } catch { /* not JSON */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
