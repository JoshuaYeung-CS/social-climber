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
  ["they_unfollowed_you", "They unfollowed you (since last import)"],
  ["they_removed_you_as_follower", "They removed you as a follower (since last import)"],
  ["you_unfollowed", "You unfollowed (since last import)"],
  ["ever_unfollowed_you", "Ever unfollowed you (full history)"],
  ["ever_removed_you_as_follower", "Ever removed you as a follower (full history)"],
  ["you_unfollowed_ever", "You ever unfollowed (full history)"],
  ["unfollowers_you_still_follow", "Unfollowers you still follow (since last import)"],
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
select.addEventListener("change", loadLists);

const sortSelect = $("#list-sort");
sortSelect.addEventListener("change", loadLists);

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
// Order of preference: when you became mutual > when you started following them
// > when they last followed you > when the pending request was sent. Most rows
// have at least one. Returns "" so missing values sort to the end naturally.
function rowDateKey(r) {
  return r.mutual_since_at || r.followed_at || r.last_followed_you_at || r.pending_since_at || "";
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

  return `
    <div class="list-row${rowClass ? " " + rowClass : ""}" data-username="${escapeAttr(item.username)}">
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
    const out = $("#list-output");
    let items = sections[kind] || [];
    if (items.length === 0) {
      out.innerHTML = `<div class="muted">(none — 0 entries)</div>`;
      return;
    }

    sortSelect.parentElement.style.display = "";
    items = applySort(items, sortSelect.value);

    out.innerHTML = items.map(renderListRow).join("");
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
