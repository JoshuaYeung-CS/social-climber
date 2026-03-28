"use strict";

// ---------- tiny helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
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

function fmtRelativeDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ---------- view switching ----------

function showView(name, push = true) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  if (name === "lists") loadLists();
  if (name === "snapshots") loadSnapshots();
  if (name === "check") loadQueue();
  if (name === "history") loadHistory();
  if (push) {
    const state = history.state || {};
    if (state.view !== name || state.listKind) {
      history.pushState({ view: name }, "", `#${name}`);
    }
  }
}

$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ---------- home ----------

async function loadHome() {
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
        ["Ever removed you as follower", s.ever_removed_you_as_follower ?? 0, "ever_removed_you_as_follower"],
        ["You ever unfollowed", s.ever_you_unfollowed ?? 0, "you_unfollowed_ever"],
        ["You still follow them after they unfollowed you", s.still_follow_after_drop ?? 0, "still_follow_after_drop"],
        ["⚠ Tagged disabled", s.disabled_tagged ?? 0, "disabled"],
        ["✕ Tagged unavailable", s.unavailable_tagged ?? 0, "unavailable"],
      ];
      for (const [label, value, listKind] of stats) {
        const div = document.createElement("div");
        div.className = "stat clickable";
        div.dataset.listKind = listKind;
        div.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
        div.addEventListener("click", () => goToList(listKind));
        grid.appendChild(div);
      }
    } else {
      summaryCard.hidden = true;
    }

    const alertsCard = $("#alerts-card");
    const alertsList = $("#alerts-list");
    const all = [...(data.alerts.diff || []), ...(data.alerts.stateful || [])];
    if (all.length === 0) {
      alertsCard.hidden = true;
    } else {
      alertsCard.hidden = false;
      alertsList.innerHTML = "";
      for (const a of all) {
        const li = document.createElement("li");
        li.className = a.severity || "normal";
        li.innerHTML = `<span>${escapeHtml(a.message)}</span>`;
        const btn = document.createElement("button");
        btn.className = "open-btn";
        btn.textContent = "Open";
        btn.addEventListener("click", () => openAccountModal(a.username));
        li.appendChild(btn);
        alertsList.appendChild(li);
      }
    }

    $("#count-favorite").textContent = data.bucket_counts.favorites;
    $("#count-want_remove").textContent = data.bucket_counts.want_remove;
    $("#count-watchlist").textContent = data.bucket_counts.watchlist;
    $("#count-disabled").textContent = data.bucket_counts.disabled ?? 0;
    $("#count-unavailable").textContent = data.bucket_counts.unavailable ?? 0;
  } catch (e) {
    console.error(e);
    toast(`Couldn't load home: ${e.message}`);
  }
}

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

async function doImport(file) {
  const status = $("#import-status");
  status.innerHTML = `<span class="pending"><span class="spinner"></span>Importing ${escapeHtml(file.name)}…</span>`;
  try {
    const result = await api.upload(file);
    const lines = result.imports.map((r) => {
      let line = `<div class="ok">✓ Imported snapshot #${r.snapshot_id} (${escapeHtml(cleanLabel(r.label))}) — ${r.counts.followers} followers, ${r.counts.following} following</div>`;
      if (r.missing_files && r.missing_files.length) {
        line += `<div class="warn-box">⚠ Instagram's export was missing the following file${r.missing_files.length === 1 ? "" : "s"}:<ul>${r.missing_files.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>That data will be empty for this snapshot. Try re-requesting the export from Instagram if you need it.</div>`;
      }
      return line;
    });
    for (const s of (result.skipped || [])) {
      const icon = s.reason === "duplicate" ? "↩" : "⚠";
      lines.push(`<div class="warn-box">${icon} Skipped ${escapeHtml(cleanLabel(s.label))}: ${escapeHtml(s.message)}</div>`);
    }
    status.innerHTML = lines.join("");
    _historyData = null;  // invalidate so the next History view refetches
    await loadHome();
    const imported = result.imports.length;
    const skipped = (result.skipped || []).length;
    if (imported === 0 && skipped > 0) {
      const reason = result.skipped[0].reason === "duplicate" ? "duplicate" : "older than existing snapshots";
      toast(`Skipped — ${reason}`);
    } else {
      const warned = result.imports.some((r) => r.missing_files && r.missing_files.length);
      const skipNote = skipped ? `, ${skipped} skipped` : "";
      toast(warned
        ? `Imported, but Instagram dropped some files${skipNote}`
        : `Imported ${imported} snapshot${imported === 1 ? "" : "s"}${skipNote}`);
    }
  } catch (e) {
    status.innerHTML = `<div class="err">✗ ${escapeHtml(e.message)}</div>`;
  }
}

// ---------- lookup ----------

$("#check-go").addEventListener("click", runCheck);
$("#check-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && $("#check-input").value.split(/\n/).filter((l) => l.trim()).length <= 1) {
    e.preventDefault();
    runCheck();
  }
});

async function runCheck() {
  const text = $("#check-input").value;
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return;

  const out = $("#check-result");
  if (lines.length === 1) {
    // Single account: full detail view.
    await openAccount(lines[0]);
  } else {
    try {
      const data = await api.post("/api/filter-list", { text });
      out.innerHTML = renderBulkResult(data);
      if (data.queue_added) {
        toast(`Added ${data.queue_added} to follow queue (${data.queue_total} total)`);
      }
      loadQueue();
      $$(".clickable-name", out).forEach((el) =>
        el.addEventListener("click", () => openAccountModal(el.dataset.username))
      );
      const copyBtn = $("#copy-pruned");
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

  return `
    <div class="result-section">
      <h3>Already seen (${data.seen.length})</h3>
      <p class="muted small">Tap name for history · arrow opens Instagram.</p>
      <div class="result-list">${
        groupedSeen.map(seenRow).join("") || "<div class=\"item muted\">(none)</div>"
      }</div>
    </div>
    <div class="result-section">
      <h3>New to you (${data.new.length})</h3>
      <p class="muted small">Never followed, never requested, never a follower of yours. Safe to follow fresh.</p>
      <div class="result-list">${
        data.new.map(newRow).join("") || "<div class=\"item muted\">(none)</div>"
      }</div>
    </div>
    ${data.invalid.length ? `<div class="result-section"><h3>Couldn't parse (${data.invalid.length})</h3><div class="result-list">${data.invalid.map((i) => `<div class="item">${escapeHtml(i.input)} — ${escapeHtml(i.error)}</div>`).join("")}</div></div>` : ""}
    ${data.new.length ? `<button class="primary" id="copy-pruned">Copy new-only list to clipboard</button>` : ""}
  `;
}

async function openAccount(account) {
  try {
    const data = await api.get(`/api/lookup?account=${encodeURIComponent(account)}`);
    const result = $("#check-result");
    result.innerHTML = renderLookup(data);
    bindTagToggles(result, data.username, data.tags);

    // Single-account check: if truly never seen, queue them up like a bulk new entry.
    if (data.found === false) {
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
        // Non-fatal — lookup still shows.
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
    return `
      <div class="account-detail">
        <h3>${escapeHtml(data.username)}</h3>
        <div class="url"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
        <p class="muted">Never seen in any snapshot.</p>
        ${renderTagToggles(data.tags)}
      </div>
    `;
  }
  return `
    <div class="account-detail">
      <h3>${escapeHtml(data.username)}</h3>
      <div class="url"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
      ${renderTagToggles(data.tags)}
      ${data.aliases && data.aliases.length > 1 ? `<div class="warn-banner info-banner">↪ This account has been renamed. Aliases (oldest → newest): ${data.aliases.map((a) => a === data.username ? `<strong>${escapeHtml(a)}</strong>` : escapeHtml(a)).join(" → ")}</div>` : ""}
      ${data.follow_runs_count > 1 ? `<div class="warn-banner">⚠ You've followed this person <strong>${data.follow_runs_count} separate times</strong> across history.</div>` : ""}
      ${data.follower_runs_count > 1 ? `<div class="warn-banner">⚠ They've followed you <strong>${data.follower_runs_count} separate times</strong> across history.</div>` : ""}
      <div class="facts">
        ${data.privacy && data.privacy !== "unknown" ? `<div class="row"><span class="key">Privacy</span><span>${data.privacy === "likely_private" ? "🔒 likely private" : "🌐 likely public"}</span></div>` : ""}
        <div class="row"><span class="key">Ever followed</span><span>${data.ever_followed ? `yes (${data.follow_runs_count}× run${data.follow_runs_count === 1 ? "" : "s"})` : "no"}</span></div>
        <div class="row"><span class="key">Ever requested</span><span>${data.ever_requested ? "yes" : "no"}</span></div>
        <div class="row"><span class="key">Ever followed you</span><span>${data.ever_was_follower ? `yes (${data.follower_runs_count}× run${data.follower_runs_count === 1 ? "" : "s"})` : "no"}</span></div>
        ${data.first_followed_snapshot ? `<div class="row"><span class="key">First in following</span><span>#${data.first_followed_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.first_followed_snapshot.label))}</span></div>` : ""}
        ${data.last_followed_snapshot ? `<div class="row"><span class="key">Last in following</span><span>#${data.last_followed_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.last_followed_snapshot.label))}</span></div>` : ""}
        ${data.first_requested_snapshot ? `<div class="row"><span class="key">First requested</span><span>#${data.first_requested_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.first_requested_snapshot.label))}</span></div>` : ""}
        ${data.last_requested_snapshot ? `<div class="row"><span class="key">Last requested</span><span>#${data.last_requested_snapshot.snapshot_id} ${escapeHtml(cleanLabel(data.last_requested_snapshot.label))}</span></div>` : ""}
      </div>
      <button class="primary" data-action="show-history" data-username="${escapeAttr(data.username)}">Show full history</button>
    </div>
  `;
}

function renderTagToggles(tags) {
  return `
    <div class="tag-toggles">
      <button class="tag-toggle ${tags.favorite ? "active" : ""}" data-flag="favorite">★ Favorite</button>
      <button class="tag-toggle ${tags.want_remove ? "active" : ""}" data-flag="want_remove">✦ Want-remove</button>
      <button class="tag-toggle ${tags.watchlist ? "active" : ""}" data-flag="watchlist">↺ Wait-back</button>
      <button class="tag-toggle ${tags.disabled ? "active" : ""}" data-flag="disabled">⚠ Disabled</button>
      <button class="tag-toggle ${tags.unavailable ? "active" : ""}" data-flag="unavailable">✕ Unavailable</button>
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
        loadHome();
      } catch (e) {
        toast(`Failed: ${e.message}`);
      }
    });
  });
  const histBtn = root.querySelector('[data-action="show-history"]');
  if (histBtn) histBtn.addEventListener("click", () => showHistory(histBtn.dataset.username));
}

// ---------- account modal (used from list/alert clicks) ----------

const modal = $("#account-modal");
function closeModal() {
  if (history.state?.modal) {
    history.back();
  } else {
    modal.hidden = true;
  }
  if (modalTaggedDirty) {
    modalTaggedDirty = false;
    // Refresh whichever data view the user is on, so newly tagged accounts are reflected.
    const view = history.state?.view || "lists";
    if (view === "lists") loadLists();
    else if (view === "home") loadHome();
  }
}
$$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

// Browser back/forward integration.
window.addEventListener("popstate", (e) => {
  const state = e.state || {};
  // If popping out of a modal, hide it.
  if (!modal.hidden && !state.modal) modal.hidden = true;
  // If popping INTO a modal (forward), reopen it.
  if (modal.hidden && state.modal) {
    openAccountModal(state.modal, false);
  }
  // Restore view + list kind.
  const view = state.view || "home";
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
  if (view === "lists") {
    if (state.listKind && [...select.options].some((o) => o.value === state.listKind)) {
      select.value = state.listKind;
    }
    loadLists();
  } else if (view === "snapshots") loadSnapshots();
  else if (view === "check") loadQueue();
  else if (view === "home") loadHome();
  // Modal close via popstate already triggered a refresh; clear the dirty flag.
  modalTaggedDirty = false;
});

// Bootstrap initial state from URL hash.
(function bootstrapHistory() {
  if (!history.state) {
    const hash = location.hash.slice(1);
    if (hash) {
      const [view, kind] = hash.split("/");
      if (view) {
        if (view === "lists" && kind) {
          history.replaceState({ view: "lists", listKind: kind }, "", `#lists/${kind}`);
          showView("lists", false);
          if ([...select.options].some((o) => o.value === kind)) select.value = kind;
          loadLists();
          return;
        }
        history.replaceState({ view }, "", `#${view}`);
        showView(view, false);
        return;
      }
    }
    history.replaceState({ view: "home" }, "", "");
  }
})();

async function openAccountModal(username, push = true) {
  try {
    const data = await api.get(`/api/lookup?account=${encodeURIComponent(username)}`);
    $("#account-detail").innerHTML = renderLookup(data);
    bindTagToggles($("#account-detail"), data.username, data.tags);
    modal.hidden = false;
    if (push) {
      history.pushState({ modal: username, view: history.state?.view, listKind: history.state?.listKind }, "", "");
    }
  } catch (e) {
    toast(`Couldn't open ${username}: ${e.message}`);
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

const LIST_KINDS = [
  ["everyone", "Everyone (search-friendly)"],
  ["all_followers", "All followers"],
  ["all_following", "All following"],
  ["mutuals", "Mutuals"],
  ["not_following_you_back", "Don't follow you back"],
  ["feeder_accounts", "Feeder accounts (follow you, you don't)"],
  ["pending", "Pending requests you sent"],
  ["ever_unfollowed_you", "Ever unfollowed you"],
  ["ever_removed_you_as_follower", "Ever removed you as a follower"],
  ["you_unfollowed_ever", "You ever unfollowed"],
  ["still_follow_after_drop", "You still follow people who unfollowed you"],
  ["renamed", "Renamed accounts"],
  ["recent_follow_requests", "Recent follow requests"],
  ["recently_unfollowed", "Recently unfollowed by you"],
  ["favorite", "★ Favorites"],
  ["want_remove", "✦ Want to remove"],
  ["watchlist", "↺ Wait-back"],
  ["disabled", "⚠ Disabled"],
  ["unavailable", "✕ Unavailable (page not found)"],
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
}
buildListKindOptions();
select.addEventListener("change", () => {
  // Reset the search when switching lists — different lists, different content.
  searchInput.value = "";
  searchClear.hidden = true;
  loadLists();
});

const sortSelect = $("#list-sort");
sortSelect.addEventListener("change", loadLists);

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
    return;
  }
  let visible = 0;
  for (const row of rows) {
    const hay = row.dataset.search || (row.dataset.username || "").toLowerCase();
    const show = q === "" || hay.includes(q);
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
  if (q === "") {
    searchCount.hidden = true;
  } else {
    searchCount.hidden = false;
    searchCount.textContent = visible === rows.length
      ? `${rows.length} matches`
      : `Showing ${visible} of ${rows.length}`;
  }
}

searchInput.addEventListener("input", applyListSearch);
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

// Pick the "when did this happen" date for a row, used for chronological sorts.
// Server populates the right field per list-kind context, so we just walk a
// fallback chain: most-meaningful event date first. Returns "" so missing
// values sort to the end naturally.
function rowDateKey(r) {
  return (
    r.unfollowed_by_you_at ||
    r.removed_you_at ||
    r.last_followed_you_at ||
    r.mutual_since_at ||
    r.followed_at ||
    r.first_followed_you_at ||
    r.pending_since_at ||
    ""
  );
}

// Sort dropdown labels adapt to the list you're on. For unfollow lists the
// chronological field is the unfollow date; for "who follows me" lists it's
// the follow-back date; etc. Falling back to generic newest/oldest text when
// the list doesn't have a clean event verb.
const SORT_LABELS = {
  // followed_at-based (you started following them)
  all_following:           { newest: "Most recently followed",     oldest: "Earliest followed" },
  still_follow_after_drop: { newest: "Most recently followed",     oldest: "Earliest followed" },
  // mutual_since_at-based
  mutuals:                 { newest: "Most recent mutual",         oldest: "Earliest mutual" },
  // last_followed_you_at-based (they unfollowed you)
  not_following_you_back:        { newest: "Most recently stopped",     oldest: "Earliest stopped" },
  ever_unfollowed_you:           { newest: "Most recently unfollowed",  oldest: "Earliest unfollowed" },
  ever_removed_you_as_follower:  { newest: "Most recently removed",     oldest: "Earliest removed" },
  // unfollowed_by_you_at-based (you unfollowed them)
  you_unfollowed_ever:   { newest: "Most recently unfollowed", oldest: "Earliest unfollowed" },
  recently_unfollowed:   { newest: "Most recently unfollowed", oldest: "Earliest unfollowed" },
  // first_followed_you_at-based
  all_followers:    { newest: "Most recently followed you", oldest: "Earliest followed you" },
  feeder_accounts:  { newest: "Most recently followed you", oldest: "Earliest followed you" },
  // pending
  pending:               { newest: "Most recent request",   oldest: "Earliest request" },
  recent_follow_requests:{ newest: "Most recent request",   oldest: "Earliest request" },
};

function refreshSortLabels(kind) {
  const labels = SORT_LABELS[kind] || { newest: "Newest first", oldest: "Oldest first" };
  const opts = sortSelect.options;
  for (const opt of opts) {
    if (opt.value === "reverse_chronological") opt.textContent = labels.newest;
    else if (opt.value === "chronological")    opt.textContent = labels.oldest;
    else if (opt.value === "alphabetical")     opt.textContent = "A → Z";
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
    if (!ad && !bd) return a.username.localeCompare(b.username);
    if (!ad) return 1;
    if (!bd) return -1;
    const cmp = reverse ? bd.localeCompare(ad) : ad.localeCompare(bd);
    return cmp || a.username.localeCompare(b.username);
  });
  return arr;
}

function renderListRow(item) {
  // Build the small grey sub-line and the right-side chip.
  let sub = "";
  let chip = "";
  let chipClass = "timing";
  let rowClass = "";

  // Build sub-line: chronological story of the relationship.
  const parts = [];
  if (item.followed_at) parts.push(`you followed ${escapeHtml(fmtDate(item.followed_at))}`);
  if (item.mutual_since_at) parts.push(`mutual since ${escapeHtml(fmtDate(item.mutual_since_at))}`);
  if (item.pending_since_at) parts.push(`requested ${escapeHtml(fmtDate(item.pending_since_at))}`);
  if (item.history_status === "re-engaged") parts.push(`<span class="info-tag">re-engaged</span>`);
  if (item.privacy === "likely_private") parts.push(`<span class="privacy-tag privacy-private">🔒 likely private</span>`);
  else if (item.privacy === "likely_public") parts.push(`<span class="privacy-tag privacy-public">🌐 likely public</span>`);
  if (item.aliases && item.aliases.length > 1) parts.push(`<span class="info-tag">renamed: ${escapeHtml(item.aliases.join(' → '))}</span>`);
  if (item.ever_followed_you === false) parts.push(`<span class="never">never followed back</span>`);
  else if (item.ever_followed_you === true && item.last_followed_you_at) parts.push(`stopped following you on ${escapeHtml(fmtDate(item.last_followed_you_at))}`);
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
  const tagButtons = `
    ${tagBtn("favorite", "★", item.favorite)}
    ${tagBtn("want_remove", "✦", item.want_remove)}
    ${tagBtn("watchlist", "↺", item.watchlist)}
    ${tagBtn("disabled", "⚠", item.disabled)}
    ${tagBtn("unavailable", "✕", item.unavailable)}
  `;

  // Searchable haystack: current username + any past aliases (rename chain),
  // lowercased and pipe-joined. Lets the per-list search match a renamed
  // account by its old handle.
  const aliasList = (item.aliases && item.aliases.length > 0) ? item.aliases : [item.username];
  const haystack = aliasList.map((a) => String(a).toLowerCase()).join("|");

  return `
    <div class="list-row${rowClass ? " " + rowClass : ""}" data-username="${escapeAttr(item.username)}" data-search="${escapeAttr(haystack)}">
      <div class="username-block">
        <span class="username">${escapeHtml(item.username)}</span>
        ${sub ? `<span class="sub">${sub}</span>` : ""}
      </div>
      ${chip ? `<span class="${chipClass}">${chip}</span>` : ""}
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

function fmtAgo(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
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

// kept for backward compat where called from older code paths
const fmtDaysSince = fmtDuration;

async function loadLists() {
  try {
    const data = await api.get("/api/lists");
    const sections = data.sections || {};
    // Update dropdown labels with counts so totals are visible at a glance.
    [...select.options].forEach((opt) => {
      const base = LIST_KINDS.find(([k]) => k === opt.value);
      if (base) {
        const count = (sections[opt.value] || []).length;
        opt.textContent = `${base[1]} (${count})`;
      }
    });
    const kind = select.value || "everyone";
    refreshSortLabels(kind);
    const out = $("#list-output");
    let items = sections[kind] || [];
    if (items.length === 0) {
      out.innerHTML = `<div class="muted">(none — 0 entries)</div>`;
      searchCount.hidden = true;
      return;
    }

    sortSelect.parentElement.style.display = "";
    items = applySort(items, sortSelect.value);

    // For "still follow after drop", group visually so the surprising "we're
    // mutual again" cases don't get lost in the longer "still doesn't follow
    // back" list.
    if (kind === "still_follow_after_drop") {
      const notBack = items.filter((i) => i.relationship_kind !== "good");
      const mutual = items.filter((i) => i.relationship_kind === "good");
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
    } else {
      out.innerHTML = items.map(renderListRow).join("");
    }
    // Re-apply any active search after rendering so a sort change (which
    // re-renders the rows) keeps the filter live.
    applyListSearch();
    $$(".list-row", out).forEach((row) => {
      row.addEventListener("click", () => openAccountModal(row.dataset.username));
      $$(".row-tag", row).forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const flag = btn.dataset.rowFlag;
          const willBe = !btn.classList.contains("on");
          try {
            const result = await api.post("/api/tags", { account: row.dataset.username, flag, value: willBe });
            btn.classList.toggle("on", !!result[flag]);
            toast(`${flag.replace("_", " ")} ${result[flag] ? "added" : "removed"}`);
            loadHome();
            const currentKind = select.value;
            const BUCKETS = ["favorite", "want_remove", "watchlist", "disabled", "unavailable"];
            // If we just removed from the bucket we're viewing, drop the row.
            if (!result[flag] && currentKind === flag) {
              row.remove();
            }
            // If we just tagged disabled or unavailable ON while viewing a non-bucket
            // list, drop the row (server excludes these from non-bucket lists).
            if ((flag === "disabled" || flag === "unavailable") && result[flag] && !BUCKETS.includes(currentKind)) {
              row.remove();
            }
          } catch (err) {
            toast(`Failed: ${err.message}`);
          }
        });
      });
    });
  } catch (e) {
    toast(`Lists failed: ${e.message}`);
  }
}

// ---------- bucket buttons ----------

$$(".bucket-btn").forEach((btn) =>
  btn.addEventListener("click", () => goToList(btn.dataset.flag))
);

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
  try {
    if (!_historyData || force) {
      const data = await api.get("/api/timeline");
      _historyData = data.snapshots || [];
    }
    renderHistory();
    loadActivityLog(force);
  } catch (e) {
    $("#history-chart").innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
}

let _activityData = null;

async function loadActivityLog(force = false) {
  const out = $("#activity-log");
  if (!out) return;
  try {
    if (!_activityData || force) {
      out.innerHTML = `<div class="muted">Loading…</div>`;
      const data = await api.get("/api/activity-log");
      _activityData = data.events || [];
    }
    renderActivityLog();
  } catch (e) {
    out.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`;
  }
}

const ACTIVITY_GROUPS = [
  { key: "new_followers",       label: "New followers",       cls: "good" },
  { key: "they_unfollowed_you", label: "They unfollowed you", cls: "bad" },
  { key: "new_following",       label: "You followed",        cls: "good" },
  { key: "you_unfollowed",      label: "You unfollowed",      cls: "muted" },
  { key: "they_removed_you",    label: "They removed you",    cls: "bad" },
  { key: "new_pending",         label: "New pending",         cls: "info" },
  { key: "resolved_pending",    label: "Resolved pending",    cls: "muted" },
];

function renderActivityLog() {
  const out = $("#activity-log");
  if (!out || !_activityData) return;
  const filter = ($("#activity-filter")?.value || "").toLowerCase().trim();

  // Build event cards. Empty-change events are still listed (compact) so the
  // timeline doesn't have unexplained gaps, but they collapse to a one-liner.
  const html = [];
  let shownCount = 0;
  for (const ev of _activityData) {
    if (filter) {
      const allNames = ACTIVITY_GROUPS.flatMap((g) => ev[g.key] || []).join(" ").toLowerCase();
      if (!allNames.includes(filter)) continue;
    }
    shownCount++;
    const timestamp = (ev.taken_at || "").replace("T", " ").slice(0, 19);
    const groupSummaries = ACTIVITY_GROUPS
      .filter((g) => (ev[g.key] || []).length > 0)
      .map((g) => {
        const n = (ev[g.key] || []).length;
        return `<span class="al-pill al-${g.cls}"><strong>${n}</strong> ${escapeHtml(g.label)}</span>`;
      })
      .join("");
    const collapsed = ev.change_count === 0;
    const detailBlocks = ACTIVITY_GROUPS
      .map((g) => {
        const list = ev[g.key] || [];
        if (!list.length) return "";
        return `<div class="al-block al-${g.cls}-block">
          <div class="al-block-title">${escapeHtml(g.label)} <span class="al-count">(${list.length})</span></div>
          <div class="al-names">${list.map((u) => `<span class="al-name" data-username="${escapeAttr(u)}">${escapeHtml(u)}</span>`).join("")}</div>
        </div>`;
      })
      .join("");
    html.push(`
      <details class="al-event${collapsed ? " al-empty" : ""}" data-snap="${ev.snapshot_id}">
        <summary>
          <span class="al-time">${escapeHtml(timestamp || ev.label || "")}</span>
          ${collapsed
            ? `<span class="muted small">no changes</span>`
            : `<span class="al-summary-pills">${groupSummaries}</span>`
          }
          <span class="al-counts">F ${ev.counts.followers} · G ${ev.counts.following} · M ${ev.counts.mutuals} · P ${ev.counts.pending}</span>
        </summary>
        <div class="al-body">${detailBlocks || `<div class="muted small">First snapshot — nothing to compare against.</div>`}</div>
      </details>
    `);
  }
  out.innerHTML = html.length
    ? `<div class="muted small al-meta">${shownCount} of ${_activityData.length} events</div>` + html.join("")
    : `<div class="muted">No events match.</div>`;

  // Wire username taps → open account modal.
  $$(".al-name", out).forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openAccountModal(el.dataset.username);
    })
  );
}

$("#activity-filter")?.addEventListener("input", renderActivityLog);

$("#history-range")?.addEventListener("change", renderHistory);
$("#history-series")?.addEventListener("change", renderHistory);

function renderHistory() {
  if (!_historyData) return;
  const range = $("#history-range").value;
  const series = $("#history-series").value;
  // Filter snapshots by range (using created_at as the timeline anchor).
  let snaps = _historyData;
  if (range !== "all") {
    const cutoff = Date.now() - parseInt(range, 10) * 86400 * 1000;
    snaps = snaps.filter((s) => Date.parse(s.created_at) >= cutoff);
  }
  if (snaps.length === 0) {
    $("#history-chart").innerHTML = `<div class="muted">No snapshots in this range.</div>`;
    $("#history-detail").innerHTML = "";
    return;
  }
  drawHistoryChart(snaps, series);
}

function drawHistoryChart(snaps, seriesPick) {
  const W = 760, H = 280, PAD_L = 50, PAD_R = 16, PAD_T = 16, PAD_B = 40;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  const SERIES = [
    { key: "followers", label: "Followers", color: "#4f8cff" },
    { key: "following", label: "Following", color: "#ffb454" },
    { key: "mutuals",   label: "Mutuals",   color: "#3ecf8e" },
    { key: "pending",   label: "Pending",   color: "#a78bfa" },
  ];
  const visible = seriesPick === "all"
    ? SERIES.filter((s) => s.key !== "pending")
    : SERIES.filter((s) => s.key === seriesPick);

  // Domain
  const xs = snaps.map((_, i) => i);
  const allYs = visible.flatMap((s) => snaps.map((p) => p[s.key]));
  const yMin = Math.min(...allYs);
  const yMax = Math.max(...allYs);
  const yPad = Math.max(1, Math.round((yMax - yMin) * 0.08));
  const yLo = Math.max(0, yMin - yPad);
  const yHi = yMax + yPad;

  const xScale = (i) => PAD_L + (snaps.length === 1 ? innerW / 2 : (i / (snaps.length - 1)) * innerW);
  const yScale = (v) => PAD_T + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;

  // Y-axis ticks (5)
  const yTicks = [];
  for (let t = 0; t <= 4; t++) {
    const v = yLo + (t / 4) * (yHi - yLo);
    yTicks.push({ v: Math.round(v), y: yScale(v) });
  }

  // X-axis: show ~6 evenly-spaced labels
  const xLabelCount = Math.min(6, snaps.length);
  const xLabels = [];
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.round((i / (xLabelCount - 1 || 1)) * (snaps.length - 1));
    const s = snaps[idx];
    xLabels.push({ x: xScale(idx), label: shortDate(s.label || s.created_at) });
  }

  const linesSvg = visible.map((s) => {
    const d = snaps.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p[s.key]).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" />`;
  }).join("");

  const dotsSvg = snaps.map((p, i) => {
    return visible.map((s) =>
      `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(p[s.key]).toFixed(1)}" r="3" fill="${s.color}" data-snap="${p.snapshot_id}" data-idx="${i}" class="history-dot" />`
    ).join("");
  }).join("");

  // Invisible wider hit areas for tap targets
  const hitsSvg = snaps.map((p, i) => {
    const x = xScale(i);
    return `<rect x="${(x - 12).toFixed(1)}" y="${PAD_T}" width="24" height="${innerH}" fill="transparent" data-snap="${p.snapshot_id}" data-idx="${i}" class="history-hit" />`;
  }).join("");

  const yTicksSvg = yTicks.map((t) =>
    `<g><line x1="${PAD_L}" y1="${t.y}" x2="${W - PAD_R}" y2="${t.y}" stroke="var(--border)" stroke-width="1" />
     <text x="${PAD_L - 6}" y="${t.y + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${t.v}</text></g>`
  ).join("");

  const xLabelsSvg = xLabels.map((l) =>
    `<text x="${l.x}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(l.label)}</text>`
  ).join("");

  const legend = visible.map((s) =>
    `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`
  ).join("");

  $("#history-chart").innerHTML = `
    <div class="legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" class="history-svg" preserveAspectRatio="xMidYMid meet">
      ${yTicksSvg}
      ${linesSvg}
      ${dotsSvg}
      ${hitsSvg}
      ${xLabelsSvg}
    </svg>
  `;

  $$(".history-hit, .history-dot", $("#history-chart")).forEach((el) => {
    el.addEventListener("click", () => showHistoryDetail(parseInt(el.dataset.idx, 10), snaps));
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

async function showHistoryDetail(idx, snaps) {
  const curr = snaps[idx];
  const prev = idx > 0 ? snaps[idx - 1] : null;
  const dF = prev ? curr.followers - prev.followers : 0;
  const dG = prev ? curr.following - prev.following : 0;
  const dM = prev ? curr.mutuals  - prev.mutuals  : 0;
  const dP = prev ? curr.pending  - prev.pending  : 0;
  const arrow = (n) => n > 0 ? `<span class="up">+${n}</span>` : n < 0 ? `<span class="down">${n}</span>` : `<span class="muted">±0</span>`;

  let diffHtml = "";
  if (prev) {
    try {
      const d = await api.get(`/api/diff?old=${prev.snapshot_id}&new=${curr.snapshot_id}`);
      const sec = d.sections || {};
      const block = (title, list, max = 8) => {
        if (!list || !list.length) return "";
        const shown = list.slice(0, max);
        const more = list.length > max ? ` <span class="muted">+${list.length - max} more</span>` : "";
        return `<div class="diff-block"><strong>${title}</strong> (${list.length})<div>${shown.map((u) => `<span class="diff-name">${escapeHtml(u)}</span>`).join(" ")}${more}</div></div>`;
      };
      diffHtml = `
        ${block("New followers", sec.new_followers)}
        ${block("They unfollowed you", sec.they_unfollowed_you)}
        ${block("New following (you followed)", sec.new_following)}
        ${block("You unfollowed", sec.you_unfollowed)}
        ${block("They removed you as a follower", sec.they_removed_you_as_follower)}
        ${block("New pending requests", sec.new_pending)}
        ${block("Resolved pending", sec.resolved_pending)}
      `;
    } catch (e) {
      diffHtml = `<div class="muted">Diff unavailable: ${escapeHtml(e.message)}</div>`;
    }
  } else {
    diffHtml = `<div class="muted">First snapshot in range — nothing to diff against.</div>`;
  }

  $("#history-detail").innerHTML = `
    <div class="history-snapshot">
      <h3>#${curr.snapshot_id} · ${escapeHtml(cleanLabel(curr.label) || curr.created_at)}</h3>
      <div class="history-counts">
        <div>Followers <strong>${curr.followers}</strong> ${prev ? arrow(dF) : ""}</div>
        <div>Following <strong>${curr.following}</strong> ${prev ? arrow(dG) : ""}</div>
        <div>Mutuals <strong>${curr.mutuals}</strong> ${prev ? arrow(dM) : ""}</div>
        <div>Pending <strong>${curr.pending}</strong> ${prev ? arrow(dP) : ""}</div>
      </div>
      ${diffHtml}
    </div>
  `;
}

// ---------- snapshots ----------

async function loadSnapshots() {
  try {
    const list = await api.get("/api/snapshots");
    const ul = $("#snapshot-list");
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

loadHome();

// Allow ?lookup=<username|url> to auto-open a lookup. Used by iOS Shortcuts and bookmarklets.
(function autoLookupFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("lookup") || params.get("check") || params.get("u");
  if (!target) return;
  window.history.replaceState({}, "", window.location.pathname);
  showView("check");
  $("#check-input").value = target;
  openAccount(target);
})();
