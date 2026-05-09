// Shared archived-media gallery — used by both the account modal in
// app.js and the standalone full-page view at /media/<username>.
//
// Mounts into any element with class .archived-media-block. The
// document-level handlers below find their target via .closest(), so
// they fire correctly on either page without per-mount wiring.
//
// Public API (window.ArchiveGallery):
//   mount(blockEl, username)   — fetch + render into blockEl
//   refresh(blockEl)           — re-fetch + re-render (preserves dataset.username)
(function () {
  const ESC_HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_HTML[c]);
  const escapeAttr = escapeHtml;
  const cssEscape = (s) =>
    (typeof CSS !== "undefined" && CSS.escape)
      ? CSS.escape(s)
      : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  function groupLabel(key, count) {
    if (key === "_flat") return `(other &middot; ${count})`;
    const m = key.match(/^([^_]+)_(.+)$/);
    const kind = m ? m[1] : "media";
    const id = m ? m[2] : key;
    const icon = kind === "post" ? "📷"
               : kind === "reel" ? "🎬"
               : kind === "highlight" ? "📚"
               : kind === "story" ? "📖"
               : "📦";
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    return `${icon} ${label} ${escapeHtml(id)} &middot; ${count} item${count === 1 ? "" : "s"}`;
  }

  function renderTile(username, item) {
    const isVideo = item.ext === "mp4";
    const url = item.url;
    const inner = isVideo
      ? `<video src="${escapeAttr(url)}" muted preload="metadata"></video><span class="archived-badge">▶</span>`
      : `<img src="${escapeAttr(url)}" alt="${escapeAttr(item.media_id)}" loading="lazy" />`;
    return `
      <div class="archived-tile-wrap" data-media-id="${escapeAttr(item.media_id)}">
        <a class="archived-tile" href="${escapeAttr(url)}" target="_blank" rel="noopener" title="Open ${escapeAttr(item.media_id)} (${(item.size / 1024).toFixed(0)} KB)">${inner}</a>
        <button class="archived-delete" data-action="delete-media"
                data-username="${escapeAttr(username)}"
                data-media-id="${escapeAttr(item.media_id)}"
                data-ext="${escapeAttr(item.ext)}"
                title="Delete this archived file">×</button>
      </div>`;
  }

  function render(blockEl, username, items) {
    if (!items.length) {
      blockEl.innerHTML = `
        <h4 class="archived-heading">
          📦 Archived media
          <span class="muted small">no items</span>
        </h4>
      `;
      return;
    }
    const groups = new Map();
    for (const item of items) {
      const key = item.group || "_flat";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const sections = Array.from(groups.entries()).map(([key, gItems]) => {
      const tiles = gItems.map((it) => renderTile(username, it)).join("");
      return `
        <div class="archived-group" data-group-key="${escapeAttr(key)}">
          <h5 class="archived-group-h">
            <label class="archived-group-select" title="Select all in this group">
              <input type="checkbox" data-action="select-group" />
              <span class="archived-group-label">${groupLabel(key, gItems.length)}</span>
            </label>
          </h5>
          <div class="archived-grid">${tiles}</div>
        </div>`;
    }).join("");
    const totalKb = (items.reduce((a, b) => a + b.size, 0) / 1024).toFixed(0);
    const fullPageHref = `/media/${encodeURIComponent(username)}`;
    blockEl.dataset.username = username;
    // Stash the rendered items on the block so the slideshow can pull
    // them directly without reparsing the DOM. Order here is mtime-desc
    // (matches the server) but the slideshow steps in render order so
    // the user sees groups in the same order as the page above.
    blockEl._archivedItems = items;
    blockEl.innerHTML = `
      <h4 class="archived-heading">
        📦 Archived media
        <span class="muted small">${items.length} item${items.length === 1 ? "" : "s"} &middot; ${totalKb} KB total</span>
        <a class="archived-fullpage-link" href="${escapeAttr(fullPageHref)}" target="_blank" rel="noopener" title="Open full-page archive view in a new tab">↗ Full page</a>
        <button class="archived-slideshow" data-action="archive-slideshow" title="Cycle through every post and highlight">▶ Slideshow</button>
        <button class="archived-select-toggle" data-action="toggle-archive-select" title="Select multiple to delete in bulk">Select</button>
      </h4>
      <label class="archived-select-all" hidden>
        <input type="checkbox" data-action="select-all" />
        <span>Select all (${items.length})</span>
      </label>
      ${sections}
      <div class="archived-bulk-bar" hidden>
        <button class="archived-bulk-delete" data-action="bulk-delete-archive">Delete 0</button>
        <input type="text" class="archived-bulk-move-input" data-action="move-target" placeholder="Move to @username" autocomplete="off" />
        <button class="archived-bulk-move" data-action="bulk-move-archive">Move 0</button>
      </div>
    `;
  }

  async function fetchAndRender(blockEl, username) {
    blockEl.dataset.username = username;
    try {
      const r = await fetch(`/api/media-list/${encodeURIComponent(username)}`);
      if (!r.ok) return;
      const data = await r.json();
      render(blockEl, username, data.items || []);
    } catch {
      /* leave whatever was rendered before */
    }
  }

  // ---------- selection hierarchy ----------
  // master ↔ groups ↔ tiles. A change to any level recomputes the
  // others. Indeterminate state for partial coverage.

  function _setCheckbox(input, state) {
    if (!input) return;
    if (state === "all") { input.checked = true; input.indeterminate = false; }
    else if (state === "none") { input.checked = false; input.indeterminate = false; }
    else { input.checked = false; input.indeterminate = true; }
  }

  function _coverageState(total, selected) {
    if (selected === 0) return "none";
    if (selected === total) return "all";
    return "partial";
  }

  function recomputeBlockState(blockEl) {
    const groups = blockEl.querySelectorAll(".archived-group");
    let blockTotal = 0;
    let blockSelected = 0;
    groups.forEach((g) => {
      const tiles = g.querySelectorAll(".archived-tile-wrap");
      const sel = g.querySelectorAll(".archived-tile-wrap.archived-selected");
      blockTotal += tiles.length;
      blockSelected += sel.length;
      const groupCb = g.querySelector('input[data-action="select-group"]');
      _setCheckbox(groupCb, _coverageState(tiles.length, sel.length));
    });
    const masterCb = blockEl.querySelector('input[data-action="select-all"]');
    _setCheckbox(masterCb, _coverageState(blockTotal, blockSelected));
    refreshDeleteBar(blockEl);
  }

  function refreshDeleteBar(blockEl) {
    const bar = blockEl.querySelector(".archived-bulk-bar");
    if (!bar) return;
    const count = blockEl.querySelectorAll(".archived-tile-wrap.archived-selected").length;
    bar.hidden = count === 0;
    const delBtn = bar.querySelector('[data-action="bulk-delete-archive"]');
    if (delBtn) delBtn.textContent = `Delete ${count}`;
    const mvBtn = bar.querySelector('[data-action="bulk-move-archive"]');
    if (mvBtn) mvBtn.textContent = `Move ${count}`;
  }

  function setBlockSelectMode(blockEl, on) {
    blockEl.classList.toggle("archived-select-mode", on);
    const toggle = blockEl.querySelector('[data-action="toggle-archive-select"]');
    if (toggle) toggle.textContent = on ? "Cancel" : "Select";
    const masterRow = blockEl.querySelector(".archived-select-all");
    if (masterRow) masterRow.hidden = !on;
    if (!on) {
      blockEl.querySelectorAll(".archived-tile-wrap.archived-selected").forEach((el) =>
        el.classList.remove("archived-selected")
      );
      blockEl.querySelectorAll('input[data-action="select-group"], input[data-action="select-all"]').forEach((cb) => {
        cb.checked = false; cb.indeterminate = false;
      });
    }
    refreshDeleteBar(blockEl);
  }

  // ---------- delete ----------

  async function deleteFile(username, mediaId, ext) {
    const r = await fetch(
      `/api/media/${encodeURIComponent(username)}/${encodeURIComponent(mediaId)}.${encodeURIComponent(ext)}`,
      { method: "DELETE" }
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${r.status}`);
    }
  }

  // ---------- document-level handlers ----------
  // Installed once per page. closest('.archived-media-block') gates
  // them so they only fire when there's a gallery on screen.

  function _onSingleDelete(e) {
    const delBtn = e.target.closest('button[data-action="delete-media"]');
    if (!delBtn) return;
    const block = delBtn.closest(".archived-media-block");
    if (!block) return;
    // In select-mode the × is hidden by CSS. Don't act on it.
    if (block.classList.contains("archived-select-mode")) return;
    e.preventDefault();
    e.stopPropagation();
    const { username, mediaId, ext } = delBtn.dataset;
    if (!username || !mediaId || !ext) return;
    delBtn.disabled = true;
    deleteFile(username, mediaId, ext)
      .then(() => {
        fetchAndRender(block, username);
        if (typeof window.loadArchiveCard === "function") window.loadArchiveCard();
      })
      .catch((err) => {
        delBtn.disabled = false;
        alert(`Couldn't delete: ${err.message}`);
      });
  }

  function _onToggleSelectMode(e) {
    const toggle = e.target.closest('button[data-action="toggle-archive-select"]');
    if (!toggle) return;
    const block = toggle.closest(".archived-media-block");
    if (!block) return;
    e.preventDefault();
    setBlockSelectMode(block, !block.classList.contains("archived-select-mode"));
  }

  function _onTileClick(e) {
    const wrap = e.target.closest(".archived-tile-wrap");
    if (!wrap) return;
    const block = wrap.closest(".archived-media-block");
    if (!block || !block.classList.contains("archived-select-mode")) return;
    // Don't fight the master/group checkbox clicks.
    if (e.target.closest('input[data-action="select-all"], input[data-action="select-group"]')) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.toggle("archived-selected");
    recomputeBlockState(block);
  }

  function _onMasterChange(e) {
    const cb = e.target.closest('input[data-action="select-all"]');
    if (!cb) return;
    const block = cb.closest(".archived-media-block");
    if (!block || !block.classList.contains("archived-select-mode")) {
      // Stale toggle outside select mode — ignore and reset.
      cb.checked = false; cb.indeterminate = false;
      return;
    }
    const want = cb.checked; // browser already toggled state
    block.querySelectorAll(".archived-tile-wrap").forEach((w) =>
      w.classList.toggle("archived-selected", want)
    );
    recomputeBlockState(block);
  }

  function _onGroupChange(e) {
    const cb = e.target.closest('input[data-action="select-group"]');
    if (!cb) return;
    const group = cb.closest(".archived-group");
    if (!group) return;
    const block = group.closest(".archived-media-block");
    if (!block || !block.classList.contains("archived-select-mode")) {
      cb.checked = false; cb.indeterminate = false;
      return;
    }
    const want = cb.checked;
    group.querySelectorAll(".archived-tile-wrap").forEach((w) =>
      w.classList.toggle("archived-selected", want)
    );
    recomputeBlockState(block);
  }

  async function _onBulkDelete(e) {
    const btn = e.target.closest('button[data-action="bulk-delete-archive"]');
    if (!btn) return;
    e.preventDefault();
    const block = btn.closest(".archived-media-block");
    if (!block) return;
    const username = block.dataset.username;
    const selected = Array.from(block.querySelectorAll(".archived-tile-wrap.archived-selected"));
    if (!selected.length) return;
    btn.disabled = true;
    btn.textContent = `Deleting ${selected.length}…`;
    for (const wrap of selected) {
      const delBtn = wrap.querySelector('button[data-action="delete-media"]');
      if (!delBtn) continue;
      const { mediaId, ext } = delBtn.dataset;
      try { await deleteFile(username, mediaId, ext); } catch { /* keep going */ }
    }
    await fetchAndRender(block, username);
    if (typeof window.loadArchiveCard === "function") window.loadArchiveCard();
  }

  // Move N selected files to a different account. Used to reattach
  // @unknown highlights (saved before the runner could resolve the
  // owning username) to the actual account they came from.
  async function _onBulkMove(e) {
    const btn = e.target.closest('button[data-action="bulk-move-archive"]');
    if (!btn) return;
    e.preventDefault();
    const block = btn.closest(".archived-media-block");
    if (!block) return;
    const sourceUser = block.dataset.username;
    const input = block.querySelector('input[data-action="move-target"]');
    const targetUser = (input?.value || "").trim().replace(/^@/, "");
    if (!targetUser) {
      if (input) { input.focus(); input.placeholder = "Type a target @username first"; }
      return;
    }
    if (targetUser === sourceUser) {
      if (input) input.placeholder = "Target must differ from source";
      return;
    }
    const selected = Array.from(block.querySelectorAll(".archived-tile-wrap.archived-selected"));
    if (!selected.length) return;
    const items = selected.map((wrap) => {
      const delBtn = wrap.querySelector('button[data-action="delete-media"]');
      if (!delBtn) return null;
      return { media_id: delBtn.dataset.mediaId, ext: delBtn.dataset.ext };
    }).filter(Boolean);
    btn.disabled = true;
    if (input) input.disabled = true;
    btn.textContent = `Moving ${items.length}…`;
    let resp = null;
    try {
      const r = await fetch("/api/media-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_user: sourceUser, target_user: targetUser, items }),
      });
      resp = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resp?.detail || `HTTP ${r.status}`);
    } catch (err) {
      btn.textContent = `Move failed`;
      console.warn("[archive-gallery] bulk move failed:", err?.message || err);
      setTimeout(() => {
        btn.disabled = false;
        if (input) input.disabled = false;
        refreshDeleteBar(block);
      }, 2500);
      return;
    }
    const movedN = resp?.moved || 0;
    const failedN = (resp?.failed || []).length;
    btn.textContent = failedN
      ? `Moved ${movedN} (${failedN} failed) ✓`
      : `Moved ${movedN} ✓`;
    if (input) input.value = "";
    setTimeout(() => {
      btn.disabled = false;
      if (input) input.disabled = false;
    }, 2500);
    // Refresh the source view (selection mode auto-clears on re-render).
    await fetchAndRender(block, sourceUser);
    if (typeof window.loadArchiveCard === "function") window.loadArchiveCard();
  }

  // ---------- slideshow ----------
  // Fullscreen overlay that walks every archived file in render order.
  // Images auto-advance after IMAGE_HOLD_MS; videos play through and
  // advance on `ended` (or after VIDEO_MAX_MS as a hard cap so a glitchy
  // 10-minute clip doesn't stall the loop). Space pauses; arrow keys
  // step manually; Esc closes. Single overlay shared across mounts —
  // closing one before opening another (defensive cleanup).
  const IMAGE_HOLD_MS = 4000;
  const VIDEO_MAX_MS = 30000;
  let _slideshowState = null;

  function _slideshowGroupLabel(item) {
    const key = item.group || "_flat";
    if (key === "_flat") return "(other)";
    const m = key.match(/^([^_]+)_(.+)$/);
    const kind = m ? m[1] : "media";
    const id = m ? m[2] : key;
    const icon = kind === "post" ? "📷"
               : kind === "reel" ? "🎬"
               : kind === "highlight" ? "📚"
               : kind === "story" ? "📖"
               : "📦";
    return `${icon} ${kind} ${id}`;
  }

  function closeSlideshow() {
    if (!_slideshowState) return;
    const { overlay, onKey, advanceTimer } = _slideshowState;
    if (advanceTimer) clearTimeout(advanceTimer);
    if (onKey) document.removeEventListener("keydown", onKey);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    _slideshowState = null;
  }

  function _renderSlide() {
    if (!_slideshowState) return;
    const s = _slideshowState;
    const item = s.items[s.index];
    if (!item) { closeSlideshow(); return; }
    if (s.advanceTimer) {
      clearTimeout(s.advanceTimer);
      s.advanceTimer = null;
    }
    const isVideo = item.ext === "mp4";
    const url = item.url;
    s.stage.innerHTML = isVideo
      ? `<video src="${escapeAttr(url)}" autoplay muted playsinline></video>`
      : `<img src="${escapeAttr(url)}" alt="" />`;
    s.caption.textContent =
      `${_slideshowGroupLabel(item)}  ·  slide ${s.index + 1} of ${s.items.length}`;
    s.playPauseBtn.textContent = s.paused ? "▶" : "⏸";
    if (s.paused) return;
    if (isVideo) {
      const v = s.stage.querySelector("video");
      if (v) {
        const onEnded = () => {
          v.removeEventListener("ended", onEnded);
          if (_slideshowState === s && !s.paused) _advance(1);
        };
        v.addEventListener("ended", onEnded);
        // Hard cap so a long/looping clip doesn't freeze the show.
        s.advanceTimer = setTimeout(() => _advance(1), VIDEO_MAX_MS);
      } else {
        s.advanceTimer = setTimeout(() => _advance(1), IMAGE_HOLD_MS);
      }
    } else {
      s.advanceTimer = setTimeout(() => _advance(1), IMAGE_HOLD_MS);
    }
  }

  function _advance(delta) {
    if (!_slideshowState) return;
    const s = _slideshowState;
    s.index = (s.index + delta + s.items.length) % s.items.length;
    _renderSlide();
  }

  function _togglePause() {
    if (!_slideshowState) return;
    _slideshowState.paused = !_slideshowState.paused;
    _renderSlide();
  }

  function _onSlideshow(e) {
    const btn = e.target.closest('button[data-action="archive-slideshow"]');
    if (!btn) return;
    const block = btn.closest(".archived-media-block");
    if (!block) return;
    e.preventDefault();
    const items = (block._archivedItems || []).filter(
      (it) => it.ext === "mp4" || /^(jpg|jpeg|png|gif|webp)$/i.test(it.ext)
    );
    if (!items.length) return;
    closeSlideshow();
    const overlay = document.createElement("div");
    overlay.className = "archived-slideshow-overlay";
    overlay.innerHTML = `
      <button class="ssh-close" type="button" title="Close (Esc)">✕</button>
      <div class="ssh-stage"></div>
      <div class="ssh-controls">
        <button class="ssh-prev" type="button" title="Previous (←)">⟨</button>
        <button class="ssh-playpause" type="button" title="Play/pause (Space)">⏸</button>
        <button class="ssh-next" type="button" title="Next (→)">⟩</button>
      </div>
      <div class="ssh-caption"></div>
    `;
    document.body.appendChild(overlay);
    const stage = overlay.querySelector(".ssh-stage");
    const caption = overlay.querySelector(".ssh-caption");
    const playPauseBtn = overlay.querySelector(".ssh-playpause");
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeSlideshow(); }
      else if (ev.key === "ArrowLeft") { ev.preventDefault(); _advance(-1); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); _advance(1); }
      else if (ev.key === " ") { ev.preventDefault(); _togglePause(); }
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) closeSlideshow(); });
    overlay.querySelector(".ssh-close").addEventListener("click", closeSlideshow);
    overlay.querySelector(".ssh-prev").addEventListener("click", () => _advance(-1));
    overlay.querySelector(".ssh-next").addEventListener("click", () => _advance(1));
    playPauseBtn.addEventListener("click", _togglePause);
    _slideshowState = {
      overlay, stage, caption, playPauseBtn, onKey,
      items, index: 0, paused: false, advanceTimer: null,
    };
    _renderSlide();
  }

  let _installed = false;
  function installHandlers() {
    if (_installed) return;
    _installed = true;
    document.addEventListener("click", _onSingleDelete);
    document.addEventListener("click", _onToggleSelectMode);
    document.addEventListener("click", _onTileClick);
    document.addEventListener("change", _onMasterChange);
    document.addEventListener("change", _onGroupChange);
    document.addEventListener("click", _onBulkDelete);
    document.addEventListener("click", _onBulkMove);
    document.addEventListener("click", _onSlideshow);
  }

  // ---------- public API ----------
  window.ArchiveGallery = {
    mount(blockEl, username) {
      if (!blockEl) return;
      installHandlers();
      fetchAndRender(blockEl, username);
    },
    refresh(blockEl) {
      if (!blockEl) return;
      const username = blockEl.dataset.username;
      if (!username) return;
      fetchAndRender(blockEl, username);
    },
  };
})();
