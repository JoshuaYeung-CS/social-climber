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
        ["Requests to follow you", s.incoming_requests ?? 0, "incoming_requests"],
        ["Ever requested to follow you", s.ever_incoming_requests ?? 0, "ever_incoming_requests"],
        ["Incoming Request Rejected", s.incoming_request_dropped ?? 0, "incoming_request_dropped"],
        ["Ever requested to follow", s.ever_requested_outgoing ?? 0, "ever_requested_outgoing"],
        ["Follow Request Rejected", s.request_dropped ?? 0, "request_dropped"],
        ["⚠ Tagged disabled", s.disabled_tagged ?? 0, "disabled"],
        ["✕ Tagged unavailable", s.unavailable_tagged ?? 0, "unavailable"],
        ["🎲 Tagged random requests", s.random_request_tagged ?? 0, "random_request"],
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
        const igHref = `https://www.instagram.com/${encodeURIComponent(a.username || "")}/`;
        li.innerHTML = `<span>${escapeHtml(a.message)}</span>`;
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

// Manual Drive-folder scan button. Shows up only if the server has
// IG_WATCH_FOLDER configured. Click it to import any new Meta exports
// sitting in your Drive sync folder right now — costs nothing in the
// background, but a single recursive scan of a large Drive root can
// take a minute or two on first click.
async function refreshScanButton() {
  try {
    const data = await api.get("/api/scan-status");
    const btn = $("#scan-drive-btn");
    const hint = $("#scan-folder-hint");
    if (data.watch_folder) {
      btn.hidden = false;
      hint.hidden = false;
      hint.textContent = `Watching: ${data.watch_folder}`;
    } else {
      btn.hidden = true;
      hint.hidden = true;
    }
  } catch (e) { /* server not ready, ignore */ }
}
refreshScanButton();

$("#scan-drive-btn")?.addEventListener("click", async () => {
  const btn = $("#scan-drive-btn");
  const status = $("#scan-status");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Scanning… (Drive listing can take a minute)";
  status.innerHTML = `<span class="pending"><span class="spinner"></span>Scanning Drive folder…</span>`;
  try {
    const result = await api.post("/api/scan");
    if (!result.ok) {
      status.innerHTML = `<div class="warn-box">⚠ ${escapeHtml(result.message)}</div>`;
    } else {
      const seen = result.already_seen ?? 0;
      const newCount = result.scanned - seen;
      const errors = (result.details || []).filter((d) => d.outcome === "error").length;
      // Concise summary line; full per-file details collapsed under a toggle.
      const summary = `<div class="ok">✓ ${result.imported} imported · ${result.skipped} skipped/backfilled · ${seen} already known${errors ? ` · <span class="err">${errors} errors</span>` : ""}</div>`;
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
          return `<div class="scan-item ${cls}"><span class="scan-verb">${escapeHtml(verb)}</span> <code>${escapeHtml(d.file)}</code></div>`;
        }).join("");
        detailHtml = `<details class="scan-details"><summary class="muted small">Show ${result.details.length} per-file detail${result.details.length === 1 ? "" : "s"}</summary><div class="scan-detail-list">${items}</div></details>`;
      }
      status.innerHTML = summary + detailHtml;
    }
    await loadHome();
  } catch (e) {
    status.innerHTML = `<div class="err">✗ ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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
    _historyData = null;  // invalidate so the next History view refetches
    await loadHome();
    if (imported === 0 && skipped.length > 0) {
      if (backfilledCount > 0 && trueSkippedCount === 0) {
        toast(`Backfilled ${backfilledCount} snapshot${backfilledCount === 1 ? "" : "s"}`);
      } else {
        const reason = skipped[0].reason === "duplicate" ? "duplicate" : "older than existing snapshots";
        toast(`Skipped — ${reason}`);
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
bindCheckFlow({ inputId: "queue-input",  buttonId: "queue-go",  resultId: "queue-result",  saveToQueue: true  });

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
        el.addEventListener("click", () => openAccountModal(el.dataset.username))
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

async function openAccount(account, { resultId = "lookup-result", saveToQueue = false } = {}) {
  try {
    const data = await api.get(`/api/lookup?account=${encodeURIComponent(account)}`);
    const result = $(`#${resultId}`);
    result.innerHTML = renderLookup(data);
    bindTagToggles(result, data.username, data.tags);

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
      ${data.aliases && data.aliases.length > 1 ? `<div class="warn-banner info-banner">↪ This account has been renamed. Aliases (oldest → newest): ${data.aliases.map((a) => a === data.username ? `<strong>${escapeHtml(a)}</strong>` : `<a href="#" class="alias-link" data-username="${escapeAttr(a)}">${escapeHtml(a)}</a>`).join(" → ")}</div>` : ""}
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
      <button class="tag-toggle ${tags.random_request ? "active" : ""}" data-flag="random_request">🎲 Random request</button>
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
  ["everyone", "Everyone you've ever interacted with"],
  ["all_followers", "All followers"],
  ["all_following", "All following"],
  ["mutuals", "Mutuals"],
  ["not_following_you_back", "Don't follow you back"],
  ["feeder_accounts", "Feeder accounts (follow you, you don't)"],
  ["pending", "Pending requests you sent"],
  ["incoming_requests", "Requests to follow you"],
  ["ever_incoming_requests", "Ever requested to follow you"],
  ["real_requests", "✓ Real requests (excl. random)"],
  ["incoming_request_dropped", "Incoming Request Rejected"],
  ["ever_requested_outgoing", "Ever requested to follow"],
  ["request_dropped", "Follow Request Rejected"],
  ["ever_unfollowed_you", "Ever unfollowed you"],
  ["ever_removed_you_as_follower", "Ever removed you as a follower"],
  ["you_unfollowed_ever", "You ever unfollowed"],
  ["still_follow_after_drop", "You still follow people who unfollowed you"],
  ["renamed", "Renamed accounts"],
  ["favorite", "★ Favorites"],
  ["want_remove", "✦ Want to remove"],
  ["watchlist", "↺ Wait-back"],
  ["disabled", "⚠ Disabled"],
  ["unavailable", "✕ Unavailable (page not found)"],
  ["random_request", "🎲 Random requests"],
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
  { label: "Current",  kinds: ["everyone", "all_followers", "all_following", "mutuals", "not_following_you_back", "feeder_accounts", "pending", "incoming_requests", "renamed"] },
  { label: "History",  kinds: ["ever_unfollowed_you", "ever_removed_you_as_follower", "you_unfollowed_ever", "still_follow_after_drop"] },
  { label: "Requests", kinds: ["ever_incoming_requests", "real_requests", "incoming_request_dropped", "ever_requested_outgoing", "request_dropped"] },
  { label: "Tags",     kinds: ["favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"] },
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
  // If all three filters are off, treat it as "show everything" rather than
  // hiding the entire list — saves the user from a blank-list state.
  const filterOn = allowedPrivacy.size > 0 && allowedPrivacy.size < 3;

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
}

searchInput.addEventListener("input", applyListSearch);

// Privacy filter chips. Each chip toggles its own state; the filter
// applies after all chips are evaluated. "Clear filters" reactivates
// all chips so everything shows.
function updateFilterCounts(rows) {
  const counts = { likely_private: 0, likely_public: 0, unknown: 0 };
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
    <button type="button" class="bulk-btn" data-bulk="open">Open all in tabs</button>
    <button type="button" class="bulk-btn" data-bulk="queue">Add to follow queue</button>
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
const SORT_DATE_HINT = {
  all_following:                "by when you followed them",
  still_follow_after_drop:      "by when you followed them",
  mutuals:                      "by when you became mutual",
  not_following_you_back:       "by when they last followed you",
  ever_unfollowed_you:          "by when they last followed you",
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

function renderListRow(item) {
  // Build the small grey sub-line and the right-side chip.
  let sub = "";
  let chip = "";
  let chipClass = "timing";
  let rowClass = "";

  // Build sub-line: chronological story of the relationship. Prefer the
  // exact unix-second timestamp (*_ts) IG provides; fall back to the
  // date-precision ISO string when only a snapshot label is available.
  const parts = [];
  if (item.followed_ts) parts.push(`you followed ${escapeHtml(fmtDateTime(item.followed_ts))}`);
  else if (item.followed_at) parts.push(`you followed ${escapeHtml(fmtDate(item.followed_at))}`);
  if (item.followers_ts) parts.push(`they followed you ${escapeHtml(fmtDateTime(item.followers_ts))}`);
  if (item.pending_ts) parts.push(`you requested ${escapeHtml(fmtDateTime(item.pending_ts))}`);
  else if (item.pending_since_at && !item.pending_ts) parts.push(`requested ${escapeHtml(fmtDate(item.pending_since_at))}`);
  if (item.incoming_ts) parts.push(`they requested ${escapeHtml(fmtDateTime(item.incoming_ts))}`);
  if (item.unfollowed_ts) parts.push(`you unfollowed ${escapeHtml(fmtDateTime(item.unfollowed_ts))}`);
  if (item.mutual_since_at) parts.push(`mutual since ${escapeHtml(fmtDate(item.mutual_since_at))}`);
  if (item.history_status === "re-engaged") parts.push(`<span class="info-tag">re-engaged</span>`);
  if (item.privacy === "likely_private") parts.push(`<span class="privacy-tag privacy-private">🔒 likely private</span>`);
  else if (item.privacy === "likely_public") parts.push(`<span class="privacy-tag privacy-public">🌐 likely public</span>`);
  if (item.aliases && item.aliases.length > 1) parts.push(`<span class="info-tag">renamed: ${escapeHtml(item.aliases.join(' → '))}</span>`);
  if (item.ever_followed_you === false) parts.push(`<span class="never">never followed back</span>`);
  else if (item.ever_followed_you === true) {
    if (item.last_followed_you_ts) parts.push(`stopped following you on ${escapeHtml(fmtDateTime(item.last_followed_you_ts))}`);
    else if (item.last_followed_you_at) parts.push(`stopped following you on ${escapeHtml(fmtDate(item.last_followed_you_at))}`);
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
  const tagButtons = `
    ${tagBtn("favorite", "★", item.favorite)}
    ${tagBtn("want_remove", "✦", item.want_remove)}
    ${tagBtn("watchlist", "↺", item.watchlist)}
    ${tagBtn("disabled", "⚠", item.disabled)}
    ${tagBtn("unavailable", "✕", item.unavailable)}
    ${tagBtn("random_request", "🎲", item.random_request)}
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

  // Privacy bucket for filter chips. unknown when we have no inference yet.
  const privacy = item.privacy || "unknown";

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
  try {
    const data = await api.get("/api/lists");
    const sections = data.sections || {};
    // Counts on the (hidden) select for fallback consumers.
    [...select.options].forEach((opt) => {
      const base = LIST_KINDS.find(([k]) => k === opt.value);
      if (base) {
        const count = (sections[opt.value] || []).length;
        opt.textContent = `${base[1]} (${count})`;
      }
    });
    // Counts on the visible pills.
    $$("[data-pill-count]").forEach((el) => {
      const k = el.dataset.pillCount;
      const count = (sections[k] || []).length;
      el.textContent = count.toString();
    });
    refreshActivePill();
    const kind = select.value || "everyone";
    refreshSortLabels(kind);
    const out = $("#list-output");
    out.dataset.listKind = kind;
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
      out.innerHTML = `<div class="muted">(none — 0 in intersection)</div>`;
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
    // Restore select-mode visual state after a re-render.
    if (_selectMode) {
      out.classList.add("select-mode");
      $$(".list-row", out).forEach((row) => {
        if (_selectedUsernames.has(row.dataset.username)) {
          row.setAttribute("aria-selected", "true");
        }
      });
    }
    $$(".list-row", out).forEach((row) => {
      row.addEventListener("click", () => {
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
      const openLink = row.querySelector(".row-open");
      if (openLink) openLink.addEventListener("click", (e) => e.stopPropagation());
      $$(".row-tag", row).forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const flag = btn.dataset.rowFlag;
          const willBe = !btn.classList.contains("on");
          try {
            const result = await api.post("/api/tags", { account: row.dataset.username, flag, value: willBe });
            btn.classList.toggle("on", !!result[flag]);
            toast(`${flag.replace("_", " ")} ${result[flag] ? "added" : "removed"}`);
            // No loadHome here — user is on Lists, not Home; bucket-count
            // tiles aren't visible. They'll refresh next time the user
            // navigates back. Saves a ~1s wait per tag click.
            const currentKind = select.value;
            const BUCKETS = ["favorite", "want_remove", "watchlist", "disabled", "unavailable", "random_request"];
            // If we just removed from the bucket we're viewing, drop the row.
            if (!result[flag] && currentKind === flag) {
              row.remove();
            }
            // If we just tagged disabled or unavailable ON while viewing a non-bucket
            // list, drop the row (server excludes these from non-bucket lists).
            if ((flag === "disabled" || flag === "unavailable" || flag === "random_request") && result[flag] && !BUCKETS.includes(currentKind)) {
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

// Per-kind label and color for the flat activity feed.
const ACTIVITY_KIND_META = {
  new_follower:         { label: "started following you",  cls: "good"  },
  unfollowed_you:       { label: "unfollowed you",         cls: "bad"   },
  you_followed:         { label: "you followed",           cls: "good"  },
  you_unfollowed:       { label: "you unfollowed",         cls: "muted" },
  removed_you:          { label: "removed you",            cls: "bad"   },
  you_requested:        { label: "you requested",          cls: "info"  },
  they_accepted:        { label: "they accepted you",      cls: "good"  },
  pending_withdrawn:    { label: "follow request rejected", cls: "muted" },
  new_incoming_request: { label: "requested to follow you", cls: "info" },
  you_accepted:         { label: "you accepted them",      cls: "good"  },
  incoming_withdrawn:   { label: "their request withdrawn", cls: "muted" },
};

const ACTIVITY_KIND_FILTERS = [
  "all", "new_follower", "unfollowed_you", "you_followed", "you_unfollowed",
  "removed_you", "you_requested", "they_accepted", "pending_withdrawn",
  "new_incoming_request", "you_accepted", "incoming_withdrawn",
];

// Multi-select kind filter. Empty Set means "show all kinds" (the All chip
// is the implicit catch-all). Otherwise show only events whose kind is in
// the set.
let _activityKindFilter = new Set();
let _activityVisibleCap = 500;  // soft cap for initial paint; "show more" expands it

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
  const chips = ACTIVITY_KIND_FILTERS.map((k) => {
    const m = k === "all" ? { label: "All", cls: "muted" } : ACTIVITY_KIND_META[k];
    const active = k === "all" ? noneSelected : kindFilter.has(k);
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
    let header = "";
    if (day !== lastDay) {
      lastDay = day;
      header = `<div class="al-day">${escapeHtml(dayLabel(t))}</div>`;
    }
    return header + `
      <div class="al-row">
        <span class="al-time-cell">${escapeHtml(time)}</span>
        <span class="al-kind-pill al-${meta.cls}">${escapeHtml(meta.label)}</span>
        <span class="al-name" data-username="${escapeAttr(e.username)}">${escapeHtml(e.username)}</span>
        <a class="al-open" href="https://www.instagram.com/${encodeURIComponent(e.username)}/" target="_blank" rel="noopener" title="Open on Instagram" onclick="event.stopPropagation()">↗</a>
      </div>
    `;
  }).join("");

  const more = filtered.length > limit
    ? `<button type="button" class="ghost-btn al-more">Show ${filtered.length - limit} more</button>`
    : "";

  out.innerHTML = `
    <div class="al-toolbar">${chips}</div>
    <div class="muted small al-meta">${filtered.length === totalAll
      ? `${totalAll} events`
      : `${filtered.length} of ${totalAll} events`}</div>
    ${rowHtml || `<div class="muted">No events match.</div>`}
    ${more}
  `;

  $$(".al-chip", out).forEach((el) =>
    el.addEventListener("click", () => {
      const k = el.dataset.kind;
      if (k === "all") {
        _activityKindFilter.clear();
      } else if (_activityKindFilter.has(k)) {
        _activityKindFilter.delete(k);
      } else {
        _activityKindFilter.add(k);
      }
      _activityVisibleCap = 500;
      renderActivityLog();
    })
  );
  $$(".al-name", out).forEach((el) =>
    el.addEventListener("click", () => openAccountModal(el.dataset.username))
  );
  const moreBtn = out.querySelector(".al-more");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      _activityVisibleCap += 500;
      renderActivityLog();
    });
  }
}

// Reset the cap whenever filters change so we don't leak a huge render.
$("#activity-filter")?.addEventListener("input", () => { _activityVisibleCap = 500; });

$("#activity-filter")?.addEventListener("input", renderActivityLog);

// Series available in the chart. Sticky checkbox state persists across renders.
const HISTORY_SERIES = [
  { key: "followers",              label: "Followers",                color: "#4f8cff", on: true  },
  { key: "following",              label: "Following",                color: "#ffb454", on: true  },
  { key: "mutuals",                label: "Mutuals",                  color: "#3ecf8e", on: true  },
  { key: "pending",                label: "Pending (you sent)",       color: "#a78bfa", on: false },
  { key: "incoming",               label: "Pending (they sent)",      color: "#f472b6", on: false },
  { key: "cumulative_unfollowers", label: "Unfollowers (cumulative)", color: "#ff5e7a", on: false },
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
        return `<div class="diff-block"><strong>${title}</strong> (${list.length})<div>${shown.map((u) => `<span class="diff-name" data-username="${escapeAttr(u)}">${escapeHtml(u)}<a class="diff-link" href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener" title="Open on Instagram">↗</a></span>`).join(" ")}${more}</div></div>`;
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
  $("#lookup-input").value = target;
  openAccount(target, { resultId: "lookup-result", saveToQueue: false });
})();
