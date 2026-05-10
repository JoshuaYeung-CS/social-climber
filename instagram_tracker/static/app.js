"use strict";

// ---------- tiny helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Hard timeout + AbortController on every fetch so a server restart
// or transient network blip can't leave a request pending forever
// (was actually happening — kickstarting the server mid-flight left
// the browser in zombie state, ui stuck on 'loading…' indefinitely).
// Default 20s is generous for cold-cache /api/lists; everything else
// returns in <1s.
const API_TIMEOUT_MS = 20_000;

async function _fetchWithTimeout(path, init = {}, timeoutMs = API_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("client timeout")), timeoutMs);
  try {
    return await fetch(path, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Long-timeout endpoints. Reset wipes + re-imports every Drive folder
// (can take 5+ minutes for hundreds of imports). Force-rescan likewise.
// Scheduled poll-scans hit /api/scan but those use the SW with its own
// timeout, so this only matters for user-triggered reset/rescan from
// the home page.
const _LONG_TIMEOUT_PATHS = new Set([
  "/api/reset-snapshots",
  "/api/scan",
  // /api/lists does the heavy cross-snapshot cumulative compute.
  // Cold-cache hits can take 30-60s once the snapshot table grows
  // past a few thousand rows. The cached path is sub-second so this
  // long timeout only matters on the first request after a server
  // restart or a snapshot import.
  "/api/lists",
  // /api/home shares the same cumulative compute machinery and the
  // archive-mtime scan over data/media/* — both grow with archive
  // size. Snapshot counts in the thousands push cold-cache compute
  // past 20s. Hot cache is sub-second.
  "/api/home",
  // /api/activity-log iterates every snapshot transition to build
  // per-event rows; same cold-cache shape.
  "/api/activity-log",
]);
function _timeoutFor(path) {
  for (const p of _LONG_TIMEOUT_PATHS) {
    if (path.startsWith(p)) return 10 * 60_000;  // 10 min
  }
  return API_TIMEOUT_MS;
}

const api = {
  async get(path) {
    const r = await _fetchWithTimeout(path, undefined, _timeoutFor(path));
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (_) { /* non-JSON */ }
      throw new Error(msg);
    }
    return r.json();
  },
  async post(path, body) {
    const r = await _fetchWithTimeout(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, _timeoutFor(path));
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (_) { /* non-JSON */ }
      throw new Error(msg);
    }
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    return r.json();
  },
  async upload(file) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/import", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    return r.json();
  },
};

function toast(msg, ms = 2400) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

function instagramUrl(username) {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

// Compact relative-time formatter: "5m ago", "3h ago", "2d ago".
// Input is unix-seconds (server gives mtimes as floats). Returns
// empty string for invalid / zero input so callers can chain into a
// truthy check.
function _fmtRelativeFromUnix(unixSec) {
  if (!unixSec || !Number.isFinite(unixSec)) return "";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d ago`;
  if (sec < 86400 * 60) return `${Math.floor(sec / (86400 * 7))}w ago`;
  return `${Math.floor(sec / (86400 * 30))}mo ago`;
}

function fmtRelativeDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ---------- scroll persistence per route ----------
//
// Persist window.scrollY per URL hash to localStorage so reload AND
// Cmd+Shift+T (reopen closed tab — sessionStorage would be cleared
// across that gesture) both land back where the user was. Browser
// default scrollRestoration would jump to top after our SPA rebuild
// swaps in fresh DOM, so we manage it manually. Local-only app on a
// single browser profile — cross-tab interference isn't a real risk
// (and even when two tabs are on the same route, last-write-wins is
// fine for this UX).
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}
const _SCROLL_KEY_PREFIX = "ig-tracker:scroll:";
function _scrollRouteKey() {
  return location.hash.replace(/^#/, "") || "home";
}
function _saveScrollNow() {
  try {
    const y = window.scrollY;
    if (y <= 0) localStorage.removeItem(_SCROLL_KEY_PREFIX + _scrollRouteKey());
    else localStorage.setItem(_SCROLL_KEY_PREFIX + _scrollRouteKey(), String(y));
  } catch {}
}
let _scrollSaveTimer = null;
window.addEventListener("scroll", () => {
  if (_scrollSaveTimer) return;
  _scrollSaveTimer = setTimeout(() => {
    _scrollSaveTimer = null;
    _saveScrollNow();
  }, 150);
}, { passive: true });
window.addEventListener("beforeunload", _saveScrollNow);
window.addEventListener("pagehide", _saveScrollNow);  // Safari/iOS

// Pending Y to restore. Set during bootstrap (page reload) and during
// popstate (back/forward), cleared once the page is tall enough to
// reach the target OR the user starts scrolling on their own.
let _pendingScrollRestoreY = null;
function _markScrollRestorePending() {
  try {
    const v = localStorage.getItem(_SCROLL_KEY_PREFIX + _scrollRouteKey());
    const y = Number(v);
    if (Number.isFinite(y) && y > 0) _pendingScrollRestoreY = y;
  } catch {}
}
function _tryRestoreScroll() {
  if (_pendingScrollRestoreY == null) return;
  const target = _pendingScrollRestoreY;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return;
  window.scrollTo(0, Math.min(target, Math.max(0, max)));
  // Once the document is tall enough to reach the saved position, the
  // restore is complete — drop the pending flag so the user's own
  // scrolls aren't fought by subsequent chunked-render paints.
  if (max >= target) _pendingScrollRestoreY = null;
}
// User-initiated input cancels any pending restore so we don't yank
// the page out from under them mid-scroll.
const _cancelPendingScrollRestore = () => { _pendingScrollRestoreY = null; };
window.addEventListener("wheel", _cancelPendingScrollRestore, { passive: true, once: false });
window.addEventListener("touchstart", _cancelPendingScrollRestore, { passive: true });
window.addEventListener("keydown", (e) => {
  if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "].includes(e.key)) {
    _cancelPendingScrollRestore();
  }
});

// ---------- view switching ----------

function showView(name, push = true) {
  // "snapshots" used to be its own view but moved to a home card.
  // Redirect any lingering links / bookmarks to home so the imports
  // list still surfaces (now on home as #imports-card).
  if (name === "snapshots") name = "home";
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  if (name === "lists") loadLists();
  if (name === "check") loadQueue();
  if (name === "history") loadHistory();
  if (name === "activity") loadActivityLog();
  if (push) {
    const state = history.state || {};
    if (state.view !== name || state.listKind) {
      history.pushState({ view: name }, "", `#${name}`);
    }
  }
  _renderedView = name;
  if (name !== "lists") _renderedListKind = null;
}

// Tabs are anchors so the browser handles cmd/ctrl/shift-click and
// middle-click natively (opens a new tab pointing at #<view> — the
// receiving tab's bootstrapHistory routes to that view on load).
// Plain click: intercept and SPA-route in place.
$$(".tab").forEach((t) =>
  t.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    showView(t.dataset.view);
  })
);

// ---------- home ----------

async function loadHome() {
  // Initial home load — surface a spinner in the snapshot pill so the
  // header doesn't sit blank during the fetch. Trigger the swap on
  // ANY initial state (the default HTML text is "no data", but we
  // also overwrite if the pill is empty / loading from a previous
  // call — e.g. fresh new-tab opens of /#lists/X where the pill
  // never got updated yet).
  const pillEl = $("#snapshot-pill");
  if (pillEl && (pillEl.textContent === "no data" || !pillEl.querySelector(".spinner"))) {
    if (!pillEl.textContent.startsWith("snapshot ")) {
      pillEl.innerHTML = `<span class="spinner" style="margin-right:4px"></span>loading…`;
    }
  }
  try {
    const data = await api.get("/api/home");
    const pill = $("#snapshot-pill");
    if (data.summary) {
      pill.textContent = `snapshot #${data.summary.snapshot_id}`;
    } else {
      pill.textContent = "no data";
    }

    const summaryCard = $("#summary-card");
    const grid = $("#summary-grid");
    if (data.summary) {
      summaryCard.hidden = false;
      const s = data.summary;
      grid.innerHTML = "";
      const stats = [
        ["Followers", s.followers, "all_followers"],
        ["Following", s.following, "all_following"],
        ["Mutuals", s.mutuals, "mutuals"],
        ["Don't follow back", s.not_following_you_back, "not_following_you_back"],
        ["Feeders", s.feeder_accounts, "feeder_accounts"],
        ["Pending", s.pending, "pending"],
        ["Ever unfollowed you", s.ever_unfollowed_you ?? 0, "ever_unfollowed_you"],
        ["🐀 Rats", s.rats ?? 0, "rats"],
        ["Mutual · you unfollowed first", s.mutual_break_you_first ?? 0, "mutual_break_you_first"],
        ["Mutual · they unfollowed first", s.mutual_break_they_first ?? 0, "mutual_break_they_first"],
        ["Ever removed you as follower", s.ever_removed_you_as_follower ?? 0, "ever_removed_you_as_follower"],
        ["You ever unfollowed", s.ever_you_unfollowed ?? 0, "you_unfollowed_ever"],
        ["You still follow them after they unfollowed you", s.still_follow_after_drop ?? 0, "still_follow_after_drop"],
        ["Requests to follow you", s.incoming_requests ?? 0, "incoming_requests"],
        ["Ever requested to follow you", s.ever_incoming_requests ?? 0, "ever_incoming_requests"],
        ["Removed their follow request", s.incoming_request_dropped ?? 0, "incoming_request_dropped"],
        ["Ever requested to follow", s.ever_requested_outgoing ?? 0, "ever_requested_outgoing"],
        ["My follow request rejected", s.request_dropped ?? 0, "request_dropped"],
        ["⚠ Tagged disabled", s.disabled_tagged ?? 0, "disabled"],
        ["✕ Tagged unavailable", s.unavailable_tagged ?? 0, "unavailable"],
        ["🎲 Tagged random requests", s.random_request_tagged ?? 0, "random_request"],
        ["👤 To follow", s.to_follow_tagged ?? 0, "to_follow"],
        ["⭐ Stars", s.star_tagged ?? 0, "star"],
      ];
      for (const [label, value, listKind] of stats) {
        // Render as an <a> with a real hash href so cmd/ctrl/shift-
        // click and middle-click open the list in a new tab via the
        // browser's default anchor behavior. Plain left-click is
        // intercepted to do SPA navigation (no full reload).
        const a = document.createElement("a");
        a.className = "stat clickable";
        a.dataset.listKind = listKind;
        a.href = `#lists/${listKind}`;
        a.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
        a.addEventListener("click", (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
          ev.preventDefault();
          goToList(listKind);
        });
        grid.appendChild(a);
      }
    } else {
      summaryCard.hidden = true;
    }

    const alertsCard = $("#alerts-card");
    const alertsList = $("#alerts-list");
    const all = [...(data.alerts.diff || []), ...(data.alerts.stateful || [])];
    // Sort: new alerts first (so the user sees what changed since
    // last export at the top of the scrollable list), then by
    // severity within each group.
    all.sort((a, b) => {
      const an = a.is_new ? 0 : 1;
      const bn = b.is_new ? 0 : 1;
      if (an !== bn) return an - bn;
      return 0;  // preserve server's secondary order (severity-then-ts)
    });
    const newCount = all.filter((a) => a.is_new).length;
    const clearedCount = data.alerts.cleared_count || 0;
    if (all.length === 0 && clearedCount === 0) {
      alertsCard.hidden = true;
    } else {
      alertsCard.hidden = false;
      alertsList.innerHTML = "";
      // Diff summary above the list — only shown when there's
      // actually something new or cleared since the last snapshot.
      // First-ever load shows nothing here (no baseline to diff).
      const summary = $("#alerts-diff-summary");
      if (summary) {
        const parts = [];
        if (newCount > 0)     parts.push(`<span class="alert-diff-new">🆕 ${newCount} new</span>`);
        if (clearedCount > 0) parts.push(`<span class="alert-diff-cleared">✓ ${clearedCount} resolved since last ack</span>`);
        if (parts.length) {
          parts.push(`<a href="#" class="alert-ack-link" id="alert-ack-link">mark read</a>`);
        }
        summary.innerHTML = parts.join(" · ");
        summary.hidden = parts.length === 0;
        const ackLink = $("#alert-ack-link");
        if (ackLink) {
          ackLink.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ackLink.textContent = "marking…";
            try {
              await api.post("/api/alerts/ack", {});
              await loadHome();
            } catch (e) {
              ackLink.textContent = "failed";
              setTimeout(() => { ackLink.textContent = "mark read"; }, 1500);
            }
          });
        }
      }
      for (const a of all) {
        const li = document.createElement("li");
        li.className = (a.severity || "normal") + (a.is_new ? " is-new" : "");
        const igHref = `https://www.instagram.com/${encodeURIComponent(a.username || "")}/`;
        // Add a 🆕 badge inline in the message for new alerts.
        const newBadge = a.is_new ? `<span class="alert-new-badge" title="New since last export">🆕</span> ` : "";
        li.innerHTML = `<span>${newBadge}${escapeHtml(a.message)}</span>`;
        // Direct IG link, then "Details" for the modal — gives one tap to
        // jump to the profile without going through the detail view first.
        const linkBtn = document.createElement("a");
        linkBtn.className = "open-btn open-link";
        linkBtn.href = igHref;
        linkBtn.target = "_blank";
        linkBtn.rel = "noopener";
        linkBtn.textContent = "↗";
        linkBtn.title = "Open on Instagram";
        const detailBtn = document.createElement("button");
        detailBtn.className = "open-btn";
        detailBtn.textContent = "Details";
        detailBtn.addEventListener("click", () => openAccountModal(a.username));
        li.appendChild(linkBtn);
        li.appendChild(detailBtn);
        alertsList.appendChild(li);
      }
    }

    $("#count-favorite").textContent = data.bucket_counts.favorites;
    $("#count-want_remove").textContent = data.bucket_counts.want_remove;
    $("#count-watchlist").textContent = data.bucket_counts.watchlist;
    $("#count-disabled").textContent = data.bucket_counts.disabled ?? 0;
    $("#count-unavailable").textContent = data.bucket_counts.unavailable ?? 0;
    $("#count-random_request").textContent = data.bucket_counts.random_request ?? 0;
    $("#count-now_public").textContent = data.bucket_counts.now_public ?? 0;
    const notesCount = data.bucket_counts.with_notes ?? 0;
    $("#count-with_notes").textContent = notesCount;
    // Hide the card entirely until at least one note exists, mirroring
    // the Archived media card's "no clutter when empty" behavior.
    $("#notes-card").hidden = notesCount === 0;
    const notesUsersEl = $("#notes-users");
    if (notesUsersEl) {
      const noted = data.noted_users || [];
      notesUsersEl.innerHTML = noted.map((n) => {
        const snippet = String(n.note || "").trim();
        const truncated = snippet.length > 80 ? snippet.slice(0, 77) + "…" : snippet;
        return `<a class="notes-user" data-username="${escapeAttr(n.username)}" href="${escapeAttr(instagramUrl(n.username))}" target="_blank" rel="noopener" title="${escapeAttr(snippet)}">@${escapeHtml(n.username)} <span class="muted small">${escapeHtml(truncated)}</span></a>`;
      }).join("");
      $$(".notes-user", notesUsersEl).forEach((el) =>
        // Plain click → open modal. Cmd/ctrl/shift-click and
        // middle-click fall through to the <a>'s default behavior
        // (open Instagram profile in new tab) since target=_blank.
        el.addEventListener("click", (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          openAccountModal(el.dataset.username);
        })
      );
    }

    // Public follow-backs / private accept-no-follow-back / Follow
    // Request Rejected cards. Hidden when empty; otherwise shows the
    // count + clickable usernames that open the per-account modal.
    // `tsConfigs` is an array of `{key, label, format}` describing
    // timestamps to render — one bullet-separated chip per entry.
    //   key: property on the entry object (e.g. "ts", "ts2", "ts2_iso")
    //   label: leading text ("you requested", "they accepted", "rejected ~")
    //   format: "datetime" (default, fmtDateTime on int/iso) or "iso" (ISO string passthrough)
    const renderUserCard = (cardId, listEl, countId, users, tsConfigs = []) => {
      const card = $(`#${cardId}`);
      const countEl = $(`#${countId}`);
      if (countEl) countEl.textContent = (users && users.length) || 0;
      if (!users || users.length === 0) { if (card) card.hidden = true; return; }
      if (card) card.hidden = false;
      if (!listEl) return;
      listEl.innerHTML = users.map((entry) => {
        const u = typeof entry === "string" ? entry : entry.username;
        const tsParts = [];
        if (typeof entry === "object") {
          for (const cfg of tsConfigs) {
            const v = entry[cfg.key];
            if (v == null || v === "") continue;
            let formatted;
            if (cfg.format === "iso") {
              // ISO string from server (taken_at). Convert to epoch
              // seconds so fmtDateTime can render consistently.
              const ms = Date.parse(v);
              if (Number.isNaN(ms)) continue;
              formatted = fmtDateTime(Math.floor(ms / 1000));
            } else {
              formatted = fmtDateTime(v);
            }
            tsParts.push(`${escapeHtml(cfg.label)} ${escapeHtml(formatted)}`);
          }
        }
        const tsHtml = tsParts.length
          ? `<span class="muted small">${tsParts.join(" · ")}</span>`
          : "";
        return `<a class="notes-user" data-username="${escapeAttr(u)}" href="${escapeAttr(instagramUrl(u))}" target="_blank" rel="noopener">@${escapeHtml(u)}${tsHtml ? " " + tsHtml : ""}</a>`;
      }).join("");
      $$(".notes-user", listEl).forEach((el) =>
        // Plain click → modal. Modifier / middle clicks → browser
        // default (new tab to instagram.com/<u>/).
        el.addEventListener("click", (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          openAccountModal(el.dataset.username);
        })
      );
    };
    renderUserCard(
      "public-followback-card",
      $("#public-followback-users"),
      "count-public_followed_back",
      data.public_followed_back || [],
      [
        { key: "ts",  label: "they followed you" },
        { key: "ts2", label: "you followed them" },
      ]
    );
    renderUserCard(
      "private-accepted-card",
      $("#private-accepted-users"),
      "count-private_accepted_no_follow_back",
      data.private_accepted_no_follow_back || [],
      [
        { key: "ts",  label: "you requested" },
        { key: "ts2", label: "they accepted" },
      ]
    );
    renderUserCard(
      "request-rejected-card",
      $("#request-rejected-users"),
      "count-request_dropped",
      data.request_dropped || [],
      [
        { key: "ts",      label: "you requested" },
        // ts2_iso is a snapshot taken_at string (ISO). Fall back to
        // "rejected ~" prefix since this is an ESTIMATE: rejection
        // happened sometime after the last snapshot we observed
        // them in pending.
        { key: "ts2_iso", label: "rejected ~", format: "iso" },
      ]
    );

    loadArchiveQueueCard();
    // Imports moved from its own tab to a home card (swapped slots
    // with the archive-media card, which is now its own top-level
    // page). loadSnapshots also handles count-pill + show/hide of
    // the card based on whether any imports exist.
    loadSnapshots();
    // Home page is shorter than lists but a long Notes / archive
    // queue can still push it taller than the viewport — restore the
    // saved scroll if we have one.
    _tryRestoreScroll();
  } catch (e) {
    console.error("loadHome failed:", e);
    // Reset the pill so it doesn't sit stuck on the spinner. Show a
    // clickable retry — clicking re-runs loadHome.
    const pill = $("#snapshot-pill");
    if (pill) {
      pill.innerHTML = "";
      const btn = document.createElement("button");
      btn.style.cssText = "background:transparent;border:1px solid currentColor;color:inherit;padding:2px 8px;border-radius:6px;cursor:pointer;font:inherit;";
      btn.textContent = `error · retry (${e.message || "unknown"})`;
      btn.onclick = () => { pill.textContent = "no data"; loadHome(); };
      pill.appendChild(btn);
    }
    toast(`Couldn't load home: ${e.message}`);
  }
}

// Archive queue card — shows what the auto-archive runner will visit
// next, with add/remove. Hidden when both queue is empty AND no
// favorites have been set up (no point showing an empty queue if
// the user isn't using the runner).
async function loadArchiveQueueCard() {
  const card = $("#archive-queue-card");
  if (!card) return;
  let data;
  try {
    data = await api.get("/api/archive-queue");
  } catch (e) {
    card.hidden = true;
    return;
  }
  const queue = data.queue || [];
  const stats = data.stats || {};
  const manualSet = new Set(data.manual_in_queue || []);
  if (queue.length === 0 && !stats.favorite_total && !stats.manual_total) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const summary = [
    `${queue.length} queued`,
    stats.manual_in_queue ? `${stats.manual_in_queue} manual` : null,
    stats.skipped_already_archived ? `${stats.skipped_already_archived} already archived` : null,
    stats.skipped_user_cleared ? `${stats.skipped_user_cleared} you cleared` : null,
    stats.skipped_tagged ? `${stats.skipped_tagged} skipped (tagged)` : null,
  ].filter(Boolean).join(" · ");
  $("#archive-queue-summary").textContent = summary;

  const list = $("#archive-queue-list");
  list.innerHTML = queue.map((u) => {
    const isManual = manualSet.has(u);
    const safeU = escapeHtml(u);
    return `<li>
      <span class="qbadge${isManual ? " manual" : ""}">${isManual ? "manual" : "favorite"}</span>
      <span class="qname"><a href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener">@${safeU}</a></span>
      <button class="qremove" data-username="${escapeAttr(u)}" data-manual="${isManual ? "1" : "0"}">Remove</button>
    </li>`;
  }).join("");

  list.querySelectorAll(".qremove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const u = btn.dataset.username;
      const isManual = btn.dataset.manual === "1";
      btn.disabled = true;
      btn.textContent = "…";
      try {
        if (isManual) {
          // Manual entries: just untag need_archive.
          await api.post("/api/tags", { username: u, flag: "need_archive", value: false });
        } else {
          // Favorite entries: set archive_skip so they don't re-appear,
          // without un-favoriting them.
          await api.post("/api/tags", { username: u, flag: "archive_skip", value: true });
        }
        await loadArchiveQueueCard();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Remove"; }, 1500);
      }
    });
  });
}

async function _archiveQueueAdd() {
  const input = $("#archive-queue-add-input");
  const btn = $("#archive-queue-add-btn");
  const u = (input.value || "").trim().replace(/^@/, "");
  if (!u) return;
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    // If the account was previously archive_skip'd, clear that too so
    // it actually re-enters the queue.
    await api.post("/api/tags", { username: u, flag: "archive_skip", value: false });
    await api.post("/api/tags", { username: u, flag: "need_archive", value: true });
    btn.textContent = "Added ✓";
    input.value = "";
    setTimeout(() => { btn.textContent = "Add"; btn.disabled = false; loadArchiveQueueCard(); }, 700);
  } catch (e) {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Add"; btn.disabled = false; }, 1500);
  }
}
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("#archive-queue-add-btn");
  const input = $("#archive-queue-add-input");
  if (btn) btn.addEventListener("click", _archiveQueueAdd);
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") _archiveQueueAdd(); });
});

// Surface the local media archive on the home view. Hidden entirely
// when nothing has been auto-archived yet (the auto-archive setting
// defaults off, so most users won't see this card).
async function loadArchiveCard() {
  const card = $("#archive-card");
  if (!card) return;
  try {
    const r = await fetch("/api/media-summary");
    if (!r.ok) { card.hidden = true; return; }
    const data = await r.json();
    if (!data.users || data.users.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    const totalMb = (data.total_bytes / 1024 / 1024).toFixed(1);
    $("#archive-summary").textContent =
      `${data.total_items} item${data.total_items === 1 ? "" : "s"} across ${data.users.length} account${data.users.length === 1 ? "" : "s"} · ${totalMb} MB`;
    // List rows match the notes / public-followback / private-accepted
    // cards: username on the left, "<count> items · <size> · <when>"
    // on the right. Each row links to /media/<username> in a new tab
    // (real <a target="_blank"> so cmd/ctrl-click works without any
    // JS interception). Server already sorts by latest_mtime desc, so
    // most-recently archived accounts surface at the top.
    const users = (data.users || []).slice().sort(
      (a, b) => (b.latest_mtime || 0) - (a.latest_mtime || 0)
    );
    const fmtSize = (bytes) => bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${(bytes / 1024).toFixed(0)} KB`;
    $("#archive-users").innerHTML = users.map((u) => {
      const size = fmtSize(u.bytes);
      const when = fmtMtimeAgo(u.latest_mtime);
      const href = `/media/${encodeURIComponent(u.username)}`;
      const detail = `${u.count} item${u.count === 1 ? "" : "s"} · ${size}${when ? ` · ${when}` : ""}`;
      return `<a class="notes-user" href="${escapeAttr(href)}" target="_blank" rel="noopener" title="${escapeAttr(u.username)} · open archive page">@${escapeHtml(u.username)} <span class="muted small">${escapeHtml(detail)}</span></a>`;
    }).join("");
  } catch {
    card.hidden = true;
  }
}

// Live-refresh the archive card + notes count every 15 seconds when
// the home view is active. Updates only those two cards (not the
// whole loadHome flow), so the user's scroll position and any open
// modals are preserved. Driven by the visible/active-view check so
// we don't pointlessly poll while the user is on Lists / Imports.
// Calibration banner — top-right sticky notification that surfaces
// post-import "calibrating data..." → "✓ snapshot calibrated" so the
// user knows exactly when their imports have been fully incorporated
// into the cached views (instead of guessing whether the SWR reprewarm
// has finished). Persistent until manually dismissed; survives tab
// navigation and page reloads via localStorage of the last-shown
// completed_id (so the user only ever sees each calibration once).
const CAL_LS_LAST_ACKED = "igtracker:calibration:lastAcked";
const CAL_LS_LAST_DISPLAYED_DONE = "igtracker:calibration:lastDisplayedDone";
let _calibrationPollTimer = null;
let _calibrationLastState = null;

function _calLoadAcked() {
  try { return parseInt(localStorage.getItem(CAL_LS_LAST_ACKED) || "0", 10) || 0; }
  catch { return 0; }
}
function _calSaveAcked(id) {
  try { localStorage.setItem(CAL_LS_LAST_ACKED, String(id)); } catch {}
}

function _calRender(state) {
  const banner = document.getElementById("calibration-banner");
  if (!banner) return;
  const acked = _calLoadAcked();
  const pendingId = state?.pending_id || 0;
  const completedId = state?.completed_id || 0;
  const isPending = pendingId > completedId;
  const isUnackedDone = !isPending && completedId > 0 && completedId > acked;

  if (!isPending && !isUnackedDone) {
    banner.hidden = true;
    banner.className = "";
    banner.innerHTML = "";
    return;
  }
  banner.hidden = false;
  if (isPending) {
    banner.className = "cal-pending";
    banner.innerHTML = `
      <span class="cal-spinner" aria-hidden="true"></span>
      <span class="cal-text">Incorporating snapshot data… cached views still showing the previous snapshot until this finishes.</span>
    `;
  } else {
    const snapId = state?.snapshot_id;
    const label = snapId ? `Snapshot #${snapId} fully calibrated` : "Snapshot data fully calibrated";
    banner.className = "cal-done";
    banner.innerHTML = `
      <span aria-hidden="true">✓</span>
      <span class="cal-text">${escapeHtml(label)} — your views now reflect the latest import.</span>
      <button class="cal-close" type="button" aria-label="Dismiss" data-cal-completed="${completedId}">×</button>
    `;
    const closeBtn = banner.querySelector(".cal-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        const id = parseInt(closeBtn.dataset.calCompleted || "0", 10);
        if (id > 0) _calSaveAcked(id);
        banner.hidden = true;
        banner.className = "";
        banner.innerHTML = "";
      });
    }
  }
}

async function _calPoll() {
  try {
    const r = await fetch("/api/calibration-status");
    if (!r.ok) return;
    const state = await r.json();
    // Skip re-render if nothing meaningful changed — avoids re-binding
    // the close handler every poll while the banner is in "done" state.
    const sig = `${state.pending_id}:${state.completed_id}:${state.snapshot_id || ""}`;
    if (sig === _calibrationLastState) return;
    _calibrationLastState = sig;
    _calRender(state);
  } catch {
    /* ignore — not critical */
  }
}

function _startCalibrationPolling() {
  if (_calibrationPollTimer) return;
  // First call right away so the banner renders before the first
  // tick lands; subsequent ticks every 2.5s. 2.5s feels live without
  // hammering the endpoint — reprewarm is debounced + 10-15s long, so
  // we'll hit it ~5 times before completion.
  _calPoll();
  _calibrationPollTimer = setInterval(_calPoll, 2500);
}
_startCalibrationPolling();

let _liveRefreshTimer = null;
function _startLiveRefresh() {
  if (_liveRefreshTimer) return;
  _liveRefreshTimer = setInterval(async () => {
    if (document.hidden) return;
    if (_renderedView !== "home") return;
    try {
      // Refresh just the imports card — cheap, no scroll impact.
      // (Archive card moved to its own top-level page.)
      await loadSnapshots();
      // Also refresh the home summary's bucket counts (notes count
      // changes when you add/edit notes from the modal). Skip the
      // top-of-card spinner so the UI doesn't flash.
      const r = await fetch("/api/home");
      if (!r.ok) return;
      const data = await r.json();
      if (data.bucket_counts) {
        const bc = data.bucket_counts;
        const setIfChanged = (id, val) => {
          const el = $(`#${id}`);
          if (el && el.textContent !== String(val)) el.textContent = String(val);
        };
        setIfChanged("count-favorite", bc.favorites);
        setIfChanged("count-want_remove", bc.want_remove);
        setIfChanged("count-watchlist", bc.watchlist);
        setIfChanged("count-disabled", bc.disabled ?? 0);
        setIfChanged("count-unavailable", bc.unavailable ?? 0);
        setIfChanged("count-random_request", bc.random_request ?? 0);
        setIfChanged("count-now_public", bc.now_public ?? 0);
        const noteCard = $("#notes-card");
        const noteCount = bc.with_notes ?? 0;
        if (noteCard) noteCard.hidden = noteCount === 0;
        setIfChanged("count-with_notes", noteCount);
      }
    } catch {
      /* network blip — try again next tick */
    }
  }, 15000);
}
_startLiveRefresh();

// ---------- import ----------

const fileInput = $("#file-input");
const dropCard = $("#drop-card");

$("#pick-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) doImport(file);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropCard.addEventListener(evt, (e) => {
    e.preventDefault();
    dropCard.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropCard.addEventListener(evt, (e) => {
    e.preventDefault();
    dropCard.classList.remove("dragover");
  })
);
dropCard.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) doImport(file);
});

// Manual Drive-folder scan button. Shows up only if the server has
// IG_WATCH_FOLDER configured. Click it to import any new Meta exports
// sitting in your Drive sync folder right now — costs nothing in the
// background, but a single recursive scan of a large Drive root can
// take a minute or two on first click.
async function refreshScanButton() {
  try {
    const data = await api.get("/api/scan-status");
    const btn = $("#scan-drive-btn");
    const forceBtn = $("#scan-drive-force-btn");
    const resetBtn = $("#reset-snapshots-btn");
    const hint = $("#scan-folder-hint");
    const toggleRow = $("#auto-import-toggle-row");
    const toggleEl = $("#auto-import-toggle");
    const folderRow = $("#watch-folder-row");
    const folderInput = $("#watch-folder-input");
    if (data.watch_folder) {
      const enabled = data.auto_import_enabled !== false;
      btn.hidden = !enabled;
      if (forceBtn) forceBtn.hidden = !enabled;
      if (resetBtn) resetBtn.hidden = !enabled;
      hint.hidden = false;
      hint.textContent = enabled
        ? `Watching: ${data.watch_folder}`
        : `Watching paused — drag-drop zips below to import. (Configured folder: ${data.watch_folder})`;
      if (toggleRow) toggleRow.hidden = false;
      if (toggleEl) toggleEl.checked = enabled;
      if (folderRow) folderRow.hidden = false;
      if (folderInput && document.activeElement !== folderInput) folderInput.value = data.watch_folder;
    } else {
      btn.hidden = true;
      if (forceBtn) forceBtn.hidden = true;
      if (resetBtn) resetBtn.hidden = true;
      hint.hidden = true;
      if (toggleRow) toggleRow.hidden = true;
      if (folderRow) folderRow.hidden = false;  // keep visible so user can SET one
    }
  } catch (e) { /* server not ready, ignore */ }
}
refreshScanButton();

// Auto-import on/off toggle. Disabling stops the minute-by-minute
// extension scan from spamming the audit log AND silences the
// Drive-Desktop EDEADLK / ghost-rglob noise that comes from a
// flaky File Provider. The home page's file picker / drag-drop
// remains the manual escape hatch and is unaffected.
$("#auto-import-toggle")?.addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  try {
    await api.post("/api/watcher", { enabled });
  } catch (err) {
    toast(`Couldn't toggle auto-import: ${err.message}`);
    e.target.checked = !enabled;  // revert on failure
    return;
  }
  await refreshScanButton();
});

async function _saveWatchFolder(folder) {
  const btn = $("#watch-folder-save");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const result = await api.post("/api/watcher", { watch_folder: folder });
    if (!result.watch_folder && folder) {
      toast(`Path doesn't exist or isn't a directory: ${folder}`);
    } else {
      toast(folder ? `Watching: ${result.watch_folder}` : "Cleared override — using IG_WATCH_FOLDER env var");
    }
  } catch (err) {
    toast(`Couldn't update watch folder: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
    await refreshScanButton();
  }
}

$("#watch-folder-save")?.addEventListener("click", async () => {
  const v = ($("#watch-folder-input")?.value || "").trim();
  await _saveWatchFolder(v);
});

$("#watch-folder-downloads")?.addEventListener("click", async () => {
  // Resolve to user's actual Downloads via the server (it expands ~).
  const path = "~/Downloads";
  const input = $("#watch-folder-input");
  if (input) input.value = path;
  await _saveWatchFolder(path);
});

// Reset snapshots + auto re-import. Confirms first since this wipes
// all derived snapshot tables. Tags, notes, and archived media are
// preserved server-side. The result panel shows the same per-file
// detail view as a normal scan, so the 2 errors (or whatever's left)
// are visible inline.
async function runReset() {
  const ok = window.confirm(
    "This will wipe all snapshot data (followers / following / pending / etc.) and re-import every export from Drive.\n\n" +
    "Tags, notes, follow-up queue, and archived media are kept.\n\n" +
    "Continue?"
  );
  if (!ok) return;
  const btn = $("#reset-snapshots-btn");
  const status = $("#scan-status");
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Resetting + re-importing… (can take a few minutes)"; }
  status.innerHTML = `<div class="loading-card"><span class="spinner"></span>Wiping snapshots and re-importing every Drive export. Don't navigate away.</div>`;
  try {
    const result = await api.post("/api/reset-snapshots?rescan=true");
    const scan = result.scan || {};
    const seen = scan.already_seen ?? 0;
    const errors = (scan.details || []).filter((d) => d.outcome === "error").length;
    const wipedSummary = Object.entries(result.wiped || {})
      .map(([t, n]) => `${t}: ${n}`).join(", ");
    const deferred = scan.deferred ?? (scan.details || []).filter((d) => d.outcome === "deferred").length;
    const deferredHtml = deferred ? ` · <span class="muted">${deferred} waiting on Drive sync</span>` : "";
    const summary = `<div class="ok">✓ Reset complete · wiped {${escapeHtml(wipedSummary)}} · ${scan.imported || 0} re-imported · ${scan.skipped || 0} skipped/backfilled${errors ? ` · <span class="err">${errors} errors</span>` : ""}${deferredHtml}</div>`;
    let detailHtml = "";
    if ((scan.details || []).length > 0) {
      const items = scan.details.map((d) => {
        const cls = d.outcome === "imported" || d.outcome === "backfilled" ? "ok"
          : d.outcome === "error" ? "err" : "muted";
        const verb = d.outcome === "imported" ? `+${d.snapshot_id}`
          : d.outcome === "backfilled" ? "↺"
          : d.outcome === "duplicate" ? "↩"
          : d.outcome === "out_of_order" ? "⏪"
          : d.outcome === "error" ? "✗" : d.outcome;
        const msg = (d.message || "").trim();
        const msgHtml = msg ? ` <span class="muted small">— ${escapeHtml(msg.length > 200 ? msg.slice(0, 197) + "…" : msg)}</span>` : "";
        return `<div class="scan-item ${cls}"><span class="scan-verb">${escapeHtml(verb)}</span> <code>${escapeHtml(d.file)}</code>${msgHtml}</div>`;
      }).join("");
      detailHtml = `<details class="scan-details" open><summary class="muted small">${scan.details.length} per-file details</summary><div class="scan-detail-list">${items}</div></details>`;
    }
    status.innerHTML = summary + detailHtml;
    await loadHome();
    await loadAuditLog();
  } catch (e) {
    status.innerHTML = `<div class="err">✗ Reset failed: ${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}
$("#reset-snapshots-btn")?.addEventListener("click", runReset);

// Pull the audit log. Render newest-first as one row per entry with
// op + target + a one-line detail summary. Auto-loads when the
// "View activity log" disclosure is opened.
async function loadAuditLog() {
  const el = $("#audit-log");
  if (!el) return;
  try {
    const data = await api.get("/api/audit-log?limit=200");
    const entries = data.entries || [];
    if (entries.length === 0) {
      el.innerHTML = `<div class="muted small">No activity recorded yet. Operations like scans, imports, errors, and resets will appear here.</div>`;
      return;
    }
    el.innerHTML = entries.map((e) => {
      const cls = !e.ok ? "err" : (e.op.includes("error") ? "err" : "muted");
      const det = e.details
        ? Object.entries(e.details).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")
        : "";
      const tgt = e.target ? `<code class="audit-target">${escapeHtml(e.target.length > 80 ? "…" + e.target.slice(-77) : e.target)}</code>` : "";
      return `<div class="audit-row ${cls}">
        <span class="audit-ts muted small">${escapeHtml(e.ts)}</span>
        <span class="audit-op">${escapeHtml(e.op)}</span>
        ${tgt}
        ${det ? `<span class="audit-det muted small">${escapeHtml(det)}</span>` : ""}
      </div>`;
    }).join("");
  } catch (err) {
    el.innerHTML = `<div class="err">Couldn't load audit log: ${escapeHtml(err.message)}</div>`;
  }
}
// Lazy-load on first open of the disclosure; refresh on each open
// thereafter (cheap — capped at 200 rows).
const auditDetails = document.querySelector(".audit-details");
if (auditDetails) {
  auditDetails.addEventListener("toggle", () => {
    if (auditDetails.open) loadAuditLog();
  });
}

// Toggles a "has-overflow" / "scrolled-end" class on a scrollable list so
// the bottom-fade-mask (CSS) only shows when there's actually content
// beyond the visible area. Run after rendering the details, then on scroll.
function manageOverflowFade(el) {
  if (!el) return;
  const sync = () => {
    const overflows = el.scrollHeight > el.clientHeight + 2;
    el.classList.toggle("has-overflow", overflows);
    const atBottom = overflows && (el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    el.classList.toggle("scrolled-end", atBottom);
  };
  sync();
  el.addEventListener("scroll", sync, { passive: true });
}

async function runScan({ force }) {
  const btn = $("#scan-drive-btn");
  const forceBtn = $("#scan-drive-force-btn");
  const status = $("#scan-status");
  if (btn) btn.disabled = true;
  if (forceBtn) forceBtn.disabled = true;
  const originalLabel = btn?.textContent;
  const originalForceLabel = forceBtn?.textContent;
  if (btn) btn.textContent = force ? "Force re-scanning…" : "Scanning… (Drive listing can take a minute)";
  if (forceBtn && force) forceBtn.textContent = "Re-extracting every file…";
  status.innerHTML = `<div class="loading-card"><span class="spinner"></span>${
    force
      ? "Force re-scan in progress. Re-extracting every file regardless of fingerprint cache. This is slower but thorough — please wait."
      : "Scanning Drive folder…"
  }</div>`;
  try {
    const result = await api.post(`/api/scan${force ? "?force=true" : ""}`);
    if (!result.ok) {
      status.innerHTML = `<div class="warn-box">⚠ ${escapeHtml(result.message)}</div>`;
    } else {
      const seen = result.already_seen ?? 0;
      const newCount = result.scanned - seen;
      const errors = (result.details || []).filter((d) => d.outcome === "error").length;
      const deferred = (result.deferred ?? (result.details || []).filter((d) => d.outcome === "deferred").length);
      // Concise summary line; full per-file details collapsed under a toggle.
      const deferredHtml = deferred ? ` · <span class="muted">${deferred} waiting on Drive sync</span>` : "";
      const summary = `<div class="ok">✓ ${result.imported} imported · ${result.skipped} skipped/backfilled · ${seen} already known${errors ? ` · <span class="err">${errors} errors</span>` : ""}${deferredHtml}</div>`;
      let detailHtml = "";
      if ((result.details || []).length > 0) {
        const items = result.details.map((d) => {
          const cls = d.outcome === "imported" || d.outcome === "backfilled" ? "ok"
            : d.outcome === "error" ? "err" : "muted";
          const verb = d.outcome === "imported" ? `+${d.snapshot_id}`
            : d.outcome === "backfilled" ? "↺"
            : d.outcome === "duplicate" ? "↩"
            : d.outcome === "out_of_order" ? "⏪"
            : d.outcome === "error" ? "✗" : d.outcome;
          // Surface the error / skip reason inline (truncated). Without
          // this, errors and skip outcomes were just an icon — you had
          // to dig through the API response to see why.
          const msg = (d.message || "").trim();
          const msgHtml = msg ? ` <span class="muted small">— ${escapeHtml(msg.length > 200 ? msg.slice(0, 197) + "…" : msg)}</span>` : "";
          return `<div class="scan-item ${cls}"><span class="scan-verb">${escapeHtml(verb)}</span> <code>${escapeHtml(d.file)}</code>${msgHtml}</div>`;
        }).join("");
        detailHtml = `<details class="scan-details"><summary class="muted small">Show ${result.details.length} per-file detail${result.details.length === 1 ? "" : "s"}</summary><div class="scan-detail-list">${items}</div></details>`;
      }
      status.innerHTML = summary + detailHtml;
      // Initialise the fade-mask on first expand AND on subsequent expands
      // (re-rendering the innerHTML wipes prior listeners).
      const detailsEl = status.querySelector(".scan-details");
      const listEl = status.querySelector(".scan-detail-list");
      if (detailsEl && listEl) {
        detailsEl.addEventListener("toggle", () => {
          if (detailsEl.open) manageOverflowFade(listEl);
        });
      }
    }
    await loadHome();
  } catch (e) {
    status.innerHTML = `<div class="err">✗ ${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    if (forceBtn) { forceBtn.disabled = false; forceBtn.textContent = originalForceLabel; }
  }
}
$("#scan-drive-btn")?.addEventListener("click", () => runScan({ force: false }));
$("#scan-drive-force-btn")?.addEventListener("click", () => {
  if (!confirm("Force re-scan re-extracts every file in your Drive folder. " +
               "This can take several minutes for many snapshots. Continue?")) return;
  runScan({ force: true });
});

async function doImport(file) {
  const status = $("#import-status");
  status.innerHTML = `<span class="pending"><span class="spinner"></span>Importing ${escapeHtml(file.name)}…</span>`;
  try {
    const result = await api.upload(file);
    const skipped = (result.skipped || []);
    const imported = result.imports.length;
    const backfilledCount = skipped.filter((s) => s.reason === "backfilled").length;
    const trueSkippedCount = skipped.length - backfilledCount;
    const missingFiles = result.imports.some((r) => r.missing_files && r.missing_files.length);

    const summary = `<div class="ok">✓ ${imported} imported · ${backfilledCount} backfilled · ${trueSkippedCount} skipped${missingFiles ? ` · <span class="warn-box">some IG files missing</span>` : ""}</div>`;

    // Per-entry details, collapsed under a click-to-expand toggle.
    const items = [];
    for (const r of result.imports) {
      items.push(`<div class="scan-item ok"><span class="scan-verb">+${r.snapshot_id}</span> <code>${escapeHtml(cleanLabel(r.label))}</code> — ${r.counts.followers}F/${r.counts.following}G</div>`);
      if (r.missing_files && r.missing_files.length) {
        items.push(`<div class="scan-item muted">  ⚠ missing files: ${r.missing_files.map((f) => escapeHtml(f)).join(", ")}</div>`);
      }
    }
    for (const s of skipped) {
      const verb = s.reason === "backfilled" ? "↺" : (s.reason === "duplicate" ? "↩" : "⚠");
      const cls = s.reason === "backfilled" ? "ok" : "muted";
      items.push(`<div class="scan-item ${cls}"><span class="scan-verb">${verb}</span> <code>${escapeHtml(cleanLabel(s.label))}</code> — ${escapeHtml(s.message.slice(0, 100))}</div>`);
    }
    const detailHtml = items.length
      ? `<details class="scan-details"><summary class="muted small">Show ${items.length} per-file detail${items.length === 1 ? "" : "s"}</summary><div class="scan-detail-list">${items.join("")}</div></details>`
      : "";
    status.innerHTML = summary + detailHtml;
    const detailsEl = status.querySelector(".scan-details");
    const listEl = status.querySelector(".scan-detail-list");
    if (detailsEl && listEl) {
      detailsEl.addEventListener("toggle", () => {
        if (detailsEl.open) manageOverflowFade(listEl);
      });
    }
    _historyData = null;  // invalidate so the next History view refetches
    await loadHome();
    if (imported === 0 && skipped.length > 0) {
      if (backfilledCount > 0 && trueSkippedCount === 0) {
        toast(`Backfilled ${backfilledCount} snapshot${backfilledCount === 1 ? "" : "s"}`);
      } else {
        const r = skipped[0].reason;
        const reasonLabel = r === "duplicate"
          ? "duplicate"
          : r === "missing_files"
            ? "missing critical files (partial export)"
            : r === "placeholder_partial"
              ? "Drive sync incomplete"
              : "older than existing snapshots";
        toast(`Skipped — ${reasonLabel}`);
      }
    } else {
      const parts = [];
      if (imported) parts.push(`Imported ${imported} snapshot${imported === 1 ? "" : "s"}`);
      if (backfilledCount) parts.push(`backfilled ${backfilledCount}`);
      if (trueSkippedCount) parts.push(`${trueSkippedCount} skipped`);
      const msg = parts.join(", ") || "Done";
      toast(missingFiles ? `${msg} (some IG files missing)` : msg);
    }
  } catch (e) {
    status.innerHTML = `<div class="err">✗ ${escapeHtml(e.message)}</div>`;
  }
}

// ---------- lookup ----------

// Two flows: pure lookup (no side effects) vs add-to-queue (current behaviour).
// The user gets to decide which by which button they hit.
function bindCheckFlow({ inputId, buttonId, resultId, saveToQueue }) {
  const input = $(`#${inputId}`);
  const button = $(`#${buttonId}`);
  if (!input || !button) return;
  button.addEventListener("click", () => runCheck({ inputId, resultId, saveToQueue }));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && input.value.split(/\n/).filter((l) => l.trim()).length <= 1) {
      e.preventDefault();
      runCheck({ inputId, resultId, saveToQueue });
    }
  });
}

bindCheckFlow({ inputId: "lookup-input", buttonId: "lookup-go", resultId: "lookup-result", saveToQueue: false });

// ---------- recent lookups history ----------
//
// Every successful single-account lookup appends the canonical username
// to a localStorage list (newest first, deduped, capped at RECENT_CAP).
// Rendered as a strip of chips under the Look-up card; click a chip to
// re-run the lookup. Persists across reloads + reopened tabs because
// localStorage survives both. Per-account dedup keeps the list a true
// "recently checked" rather than a "every keystroke" log.
const RECENT_LOOKUPS_KEY = "ig-tracker:recent-lookups";
const RECENT_LOOKUPS_CAP = 30;

function _loadRecentLookups() {
  try {
    const raw = localStorage.getItem(RECENT_LOOKUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string" && u) : [];
  } catch { return []; }
}
function _saveRecentLookups(list) {
  try { localStorage.setItem(RECENT_LOOKUPS_KEY, JSON.stringify(list)); } catch {}
}
function _recordRecentLookup(username) {
  const u = String(username || "").trim();
  if (!u) return;
  const list = _loadRecentLookups();
  const idx = list.indexOf(u);
  if (idx !== -1) list.splice(idx, 1);  // dedupe — move to front
  list.unshift(u);
  if (list.length > RECENT_LOOKUPS_CAP) list.length = RECENT_LOOKUPS_CAP;
  _saveRecentLookups(list);
  _renderRecentLookups();
}
function _renderRecentLookups() {
  const wrap = $("#recent-lookups");
  if (!wrap) return;
  const list = _loadRecentLookups();
  if (!list.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
  wrap.hidden = false;
  const chips = list
    .map((u) => `<button type="button" class="recent-lookup-chip" data-username="${escapeAttr(u)}" title="Re-look up @${escapeAttr(u)}">${escapeHtml(u)}</button>`)
    .join("");
  wrap.innerHTML = `
    <div class="recent-lookups-head">
      <span class="muted small">Recent lookups (${list.length})</span>
      <button type="button" class="ghost-btn recent-lookups-clear" title="Clear lookup history">Clear</button>
    </div>
    <div class="recent-lookups-chips">${chips}</div>
  `;
  $$(".recent-lookup-chip", wrap).forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const u = btn.dataset.username;
      // Cmd/Ctrl-click → open the IG profile in a new tab; plain click
      // re-runs the lookup in place. Mirrors the modifier-click pattern
      // already used on list rows.
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        window.open(instagramUrl(u), "_blank", "noopener");
        return;
      }
      const input = $("#lookup-input");
      if (input) input.value = u;
      openAccount(u, { resultId: "lookup-result", saveToQueue: false });
    })
  );
  const clearBtn = wrap.querySelector(".recent-lookups-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all recent lookups?")) return;
    _saveRecentLookups([]);
    _renderRecentLookups();
  });
}
// First-paint render: surface anything saved from prior sessions.
_renderRecentLookups();
bindCheckFlow({ inputId: "queue-input",  buttonId: "queue-go",  resultId: "queue-result",  saveToQueue: true  });

// One-click clear: empties the textarea + result panel and refocuses the
// input. Always visible so the affordance is discoverable; just disabled
// when there's nothing to clear, so the user can still see it exists.
function bindClearButton({ inputId, clearId, resultId }) {
  const input = $(`#${inputId}`);
  const btn = $(`#${clearId}`);
  const result = $(`#${resultId}`);
  if (!input || !btn) return;
  const sync = () => {
    const hasContent = input.value || (result && result.innerHTML.trim());
    btn.disabled = !hasContent;
  };
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    input.value = "";
    if (result) result.innerHTML = "";
    sync();
    input.focus();
  });
  input.addEventListener("input", sync);
  sync();
}
bindClearButton({ inputId: "lookup-input", clearId: "lookup-clear",       resultId: "lookup-result" });
bindClearButton({ inputId: "queue-input",  clearId: "queue-input-clear",  resultId: "queue-result"  });

// Paste button: pulls clipboard text and appends to the textarea (with a
// newline separator if there's existing content). Uses the async Clipboard
// API which works on Chrome/Edge/Firefox over localhost or HTTPS, and on
// Safari (Mac + iOS 13.4+) inside a user-gesture handler. If the API is
// blocked or unavailable, falls back to focusing the input so the user
// can paste manually with Cmd+V / long-press.
function bindPasteButton({ inputId, pasteId, runAfter }) {
  const input = $(`#${inputId}`);
  const btn = $(`#${pasteId}`);
  if (!input || !btn) return;

  // iOS Safari over plain HTTP (i.e. the phone hitting the Mac's LAN IP,
  // not localhost) blocks navigator.clipboard entirely. Detect this up
  // front so the toast can explain *why* the Paste button can't directly
  // paste, instead of saying something generic.
  const insecureLocal = location.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(location.hostname);

  // Focus + place caret at end so the iOS keyboard appears with its
  // clipboard suggestion strip. The user can then one-tap the suggestion
  // OR long-press → Paste in the textarea — both faster than typing.
  const focusForManualPaste = () => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  btn.addEventListener("click", async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      focusForManualPaste();
      if (insecureLocal) {
        toast("iOS blocks clipboard reads over LAN HTTP. Tap the suggestion above the keyboard, or long-press → Paste.", 4500);
      } else {
        toast("Clipboard API unavailable here. Long-press the box → Paste.");
      }
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        focusForManualPaste();
        toast("Clipboard is empty.");
        return;
      }
      // Replace, don't append: each paste-and-action click is a fresh
      // operation. The previous textarea content + result panel are
      // cleared first so the next lookup/queue is unambiguous, not a
      // pile-up of past clipboards.
      const result = $(`#${inputId.replace("-input", "-result")}`);
      input.value = text;
      if (result) result.innerHTML = "";
      // Notify the bound clear-button (and any other listeners) that the
      // input changed, so disabled-state updates immediately.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      focusForManualPaste();
      // Auto-run the card's primary action right after paste (look up /
      // add to queue), so a single tap finishes the whole flow.
      if (typeof runAfter === "function") {
        runAfter();
      }
    } catch (e) {
      // Most common failure: Safari blocks clipboard read outside a recent
      // user gesture, or the user denied the prompt.
      focusForManualPaste();
      toast("Couldn't read clipboard — tap the keyboard's paste suggestion or long-press → Paste.", 4500);
    }
  });
}
bindPasteButton({
  inputId: "lookup-input",
  pasteId: "lookup-paste",
  runAfter: () => runCheck({ inputId: "lookup-input", resultId: "lookup-result", saveToQueue: false }),
});
bindPasteButton({
  inputId: "queue-input",
  pasteId: "queue-input-paste",
  runAfter: () => runCheck({ inputId: "queue-input", resultId: "queue-result", saveToQueue: true }),
});

async function runCheck({ inputId, resultId, saveToQueue }) {
  const text = $(`#${inputId}`).value;
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return;

  const out = $(`#${resultId}`);
  if (lines.length === 1) {
    await openAccount(lines[0], { resultId, saveToQueue });
  } else {
    try {
      const data = await api.post("/api/filter-list", { text, save_to_queue: saveToQueue });
      out.innerHTML = renderBulkResult(data);
      if (data.queue_added) {
        toast(`Added ${data.queue_added} to follow queue (${data.queue_total} total)`);
        loadQueue();
      }
      $$(".clickable-name", out).forEach((el) =>
        // Plain click → modal. Modifier-click → open IG profile in new tab.
        el.addEventListener("click", (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            window.open(instagramUrl(el.dataset.username), "_blank", "noopener");
            return;
          }
          openAccountModal(el.dataset.username);
        })
      );
      const copyBtn = out.querySelector("#copy-pruned");
      if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(data.pruned_text);
            toast("Copied to clipboard");
          } catch {
            toast("Clipboard not available");
          }
        });
      }
    } catch (e) {
      toast(`Check failed: ${e.message}`);
    }
  }
}

function renderBulkResult(data) {
  // Group by status_kind so the most actionable shows first.
  const order = ["good", "warn", "info", "muted"];
  const groupedSeen = data.seen.slice().sort((a, b) => {
    const ai = order.indexOf(a.status_kind);
    const bi = order.indexOf(b.status_kind);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.username.localeCompare(b.username);
  });

  const seenRow = (s) => `
    <div class="item bulk-row">
      <span class="clickable-name" data-username="${escapeAttr(s.username)}" title="Show history">${escapeHtml(s.username)}</span>
      <a class="ig-link" href="${escapeAttr(instagramUrl(s.username))}" target="_blank" rel="noopener" title="Open on Instagram">↗</a>
      <span class="status-pill status-${s.status_kind}">${escapeHtml(s.status)}</span>
    </div>`;

  const newRow = (n) => `
    <div class="item bulk-row">
      <a class="bulk-name-link" href="${escapeAttr(instagramUrl(n.username))}" target="_blank" rel="noopener">${escapeHtml(n.username)}</a>
      <a class="ig-link" href="${escapeAttr(instagramUrl(n.username))}" target="_blank" rel="noopener" title="Open on Instagram">↗</a>
    </div>`;

  const viewedRow = (v) => `
    <div class="item bulk-row">
      <span class="clickable-name" data-username="${escapeAttr(v.username)}" title="Show history">${escapeHtml(v.username)}</span>
      <a class="ig-link" href="${escapeAttr(instagramUrl(v.username))}" target="_blank" rel="noopener" title="Open on Instagram">↗</a>
      <span class="status-pill status-muted">👀 viewed${v.observed_at ? ` ${_fmtRelative(v.observed_at)}` : ""}</span>
    </div>`;

  const viewedList = data.viewed || [];

  return `
    <div class="result-section">
      <h3>Already seen (${data.seen.length})</h3>
      <p class="muted small">Tap name for history · arrow opens Instagram.</p>
      <div class="result-list">${
        groupedSeen.map(seenRow).join("") || "<div class=\"item muted\">(none)</div>"
      }</div>
    </div>
    <div class="result-section">
      <h3>👀 Viewed before, no interaction (${viewedList.length})</h3>
      <p class="muted small">You've opened their profile via the extension overlay before, but never followed or requested. Worth a second look before re-adding.</p>
      <div class="result-list">${
        viewedList.map(viewedRow).join("") || "<div class=\"item muted\">(none)</div>"
      }</div>
    </div>
    <div class="result-section">
      <h3>New to you (${data.new.length})</h3>
      <p class="muted small">Never followed, never requested, never viewed via the extension. Safe to follow fresh.</p>
      <div class="result-list">${
        data.new.map(newRow).join("") || "<div class=\"item muted\">(none)</div>"
      }</div>
    </div>
    ${data.invalid.length ? `<div class="result-section"><h3>Couldn't parse (${data.invalid.length})</h3><div class="result-list">${data.invalid.map((i) => `<div class="item">${escapeHtml(i.input)} — ${escapeHtml(i.error)}</div>`).join("")}</div></div>` : ""}
    ${data.new.length ? `<button class="primary" id="copy-pruned">Copy new-only list to clipboard</button>` : ""}
  `;
}

// Format an ISO timestamp as "5h ago" / "3 days ago" for compact
// display next to the viewed-before pill. Returns "" if the
// timestamp is unparseable.
function _fmtRelative(isoStr) {
  if (!isoStr) return "";
  try {
    const t = new Date(isoStr).getTime();
    if (!t) return "";
    const ms = Date.now() - t;
    if (ms < 0) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
  } catch { return ""; }
}

async function openAccount(account, { resultId = "lookup-result", saveToQueue = false } = {}) {
  try {
    const data = await api.get(`/api/lookup?account=${encodeURIComponent(account)}`);
    const result = $(`#${resultId}`);
    result.innerHTML = renderLookup(data);
    loadArchivedMediaForModal(data.username);
    loadAccountNote(data.username);
    bindTagToggles(result, data.username, data.tags);
    // Record on every successful lookup so the user can scroll back
    // through accounts they've checked. Uses the resolved canonical
    // username (data.username) rather than the raw input — handles
    // pasted profile URLs, alias chains, and raw @-handles uniformly.
    if (data.username) _recordRecentLookup(data.username);

    if (saveToQueue && data.found === false) {
      try {
        const r = await api.post("/api/followup/add", {
          username: data.username,
          profile_url: data.profile_url,
          input: account,
        });
        if (r.added) {
          toast(`Added ${data.username} to follow queue (${r.total} total)`);
          loadQueue();
        }
      } catch (e) {
        console.warn("Couldn't add to queue:", e);
      }
    }
  } catch (e) {
    toast(`Lookup failed: ${e.message}`);
  }
}

function renderLookup(data) {
  const url = instagramUrl(data.username);
  if (!data.found) {
    // Even when the account isn't in any snapshot, the user may have
    // saved a note for them OR archived media — show the full notes
    // block + the archived-media block so those pieces don't silently
    // disappear off the modal. The async loaders below this render
    // populate them.
    return `
      <div class="account-detail">
        <h3>${escapeHtml(data.username)}</h3>
        <div class="url"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
        <p class="muted">Never seen in any snapshot.</p>
        ${renderTagToggles(data.tags)}
        <div class="archived-media-block" data-username="${escapeAttr(data.username)}"></div>
        <div class="account-note-block" data-username="${escapeAttr(data.username)}">
          <h4 class="account-note-h">📝 Notes</h4>
          <textarea class="account-note-input" data-username="${escapeAttr(data.username)}" placeholder="VSCO link, where you met, why you tagged them, etc."></textarea>
          <div class="account-note-actions">
            <button class="account-note-save" data-action="save-note" data-username="${escapeAttr(data.username)}">Save</button>
            <span class="account-note-status" data-username="${escapeAttr(data.username)}"></span>
          </div>
        </div>
      </div>
    `;
  }
  // Live profile facts captured by the browser extension when the user
  // last visited this account on instagram.com. Optional — empty if the
  // extension hasn't observed this profile yet.
  const obs = data.observation;
  const obsBlock = obs ? `
    <div class="obs-block">
      <div class="obs-head">
        <span class="obs-label">Live page facts</span>
        <span class="muted small">observed ${escapeHtml(fmtDate(obs.observed_at?.slice(0, 10)) || "")}</span>
      </div>
      ${obs.display_name ? `<div class="obs-name">${escapeHtml(obs.display_name)}${obs.verified ? ' <span class="obs-check">✓</span>' : ""}</div>` : (obs.verified ? `<div class="obs-name"><span class="obs-check">✓ verified</span></div>` : "")}
      ${(obs.post_count != null || obs.follower_count != null || obs.following_count != null) ? `<div class="obs-counts">${[
        obs.post_count != null ? `<strong>${obs.post_count.toLocaleString()}</strong> posts` : "",
        obs.follower_count != null ? `<strong>${obs.follower_count.toLocaleString()}</strong> followers` : "",
        obs.following_count != null ? `<strong>${obs.following_count.toLocaleString()}</strong> following` : "",
      ].filter(Boolean).join(" · ")}</div>` : ""}
      ${obs.bio ? `<div class="obs-bio">${escapeHtml(obs.bio)}</div>` : ""}
      ${obs.external_link ? `<div class="obs-link"><a href="${escapeAttr(obs.external_link)}" target="_blank" rel="noopener">${escapeHtml(obs.external_link)}</a></div>` : ""}
      ${obs.is_private === true ? `<div class="obs-private">🔒 private</div>` : ""}
      ${(() => {
        const s = obs.follow_button_state;
        if (!s) return "";
        const labels = {
          requested:               "🔵 you sent a follow request (button: Requested)",
          following:               "🟢 you currently follow them (button: Following)",
          not_following:           "⚪ you don't follow them yet (button: Follow)",
          follow_back_available:   "🟡 they follow you, you don't yet (button: Follow back)",
        };
        const label = labels[s] || `button: ${s}`;
        const when = obs.follow_state_changed_at
          ? ` · changed ${escapeHtml(fmtDate(obs.follow_state_changed_at.slice(0, 10)) || "")}`
          : "";
        return `<div class="obs-button-state">${label}${when}</div>`;
      })()}
    </div>
  ` : "";

  // Prefer the locally-stored profile pic. Falls back to the IG CDN URL
  // if no local copy exists (404 on the local endpoint will hit onerror).
  const localPicUrl = `/api/profile-pic/${encodeURIComponent(data.username)}`;
  const cdnPicUrl = data.observation?.profile_pic_url || "";
  const picBlock = cdnPicUrl
    ? `<a class="account-pic-link" href="${escapeAttr(localPicUrl)}" target="_blank" rel="noopener" title="Click to open full-size"><img class="account-pic" src="${escapeAttr(localPicUrl)}" onerror="this.onerror=null;this.src='${escapeAttr(cdnPicUrl)}';this.parentElement.href='${escapeAttr(cdnPicUrl)}';" alt="${escapeAttr(data.username)} profile picture" /></a>`
    : `<a class="account-pic-link" href="${escapeAttr(localPicUrl)}" target="_blank" rel="noopener" title="Click to open full-size (if available)"><img class="account-pic" src="${escapeAttr(localPicUrl)}" onerror="this.style.display='none'" alt="" /></a>`;
  return `
    <div class="account-detail">
      ${picBlock}
      <h3>${escapeHtml(data.username)}</h3>
      <div class="url"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
      ${renderTagToggles(data.tags)}
      ${obsBlock}
      ${data.aliases && data.aliases.length > 1 ? `<div class="warn-banner info-banner">↪ This account has been renamed. Aliases (oldest → newest): ${data.aliases.map((a) => a === data.username ? `<strong>${escapeHtml(a)}</strong>` : `<a href="#" class="alias-link" data-username="${escapeAttr(a)}">${escapeHtml(a)}</a>`).join(" → ")}</div>` : ""}
      <div class="journey-block" data-username="${escapeAttr(data.username)}" data-aliases="${escapeAttr((data.aliases || []).join(","))}"></div>
      ${data.follow_runs_count > 1 ? `<div class="warn-banner">⚠ You've followed this person <strong>${data.follow_runs_count} separate times</strong> across history.</div>` : ""}
      ${data.follower_runs_count > 1 ? `<div class="warn-banner">⚠ They've followed you <strong>${data.follower_runs_count} separate times</strong> across history.</div>` : ""}
      <div class="facts">
        ${(() => {
          const confirmed = data.observation?.is_private === true;
          // Privacy rule:
          //  now_public tagged → "🌐 public (you confirmed)" — user verified
          //  banner / pending  → "🔒 private" (100% certain)
          //  ever-pending      → "🔒 private" (un-hedged; flip handled by tag)
          //  likely_public     → "🌐 likely public" (always hedged)
          if (data.tags?.now_public) return `<div class="row"><span class="key">Privacy</span><span>🌐 public (you confirmed)</span></div>`;
          if (confirmed) return `<div class="row"><span class="key">Privacy</span><span>🔒 private</span></div>`;
          if (data.privacy === "likely_private") return `<div class="row"><span class="key">Privacy</span><span>🔒 private</span></div>`;
          if (data.privacy === "likely_public") return `<div class="row"><span class="key">Privacy</span><span>🌐 likely public</span></div>`;
          return "";
        })()}
        <div class="row"><span class="key">Ever followed</span><span>${data.ever_followed ? `yes (${data.follow_runs_count}× run${data.follow_runs_count === 1 ? "" : "s"})` : "no"}</span></div>
        <div class="row"><span class="key">Ever requested</span><span>${data.ever_requested ? "yes" : "no"}</span></div>
        <div class="row"><span class="key">Ever followed you</span><span>${data.ever_was_follower ? `yes (${data.follower_runs_count}× run${data.follower_runs_count === 1 ? "" : "s"})` : "no"}</span></div>
        ${data.first_followed_snapshot ? `<div class="row"><span class="key">First in following</span><span>#${data.first_followed_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.first_followed_snapshot.label))}</span></div>` : ""}
        ${data.last_followed_snapshot ? `<div class="row"><span class="key">Last in following</span><span>#${data.last_followed_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.last_followed_snapshot.label))}</span></div>` : ""}
        ${data.first_requested_snapshot ? `<div class="row"><span class="key">First requested</span><span>#${data.first_requested_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.first_requested_snapshot.label))}</span></div>` : ""}
        ${data.last_requested_snapshot ? `<div class="row"><span class="key">Last requested</span><span>#${data.last_requested_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.last_requested_snapshot.label))}</span></div>` : ""}
      </div>
      <div class="archived-media-block" data-username="${escapeAttr(data.username)}"></div>
      <div class="account-note-block" data-username="${escapeAttr(data.username)}">
        <h4 class="account-note-h">📝 Notes</h4>
        <textarea class="account-note-input" data-username="${escapeAttr(data.username)}" placeholder="VSCO link, where you met, why you tagged them, etc."></textarea>
        <div class="account-note-actions">
          <button class="account-note-save" data-action="save-note" data-username="${escapeAttr(data.username)}">Save</button>
          <span class="account-note-status" data-username="${escapeAttr(data.username)}"></span>
        </div>
      </div>
      <button class="primary" data-action="show-history" data-username="${escapeAttr(data.username)}">Show full history</button>
    </div>
  `;
}

// Async loader for the archived-media gallery in the account modal.
// Delegates to the shared ArchiveGallery module (archive-gallery.js)
// which handles rendering, hierarchical select-all, and delete. The
// same module powers the standalone /media/<username> full-page view.
async function loadArchivedMediaForModal(username) {
  const block = document.querySelector(`.archived-media-block[data-username="${cssEscape(username)}"]`);
  if (!block) return;
  if (window.ArchiveGallery) window.ArchiveGallery.mount(block, username);
}

function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// Per-account follow journey: finds every activity-log event for the
// account (including its prior aliases if it was renamed) and renders a
// compact chronological strip in the modal. Sources from `_activityData`
// when it's already loaded; lazy-loads /api/activity-log otherwise so
// modals opened from the home/lists tabs don't fail. Cached SWR — the
// first call is the only slow one.
async function renderJourneyForModal(username, aliases) {
  const block = document.querySelector(
    `.journey-block[data-username="${cssEscape(username)}"]`
  );
  if (!block) return;
  // Match any of the alias chain — events emitted under prior usernames
  // belong to the same person and should appear in the same journey.
  const names = new Set([username, ...(aliases || [])]);
  let events = _activityData;
  if (!events) {
    try {
      const data = await api.get("/api/activity-log");
      _activityData = data.events || [];
      events = _activityData;
    } catch {
      return;
    }
  }
  // Sanity: if the modal closed or moved on while we were loading,
  // bail rather than render into a stale node.
  if (!block.isConnected) return;
  const mine = events.filter((e) => names.has(e.username));
  if (!mine.length) return;
  const cap = 30;
  const shown = mine.slice(0, cap);
  const rows = shown.map((e) => {
    const meta = ACTIVITY_KIND_META[e.kind] || { label: e.kind, cls: "muted" };
    const detail = activityTimeDetail(e);
    const t = detail || (e.timestamp || "").slice(0, 16).replace("T", " ");
    return `
      <div class="journey-step">
        <span class="al-kind-pill al-${meta.cls}">${escapeHtml(meta.label)}</span>
        <span class="muted small">${escapeHtml(t)}</span>
      </div>
    `;
  }).join("");
  const more = mine.length > cap
    ? `<div class="muted small journey-more">+${mine.length - cap} earlier events — see Activity log</div>`
    : "";
  block.innerHTML = `
    <h4 class="journey-h">📜 Journey (${mine.length} event${mine.length === 1 ? "" : "s"})</h4>
    <div class="journey-list">${rows}${more}</div>
  `;
}

// Free-form per-account note. Loaded async after the modal renders so
// we don't block paint while we hit the DB. Empty notes leave the
// textarea blank but the block still shows so the user can add one.
async function loadAccountNote(username) {
  const ta = document.querySelector(`.account-note-input[data-username="${cssEscape(username)}"]`);
  if (!ta) return;
  try {
    const r = await fetch(`/api/note/${encodeURIComponent(username)}`);
    if (!r.ok) return;
    const data = await r.json();
    ta.value = data.note || "";
  } catch {
    /* leave blank — note is non-critical */
  }
}

// Delete + bulk-select handlers for the archived-media gallery live
// in archive-gallery.js so they're shared between the modal and the
// standalone /media/<username> page.

// One delegated handler at document level so both openAccount and
// openAccountModal paths get save behavior without manual binding.
// renderLookup may also be re-run on tag toggles, which would discard
// any direct addEventListener — delegation is the only pattern that
// survives that.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest('button[data-action="save-note"]');
  if (!btn) return;
  const username = btn.dataset.username;
  if (!username) return;
  const ta = document.querySelector(
    `.account-note-input[data-username="${cssEscape(username)}"]`
  );
  const status = document.querySelector(
    `.account-note-status[data-username="${cssEscape(username)}"]`
  );
  if (!ta) return;
  btn.disabled = true;
  if (status) status.textContent = "Saving…";
  try {
    const r = await fetch("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, note: ta.value }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (status) {
      status.textContent = "Saved ✓";
      setTimeout(() => { if (status) status.textContent = ""; }, 1500);
    }
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderTagToggles(tags) {
  return `
    <div class="tag-toggles">
      <button class="tag-toggle ${tags.favorite ? "active" : ""}" data-flag="favorite">★ Favorite</button>
      <button class="tag-toggle ${tags.star ? "active" : ""}" data-flag="star">⭐ Star</button>
      <button class="tag-toggle ${tags.want_remove ? "active" : ""}" data-flag="want_remove">✦ Want-remove</button>
      <button class="tag-toggle ${tags.watchlist ? "active" : ""}" data-flag="watchlist">↺ Wait-back</button>
      <button class="tag-toggle ${tags.to_follow ? "active" : ""}" data-flag="to_follow">👤 To follow</button>
      <button class="tag-toggle ${tags.disabled ? "active" : ""}" data-flag="disabled">⚠ Disabled</button>
      <button class="tag-toggle ${tags.unavailable ? "active" : ""}" data-flag="unavailable">✕ Unavailable</button>
      <button class="tag-toggle ${tags.random_request ? "active" : ""}" data-flag="random_request">🎲 Random request</button>
      <button class="tag-toggle ${tags.now_public ? "active" : ""}" data-flag="now_public">🌐 Now public</button>
    </div>
  `;
}

let modalTaggedDirty = false;
function bindTagToggles(root, username, currentTags) {
  $$(".tag-toggle", root).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const flag = btn.dataset.flag;
      const willBe = !btn.classList.contains("active");
      try {
        const result = await api.post("/api/tags", { account: username, flag, value: willBe });
        btn.classList.toggle("active", result[flag]);
        toast(`${flag} ${result[flag] ? "added" : "removed"}`);
        modalTaggedDirty = true;
        // Don't reload home synchronously — bucket counts on the home tab
        // aren't visible from inside the modal, and reloading mid-toggle
        // adds a noticeable delay. closeModal handles the refresh on exit.
      } catch (e) {
        toast(`Failed: ${e.message}`);
      }
    });
  });
  const histBtn = root.querySelector('[data-action="show-history"]');
  if (histBtn) histBtn.addEventListener("click", () => showHistory(histBtn.dataset.username));

  // Click on any past alias in the rename banner to navigate to that account.
  $$(".alias-link", root).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAccountModal(el.dataset.username);
    })
  );
}

// ---------- account modal (used from list/alert clicks) ----------

const modal = $("#account-modal");
function closeModal() {
  // If a history entry was pushed when the modal opened, calling
  // history.back() lets the popstate handler hide the modal and decide
  // whether a data refresh is warranted. Otherwise just hide directly.
  if (history.state?.modal) {
    history.back();
    return;  // popstate handler will run; don't double-handle here
  }
  modal.hidden = true;
  if (modalTaggedDirty) {
    modalTaggedDirty = false;
    const view = history.state?.view || "lists";
    if (view === "lists") loadLists();
    else if (view === "home") loadHome();
  }
}
$$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

// Track which view + list-kind is currently rendered, so popstate can
// distinguish "user closed a modal back to the same list" from "user
// actually navigated to a different view." Updated by showView() and
// loadLists() at the end of each render.
let _renderedView = "home";
let _renderedListKind = null;

// Browser back/forward integration.
window.addEventListener("popstate", (e) => {
  const state = e.state || {};
  const goingToView = state.view || "home";
  const goingToListKind = state.listKind || null;
  console.debug("[IGT] popstate", {
    state, goingToView, goingToListKind,
    modalHidden: modal.hidden,
    rendered: { view: _renderedView, listKind: _renderedListKind },
    dirty: modalTaggedDirty,
  });

  // Case 1: popping out of a modal back to the same view+list.
  // Just hide the modal — DO NOT re-render the underlying view, since
  // re-rendering destroys scroll position and shows a loading spinner
  // for no benefit. This is the main fix for "page reloads when I
  // close a modal." Only refresh when a tag was actually changed
  // inside the modal (modalTaggedDirty).
  if (!modal.hidden && !state.modal
      && goingToView === _renderedView
      && goingToListKind === _renderedListKind) {
    modal.hidden = true;
    if (modalTaggedDirty) {
      modalTaggedDirty = false;
      if (goingToView === "lists") loadLists();
      else if (goingToView === "home") loadHome();
    }
    console.debug("[IGT] popstate → modal-only close, no reload");
    return;
  }
  console.debug("[IGT] popstate → falling through to view re-render");

  // Case 2: popping forward into a modal that was closed earlier.
  if (modal.hidden && state.modal) {
    openAccountModal(state.modal, false);
    return;
  }

  // Case 3: any actual view / list change — re-render appropriately.
  // Arm scroll-restore for the destination route so back/forward
  // returns the user to where they were on that route.
  _markScrollRestorePending();
  if (!modal.hidden && !state.modal) modal.hidden = true;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === goingToView));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === goingToView));
  if (goingToView === "lists") {
    if (goingToListKind && [...select.options].some((o) => o.value === goingToListKind)) {
      select.value = goingToListKind;
    }
    loadLists();
  } else if (goingToView === "check") loadQueue();
  else if (goingToView === "activity") loadActivityLog();
  else if (goingToView === "history") loadHistory();
  else if (goingToView === "home" || goingToView === "snapshots") loadHome();
  modalTaggedDirty = false;
});

// Bootstrap initial state from URL hash. NOTE: must run AFTER all the
// `const select = ...` etc. declarations later in this file have been
// initialized — `goToList` references `select`, which is in the
// temporal dead zone if we run the bootstrap inline here. Called from
// the boot section at the bottom of the file.
// Returns the view name we resolved to ("home" / "lists" / etc.) so the
// caller can skip loadHome() when we landed somewhere else. Without this
// return, page reload + Cmd+Shift+T (reopen closed tab) used to bounce
// the user back to Home: history.state was restored by the browser,
// the if-no-state branch was skipped, and the default DOM .active
// class on the home view stuck — so even though state said "lists",
// nothing in the DOM updated.
function bootstrapHistory() {
  _markScrollRestorePending();
  // Reload / restore-tab case: history.state survives across reloads,
  // so honor it. Drives showView so the DOM reflects what state says.
  if (history.state && history.state.view) {
    const view = history.state.view;
    const kind = history.state.listKind;
    if (view === "lists" && kind) {
      goToList(kind, false);
      return view;
    }
    showView(view, false);
    return view;
  }
  // Fresh tab / no state — fall back to the URL hash.
  const hash = location.hash.slice(1);
  if (hash) {
    const [view, kind] = hash.split("/");
    if (view) {
      if (view === "lists" && kind) {
        history.replaceState({ view: "lists", listKind: kind }, "", `#lists/${kind}`);
        // Use goToList — it handles dropdown population via
        // buildListKindOptions() when the option isn't there yet,
        // sets the right sort default per bucket-vs-non-bucket
        // kind, and calls loadLists. The previous inline path
        // skipped buildListKindOptions, so on a fresh tab the
        // select had no options → select.value never got set →
        // loadLists ran with no kind → "Loading list…" forever.
        goToList(kind, false);
        return view;
      }
      history.replaceState({ view }, "", `#${view}`);
      showView(view, false);
      return view;
    }
  }
  history.replaceState({ view: "home" }, "", "");
  return "home";
}

async function openAccountModal(username, push = true) {
  // Open the modal immediately with a spinner — feedback that the click
  // registered. The first lookup is sometimes uncached (1+ seconds for
  // accounts with many snapshots) so a blank modal would feel broken.
  $("#account-detail").innerHTML =
    `<div class="loading-card"><span class="spinner"></span>Loading ${escapeHtml(username)}…</div>`;
  modal.hidden = false;
  if (push) {
    history.pushState({ modal: username, view: history.state?.view, listKind: history.state?.listKind }, "", "");
  }
  try {
    const data = await api.get(`/api/lookup?account=${encodeURIComponent(username)}`);
    $("#account-detail").innerHTML = renderLookup(data);
    bindTagToggles($("#account-detail"), data.username, data.tags);
    loadArchivedMediaForModal(data.username);
    loadAccountNote(data.username);
    renderJourneyForModal(data.username, data.aliases || []);
  } catch (e) {
    $("#account-detail").innerHTML =
      `<div class="warn-banner">Couldn't load ${escapeHtml(username)}: ${escapeHtml(e.message)}</div>`;
  }
}

async function showHistory(username) {
  try {
    const data = await api.get(`/api/history?username=${encodeURIComponent(username)}`);
    const detail = $("#account-detail");
    const existing = detail.innerHTML;
    detail.innerHTML = existing + `
      <div class="history-list">
        <h3>History</h3>
        ${data.history
          .map(
            (h) => `<div class="row"><span>#${h.snapshot_id} ${escapeHtml(cleanLabel(h.label))}</span><span class="statuses">${escapeHtml(h.statuses.join(", "))}</span></div>`
          )
          .join("")}
      </div>
    `;
  } catch (e) {
    toast(`History failed: ${e.message}`);
  }
}

// ---------- lists ----------

// Per-list description shown above the search bar when a list is open.
// Keep each one short — one or two sentences max — so it explains the
// definition without becoming a wall of text.
const LIST_DESCRIPTIONS = {
  everyone:                     "Every account that has appeared in any of your IG export tables across all imported snapshots — followers, following, pending, recently_unfollowed, or incoming follow requests. The widest possible 'have I ever interacted with this account?' set.",
  all_followers:                "Accounts currently following you, per the latest snapshot. Excludes accounts you've tagged disabled / unavailable / random_request.",
  all_following:                "Accounts you currently follow, per the latest snapshot, plus extension-confirmed follows that haven't been ingested into a snapshot yet.",
  mutuals:                      "Accounts that follow you AND that you follow.",
  public_mutuals:               "Mutuals whose privacy is public — either inferred 'likely public' from snapshot history or manually flipped via the now_public tag. Use this list to spot the public accounts that have followed you back (no request gate). New entries also fire a 🌐 follow-back alert.",
  they_followed_first:          "Mutuals where THEY followed YOU first — IG's per-row export_timestamp on their follow of you predates your follow of them. Useful for spotting who's been actively engaging vs. who you initiated. Skips users with missing timestamps on either side (older imports may lack the data).",
  you_followed_first:           "Mutuals where YOU followed THEM first — your follow timestamp predates theirs. The complement of 'they followed first'. Skips users with missing timestamps.",
  not_following_you_back:       "Accounts you follow but who don't follow you back. Excludes accounts who've sent you an incoming request you haven't acted on (those are 'requesting to follow back', not 'doesn't follow back').",
  feeder_accounts:              "Accounts that follow you but you don't follow them. The opposite side of 'Don't follow you back'.",
  pending:                      "Outbound follow requests you've sent that haven't been accepted yet, including extension-confirmed pending requests not yet visible in the IG export.",
  incoming_requests:            "Inbound follow requests you haven't approved or rejected yet. Pulled directly from the latest IG export.",
  renamed:                      "Accounts whose username changed across snapshots. Detected by sharing the same IG follow timestamp across non-overlapping snapshot ranges (IG preserves the timestamp through renames).",
  ever_unfollowed_you:          "Broad event log: every account that has ever stopped following you, regardless of who initiated, whether you reciprocated, or any tags. Includes pure inbound unfollows + both halves of every mutual break, including spam-tagged accounts. The noise-filtered, opinionated version is 🐀 Rats below. Accounts that re-followed later still appear here — check the 'current relation' label on each row.",
  rats:                         "🐀 The opinionated 'people who unfollowed me first' list. Includes pure inbound unfollows AND mutual breaks where THEY unfollowed first (you may or may not have unfollowed back later). Excludes mutual breaks where you initiated, accounts tagged 🎲 random_request, and accounts tagged ✕ unavailable (page-not-found — you can't act on them anymore). Doesn't filter on whether you currently follow them or not — the historical event is the point.",
  mutual_break_you_first:       "Mutual unfollows where you initiated: your unfollow timestamp is strictly before the last snapshot they appeared as a follower. They were still following you at the moment you unfollowed; they likely unfollowed back later.",
  mutual_break_they_first:      "Mutual unfollows where they likely initiated, OR the events fell within the same snapshot window and we can't distinguish precisely. Catch-all for everything that isn't clearly 'you-first'.",
  ever_removed_you_as_follower: "Accounts that left your following list without you actively unfollowing them. Most often: account blocked you, deactivated, or was made unreachable.",
  you_unfollowed_ever:          "Every account you've ever unfollowed across all snapshots. Pulled from IG's recently_unfollowed log (which retains a few weeks per export, so this accumulates as snapshots are ingested).",
  still_follow_after_drop:      "Accounts who unfollowed you (or were ever in 'Ever unfollowed you') that you still currently follow. Useful for spotting one-sided relationships you might want to clean up.",
  ever_incoming_requests:       "Every account ever observed in your incoming-requests AND every account that has ever appeared in your followers (each follow implies a request happened — IG only retains the request log a few weeks but the resulting follow is permanent).",
  real_requests:                "Cumulative incoming requests, with random_request-tagged accounts excluded. The 'genuinely worth triaging' subset.",
  incoming_request_dropped:     "Accounts that requested to follow you but the request disappeared without becoming a follow. Either they withdrew their request, or you rejected/ignored it. From the snapshot data alone we can't tell which — both look the same.",
  ever_requested_outgoing:      "Every account you've ever sent a follow request to (pending) plus every account you've ever followed (each follow implied a request).",
  request_dropped:              "Your outbound follow requests that never made it into your following list — they declined, expired, or you cancelled. From snapshot data alone we can't tell which.",
  favorite:                     "Accounts you've manually starred. Manual labels — the tag persists across snapshots.",
  want_remove:                  "Accounts you've manually flagged for unfollowing later. Manual labels.",
  watchlist:                    "Accounts you're waiting on for a follow-back. Each row shows one of: 'request pending' (you sent a follow request, they haven't accepted), 'no follow back yet' (they accepted or it's public, but haven't followed you back), 'now follows back ✓' (mutual), or 'you've unfollowed' (you withdrew). Alerts fire after 7 days of waiting; favorites get higher priority.",
  to_follow:                    "👤 Accounts you've bookmarked to follow later. Use this for profiles you want to revisit before sending a request — e.g. private accounts you want to wait to follow strategically, or new finds you want to confirm before requesting. Auto-marks 'now following ✓' or 'request sent ✓' when the bookmark is fulfilled, so the list trims itself as you act on it.",
  star:                         "⭐ Stars — models, celebrities, creators, public figures. Distinct from ★ Favorite (which is for everyday people you actually know). Lets you bucket the two populations separately so 'favorite unfollowed you' alerts and similar don't conflate someone you met with a creator you fan-follow.",
  disabled:                     "Accounts you've manually marked as gone (deactivated, deleted, blocked you). Auto-clears if they reappear in your followers (proof of life). Excluded from non-bucket lists.",
  unavailable:                  "Accounts where the extension landed on Instagram's 'Sorry, this page isn't available' state. Auto-clears if they reappear in your followers. Excluded from non-bucket lists.",
  random_request:               "Manual flag for incoming requests that look like spam / bots / random users. Excluded from 'real_requests' and other non-bucket lists.",
  now_public:                   "Accounts you've personally verified flipped from private to public. The historical pending evidence in your DB still says 'likely private', but you've checked their profile and confirmed they're now public. This tag overrides the privacy display to '🌐 public (you confirmed)' for those accounts. Use it for the rare flip case the inference can't detect on its own.",
  with_notes:                   "Every account you've saved a note on (VSCO link, where you met, why you tagged them, etc.). Sourced directly from profile_tags.notes — does NOT require the account to currently follow you or be in your following list, so notes for accounts you've unfollowed (or who unfollowed you) stay discoverable. Disabled / unavailable / random_request tags don't filter this list either.",
};

const LIST_KINDS = [
  ["everyone", "Everyone you've ever interacted with"],
  ["all_followers", "All followers"],
  ["all_following", "All following"],
  ["mutuals", "Mutuals"],
  ["public_mutuals", "🌐 Public mutuals (followed back)"],
  ["they_followed_first", "🪄 They followed you first"],
  ["you_followed_first", "🪄 You followed them first"],
  ["private_accepted_no_follow_back", "🔒 Private accepted, no follow-back"],
  ["not_following_you_back", "Don't follow you back"],
  ["feeder_accounts", "Feeder accounts (follow you, you don't)"],
  ["pending", "Pending requests you sent"],
  ["incoming_requests", "Requests to follow you"],
  ["ever_incoming_requests", "Ever requested to follow you"],
  ["real_requests", "✓ Real requests (excl. random)"],
  ["incoming_request_dropped", "Removed their follow request"],
  ["ever_requested_outgoing", "Ever requested to follow"],
  ["request_dropped", "My follow request rejected"],
  ["ever_unfollowed_you", "Ever unfollowed you"],
  ["rats", "🐀 Rats"],
  ["mutual_break_you_first", "Mutual · you unfollowed first"],
  ["mutual_break_they_first", "Mutual · they unfollowed first"],
  ["ever_removed_you_as_follower", "Ever removed you as a follower"],
  ["you_unfollowed_ever", "You ever unfollowed"],
  ["still_follow_after_drop", "You still follow people who unfollowed you"],
  ["renamed", "Renamed accounts"],
  ["favorite", "★ Favorites"],
  ["star", "⭐ Stars (creators/celebs)"],
  ["want_remove", "✦ Want to remove"],
  ["watchlist", "↺ Wait-back"],
  ["to_follow", "👤 To follow"],
  ["disabled", "⚠ Disabled"],
  ["unavailable", "✕ Unavailable (page not found)"],
  ["random_request", "🎲 Random requests"],
  ["now_public", "🌐 Was private, now public"],
  ["with_notes", "📝 Has notes"],
];

const select = $("#list-kind");
function buildListKindOptions() {
  select.innerHTML = "";
  LIST_KINDS.forEach(([k, label]) => {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = label;
    select.appendChild(o);
  });
  buildListKindPills();
}

// Visible list picker. Group the 19+ kinds so the user can scan them
// fast instead of opening a long dropdown. Each pill gets a count
// once loadLists has data.
const LIST_GROUPS = [
  { label: "Current",  kinds: ["everyone", "all_followers", "all_following", "mutuals", "public_mutuals", "they_followed_first", "you_followed_first", "private_accepted_no_follow_back", "not_following_you_back", "feeder_accounts", "pending", "incoming_requests", "renamed"] },
  { label: "History",  kinds: ["ever_unfollowed_you", "rats", "mutual_break_you_first", "mutual_break_they_first", "ever_removed_you_as_follower", "you_unfollowed_ever", "still_follow_after_drop"] },
  { label: "Requests", kinds: ["ever_incoming_requests", "real_requests", "incoming_request_dropped", "ever_requested_outgoing", "request_dropped"] },
  { label: "Tags",     kinds: ["favorite", "star", "want_remove", "watchlist", "to_follow", "disabled", "unavailable", "random_request", "now_public"] },
];

// Cross-list intersection: cmd/ctrl+click (or long-press on touch) a pill
// to add it to the active set. The list view then shows accounts present
// in ALL selected lists. Plain click resets to single-list mode.
const _intersectKinds = new Set();

function buildListKindPills() {
  const wrap = $("#list-pills");
  if (!wrap) return;
  const labelOf = (k) => {
    const ent = LIST_KINDS.find(([key]) => key === k);
    return ent ? ent[1] : k;
  };
  // Strip leading icon from "★ Favorites" etc. for a cleaner pill — the
  // group already says "Tags" — and short-trim long labels.
  const display = (l) => {
    const stripped = l.replace(/^[★✦↺⚠✕]\s*/, "");
    return stripped;
  };
  const html = LIST_GROUPS.map((g) => {
    const pills = g.kinds
      .filter((k) => LIST_KINDS.some(([key]) => key === k))
      .map((k) => `<button type="button" class="kind-pill" data-kind="${k}">
        <span class="kind-name">${escapeHtml(display(labelOf(k)))}</span>
        <span class="kind-count" data-pill-count="${k}"></span>
      </button>`).join("");
    return `<div class="kind-group">
      <div class="kind-group-label">${escapeHtml(g.label)}</div>
      <div class="kind-group-pills">${pills}</div>
    </div>`;
  }).join("");
  wrap.innerHTML = html;
  $$(".kind-pill", wrap).forEach((btn) => {
    let touchTimer = null;

    const togglePillInIntersection = (k) => {
      if (k === select.value) {
        // Combining with itself is meaningless; do nothing.
        return;
      }
      if (_intersectKinds.has(k)) _intersectKinds.delete(k);
      else _intersectKinds.add(k);
      refreshActivePill();
      loadLists();
    };

    btn.addEventListener("click", (e) => {
      const k = btn.dataset.kind;
      // Cmd/Ctrl+click → add/remove from intersection set (don't change primary).
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        togglePillInIntersection(k);
        return;
      }
      // Plain click → reset to single-list mode for this kind.
      _intersectKinds.clear();
      if (select.value === k) {
        // Already primary AND no intersection — nothing changed visually.
        refreshActivePill();
        return;
      }
      select.value = k;
      // Programmatic value sets don't fire 'change' — dispatch manually
      // so the existing wiring (search reset, select-mode exit, loadLists)
      // runs the same way it would for a dropdown change.
      select.dispatchEvent(new Event("change"));
    });

    // Long-press on touch (~280ms) is the mobile equivalent of cmd-click.
    btn.addEventListener("touchstart", (e) => {
      const k = btn.dataset.kind;
      touchTimer = setTimeout(() => {
        touchTimer = null;
        e.preventDefault();
        // Haptic feedback on iOS where supported.
        if (navigator.vibrate) navigator.vibrate(15);
        togglePillInIntersection(k);
      }, 280);
    }, { passive: true });
    const cancelTouch = () => {
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    };
    btn.addEventListener("touchend", cancelTouch);
    btn.addEventListener("touchmove", cancelTouch);
    btn.addEventListener("touchcancel", cancelTouch);
  });
  refreshActivePill();
}

function refreshActivePill() {
  const active = select.value;
  $$(".kind-pill").forEach((btn) => {
    const k = btn.dataset.kind;
    btn.classList.toggle("active", k === active);
    btn.classList.toggle("intersect", _intersectKinds.has(k));
  });
}

buildListKindOptions();
select.addEventListener("change", () => {
  // Reset the search when switching lists — different lists, different content.
  searchInput.value = "";
  searchClear.hidden = true;
  // Drop any in-flight selection too — selecting "_carrotro11" on the rejected
  // list shouldn't carry over to the mutuals list.
  if (typeof setSelectMode === "function") setSelectMode(false);
  loadLists();
});

const sortSelect = $("#list-sort");
sortSelect.addEventListener("change", loadLists);

const _listExportBtn = $("#list-export-csv");
let _currentListExportItems = [];
let _currentListExportKind = "everyone";

// Per-list search bar. Filters DOM rows in place (no server roundtrip), matches
// case-insensitive substring against username AND any past aliases (so a renamed
// account is findable by its old handle). Esc clears.
const searchInput = $("#list-search");
const searchClear = $("#list-search-clear");
const searchCount = $("#search-count");

function applyListSearch() {
  const q = (searchInput.value || "").toLowerCase().trim();
  searchClear.hidden = q === "";
  const out = $("#list-output");
  const rows = $$(".list-row", out);
  const sections = $$(".list-section", out);
  if (rows.length === 0) {
    searchCount.hidden = true;
    if (typeof updateFilterCounts === "function") updateFilterCounts(rows);
    return;
  }
  // Active privacy filters: which dataset.privacy values are allowed.
  const allowedPrivacy = new Set();
  $$(".filter-chip.active").forEach((c) => {
    const m = (c.dataset.filter || "").match(/^privacy:(.+)$/);
    if (m) allowedPrivacy.add(m[1]);
  });
  // If every filter is on (or none are), treat as "show everything" so
  // the user never lands on an empty filtered list. Match the count of
  // visible chips.
  const totalChips = $$(".filter-chip").length;
  const filterOn = allowedPrivacy.size > 0 && allowedPrivacy.size < totalChips;

  let visible = 0;
  for (const row of rows) {
    const hay = row.dataset.search || (row.dataset.username || "").toLowerCase();
    const matchesQuery = q === "" || hay.includes(q);
    const matchesPrivacy = !filterOn || allowedPrivacy.has(row.dataset.privacy || "unknown");
    const show = matchesQuery && matchesPrivacy;
    row.style.display = show ? "" : "none";
    if (show) visible++;
  }
  // Hide any section header whose entire group filtered out.
  for (const sec of sections) {
    let next = sec.nextElementSibling;
    let anyVisible = false;
    while (next && !next.classList.contains("list-section")) {
      if (next.classList.contains("list-row") && next.style.display !== "none") {
        anyVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    sec.style.display = anyVisible ? "" : "none";
  }
  // Counts on the privacy filter chips (always reflect the unfiltered set
  // so the user sees the totals available, not what's currently shown).
  if (typeof updateFilterCounts === "function") updateFilterCounts(rows);

  if (q === "" && !filterOn) {
    searchCount.hidden = true;
  } else {
    searchCount.hidden = false;
    searchCount.textContent = visible === rows.length
      ? `${rows.length} matches`
      : `Showing ${visible} of ${rows.length}`;
  }
  updateListExportButton();
}

function listLabel(kind) {
  return (LIST_KINDS.find(([key]) => key === kind) || [, kind])[1];
}

function currentPrivacyFilter() {
  const allowedPrivacy = new Set();
  $$(".filter-chip.active").forEach((c) => {
    const m = (c.dataset.filter || "").match(/^privacy:(.+)$/);
    if (m) allowedPrivacy.add(m[1]);
  });
  const totalChips = $$(".filter-chip").length;
  return allowedPrivacy.size > 0 && allowedPrivacy.size < totalChips
    ? allowedPrivacy
    : null;
}

function itemPrivacyKind(item) {
  if (item.now_public) return "public";
  if (item.privacy_confirmed_private || item.privacy === "likely_private") return "private";
  if (item.privacy === "likely_public") return "likely_public";
  return "unknown";
}

function currentListFilteredItems() {
  const q = (searchInput?.value || "").toLowerCase().trim();
  const privacyFilter = currentPrivacyFilter();
  return (_currentListExportItems || []).filter((item) => {
    const aliases = (item.aliases && item.aliases.length > 0) ? item.aliases : [item.username];
    const hay = aliases.map((a) => String(a).toLowerCase()).join("|");
    if (q && !hay.includes(q)) return false;
    if (privacyFilter && !privacyFilter.has(itemPrivacyKind(item))) return false;
    return true;
  });
}

function updateListExportButton() {
  if (!_listExportBtn) return;
  const n = currentListFilteredItems().length;
  _listExportBtn.disabled = n === 0;
  _listExportBtn.textContent = n > 0 ? `Export CSV (${n})` : "Export CSV";
}

function csvCell(value) {
  if (value == null) return "";
  const s = Array.isArray(value) ? value.join(" | ") : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvDateTimeFromUnix(ts) {
  if (typeof ts !== "number") return "";
  const d = new Date(ts * 1000);
  return isNaN(d) ? "" : d.toISOString();
}

function exportCurrentListCsv() {
  const items = currentListFilteredItems();
  if (!items.length) {
    toast("No rows to export");
    updateListExportButton();
    return;
  }
  const kind = _currentListExportKind || select.value || "everyone";
  const activeIntersections = [..._intersectKinds].map(listLabel).join(" + ");
  const headers = [
    "username", "instagram_url", "list_kind", "list_label", "intersections",
    "relationship", "bucket_status", "privacy", "aliases", "note",
    "favorite", "star", "want_remove", "watchlist", "to_follow",
    "disabled", "unavailable", "random_request", "now_public",
    "followed_at", "they_followed_at", "requested_at", "incoming_requested_at",
    "you_unfollowed_at", "last_seen_as_follower_at", "last_archived_at",
  ];
  const rows = items.map((item) => ({
    username: item.username,
    instagram_url: instagramUrl(item.username),
    list_kind: kind,
    list_label: listLabel(kind),
    intersections: activeIntersections,
    relationship: item.relationship || "",
    bucket_status: item.bucket_status || "",
    privacy: itemPrivacyKind(item),
    aliases: item.aliases || "",
    note: item.note || "",
    favorite: item.favorite ? "1" : "",
    star: item.star ? "1" : "",
    want_remove: item.want_remove ? "1" : "",
    watchlist: item.watchlist ? "1" : "",
    to_follow: item.to_follow ? "1" : "",
    disabled: item.disabled ? "1" : "",
    unavailable: item.unavailable ? "1" : "",
    random_request: item.random_request ? "1" : "",
    now_public: item.now_public ? "1" : "",
    followed_at: csvDateTimeFromUnix(item.followed_ts) || item.followed_at || "",
    they_followed_at: csvDateTimeFromUnix(item.followers_ts) || item.first_followed_you_at || "",
    requested_at: csvDateTimeFromUnix(item.pending_ts) || item.pending_since_at || "",
    incoming_requested_at: csvDateTimeFromUnix(item.incoming_ts),
    you_unfollowed_at: csvDateTimeFromUnix(item.unfollowed_ts || item.unfollowed_by_you_ts) || item.unfollowed_by_you_at || "",
    last_seen_as_follower_at: csvDateTimeFromUnix(item.last_followed_you_ts) || item.last_followed_you_at || "",
    last_archived_at: csvDateTimeFromUnix(item.last_archived_ts),
  }));
  const csv = [headers.join(",")]
    .concat(rows.map((row) => headers.map((h) => csvCell(row[h])).join(",")))
    .join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  const suffix = _intersectKinds.size ? "-intersection" : "";
  a.href = url;
  a.download = `igtracker-${kind}${suffix}-${date}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${items.length} row${items.length === 1 ? "" : "s"}`);
}

if (_listExportBtn) {
  _listExportBtn.addEventListener("click", exportCurrentListCsv);
}

searchInput.addEventListener("input", applyListSearch);

// Delegated click handler for list rows. Bound ONCE here so rows that the
// chunked renderer (renderRowsChunked) appends asynchronously after the
// first 120-row sync paint still respond to clicks. The previous per-row
// .addEventListener loop ran immediately after the sync paint, so any row
// painted in a later requestAnimationFrame batch never got handlers and
// the user could only tag the first batch (the visible "newest" rows).
$("#list-output")?.addEventListener("click", async (e) => {
  const row = e.target.closest(".list-row");
  if (!row) return;

  // External-link icon: let the browser handle navigation, just stop the
  // click from also bubbling up to the row (which would open the modal).
  if (e.target.closest(".row-open")) {
    e.stopPropagation();
    return;
  }

  // Modifier-click on the row anywhere → open the Instagram profile in
  // a new tab instead of opening the modal. Covers cmd-click (Mac),
  // ctrl-click (Windows/Linux), and shift-click (new window). Tag
  // buttons handle their own stopPropagation above so we don't trigger
  // this from a tag-button click.
  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    if (e.target.closest(".row-tag")) return;  // tag button has its own handling
    e.preventDefault();
    e.stopPropagation();
    window.open(instagramUrl(row.dataset.username), "_blank", "noopener");
    return;
  }

  // Tag button: toggle the flag via API, then update local row state.
  const tagBtn = e.target.closest(".row-tag");
  if (tagBtn) {
    e.stopPropagation();
    const flag = tagBtn.dataset.rowFlag;
    const willBe = !tagBtn.classList.contains("on");
    try {
      const result = await api.post("/api/tags", { account: row.dataset.username, flag, value: willBe });
      tagBtn.classList.toggle("on", !!result[flag]);
      toast(`${flag.replace("_", " ")} ${result[flag] ? "added" : "removed"}`);
      const currentKind = select.value;
      const BUCKETS = ["favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"];
      // Removed from the bucket we're viewing → drop the row.
      if (!result[flag] && currentKind === flag) row.remove();
      // Tagged suppressed flag ON while viewing a non-bucket list → drop
      // (server excludes these from non-bucket lists, so the local view
      // would be inconsistent with the server's next render).
      if ((flag === "disabled" || flag === "unavailable" || flag === "random_request")
          && result[flag] && !BUCKETS.includes(currentKind)) {
        row.remove();
      }
    } catch (err) {
      toast(`Failed: ${err.message}`);
    }
    return;
  }

  // Bare row click — select-mode toggle or open modal.
  if (_selectMode) {
    const u = row.dataset.username;
    if (_selectedUsernames.has(u)) {
      _selectedUsernames.delete(u);
      row.removeAttribute("aria-selected");
    } else {
      _selectedUsernames.add(u);
      row.setAttribute("aria-selected", "true");
    }
    renderBulkToolbar();
  } else {
    openAccountModal(row.dataset.username);
  }
});

// Privacy filter chips. Each chip toggles its own state; the filter
// applies after all chips are evaluated. "Clear filters" reactivates
// all chips so everything shows.
function updateFilterCounts(rows) {
  const counts = { private: 0, public: 0, likely_public: 0, unknown: 0 };
  rows.forEach((r) => {
    const p = r.dataset.privacy || "unknown";
    counts[p] = (counts[p] || 0) + 1;
  });
  $$("[data-filter-count]").forEach((el) => {
    const m = (el.dataset.filterCount || "").match(/^privacy:(.+)$/);
    if (m) el.textContent = (counts[m[1]] || 0).toString();
  });
  // Show "Clear filters" when at least one chip is off.
  const allOn = $$(".filter-chip").every((c) => c.classList.contains("active"));
  const clear = $("#filter-clear");
  if (clear) clear.hidden = allOn;
}

$$(".filter-chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    chip.classList.toggle("active");
    applyListSearch();
  })
);
const _filterClearBtn = $("#filter-clear");
if (_filterClearBtn) {
  _filterClearBtn.addEventListener("click", () => {
    $$(".filter-chip").forEach((c) => c.classList.add("active"));
    applyListSearch();
  });
}
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    applyListSearch();
    searchInput.blur();
  }
});
searchClear.addEventListener("click", (e) => {
  e.stopPropagation();
  searchInput.value = "";
  applyListSearch();
  searchInput.focus();
});

// ---------- multi-select for bulk actions ----------
const _selectedUsernames = new Set();
let _selectMode = false;
const _selectToggleBtn = $("#list-select-toggle");
const _bulkToolbar = $("#bulk-toolbar");

function setSelectMode(on) {
  _selectMode = !!on;
  const out = $("#list-output");
  if (out) out.classList.toggle("select-mode", _selectMode);
  if (_selectToggleBtn) {
    _selectToggleBtn.classList.toggle("active", _selectMode);
    _selectToggleBtn.textContent = _selectMode ? "Done" : "Select";
  }
  if (!_selectMode) {
    _selectedUsernames.clear();
    if (out) $$(".list-row[aria-selected='true']", out).forEach((r) => r.removeAttribute("aria-selected"));
  }
  renderBulkToolbar();
}

function renderBulkToolbar() {
  if (!_bulkToolbar) return;
  if (!_selectMode || _selectedUsernames.size === 0) {
    _bulkToolbar.hidden = true;
    _bulkToolbar.innerHTML = "";
    return;
  }
  const n = _selectedUsernames.size;
  const tagBtn = (flag, sym, label) =>
    `<button type="button" class="bulk-btn" data-bulk="${flag}" title="${label}">${sym} ${label}</button>`;
  _bulkToolbar.hidden = false;
  _bulkToolbar.innerHTML = `
    <span class="bulk-count">${n} selected</span>
    ${tagBtn("favorite", "★", "Favorite")}
    ${tagBtn("want_remove", "✦", "Want to remove")}
    ${tagBtn("watchlist", "↺", "Wait-back")}
    ${tagBtn("disabled", "⚠", "Disabled")}
    ${tagBtn("unavailable", "✕", "Unavailable")}
    ${tagBtn("random_request", "🎲", "Random request")}
    ${tagBtn("now_public", "🌐", "Now public")}
    <button type="button" class="bulk-btn" data-bulk="open">Open all in tabs</button>
    <button type="button" class="bulk-btn" data-bulk="queue">Add to follow queue</button>
    <button type="button" class="bulk-btn" data-bulk="note">📝 Note all</button>
    <button type="button" class="bulk-btn bulk-cancel" data-bulk="cancel">Cancel</button>
  `;
  $$(".bulk-btn", _bulkToolbar).forEach((btn) =>
    btn.addEventListener("click", () => runBulkAction(btn.dataset.bulk))
  );
}

async function runBulkAction(action) {
  const usernames = Array.from(_selectedUsernames);
  if (action === "cancel") { setSelectMode(false); return; }
  if (action === "open") {
    // Browsers block popup spam after a few — open the first 5 with a
    // brief gap, then warn for any beyond that.
    const limit = 5;
    const opened = usernames.slice(0, limit);
    opened.forEach((u, i) => setTimeout(() => window.open(`https://www.instagram.com/${encodeURIComponent(u)}/`, "_blank"), i * 50));
    if (usernames.length > limit) {
      toast(`Opened first ${limit}. Browser blocks bulk popups beyond that.`);
    } else {
      toast(`Opened ${opened.length} tab${opened.length === 1 ? "" : "s"}`);
    }
    return;
  }
  if (action === "queue") {
    try {
      await Promise.all(usernames.map((u) =>
        api.post("/api/followup/add", { account: u })
      ));
      toast(`Added ${usernames.length} to follow queue`);
    } catch (e) {
      toast(`Failed: ${e.message}`);
    }
    return;
  }
  if (action === "note") {
    await openBulkNoteEditor(usernames);
    return;
  }
  // Tag bulk apply: POST /api/tags for each, in parallel.
  const flag = action;
  toast(`Applying ${flag} to ${usernames.length}…`);
  try {
    await Promise.all(usernames.map((u) =>
      api.post("/api/tags", { account: u, flag, value: true })
    ));
    toast(`Applied ${flag} to ${usernames.length} account${usernames.length === 1 ? "" : "s"}`);
    // Exit select mode and refresh the current list so any newly-tagged
    // rows that should now be filtered out (disabled / unavailable
    // exclude from non-bucket lists) actually drop.
    setSelectMode(false);
    loadLists();
  } catch (e) {
    toast(`Some applies failed: ${e.message}`);
  }
}

if (_selectToggleBtn) {
  _selectToggleBtn.addEventListener("click", () => setSelectMode(!_selectMode));
}

// Lightweight inline editor for bulk-note. Builds a small overlay with
// a textarea + replace/append toggle + Save. Posts to /api/note/bulk so
// it's one tag-version bump for the whole batch (single reprewarm) —
// looping the per-account /api/note POST would fire 50 bumps and stall
// the server while reprewarms thrashed.
async function openBulkNoteEditor(usernames) {
  if (!usernames.length) return;
  const existing = document.getElementById("bulk-note-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "bulk-note-overlay";
  overlay.className = "modal-overlay";
  const sample = usernames.slice(0, 6).join(", ") + (usernames.length > 6 ? `, … +${usernames.length - 6} more` : "");
  overlay.innerHTML = `
    <div class="modal-card bulk-note-card">
      <h3 class="bulk-note-title">📝 Add note to ${usernames.length} account${usernames.length === 1 ? "" : "s"}</h3>
      <div class="muted small bulk-note-targets">${escapeHtml(sample)}</div>
      <textarea id="bulk-note-text" placeholder="e.g. met at SF meetup, do not unfollow until June, has VSCO at …"></textarea>
      <div class="bulk-note-mode">
        <label><input type="radio" name="bulk-note-mode" value="append" checked /> Append (preserve existing notes)</label>
        <label><input type="radio" name="bulk-note-mode" value="replace" /> Replace existing notes</label>
      </div>
      <div class="bulk-note-actions">
        <button type="button" class="ghost-btn" id="bulk-note-cancel">Cancel</button>
        <button type="button" class="primary" id="bulk-note-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector("#bulk-note-text");
  ta?.focus();
  const save = async () => {
    const note = (ta?.value || "").trim();
    const mode = overlay.querySelector('input[name="bulk-note-mode"]:checked')?.value || "append";
    if (!note) { toast("Note is empty — nothing to save"); return; }
    try {
      const r = await api.post("/api/note/bulk", { accounts: usernames, note, mode });
      toast(`Saved note on ${r.updated} account${r.updated === 1 ? "" : "s"} (${mode})`);
      close();
      setSelectMode(false);
      loadLists();
    } catch (e) {
      toast(`Bulk note failed: ${e.message}`);
    }
  };
  // Esc to dismiss, Cmd/Ctrl+Enter to save — common keyboard shortcuts
  // for modal-like editors. Listener is attached to overlay so it
  // dies when the overlay is removed.
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); }
  };
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  document.addEventListener("keydown", onKey);
  overlay.querySelector("#bulk-note-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#bulk-note-save").addEventListener("click", save);
}

function goToList(kind, push = true) {
  showView("lists", false);
  if (![...select.options].some((o) => o.value === kind)) {
    buildListKindOptions();
  }
  select.value = kind;
  // Default to newest-first across the board; bucket lists default alphabetical
  // so favorites/want-remove/etc. read like a roster.
  const BUCKET_KINDS = new Set(["favorite", "want_remove", "watchlist", "disabled", "unavailable"]);
  sortSelect.value = BUCKET_KINDS.has(kind) ? "alphabetical" : "reverse_chronological";
  if (push) {
    history.pushState({ view: "lists", listKind: kind }, "", `#lists/${kind}`);
  }
  loadLists();
}

// Pick the "when did this happen" instant for a row, used for chronological
// sorts. Returns milliseconds since epoch (numeric) so same-day events sort
// by exact second rather than collapsing to date precision. Server populates
// per-row exact timestamps (*_ts, unix seconds) where IG provides them; fall
// back to ISO date strings (snapshot-label precision) when not.
function rowDateKey(r) {
  const exact = r.unfollowed_by_you_ts ?? r.last_followed_you_ts ??
                r.followed_ts ?? r.first_followed_you_ts ??
                r.pending_ts ?? r.incoming_ts ?? r.unfollowed_ts ??
                r.followers_ts;
  if (typeof exact === "number") return exact * 1000;
  const iso = r.unfollowed_by_you_at || r.removed_you_at || r.last_followed_you_at ||
              r.mutual_since_at || r.followed_at || r.first_followed_you_at ||
              r.pending_since_at;
  if (!iso) return null;
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  return isNaN(d) ? null : d.getTime();
}

// Each list has its own "what date is sorting by?" — surfaced as a small
// caption next to the Sort label so the user knows which event the
// chronological options refer to. The dropdown options themselves stay
// uniform (Newest first / Oldest first / A → Z), which earlier feedback
// found easier to scan than per-list verbs.
// Event-log lists: cumulative history where accounts may have come back.
// We render came-back-as-mutual entries at the bottom in a dimmed section
// so the "actually gone" rows aren't visually buried underneath them.
const EVENT_HISTORY_KINDS = new Set([
  "ever_unfollowed_you",
  "rats",
  "mutual_break_you_first",
  "mutual_break_they_first",
  "ever_removed_you_as_follower",
  "you_unfollowed_ever",
]);

const SORT_DATE_HINT = {
  all_following:                "by when you followed them",
  still_follow_after_drop:      "by when you followed them",
  mutuals:                      "by when you became mutual",
  not_following_you_back:       "by when they last followed you",
  ever_unfollowed_you:          "by when they last followed you",
  rats:                         "by when they last followed you",
  mutual_break_you_first:       "by when they last followed you",
  mutual_break_they_first:      "by when they last followed you",
  ever_removed_you_as_follower: "by when they last appeared in your following",
  you_unfollowed_ever:          "by when you unfollowed them",
  recently_unfollowed:          "by when you unfollowed them",
  all_followers:                "by when they first followed you",
  feeder_accounts:              "by when they first followed you",
  pending:                      "by when you sent the request",
  recent_follow_requests:       "by when you sent the request",
  incoming_requests:             "by when they requested",
  ever_incoming_requests:        "by when they requested",
  incoming_request_dropped:      "by when they requested",
  ever_requested_outgoing:       "by when you started following them",
};

function refreshSortLabels(kind) {
  // Uniform option text — easy to scan.
  const opts = sortSelect.options;
  for (const opt of opts) {
    if (opt.value === "reverse_chronological") opt.textContent = "Newest first";
    else if (opt.value === "chronological")    opt.textContent = "Oldest first";
    else if (opt.value === "alphabetical")     opt.textContent = "A → Z";
  }
  // Caption next to "Sort:" tells you what the chronological options key off.
  const caption = $("#sort-caption");
  if (caption) {
    const hint = SORT_DATE_HINT[kind];
    caption.textContent = hint ? `(${hint})` : "";
  }
}

function applySort(items, mode) {
  const arr = items.slice();
  if (mode === "alphabetical") {
    arr.sort((a, b) => a.username.localeCompare(b.username));
    return arr;
  }
  // chronological = oldest first; reverse_chronological = newest first.
  // Rows with no date fall to the end (alphabetized among themselves).
  const reverse = mode === "reverse_chronological";
  arr.sort((a, b) => {
    const ad = rowDateKey(a);
    const bd = rowDateKey(b);
    if (ad == null && bd == null) return a.username.localeCompare(b.username);
    if (ad == null) return 1;
    if (bd == null) return -1;
    const cmp = reverse ? bd - ad : ad - bd;
    return cmp || a.username.localeCompare(b.username);
  });
  return arr;
}

// Chunked-rendering helper for very long lists (e.g. all_followers, ~1400
// rows). Single innerHTML assignment for that many DOM nodes blocks the
// main thread for 800-1500ms. Chunking lets the browser paint the first
// screen of rows in <100ms, then progressively appends the rest while
// the user can already start scrolling / interacting.
//
// Search/select/sort handlers re-fire after each chunk via the input
// event the calling code dispatches; they read data-search attributes
// off rendered rows, so a row that's been painted is searchable even
// while later chunks are still being added.
const _RENDER_FIRST = 120;     // visible above-the-fold first paint
const _RENDER_CHUNK = 300;     // subsequent batch size
let _renderToken = 0;          // bumps on each new render — old chunks abort

function renderRowsChunked(out, items, renderFn) {
  _renderToken += 1;
  const myToken = _renderToken;

  // First chunk: render synchronously so the user sees rows immediately.
  // Append a loading-more footer if there are more rows to come, so the
  // user knows they're not seeing the full list yet.
  const firstChunk = items.slice(0, _RENDER_FIRST).map(renderFn).join("");
  const hasMore = items.length > _RENDER_FIRST;
  out.innerHTML = firstChunk +
    (hasMore ? `<div class="loading-more" id="list-loading-more"><span class="spinner"></span>Loading ${items.length - _RENDER_FIRST} more…</div>` : "");
  // Try a scroll-restore as soon as the first chunk is in the DOM —
  // for short lists the saved position may be reachable already.
  _tryRestoreScroll();
  if (!hasMore) return;

  // Remaining chunks: append progressively. Yield to the browser between
  // each so the layout/paint cost is spread out, not bunched.
  let idx = _RENDER_FIRST;
  function paint() {
    // If a different render started while we were waiting (user clicked
    // another pill, navigated away, etc.), abandon — don't paint stale
    // rows into the wrong list.
    if (myToken !== _renderToken) return;
    if (idx >= items.length) return;
    const slice = items.slice(idx, idx + _RENDER_CHUNK);
    const frag = document.createRange().createContextualFragment(
      slice.map(renderFn).join("")
    );
    // Insert before the loading-more footer so it stays at the bottom.
    const moreFooter = out.querySelector("#list-loading-more");
    if (moreFooter) {
      moreFooter.parentNode.insertBefore(frag, moreFooter);
      // Update the count in the footer so progress feels live.
      const remaining = items.length - idx - _RENDER_CHUNK;
      if (remaining > 0) {
        moreFooter.innerHTML = `<span class="spinner"></span>Loading ${remaining} more…`;
      }
    } else {
      out.appendChild(frag);
    }
    idx += _RENDER_CHUNK;
    // Each chunk grows the page; retry the scroll-restore so a deep
    // saved position eventually lands once enough rows are appended.
    _tryRestoreScroll();
    if (idx < items.length) {
      requestAnimationFrame(paint);
    } else {
      // Final chunk done — remove the loading-more footer + re-run search.
      out.querySelector("#list-loading-more")?.remove();
      applyListSearch();
      _tryRestoreScroll();
    }
  }
  requestAnimationFrame(paint);
}

function renderListRow(item) {
  // Build the small grey sub-line and the right-side chip.
  let sub = "";
  let chip = "";
  let chipClass = "timing";
  let rowClass = "";
  // Visual flag for "they have a pending request to follow you back".
  // Unfollowing one of these would cancel a budding mutual, so we tint
  // the row purple and float it to the bottom of any list it appears
  // in (see the loadLists default branch — it splits items into
  // non-requesting + requesting groups before chunked-rendering).
  if (item.relationship === "requesting to follow back") {
    rowClass += (rowClass ? " " : "") + "is-requesting-back";
  }
  // Visual flag for "already unfollowed ✓" rows on bucket lists like
  // ✦ Want to remove. The action is done; the row is just history,
  // so dim with a transparent red tint and float to the bottom so the
  // user focuses on the still-following entries that need action.
  if (item.bucket_status === "already unfollowed ✓") {
    rowClass += (rowClass ? " " : "") + "is-already-unfollowed";
  }

  // Build sub-line: chronological story of the relationship. Prefer the
  // exact unix-second timestamp (*_ts) IG provides; fall back to the
  // date-precision ISO string when only a snapshot label is available.
  const parts = [];

  // Privacy bucket for filter chips:
  //   "public"        — user-tagged now_public (manual verification).
  //   "private"       — banner observed OR ever-pending evidence
  //                     (private accounts only; flip case handled by
  //                     the now_public tag).
  //   "likely_public" — likely_public inference, always hedged (brief
  //                     pending phase can escape between snapshots).
  //   "unknown"       — no signal.
  let privacy = "unknown";
  if (item.now_public) {
    privacy = "public";
  } else if (item.privacy_confirmed_private || item.privacy === "likely_private") {
    privacy = "private";
  } else if (item.privacy === "likely_public") {
    privacy = "likely_public";
  }

  if (item.followed_ts) parts.push(`you followed ${escapeHtml(fmtDateTime(item.followed_ts))}`);
  else if (item.followed_at) parts.push(`you followed ${escapeHtml(fmtDate(item.followed_at))}`);
  if (item.followers_ts) parts.push(`they followed you ${escapeHtml(fmtDateTime(item.followers_ts))}`);
  // Reciprocity gap: when both timestamps exist, render the time delta
  // between you-follow and them-follow with a bucketed pill (instant /
  // fast / slow / late). Surfaces follow-back speed on every mutual list
  // without needing a dedicated tab.
  const gap = reciprocityGapPill(item.followed_ts, item.followers_ts);
  if (gap) parts.push(gap);
  if (item.pending_ts) parts.push(`you requested ${escapeHtml(fmtDateTime(item.pending_ts))}`);
  else if (item.pending_since_at && !item.pending_ts) parts.push(`requested ${escapeHtml(fmtDate(item.pending_since_at))}`);
  if (item.incoming_ts) parts.push(`they requested ${escapeHtml(fmtDateTime(item.incoming_ts))}`);
  if (item.unfollowed_ts) parts.push(`you unfollowed ${escapeHtml(fmtDateTime(item.unfollowed_ts))}`);
  if (item.pending_via_extension) parts.push(`<span class="info-tag">via extension — not yet in export</span>`);
  if (item.following_via_extension) parts.push(`<span class="info-tag">via extension — not yet in export</span>`);
  if (item.mutual_since_at) parts.push(`mutual since ${escapeHtml(fmtDate(item.mutual_since_at))}`);
  if (item.history_status === "re-engaged") parts.push(`<span class="info-tag">re-engaged</span>`);
  // Privacy display:
  //   "🌐 public (you confirmed)" — user-tagged now_public.
  //   "🔒 private"                — banner OR ever-pending evidence.
  //   "🌐 likely public"          — inference only.
  if (privacy === "public") {
    parts.push(`<span class="privacy-tag privacy-public">🌐 public (you confirmed)</span>`);
  } else if (privacy === "private") {
    parts.push(`<span class="privacy-tag privacy-private">🔒 private</span>`);
  } else if (privacy === "likely_public") {
    parts.push(`<span class="privacy-tag privacy-public">🌐 likely public</span>`);
  }
  if (item.aliases && item.aliases.length > 1) parts.push(`<span class="info-tag">renamed: ${escapeHtml(item.aliases.join(' → '))}</span>`);
  if (item.note) {
    const trimmed = String(item.note).trim();
    const snippet = trimmed.length > 120 ? trimmed.slice(0, 117) + "…" : trimmed;
    parts.push(`<span class="note-tag" title="${escapeAttr(trimmed)}">📝 ${escapeHtml(snippet)}</span>`);
  }
  if (item.ever_followed_you === false) parts.push(`<span class="never">never followed back</span>`);
  else if (item.ever_followed_you === true) {
    // started_following_you_ts is IG's exact moment they began following you
    // (preserved across snapshots). last_followed_you_ts is the snapshot
    // taken_at of the LAST snapshot we observed them as a follower — the
    // unfollow itself happened sometime after that, but we don't know
    // exactly when (only as precise as our snapshot cadence).
    if (item.started_following_you_ts) {
      parts.push(`they followed you on ${escapeHtml(fmtDateTime(item.started_following_you_ts))}`);
    }
    if (item.last_followed_you_ts) {
      parts.push(`last seen as follower around ${escapeHtml(fmtDateTime(item.last_followed_you_ts))}`);
    } else if (item.last_followed_you_at) {
      parts.push(`last seen as follower around ${escapeHtml(fmtDate(item.last_followed_you_at))}`);
    }
  }
  sub = parts.join(" · ");

  // Right-side chip: unified status pill from the relationship field.
  if (item.relationship) {
    chip = escapeHtml(item.relationship);
    chipClass = `timing chip-rel-${item.relationship_kind || "muted"}`;
  }
  if (item.ever_followed_you === false) {
    chip = `never · ${escapeHtml(fmtDuration(item.days_since))}`;
    chipClass = "timing chip-never";
    if ((item.days_since ?? 0) >= 365) rowClass = "stale";
  } else if (item.ever_followed_you === true) {
    chip = item.last_followed_you_days_ago != null
      ? `stopped ${escapeHtml(fmtAgo(item.last_followed_you_days_ago))}`
      : chip;
    chipClass = "timing chip-stopped";
  }

  // Bucket lists: show actionability chip instead.
  if (item.bucket_status) {
    chip = escapeHtml(item.bucket_status);
    chipClass = `timing chip-bucket-${item.bucket_status_kind || "default"}`;
  }

  const tagBtn = (flag, sym, on) =>
    `<button class="row-tag${on ? " on" : ""}" data-row-flag="${flag}" title="${flag}">${sym}</button>`;
  // 📦 = virtual flag computed server-side from data/media/<u>/. Read-only —
  // can't toggle it from the row (clicking just opens the IG profile to view
  // archived media). Has its own CSS class so it's visually distinct from
  // togglable tags. Tooltip includes the last-archived relative time so
  // the user can see at a glance when this account was last touched.
  let archiveTitle = "has archived media — open the gallery from the modal";
  if (item.last_archived_ts) {
    const ago = _fmtRelativeFromUnix(item.last_archived_ts);
    if (ago) archiveTitle = `last archived ${ago} — open the gallery from the modal`;
  }
  const archivePill = item.has_archive
    ? `<span class="row-tag has-archive on" title="${escapeAttr(archiveTitle)}">📦</span>`
    : "";
  // Sub-line caption: "📦 last archived 2h ago". Only shown when there
  // IS archived media (item.last_archived_ts present). Distinct from
  // the per-row 📦 pill on the right edge — that pill is a tap target,
  // this caption is informational so the timestamp is visible without
  // having to hover.
  if (item.last_archived_ts) {
    const ago = _fmtRelativeFromUnix(item.last_archived_ts);
    if (ago) parts.push(`📦 last archived ${ago}`);
  }
  const tagButtons = `
    ${archivePill}
    ${tagBtn("favorite", "★", item.favorite)}
    ${tagBtn("want_remove", "✦", item.want_remove)}
    ${tagBtn("watchlist", "↺", item.watchlist)}
    ${tagBtn("disabled", "⚠", item.disabled)}
    ${tagBtn("unavailable", "✕", item.unavailable)}
    ${tagBtn("random_request", "🎲", item.random_request)}
    ${tagBtn("now_public", "🌐", item.now_public)}
  `;

  // Searchable haystack: current username + any past aliases (rename chain),
  // lowercased and pipe-joined. Lets the per-list search match a renamed
  // account by its old handle.
  const aliasList = (item.aliases && item.aliases.length > 0) ? item.aliases : [item.username];
  const haystack = aliasList.map((a) => String(a).toLowerCase()).join("|");

  // Direct-open link to the IG profile so the user doesn't have to go
  // row -> modal -> link. Stops propagation so it doesn't also fire the
  // row-click that opens the modal.
  const igUrl = `https://www.instagram.com/${encodeURIComponent(item.username)}/`;
  const openLink = `<a class="row-open" href="${igUrl}" target="_blank" rel="noopener" title="Open ${escapeAttr(item.username)} on Instagram">↗</a>`;

  // Color stripe + subtle background tint based on relationship state.
  // bucket_status_kind takes precedence (we're inside a bucket list view),
  // otherwise the row's current relationship kind.
  const rel = item.bucket_status_kind || item.relationship_kind || "muted";
  // Selection support for multi-select mode (handled by CSS when the parent
  // .list-output is in select-mode and this row has aria-selected="true").
  const checkbox = `<span class="row-check" aria-hidden="true"></span>`;

  return `
    <div class="list-row${rowClass ? " " + rowClass : ""}" data-username="${escapeAttr(item.username)}" data-search="${escapeAttr(haystack)}" data-rel="${escapeAttr(rel)}" data-privacy="${escapeAttr(privacy)}">
      ${checkbox}
      <div class="username-block">
        <span class="username">${escapeHtml(item.username)}</span>
        ${sub ? `<span class="sub">${sub}</span>` : ""}
      </div>
      ${chip ? `<span class="${chipClass}">${chip}</span>` : ""}
      ${openLink}
      <span class="row-tags">${tagButtons}</span>
    </div>`;
}

function fmtDuration(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${Math.round(days / 365 * 10) / 10} yr`;
}

// Reciprocity gap: time between when YOU followed THEM and when THEY
// followed YOU (mutuals only). Returns a pre-escaped HTML pill or "" if
// either timestamp is missing. Buckets:
//   instant <1h, fast <24h, slow 1-7d, late >7d.
// Direction is named by who acted first ("you-first" / "they-first").
// Same-second case → "instant ↔ same time".
function reciprocityGapPill(youTs, theyTs) {
  if (!youTs || !theyTs) return "";
  const a = Number(youTs), b = Number(theyTs);
  if (!isFinite(a) || !isFinite(b)) return "";
  const diff = Math.abs(a - b);  // seconds
  let bucket, label;
  if (diff < 60) { bucket = "instant"; label = "↔ within a minute"; }
  else if (diff < 3600) { bucket = "instant"; label = `↔ ${Math.round(diff / 60)}m`; }
  else if (diff < 86400) { bucket = "fast"; label = `${Math.round(diff / 3600)}h`; }
  else if (diff < 7 * 86400) { bucket = "slow"; label = `${Math.round(diff / 86400)}d`; }
  else { bucket = "late"; label = `${Math.round(diff / 86400)}d`; }
  let dirLabel = "";
  if (diff >= 60) {
    dirLabel = a < b ? "you-first by " : "they-first by ";
  }
  const text = `gap: ${dirLabel}${label}`;
  return `<span class="recip-gap recip-${bucket}" title="you followed ${fmtDateTime(youTs)} · they followed ${fmtDateTime(theyTs)}">${escapeHtml(text)}</span>`;
}

function fmtAgo(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.round(days / 365 * 10) / 10} yr ago`;
}

// Friendly relative time for an absolute mtime (seconds since epoch).
// Used by the home archive list — minute / hour granularity within
// the day so a freshly archived account reads as "just now" instead
// of "today" alongside an account archived 12 hours ago.
function fmtMtimeAgo(secs) {
  if (!secs) return "";
  const diffSec = Math.max(0, Date.now() / 1000 - secs);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  const days = Math.round(diffSec / 86400);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.round(days / 365 * 10) / 10} yr ago`;
}

function cleanLabel(label) {
  if (!label) return "";
  let s = String(label);
  s = s.replace(/\.zip$/i, "");
  s = s.replace(/-\d{8}T\d{6}Z-\d+-\d+$/, "");
  // meta-2026-Apr-28-15-50-49 → 2026-04-28 15:50:49
  const months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06", jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };
  let m = s.match(/(\d{4})-([A-Za-z]{3})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    const mo = months[m[2].toLowerCase()];
    if (mo) return `${m[1]}-${mo}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  // 2026-04-28_12-49-14 → 2026-04-28 12:49:14
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return s;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  if (isNaN(d)) return iso;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Render an exact unix timestamp (seconds) as "May 2, 4:21 PM" — local
// timezone. Falls back gracefully when ts is missing or invalid.
function fmtDateTime(ts) {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  if (isNaN(d)) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-US", sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// kept for backward compat where called from older code paths
const fmtDaysSince = fmtDuration;

async function loadLists() {
  // Show a spinner immediately so the user knows the click registered.
  // Replaced as soon as the API returns + first chunk paints.
  const out = $("#list-output");
  if (out) {
    out.innerHTML = `<div class="loading-card"><span class="spinner"></span>Loading list…</div>`;
  }
  try {
    // Pass ?kind=X so the server only returns the section we need.
    // Cuts the response from ~18MB to <2MB. Pill counts come back as
    // a separate lightweight `pill_counts` map so the picker still
    // shows the live counts without the full payload. When the user
    // has the intersection pills active we need the full sections_full
    // map, so fall back to the unfiltered fetch in that case.
    const kindHint = select.value || "everyone";
    const url = _intersectKinds.size
      ? "/api/lists"
      : `/api/lists?kind=${encodeURIComponent(kindHint)}`;
    const data = await api.get(url);
    const sections = data.sections || {};
    const pillCounts = data.pill_counts || {};
    // Counts on the (hidden) select for fallback consumers.
    [...select.options].forEach((opt) => {
      const base = LIST_KINDS.find(([k]) => k === opt.value);
      if (base) {
        const count = pillCounts[opt.value] != null ? pillCounts[opt.value] : (sections[opt.value] || []).length;
        opt.textContent = `${base[1]} (${count})`;
      }
    });
    // Counts on the visible pills.
    $$("[data-pill-count]").forEach((el) => {
      const k = el.dataset.pillCount;
      const count = pillCounts[k] != null ? pillCounts[k] : (sections[k] || []).length;
      el.textContent = count.toString();
    });
    refreshActivePill();
    const kind = select.value || "everyone";
    refreshSortLabels(kind);
    const descEl = $("#list-description");
    if (descEl) {
      const desc = LIST_DESCRIPTIONS[kind];
      if (desc) {
        descEl.textContent = desc;
        descEl.hidden = false;
      } else {
        descEl.textContent = "";
        descEl.hidden = true;
      }
    }
    const out = $("#list-output");
    out.dataset.listKind = kind;
    _renderedView = "lists";
    _renderedListKind = kind;
    // For intersection, prefer the unsuppressed sections_full so that
    // suppressed-tagged users (disabled / unavailable / random_request) can
    // legitimately match a bucket pill. Without this, "all_following ∩
    // unavailable" would always be empty because all_following has those
    // users stripped out.
    const fullSections = data.sections_full || sections;
    const baseSections = _intersectKinds.size ? fullSections : sections;
    let items = baseSections[kind] || [];

    // Apply the cross-list intersection: keep only rows whose username
    // is present in EVERY pill the user combined in. Username sets always
    // come from the unsuppressed full view so bucket-pill matches surface
    // even when the primary list normally filters them out.
    const secondaryUsernameSets = [..._intersectKinds]
      .filter((k) => k !== kind && Array.isArray(fullSections[k]))
      .map((k) => new Set(fullSections[k].map((r) => r.username)));
    if (secondaryUsernameSets.length) {
      items = items.filter((r) => secondaryUsernameSets.every((s) => s.has(r.username)));
    }

    // Surface the intersection in the sort caption so the count makes sense.
    const captionEl = $("#sort-caption");
    if (captionEl) {
      const baseCaption = SORT_DATE_HINT[kind] ? `(${SORT_DATE_HINT[kind]})` : "";
      if (_intersectKinds.size) {
        const labelOf = (k) => (LIST_KINDS.find(([key]) => key === k) || [, k])[1];
        const combined = [...(_intersectKinds)].map(labelOf).join(" + ");
        captionEl.textContent = `${baseCaption} · ∩ ${combined} (${items.length})`.trim();
      } else {
        captionEl.textContent = baseCaption;
      }
    }

    if (items.length === 0) {
      _currentListExportKind = kind;
      _currentListExportItems = [];
      updateListExportButton();
      // Distinguish "no intersection match" from "empty list" — the
      // old hardcoded message was misleading for plain single-list
      // views where there's no intersection in play. Helps the user
      // see whether they triggered an unintended intersection vs the
      // list is genuinely empty.
      const isIntersection = _intersectKinds.size > 0;
      const baseLen = (sections[kind] || []).length;
      const fullLen = (fullSections[kind] || []).length;
      let msg;
      if (isIntersection) {
        msg = `(none — 0 in intersection)`;
      } else if (baseLen === 0 && fullLen === 0) {
        msg = `(none — list is empty)`;
      } else {
        // Server returned rows but client filtered them out — this
        // usually means a stale app.js cache. Surface the diagnostic
        // counts so the user can see what's going on.
        msg = `(empty render but server has ${baseLen} item(s) — try Cmd+Shift+R to clear cache)`;
        console.warn(`[IGT] lists: kind=${kind} sections=${baseLen} sections_full=${fullLen} _intersectKinds=`, [..._intersectKinds]);
      }
      out.innerHTML = `<div class="muted">${msg}</div>`;
      searchCount.hidden = true;
      return;
    }

    sortSelect.parentElement.style.display = "";
    items = applySort(items, sortSelect.value);
    let exportItems = items;

    // For "still follow after drop", group visually so the surprising "we're
    // mutual again" cases don't get lost in the longer "still doesn't follow
    // back" list.
    if (kind === "still_follow_after_drop") {
      const notBack = items.filter((i) => i.relationship_kind !== "good");
      const mutual = items.filter((i) => i.relationship_kind === "good");
      exportItems = notBack.concat(mutual);
      const html = [];
      if (notBack.length) {
        html.push(`<div class="list-section">Still doesn't follow back (${notBack.length})</div>`);
        html.push(notBack.map(renderListRow).join(""));
      }
      if (mutual.length) {
        html.push(`<div class="list-section">Now mutual again (${mutual.length})</div>`);
        html.push(mutual.map(renderListRow).join(""));
      }
      out.innerHTML = html.join("");
    } else if (EVENT_HISTORY_KINDS.has(kind)) {
      // For event-log lists (ever_unfollowed_you, ever_removed_you...)
      // accounts that came back as mutuals are still real history but
      // shouldn't visually compete with truly-gone accounts. Sort them
      // to the bottom and dim them via the .is-came-back CSS class.
      const stillGone = items.filter((i) => i.relationship_kind !== "good");
      const cameBack = items.filter((i) => i.relationship_kind === "good");
      exportItems = stillGone.concat(cameBack);
      const html = [];
      if (stillGone.length) {
        html.push(stillGone.map(renderListRow).join(""));
      }
      if (cameBack.length) {
        html.push(`<div class="list-section came-back-section">Came back as mutual (${cameBack.length})</div>`);
        html.push(cameBack.map((i) => renderListRow(i).replace('class="list-row', 'class="list-row is-came-back')).join(""));
      }
      out.innerHTML = html.join("");
    } else {
      // Two visual-priority demotions, both move rows to the bottom of
      // the list while preserving the user's chosen sort within each
      // group:
      //
      // - "requesting to follow back" → transparent purple, the user
      //   doesn't want to unfollow someone with a pending request to
      //   them (CSS .is-requesting-back).
      // - "already unfollowed ✓" → transparent red, the action is done
      //   so the row is just history; the user wants to focus on the
      //   entries that still need action (CSS .is-already-unfollowed).
      //
      // Order: active rows → requesting-back → already-unfollowed.
      // Already-unfollowed sinks lowest because there's nothing to do
      // with those rows; requesting-back sits above them so the
      // pending-mutual cases stay visible without scrolling all the
      // way to the bottom.
      const isRequesting = (i) => i.relationship === "requesting to follow back";
      const isDone = (i) => i.bucket_status === "already unfollowed ✓";
      const active = items.filter((i) => !isRequesting(i) && !isDone(i));
      const requesting = items.filter((i) => isRequesting(i) && !isDone(i));
      const done = items.filter(isDone);
      const reordered = (requesting.length || done.length)
        ? active.concat(requesting, done)
        : items;
      exportItems = reordered;
      // Chunked render: paint first ~120 rows synchronously so the user
      // sees something immediately, then append the rest in 300-row
      // batches via requestAnimationFrame so the browser can layout +
      // paint between chunks. For short lists this is identical to the
      // single-pass render; only kicks in past the threshold.
      renderRowsChunked(out, reordered, renderListRow);
    }
    _currentListExportKind = kind;
    _currentListExportItems = exportItems;
    updateListExportButton();
    // Re-apply any active search after rendering so a sort change (which
    // re-renders the rows) keeps the filter live.
    applyListSearch();
    // Restore scroll position if a reload/back-forward set one. No-op
    // if no pending restore, or if the document isn't yet tall enough
    // (chunked renderer will retry on each chunk).
    _tryRestoreScroll();
    // Restore select-mode visual state after a re-render.
    if (_selectMode) {
      out.classList.add("select-mode");
      $$(".list-row", out).forEach((row) => {
        if (_selectedUsernames.has(row.dataset.username)) {
          row.setAttribute("aria-selected", "true");
        }
      });
    }
    // Per-row click handlers are bound once at module init via delegation
    // on #list-output, so rows added later by the chunked renderer still
    // respond. See the listOutput.addEventListener call near loadLists.
  } catch (e) {
    toast(`Lists failed: ${e.message}`);
  }
}

// ---------- bucket buttons ----------

// Bucket buttons are now anchors with href="#lists/<flag>", so cmd/ctrl-
// click and middle-click open a new tab natively via the browser. For
// plain clicks we suppress the navigation and SPA-route in place.
$$(".bucket-btn").forEach((btn) =>
  btn.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    goToList(btn.dataset.flag);
  })
);

// Notes card heading on the home page: same SPA-routing behavior as
// bucket pills. Clicks on the per-account links inside the card open
// the modal directly (handled in loadHome).
const notesCardLinkEl = $("#notes-card-link");
if (notesCardLinkEl) {
  notesCardLinkEl.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    goToList("with_notes");
  });
}

// ---------- follow queue ----------

async function loadQueue() {
  try {
    const data = await api.get("/api/followup");
    renderQueue(data.items || []);
  } catch (e) {
    console.error(e);
  }
}

function renderQueue(items) {
  const card = $("#queue-card");
  const list = $("#queue-list");
  const count = $("#queue-count");
  count.textContent = items.length;
  if (items.length === 0) {
    card.hidden = true;
    list.innerHTML = "";
    return;
  }
  card.hidden = false;
  list.innerHTML = items
    .map(
      (it) => `
        <div class="item bulk-row queue-item" data-username="${escapeAttr(it.username)}">
          <a class="bulk-name-link" href="${escapeAttr(instagramUrl(it.username))}" target="_blank" rel="noopener" data-action="open-and-remove">${escapeHtml(it.username)}</a>
          <button class="ghost-btn small" data-action="remove" title="Remove without opening">×</button>
        </div>`
    )
    .join("");
  $$(".queue-item", list).forEach((row) => {
    const username = row.dataset.username;
    const link = row.querySelector('[data-action="open-and-remove"]');
    if (link) {
      link.addEventListener("click", () => {
        // Let the link open Instagram; remove from queue right after.
        markQueueDone(username, row);
      });
    }
    const removeBtn = row.querySelector('[data-action="remove"]');
    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        markQueueDone(username, row);
      });
    }
  });
}

async function markQueueDone(username, rowEl) {
  try {
    await api.post("/api/followup/done", { username });
    if (rowEl) rowEl.remove();
    const remaining = $$(".queue-item").length;
    $("#queue-count").textContent = remaining;
    if (remaining === 0) $("#queue-card").hidden = true;
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

$("#queue-clear").addEventListener("click", async () => {
  if (!confirm("Clear the entire follow queue?")) return;
  try {
    await api.del("/api/followup");
    renderQueue([]);
    toast("Queue cleared");
  } catch (e) {
    toast(e.message);
  }
});

// ---------- history ----------

let _historyData = null;

async function loadHistory(force = false) {
  const chartEl = $("#history-chart");
  try {
    if (!_historyData || force) {
      if (chartEl) {
        chartEl.innerHTML = `<div class="loading-card"><span class="spinner"></span>Loading timeline…</div>`;
      }
      const data = await api.get("/api/timeline");
      _historyData = data.snapshots || [];
    }
    renderHistory();
    loadActivityLog(force);
  } catch (e) {
    if (chartEl) chartEl.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
}

let _activityData = null;

async function loadActivityLog(force = false) {
  const out = $("#activity-log");
  if (!out) return;
  try {
    if (!_activityData || force) {
      out.innerHTML = `<div class="loading-card"><span class="spinner"></span>Loading activity log…</div>`;
      const data = await api.get("/api/activity-log");
      _activityData = data.events || [];
    }
    renderActivityLog();
    renderActivityStats();
  } catch (e) {
    out.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
}

// Activity analytics — pure client-side reduction of _activityData.
// Conversion funnels and follow-back ratios are computed by joining
// events at the username level: each unique username's set of event
// kinds tells us whether a request became a follow, whether they
// followed back, etc. No new server endpoint needed in v1.
function renderActivityStats() {
  const wrap = $("#activity-stats");
  if (!wrap || !_activityData) return;
  const events = _activityData;
  if (!events.length) {
    wrap.innerHTML = `<div class="muted">No events yet. Import a few snapshots to populate analytics.</div>`;
    return;
  }
  // Per-username kind set: { username -> Set<kind> }. Lets us answer
  // "did THIS user ever transition X → Y?" without a SQL pass.
  const userKinds = new Map();
  const kindCounts = {};
  for (const e of events) {
    if (!e || !e.username) continue;
    if (!userKinds.has(e.username)) userKinds.set(e.username, new Set());
    userKinds.get(e.username).add(e.kind);
    kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  }
  const has = (u, k) => userKinds.get(u)?.has(k);

  // Outbound funnel: you sent a request (= private account, since
  // public profiles auto-accept without a request gate). Resolution
  // is one of:
  //   - they_accepted → they approved; you're now following them
  //   - pending_withdrawn → request disappeared without becoming a
  //     follow (rejected / expired / you cancelled — IG doesn't tell
  //     us which)
  //   - still pending → request hasn't resolved yet
  // The kind names here MUST match server.py:_activity_log_compute's
  // emit() call sites — using the wrong names gave us 0% rejected
  // even though pending_withdrawn fires 50+ times per import.
  let req_sent = 0, req_accepted = 0, req_rejected = 0, req_still_pending = 0;
  // Of the accepted ones, how many followed back?
  let accepted_back = 0;
  // Direct follow (public → no request gate, you just follow).
  let direct_follow = 0, direct_follow_back = 0;
  for (const [u, kinds] of userKinds) {
    if (kinds.has("you_requested")) {
      req_sent += 1;
      const resolved_accepted = kinds.has("they_accepted") || kinds.has("you_followed");
      const resolved_rejected = kinds.has("pending_withdrawn");
      if (resolved_accepted) {
        req_accepted += 1;
        if (kinds.has("new_follower")) accepted_back += 1;
      } else if (resolved_rejected) {
        req_rejected += 1;
      } else {
        req_still_pending += 1;
      }
    } else if (kinds.has("you_followed")) {
      // Followed without a request event = public-account direct follow.
      direct_follow += 1;
      if (kinds.has("new_follower")) direct_follow_back += 1;
    }
  }
  // "Interacted" = requests that finished one way or the other.
  // Excludes still-pending so percentages reflect actual outcomes
  // rather than being diluted by limbo cases.
  const req_interacted = req_accepted + req_rejected;

  // Inbound funnel: they sent YOU a request (which means YOU are
  // private — the request gate fires on the receiver's side). Same
  // resolution shape as outbound, mirrored.
  let inbound_received = 0, inbound_accepted = 0, inbound_dropped = 0, inbound_pending = 0;
  // Of those you accepted, how many did you follow back?
  let inbound_followed_back = 0;
  for (const [u, kinds] of userKinds) {
    if (kinds.has("new_incoming_request")) {
      inbound_received += 1;
      const resolved_accepted = kinds.has("you_accepted") || kinds.has("new_follower");
      const resolved_dropped = kinds.has("incoming_withdrawn");
      if (resolved_accepted) {
        inbound_accepted += 1;
        if (kinds.has("you_followed")) inbound_followed_back += 1;
      } else if (resolved_dropped) {
        inbound_dropped += 1;
      } else {
        inbound_pending += 1;
      }
    }
  }
  const inbound_interacted = inbound_accepted + inbound_dropped;

  // Reciprocity: total mutuals seen, partitioned by who acted first.
  // Without per-user timestamps, we approximate by checking whether
  // new_follower's earliest event predates you_followed's earliest.
  let mutuals_total = 0, you_first = 0, they_first = 0;
  for (const [u, kinds] of userKinds) {
    if (kinds.has("new_follower") && kinds.has("you_followed")) {
      mutuals_total += 1;
      // Find earliest timestamp for each side
      let theirTs = null, yourTs = null;
      for (const e of events) {
        if (e.username !== u) continue;
        if (e.kind === "new_follower" && (!theirTs || e.timestamp < theirTs)) theirTs = e.timestamp;
        if (e.kind === "you_followed" && (!yourTs || e.timestamp < yourTs)) yourTs = e.timestamp;
      }
      if (theirTs && yourTs) {
        if (theirTs < yourTs) they_first += 1;
        else if (yourTs < theirTs) you_first += 1;
      }
    }
  }

  // Net follower change. Kind names per server.py:_activity_log_compute:
  //   new_follower    — they followed you
  //   unfollowed_you  — they unfollowed
  //   removed_you     — they removed you as a follower (left following too)
  const new_followers = kindCounts.new_follower || 0;
  const lost_followers = (kindCounts.unfollowed_you || 0)
                       + (kindCounts.removed_you || 0);
  const net = new_followers - lost_followers;

  // Activity volume: events per day, last 30 days.
  const dayCounts = new Map();
  const today = new Date();
  const oldest = new Date(today.getTime() - 30 * 86400 * 1000);
  for (const e of events) {
    const day = (e.timestamp || "").slice(0, 10);
    if (!day) continue;
    if (new Date(day) < oldest) continue;
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  const days = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDay = Math.max(1, ...days.map((d) => d[1]));

  const pct = (num, den) => den ? `${Math.round((num / den) * 100)}%` : "—";

  wrap.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card">
        <div class="stats-card-h">🔒 Private requests (you sent)</div>
        <div class="stats-row"><span>Total sent</span><strong>${req_sent.toLocaleString()}</strong></div>
        <div class="stats-row"><span>Still pending</span><strong>${req_still_pending.toLocaleString()} <span class="stats-pct">${pct(req_still_pending, req_sent)}</span></strong></div>
        <div class="stats-row"><span>Interacted (resolved)</span><strong>${req_interacted.toLocaleString()} <span class="stats-pct">${pct(req_interacted, req_sent)}</span></strong></div>
        <div class="stats-row"><span>Accepted</span><strong>${req_accepted.toLocaleString()} <span class="stats-pct">${pct(req_accepted, req_interacted)} of interacted</span></strong></div>
        <div class="stats-row"><span>Rejected / withdrew</span><strong>${req_rejected.toLocaleString()} <span class="stats-pct">${pct(req_rejected, req_interacted)} of interacted</span></strong></div>
        <div class="stats-row"><span>Of accepted, followed back</span><strong>${accepted_back.toLocaleString()} <span class="stats-pct">${pct(accepted_back, req_accepted)}</span></strong></div>
        <div class="stats-row"><span>Of interacted, followed back</span><strong>${accepted_back.toLocaleString()} <span class="stats-pct">${pct(accepted_back, req_interacted)} of interacted</span></strong></div>
        <div class="stats-row stats-row-emph"><span>End-to-end mutual rate</span><strong>${accepted_back.toLocaleString()} <span class="stats-pct">${pct(accepted_back, req_sent)} of all sent</span></strong></div>
      </div>

      <div class="stats-card">
        <div class="stats-card-h">🌐 Public direct-follows</div>
        <div class="stats-row"><span>You followed (no request)</span><strong>${direct_follow.toLocaleString()}</strong></div>
        <div class="stats-row stats-row-emph"><span>Followed you back</span><strong>${direct_follow_back.toLocaleString()} <span class="stats-pct">${pct(direct_follow_back, direct_follow)}</span></strong></div>
      </div>

      <div class="stats-card">
        <div class="stats-card-h">📥 Inbound requests (they sent)</div>
        <div class="stats-row"><span>Total received</span><strong>${inbound_received.toLocaleString()}</strong></div>
        <div class="stats-row"><span>Still pending</span><strong>${inbound_pending.toLocaleString()} <span class="stats-pct">${pct(inbound_pending, inbound_received)}</span></strong></div>
        <div class="stats-row"><span>Interacted (resolved)</span><strong>${inbound_interacted.toLocaleString()} <span class="stats-pct">${pct(inbound_interacted, inbound_received)}</span></strong></div>
        <div class="stats-row"><span>You accepted</span><strong>${inbound_accepted.toLocaleString()} <span class="stats-pct">${pct(inbound_accepted, inbound_interacted)} of interacted</span></strong></div>
        <div class="stats-row"><span>Dropped / withdrawn</span><strong>${inbound_dropped.toLocaleString()} <span class="stats-pct">${pct(inbound_dropped, inbound_interacted)} of interacted</span></strong></div>
        <div class="stats-row"><span>Of accepted, you followed back</span><strong>${inbound_followed_back.toLocaleString()} <span class="stats-pct">${pct(inbound_followed_back, inbound_accepted)}</span></strong></div>
        <div class="stats-row stats-row-emph"><span>Of interacted, mutual</span><strong>${inbound_followed_back.toLocaleString()} <span class="stats-pct">${pct(inbound_followed_back, inbound_interacted)} of interacted</span></strong></div>
      </div>

      <div class="stats-card">
        <div class="stats-card-h">🤝 Mutual reciprocity</div>
        <div class="stats-row"><span>Mutuals seen (lifetime)</span><strong>${mutuals_total.toLocaleString()}</strong></div>
        <div class="stats-row"><span>🪄 They followed first</span><strong>${they_first.toLocaleString()} <span class="stats-pct">${pct(they_first, mutuals_total)}</span></strong></div>
        <div class="stats-row"><span>🪄 You followed first</span><strong>${you_first.toLocaleString()} <span class="stats-pct">${pct(you_first, mutuals_total)}</span></strong></div>
      </div>

      <div class="stats-card">
        <div class="stats-card-h">📈 Follower change</div>
        <div class="stats-row"><span>New followers (lifetime)</span><strong>${new_followers.toLocaleString()}</strong></div>
        <div class="stats-row"><span>Lost followers</span><strong>${lost_followers.toLocaleString()}</strong></div>
        <div class="stats-row stats-row-emph"><span>Net</span><strong class="${net >= 0 ? 'stats-good' : 'stats-bad'}">${net >= 0 ? '+' : ''}${net.toLocaleString()}</strong></div>
      </div>

      <div class="stats-card stats-card-wide">
        <div class="stats-card-h">📅 Last 30 days · events / day</div>
        <div class="stats-spark">
          ${days.length ? days.map(([d, c]) => `
            <div class="spark-col" title="${escapeAttr(d)}: ${c} events">
              <div class="spark-bar" style="height: ${Math.max(2, Math.round((c / maxDay) * 80))}px"></div>
              <div class="spark-label">${escapeHtml(d.slice(5))}</div>
            </div>
          `).join("") : `<div class="muted small">No events in the last 30 days.</div>`}
        </div>
      </div>
    </div>
  `;
}

// Per-kind label and color for the flat activity feed.
//
// Naming conventions:
//   "you …" / "they …" prefix makes the actor unambiguous at a glance.
//   "→" separates a request from its outcome; "·" separates clarifying
//   facts on the same step.
//   "rejected/expired/cancelled" — when IG just removes a request
//   without it becoming a follow, snapshot data alone can't tell us
//   which of the three it was. Labelling with all three is more honest
//   than "rejected" (the prior label, which was overconfident).
const ACTIVITY_KIND_META = {
  new_follower:         { label: "they followed you",                          cls: "good"  },
  unfollowed_you:       { label: "they unfollowed you",                        cls: "bad"   },
  you_followed:         { label: "you followed them",                          cls: "good"  },
  you_unfollowed:       { label: "you unfollowed them",                        cls: "muted" },
  removed_you:          { label: "they removed you as a follower",             cls: "bad"   },
  you_requested:        { label: "you requested → them",                       cls: "info"  },
  they_accepted:        { label: "they accepted your request",                 cls: "good"  },
  pending_withdrawn:    { label: "your request didn't go through (rejected/expired/cancelled)", cls: "muted" },
  new_incoming_request: { label: "they requested → you",                       cls: "info"  },
  you_accepted:         { label: "you accepted their request",                 cls: "good"  },
  incoming_withdrawn:   { label: "their request to you didn't go through (withdrawn/rejected/expired)", cls: "muted" },
};

// "Significant" is a meta-filter — clicking it activates the set of kinds
// that represent things that happened TO the user (unfollows, removals).
// Useful when scrolling the activity log to find what changed without
// being drowned in your own outbound actions.
const SIGNIFICANT_KINDS = new Set(["unfollowed_you", "removed_you"]);

const ACTIVITY_KIND_FILTERS = [
  "all", "significant",
  "new_follower", "unfollowed_you", "you_followed", "you_unfollowed",
  "removed_you", "you_requested", "they_accepted", "pending_withdrawn",
  "new_incoming_request", "you_accepted", "incoming_withdrawn",
];

const ACTIVITY_PSEUDO_LABELS = {
  all:         { label: "All",         cls: "muted" },
  significant: { label: "⚠ Significant (unfollowers)", cls: "bad" },
};

// Multi-select kind filter. Empty Set means "show all kinds" (the All chip
// is the implicit catch-all). Otherwise show only events whose kind is in
// the set.
let _activityKindFilter = new Set();
let _activityVisibleCap = 500;  // soft cap for initial paint; auto-extended on scroll
const _ACTIVITY_PAGE_SIZE = 500;
let _activityScrollObserver = null;

function parseActivityIso(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    );
  }
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

function fmtActivityDateTime(iso, { timeOnly = false } = {}) {
  const d = parseActivityIso(iso);
  if (!d) return (iso || "").slice(0, 16).replace("T", " ");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (timeOnly) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleString("en-US", sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function activityTimeDetail(e) {
  if (e.time_precision !== "bounded" || !e.time_lower_bound || !e.time_upper_bound) {
    return "";
  }
  const lo = parseActivityIso(e.time_lower_bound);
  const hi = parseActivityIso(e.time_upper_bound);
  if (!lo || !hi) {
    return `between ${fmtActivityDateTime(e.time_lower_bound)} and ${fmtActivityDateTime(e.time_upper_bound)}`;
  }
  const tFmt = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = lo.toDateString() === hi.toDateString();
  if (sameDay) {
    const today = new Date();
    const yest = new Date(today.getTime() - 86400 * 1000);
    if (lo.toDateString() === today.toDateString()) {
      return `between ${tFmt(lo)} and ${tFmt(hi)} today`;
    }
    if (lo.toDateString() === yest.toDateString()) {
      return `between ${tFmt(lo)} and ${tFmt(hi)} yesterday`;
    }
    const dayStr = lo.toLocaleDateString("en-US",
      lo.getFullYear() === today.getFullYear()
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" });
    return `between ${tFmt(lo)} and ${tFmt(hi)} on ${dayStr}`;
  }
  return `between ${fmtActivityDateTime(e.time_lower_bound)} and ${fmtActivityDateTime(e.time_upper_bound)}`;
}

function renderActivityLog() {
  const out = $("#activity-log");
  if (!out || !_activityData) return;
  const nameFilter = ($("#activity-filter")?.value || "").toLowerCase().trim();
  const kindFilter = _activityKindFilter;

  // Toolbar: chips for kind filter + total count. Multi-select — tapping
  // a kind chip toggles it; tapping All clears every kind back to the
  // unfiltered view. The All chip lights up only when no kinds are picked.
  const totalAll = _activityData.length;
  const noneSelected = kindFilter.size === 0;
  // "Significant" chip is active when the current kind filter is exactly
  // SIGNIFICANT_KINDS — same set, same size. Otherwise it's just a button.
  const significantActive = kindFilter.size === SIGNIFICANT_KINDS.size
    && [...SIGNIFICANT_KINDS].every((k) => kindFilter.has(k));
  const chips = ACTIVITY_KIND_FILTERS.map((k) => {
    const m = ACTIVITY_PSEUDO_LABELS[k] || ACTIVITY_KIND_META[k];
    let active;
    if (k === "all")              active = noneSelected;
    else if (k === "significant") active = significantActive;
    else                          active = kindFilter.has(k);
    return `<button type="button" class="al-chip al-${m.cls}${active ? " active" : ""}" data-kind="${k}">${escapeHtml(m.label)}</button>`;
  }).join("");

  // Filter events.
  const filtered = _activityData.filter((e) => {
    if (!noneSelected && !kindFilter.has(e.kind)) return false;
    if (nameFilter && !e.username.toLowerCase().includes(nameFilter)) return false;
    return true;
  });

  // Group by date for visual breaks (Today / Yesterday / older days).
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yest = new Date(today.getTime() - 86400 * 1000);
  const yestStr = yest.toISOString().slice(0, 10);
  const dayLabel = (iso) => {
    if (!iso) return "?";
    const d = iso.slice(0, 10);
    if (d === todayStr) return "Today";
    if (d === yestStr) return "Yesterday";
    const dt = new Date(d + "T12:00:00Z");
    if (isNaN(dt)) return d;
    const sameYear = dt.getUTCFullYear() === today.getUTCFullYear();
    return dt.toLocaleDateString("en-US", sameYear
      ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  };

  const limit = Math.min(filtered.length, _activityVisibleCap);
  const slice = filtered.slice(0, limit);

  let lastDay = "";
  const rowHtml = slice.map((e) => {
    const meta = ACTIVITY_KIND_META[e.kind] || { label: e.kind, cls: "muted" };
    const t = (e.timestamp || "").slice(0, 19);
    const day = t.slice(0, 10);
    const time = t.slice(11, 16) || "—";
    const detail = activityTimeDetail(e);
    let header = "";
    if (day !== lastDay) {
      lastDay = day;
      header = `<div class="al-day">${escapeHtml(dayLabel(t))}</div>`;
    }
    return header + `
      <div class="al-row clickable" data-username="${escapeAttr(e.username)}" title="Click for full account history">
        <span class="al-time-cell">${escapeHtml(time)}</span>
        <span class="al-kind-pill al-${meta.cls}">${escapeHtml(meta.label)}</span>
        <span class="al-name">${escapeHtml(e.username)}</span>
        ${detail ? `<span class="al-detail">${escapeHtml(detail)}</span>` : ""}
        <a class="al-open" href="https://www.instagram.com/${encodeURIComponent(e.username)}/" target="_blank" rel="noopener" title="Open on Instagram" onclick="event.stopPropagation()">↗</a>
      </div>
    `;
  }).join("");

  // Sentinel for auto-loading: when this element scrolls into view, we
  // bump the cap by another page. The button is still clickable as a
  // manual fallback for users who scroll past it before the observer
  // fires (or for whom IntersectionObserver is unavailable).
  const more = filtered.length > limit
    ? `<button type="button" class="ghost-btn al-more">Show ${Math.min(_ACTIVITY_PAGE_SIZE, filtered.length - limit)} more (${filtered.length - limit} remaining)</button>`
    : "";

  // Unique-accounts list: when exactly one kind is selected, show a
  // deduplicated summary above the chronological feed so the user can
  // see "the 30 distinct people who unfollowed me" at a glance instead
  // of scrolling through every per-event row. Hidden for All / multi-
  // selects / Significant preset (where the per-event view is the
  // natural primary view).
  const isExactlyOneKind = kindFilter.size === 1 && !significantActive;
  let uniqueListHtml = "";
  if (isExactlyOneKind) {
    const onlyKind = [...kindFilter][0];
    const onlyMeta = ACTIVITY_KIND_META[onlyKind] || { label: onlyKind, cls: "muted" };
    // Collapse to one row per username, keeping the newest event's
    // timestamp (events are already newest-first in _activityData).
    const seenUsers = new Set();
    const unique = [];
    for (const e of filtered) {
      if (seenUsers.has(e.username)) continue;
      seenUsers.add(e.username);
      unique.push(e);
    }
    const uniqueRows = unique.map((e) => {
      const t = activityTimeDetail(e) || (e.timestamp || "").slice(0, 16).replace("T", " ");
      return `
        <div class="al-unique-row clickable" data-username="${escapeAttr(e.username)}" title="Click for full account history">
          <span class="al-name">${escapeHtml(e.username)}</span>
          <span class="muted small">${escapeHtml(t)}</span>
          <a class="al-open" href="https://www.instagram.com/${encodeURIComponent(e.username)}/" target="_blank" rel="noopener" title="Open on Instagram" onclick="event.stopPropagation()">↗</a>
        </div>
      `;
    }).join("");
    uniqueListHtml = `
      <div class="al-unique-block">
        <div class="al-unique-head">
          <span class="al-kind-pill al-${onlyMeta.cls}">${escapeHtml(onlyMeta.label)}</span>
          <span>${unique.length} unique account${unique.length === 1 ? "" : "s"}</span>
          <span class="muted small">·  ${filtered.length} event${filtered.length === 1 ? "" : "s"} total</span>
        </div>
        <div class="al-unique-list">${uniqueRows || `<div class="muted">No matches.</div>`}</div>
      </div>
    `;
  }

  out.innerHTML = `
    <div class="al-toolbar">${chips}</div>
    <div class="muted small al-meta">${filtered.length === totalAll
      ? `${totalAll} events`
      : `${filtered.length} of ${totalAll} events`}</div>
    ${uniqueListHtml}
    ${rowHtml || `<div class="muted">No events match.</div>`}
    ${more}
  `;

  $$(".al-chip", out).forEach((el) =>
    el.addEventListener("click", () => {
      const k = el.dataset.kind;
      if (k === "all") {
        _activityKindFilter.clear();
      } else if (k === "significant") {
        // Toggle the significant-kinds preset. If currently active
        // (exact match), clear back to All. Otherwise replace the
        // filter with just SIGNIFICANT_KINDS.
        const isActive = _activityKindFilter.size === SIGNIFICANT_KINDS.size
          && [...SIGNIFICANT_KINDS].every((sk) => _activityKindFilter.has(sk));
        _activityKindFilter.clear();
        if (!isActive) SIGNIFICANT_KINDS.forEach((sk) => _activityKindFilter.add(sk));
      } else if (_activityKindFilter.has(k)) {
        _activityKindFilter.delete(k);
      } else {
        _activityKindFilter.add(k);
      }
      _activityVisibleCap = 500;
      renderActivityLog();
    })
  );
  // Whole row is clickable to open the account-detail modal — gives the
  // user "what happened with this account" context without having to
  // aim at the small username text.
  $$(".al-row.clickable, .al-unique-row.clickable", out).forEach((el) =>
    el.addEventListener("click", (e) => {
      // Don't fire when the user clicked the ↗ Open-on-Instagram link.
      if (e.target.closest(".al-open")) return;
      openAccountModal(el.dataset.username);
    })
  );
  // Disconnect any prior observer before rewiring — `out.innerHTML = ...`
  // above replaced the sentinel node, so the old observer is targeting a
  // detached element and would never fire again anyway, but explicit
  // cleanup avoids leaks.
  if (_activityScrollObserver) {
    _activityScrollObserver.disconnect();
    _activityScrollObserver = null;
  }
  const moreBtn = out.querySelector(".al-more");
  if (moreBtn) {
    const extend = () => {
      _activityVisibleCap += _ACTIVITY_PAGE_SIZE;
      renderActivityLog();
    };
    moreBtn.addEventListener("click", extend);
    // Auto-load when the sentinel is ~200px from entering the viewport.
    // Scroll-driven instead of click-driven means a user can keep scrolling
    // through 9k events without ever tapping the button. The 200px margin
    // gives the next chunk time to render before they hit the bottom.
    if (typeof IntersectionObserver !== "undefined") {
      _activityScrollObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            _activityScrollObserver.disconnect();
            _activityScrollObserver = null;
            extend();
            break;
          }
        }
      }, { rootMargin: "200px 0px" });
      _activityScrollObserver.observe(moreBtn);
    }
  }
}

// Username filter typeahead. Debounced so each keystroke doesn't trigger
// a full re-render of ~9k events; 120ms feels live but coalesces fast
// typing into one render. Cap reset belongs in the same handler — when
// the filter narrows, the previous cap is meaningless.
let _activityFilterTimer = null;
$("#activity-filter")?.addEventListener("input", () => {
  if (_activityFilterTimer) clearTimeout(_activityFilterTimer);
  _activityFilterTimer = setTimeout(() => {
    _activityFilterTimer = null;
    _activityVisibleCap = 500;
    renderActivityLog();
  }, 120);
});

// Series available in the chart. Sticky checkbox state persists across renders.
const HISTORY_SERIES = [
  { key: "followers",              label: "Followers",                color: "#4f8cff", on: true  },
  { key: "following",              label: "Following",                color: "#ffb454", on: true  },
  { key: "mutuals",                label: "Mutuals",                  color: "#3ecf8e", on: true  },
  { key: "pending",                label: "Pending (you sent)",       color: "#a78bfa", on: false },
  { key: "incoming",               label: "Pending (they sent)",      color: "#f472b6", on: false },
  { key: "cumulative_unfollowers", label: "Unfollowers (cumulative)", color: "#ff5e7a", on: false },
  // Per-snapshot deltas — count of NEW entries since previous snapshot.
  // Off by default to keep the initial chart clean; tick the boxes to
  // overlay them. Useful for spotting follow-burst days vs. quiet ones,
  // and the gap between "you requested" and "they accepted" cohorts.
  { key: "new_outgoing_requests",  label: "Δ You requested",          color: "#c084fc", on: false },
  { key: "new_follows",            label: "Δ You followed (accepted)", color: "#fbbf24", on: false },
  { key: "new_incoming_requests",  label: "Δ They requested back",    color: "#ec4899", on: false },
  { key: "new_followers",          label: "Δ They followed back",     color: "#34d399", on: false },
];
let _historyZoom = null;  // { fromIdx, toIdx } in the (range-filtered) snaps array

function buildSeriesCheckboxes() {
  const wrap = $("#history-series");
  if (!wrap) return;
  wrap.innerHTML = HISTORY_SERIES.map((s) =>
    `<label class="series-chk">
       <input type="checkbox" data-series="${s.key}"${s.on ? " checked" : ""} />
       <span class="swatch" style="background:${s.color}"></span>${s.label}
     </label>`
  ).join("");
  $$("input[data-series]", wrap).forEach((el) =>
    el.addEventListener("change", () => {
      const s = HISTORY_SERIES.find((x) => x.key === el.dataset.series);
      if (s) s.on = el.checked;
      renderHistory();
      // If a snapshot detail is currently shown, re-render it so the
      // visible-series filter for blocks/counts updates immediately.
      // Without this, toggling "Followers" off would shrink the chart
      // but leave the New-followers / They-unfollowed-you blocks
      // stranded below until the user re-clicked the same point.
      if (_lastHistoryDetail) {
        showHistoryDetail(_lastHistoryDetail.idx, _lastHistoryDetail.snaps);
      }
    })
  );
}
buildSeriesCheckboxes();

$("#history-range")?.addEventListener("change", () => {
  _historyZoom = null;
  $("#history-zoom-reset").hidden = true;
  renderHistory();
});
$("#history-zoom-reset")?.addEventListener("click", () => {
  _historyZoom = null;
  $("#history-zoom-reset").hidden = true;
  renderHistory();
});

function renderHistory() {
  if (!_historyData) return;
  const range = $("#history-range").value;
  // Filter by range (anchored on taken_at so out-of-order imports still respect "last 30 days").
  let snaps = _historyData;
  if (range !== "all") {
    const cutoff = Date.now() - parseInt(range, 10) * 86400 * 1000;
    snaps = snaps.filter((s) => Date.parse(s.taken_at || s.created_at) >= cutoff);
  }
  // Apply zoom (drag-selected sub-range) on top of the date range filter.
  if (_historyZoom && snaps.length > 0) {
    const a = Math.max(0, Math.min(_historyZoom.fromIdx, snaps.length - 1));
    const b = Math.max(0, Math.min(_historyZoom.toIdx, snaps.length - 1));
    snaps = snaps.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  if (snaps.length === 0) {
    $("#history-chart").innerHTML = `<div class="muted">No snapshots in this range.</div>`;
    $("#history-detail").innerHTML = "";
    return;
  }
  drawHistoryChart(snaps);
}

function drawHistoryChart(snaps) {
  const W = 760, H = 280, PAD_L = 50, PAD_R = 16, PAD_T = 16, PAD_B = 40;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  const visible = HISTORY_SERIES.filter((s) => s.on);
  if (visible.length === 0) {
    $("#history-chart").innerHTML = `<div class="muted">Pick at least one series above.</div>`;
    return;
  }

  const allYs = visible.flatMap((s) => snaps.map((p) => p[s.key]));
  const yMin = Math.min(...allYs);
  const yMax = Math.max(...allYs);
  const yPad = Math.max(1, Math.round((yMax - yMin) * 0.08));
  const yLo = Math.max(0, yMin - yPad);
  const yHi = yMax + yPad;

  const xScale = (i) => PAD_L + (snaps.length === 1 ? innerW / 2 : (i / (snaps.length - 1)) * innerW);
  const yScale = (v) => PAD_T + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;

  const yTicks = [];
  for (let t = 0; t <= 4; t++) {
    const v = yLo + (t / 4) * (yHi - yLo);
    yTicks.push({ v: Math.round(v), y: yScale(v) });
  }

  const xLabelCount = Math.min(6, snaps.length);
  const xLabels = [];
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.round((i / (xLabelCount - 1 || 1)) * (snaps.length - 1));
    const s = snaps[idx];
    xLabels.push({ x: xScale(idx), label: shortDate(s.taken_at || s.label || s.created_at) });
  }

  const linesSvg = visible.map((s) => {
    const d = snaps.map((p, i) =>
      `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p[s.key]).toFixed(1)}`
    ).join(" ");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" />`;
  }).join("");

  // One small dot per data point per visible series.
  const dotsSvg = snaps.map((p, i) =>
    visible.map((s) =>
      `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(p[s.key]).toFixed(1)}" r="2.5" fill="${s.color}" />`
    ).join("")
  ).join("");

  const yTicksSvg = yTicks.map((t) =>
    `<g><line x1="${PAD_L}" y1="${t.y}" x2="${W - PAD_R}" y2="${t.y}" stroke="var(--border)" stroke-width="1" />
     <text x="${PAD_L - 6}" y="${t.y + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${t.v}</text></g>`
  ).join("");

  const xLabelsSvg = xLabels.map((l) =>
    `<text x="${l.x}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(l.label)}</text>`
  ).join("");

  $("#history-chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="history-svg" preserveAspectRatio="xMidYMid meet">
      <rect class="brush-bg" x="${PAD_L}" y="${PAD_T}" width="${innerW}" height="${innerH}" fill="transparent" />
      ${yTicksSvg}
      ${linesSvg}
      ${dotsSvg}
      ${xLabelsSvg}
      <line class="hover-line" x1="0" y1="${PAD_T}" x2="0" y2="${PAD_T + innerH}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" opacity="0" pointer-events="none"/>
      <rect class="brush-rect" x="0" y="${PAD_T}" width="0" height="${innerH}" fill="var(--accent)" fill-opacity="0.15" stroke="var(--accent)" stroke-width="1" stroke-dasharray="2 2" pointer-events="none" />
    </svg>
    <div class="hover-tooltip" hidden></div>
  `;

  // Tap a data point: show that snapshot's diff in the existing detail card.
  // Brushing (drag) zooms instead of selecting a point — small drags (<6px)
  // are treated as taps so single clicks still work.
  attachChartInteractions($("#history-chart"), snaps, visible, {
    PAD_L, PAD_R, PAD_T, PAD_B, W, H, innerW, innerH, xScale, yScale,
  });
}

function attachChartInteractions(container, snaps, visible, geom) {
  const svg = container.querySelector("svg");
  const hoverLine = svg.querySelector(".hover-line");
  const brushRect = svg.querySelector(".brush-rect");
  const tooltip = container.querySelector(".hover-tooltip");
  let dragStart = null;  // { svgX, screenX }

  const indexAtSvgX = (svgX) => {
    const innerX = svgX - geom.PAD_L;
    const i = Math.round((innerX / geom.innerW) * (snaps.length - 1));
    return Math.max(0, Math.min(snaps.length - 1, i));
  };

  const eventToSvgX = (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    return pt.matrixTransform(inv).x;
  };

  const showTooltip = (i, clientX, clientY) => {
    const s = snaps[i];
    const lines = visible.map((sr) =>
      `<div><span class="swatch" style="background:${sr.color}"></span>${escapeHtml(sr.label)} <strong>${s[sr.key]}</strong></div>`
    ).join("");
    tooltip.innerHTML = `
      <div class="tt-time">${escapeHtml((s.taken_at || s.label || "").replace("T", " ").slice(0, 19))}</div>
      ${lines}
    `;
    tooltip.hidden = false;
    // Position relative to the chart container so it follows the cursor.
    const rect = container.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    let left = clientX - rect.left + 10;
    if (left + tw > rect.width - 4) left = clientX - rect.left - tw - 10;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${clientY - rect.top - tooltip.offsetHeight - 8}px`;
    // Position the dotted vertical line at the hovered x.
    const x = geom.xScale(i);
    hoverLine.setAttribute("x1", x);
    hoverLine.setAttribute("x2", x);
    hoverLine.setAttribute("opacity", "1");
  };

  const hideTooltip = () => {
    tooltip.hidden = true;
    hoverLine.setAttribute("opacity", "0");
  };

  svg.addEventListener("mousemove", (ev) => {
    const svgX = eventToSvgX(ev);
    if (svgX === null) return;
    const i = indexAtSvgX(svgX);
    showTooltip(i, ev.clientX, ev.clientY);
    if (dragStart !== null) {
      // Update brush rectangle while dragging.
      const a = Math.min(dragStart.svgX, svgX);
      const b = Math.max(dragStart.svgX, svgX);
      brushRect.setAttribute("x", Math.max(geom.PAD_L, a));
      brushRect.setAttribute("width", Math.min(geom.W - geom.PAD_R, b) - Math.max(geom.PAD_L, a));
    }
  });
  svg.addEventListener("mouseleave", hideTooltip);

  svg.addEventListener("mousedown", (ev) => {
    const svgX = eventToSvgX(ev);
    if (svgX === null) return;
    dragStart = { svgX, screenX: ev.clientX };
    brushRect.setAttribute("x", svgX);
    brushRect.setAttribute("width", 0);
  });

  const finishDrag = (ev) => {
    if (dragStart === null) return;
    const svgX = eventToSvgX(ev);
    const dx = svgX === null ? 0 : Math.abs(svgX - dragStart.svgX);
    if (svgX !== null && dx >= 6) {
      // Treat as a zoom gesture.
      const a = indexAtSvgX(Math.min(dragStart.svgX, svgX));
      const b = indexAtSvgX(Math.max(dragStart.svgX, svgX));
      _historyZoom = { fromIdx: a, toIdx: b };
      $("#history-zoom-reset").hidden = false;
      dragStart = null;
      brushRect.setAttribute("width", 0);
      renderHistory();
      return;
    }
    // Otherwise treat as a tap on the closest point.
    if (svgX !== null) {
      showHistoryDetail(indexAtSvgX(svgX), snaps);
    }
    dragStart = null;
    brushRect.setAttribute("width", 0);
  };
  svg.addEventListener("mouseup", finishDrag);
  // If the user drags off the SVG and releases, still finish.
  document.addEventListener("mouseup", (ev) => {
    if (dragStart !== null) finishDrag(ev);
  }, { once: false });

  // Touch support: treat single-tap as point-detail; drag as zoom.
  let touchStart = null;
  svg.addEventListener("touchstart", (ev) => {
    if (ev.touches.length !== 1) return;
    const t = ev.touches[0];
    const fakeEv = { clientX: t.clientX, clientY: t.clientY };
    const svgX = eventToSvgX(fakeEv);
    if (svgX === null) return;
    touchStart = { svgX, x: t.clientX };
    brushRect.setAttribute("x", svgX);
    brushRect.setAttribute("width", 0);
  });
  svg.addEventListener("touchmove", (ev) => {
    if (!touchStart || ev.touches.length !== 1) return;
    const t = ev.touches[0];
    const svgX = eventToSvgX({ clientX: t.clientX, clientY: t.clientY });
    if (svgX === null) return;
    const a = Math.min(touchStart.svgX, svgX);
    const b = Math.max(touchStart.svgX, svgX);
    brushRect.setAttribute("x", Math.max(geom.PAD_L, a));
    brushRect.setAttribute("width", Math.min(geom.W - geom.PAD_R, b) - Math.max(geom.PAD_L, a));
    showTooltip(indexAtSvgX(svgX), t.clientX, t.clientY);
  }, { passive: true });
  svg.addEventListener("touchend", (ev) => {
    if (!touchStart) return;
    const t = ev.changedTouches[0];
    const svgX = eventToSvgX({ clientX: t.clientX, clientY: t.clientY });
    const dx = svgX === null ? 0 : Math.abs(svgX - touchStart.svgX);
    if (svgX !== null && dx >= 12) {
      const a = indexAtSvgX(Math.min(touchStart.svgX, svgX));
      const b = indexAtSvgX(Math.max(touchStart.svgX, svgX));
      _historyZoom = { fromIdx: a, toIdx: b };
      $("#history-zoom-reset").hidden = false;
      touchStart = null;
      brushRect.setAttribute("width", 0);
      renderHistory();
      hideTooltip();
      return;
    }
    if (svgX !== null) showHistoryDetail(indexAtSvgX(svgX), snaps);
    touchStart = null;
    brushRect.setAttribute("width", 0);
    hideTooltip();
  });
}

function shortDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s).slice(0, 10);
  const [_, y, mo, d] = m;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(mo, 10) - 1]} ${parseInt(d, 10)}`;
}

// Map each detail-panel block to the chart series it relates to. The
// detail panel filters its blocks based on which series are currently
// visible in the chart legend, so checking only "Followers" hides the
// following / pending / mutuals blocks. Picking one box shows only
// that box; picking multiple shows all matching blocks. If no series
// are visible (rare — chart shows a "pick at least one" message in
// that case), the detail panel falls back to showing everything.
const HISTORY_DETAIL_BLOCK_TO_SERIES = {
  new_followers:               ["followers", "mutuals", "new_followers"],
  they_unfollowed_you:         ["followers", "mutuals", "cumulative_unfollowers"],
  you_removed_as_follower:     ["followers", "mutuals"],
  new_following:               ["following", "mutuals", "new_follows"],
  you_unfollowed:              ["following", "mutuals"],
  they_removed_you_as_follower: ["following", "mutuals"],
  new_pending:                 ["pending", "new_outgoing_requests"],
  resolved_pending:            ["pending", "new_follows"],
};
// Same idea for the four count cards at the top of the detail panel.
const HISTORY_DETAIL_COUNT_TO_SERIES = {
  followers: ["followers", "new_followers"],
  following: ["following", "new_follows"],
  mutuals:   ["mutuals"],
  pending:   ["pending", "new_outgoing_requests"],
};

function _historyVisibleSeriesKeys() {
  const visible = HISTORY_SERIES.filter((s) => s.on).map((s) => s.key);
  // If somehow nothing is visible, treat as "show everything" — better
  // than blanking the detail panel after a click.
  return visible.length ? new Set(visible) : null;
}
function _detailBlockShouldShow(blockKey, visible) {
  if (!visible) return true;
  const mapped = HISTORY_DETAIL_BLOCK_TO_SERIES[blockKey];
  if (!mapped) return true;
  return mapped.some((s) => visible.has(s));
}
function _detailCountShouldShow(countKey, visible) {
  if (!visible) return true;
  const mapped = HISTORY_DETAIL_COUNT_TO_SERIES[countKey];
  if (!mapped) return true;
  return mapped.some((s) => visible.has(s));
}

// Tracks the most-recently-rendered detail panel so a series-checkbox
// toggle can re-render it in place without the user having to re-click
// the same snapshot point.
let _lastHistoryDetail = null;

async function showHistoryDetail(idx, snaps) {
  _lastHistoryDetail = { idx, snaps };
  const curr = snaps[idx];
  const prev = idx > 0 ? snaps[idx - 1] : null;
  const dF = prev ? curr.followers - prev.followers : 0;
  const dG = prev ? curr.following - prev.following : 0;
  const dM = prev ? curr.mutuals  - prev.mutuals  : 0;
  const dP = prev ? curr.pending  - prev.pending  : 0;
  const arrow = (n) => n > 0 ? `<span class="up">+${n}</span>` : n < 0 ? `<span class="down">${n}</span>` : `<span class="muted">±0</span>`;

  const visibleSeries = _historyVisibleSeriesKeys();

  let diffHtml = "";
  if (prev) {
    try {
      const d = await api.get(`/api/diff?old=${prev.snapshot_id}&new=${curr.snapshot_id}`);
      const sec = d.sections || {};
      const block = (blockKey, title, list, max = 8) => {
        if (!_detailBlockShouldShow(blockKey, visibleSeries)) return "";
        if (!list || !list.length) return "";
        const shown = list.slice(0, max);
        const more = list.length > max ? ` <span class="muted">+${list.length - max} more</span>` : "";
        return `<div class="diff-block"><strong>${title}</strong> (${list.length})<div>${shown.map((u) => `<span class="diff-name" data-username="${escapeAttr(u)}">${escapeHtml(u)}<a class="diff-link" href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener" title="Open on Instagram">↗</a></span>`).join(" ")}${more}</div></div>`;
      };
      diffHtml = `
        ${block("new_followers", "New followers", sec.new_followers)}
        ${block("they_unfollowed_you", "They unfollowed you", sec.they_unfollowed_you)}
        ${block("you_removed_as_follower", "You removed them as a follower", sec.you_removed_as_follower)}
        ${block("new_following", "New following (you followed)", sec.new_following)}
        ${block("you_unfollowed", "You unfollowed", sec.you_unfollowed)}
        ${block("they_removed_you_as_follower", "They removed you as a follower", sec.they_removed_you_as_follower)}
        ${block("new_pending", "New pending requests", sec.new_pending)}
        ${block("resolved_pending", "Resolved pending", sec.resolved_pending)}
      `;
      if (!diffHtml.trim()) {
        diffHtml = `<div class="muted">No matching changes for the visible series. Tick more series above to see other categories.</div>`;
      }
    } catch (e) {
      diffHtml = `<div class="muted">Diff unavailable: ${escapeHtml(e.message)}</div>`;
    }
  } else {
    diffHtml = `<div class="muted">First snapshot in range — nothing to diff against.</div>`;
  }

  // Count cards mirror the same series-filtering rule. Hide cards
  // whose series isn't visible so a single-series view stays focused
  // (e.g. only "Followers" checked → only the followers count + the
  // followers-related diff blocks render).
  const countCard = (key, label, value, delta) => {
    if (!_detailCountShouldShow(key, visibleSeries)) return "";
    return `<div>${label} <strong>${value}</strong> ${prev ? arrow(delta) : ""}</div>`;
  };
  const countsHtml = `
    ${countCard("followers", "Followers", curr.followers, dF)}
    ${countCard("following", "Following", curr.following, dG)}
    ${countCard("mutuals", "Mutuals", curr.mutuals, dM)}
    ${countCard("pending", "Pending", curr.pending, dP)}
  `;

  $("#history-detail").innerHTML = `
    <div class="history-snapshot">
      <h3>#${curr.snapshot_id} · ${escapeHtml(cleanLabel(curr.label) || curr.created_at)}</h3>
      <div class="history-counts">${countsHtml}</div>
      ${diffHtml}
    </div>
  `;
}

// ---------- snapshots ----------

async function loadSnapshots() {
  try {
    const list = await api.get("/api/snapshots");
    const ul = $("#snapshot-list");
    const card = $("#imports-card");
    const countPill = $("#imports-count");
    if (!ul) return;
    if (countPill) countPill.textContent = String(list.length);
    if (card) card.hidden = list.length === 0;
    if (list.length === 0) {
      ul.innerHTML = `<li class="muted">No imports yet.</li>`;
      return;
    }
    ul.innerHTML = list
      .slice()
      .reverse()
      .map(
        (s) => `
          <li>
            <div class="meta">
              <div class="label">#${s.id} ${escapeHtml(cleanLabel(s.label) || "(no label)")}</div>
              <div class="ts">${escapeHtml(fmtRelativeDate(s.created_at))}</div>
            </div>
            <button class="delete-btn" data-id="${s.id}">Delete</button>
          </li>`
      )
      .join("");
    $$(".delete-btn", ul).forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm(`Delete snapshot #${btn.dataset.id}? This can't be undone.`)) return;
        try {
          await api.del(`/api/snapshots/${btn.dataset.id}`);
          toast(`Deleted #${btn.dataset.id}`);
          await loadSnapshots();
          await loadHome();
        } catch (e) {
          toast(e.message);
        }
      })
    );
  } catch (e) {
    toast(`Snapshots failed: ${e.message}`);
  }
}

// ---------- escaping ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---------- boot ----------

// Resolve URL-hash / saved-state routing FIRST so that on a fresh
// new-tab open of /#lists/<kind> OR a reload while on a non-home view,
// we navigate there directly instead of painting Home underneath. If
// bootstrap landed us on Home, kick off the home fetch; otherwise the
// destination view's loader (loadLists / loadHistory / etc.) is
// already firing inside showView/goToList. bootstrapHistory may call
// goToList (which uses const-declared `select` etc.), so it has to
// run after all the declarations above have initialized.
const _bootView = bootstrapHistory();
if (_bootView === "home") loadHome();
// We still want home data warm for the snapshot pill etc., even when
// the user lands on lists/history. Fetch it lazily so the visible view
// gets the network slot first.
else setTimeout(loadHome, 250);

// Allow ?lookup=<username|url> to auto-open a lookup. Used by iOS Shortcuts and bookmarklets.
(function autoLookupFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("lookup") || params.get("check") || params.get("u");
  if (!target) return;
  window.history.replaceState({}, "", window.location.pathname);
  showView("check");
  $("#lookup-input").value = target;
  openAccount(target, { resultId: "lookup-result", saveToQueue: false });
})();
