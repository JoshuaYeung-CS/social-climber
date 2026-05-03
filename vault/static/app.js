// IG Vault UI: grid of saved items, click to view, delete in viewer.
// Local-only fetch — no cross-origin concerns.

const API = "";

const $ = (s) => document.querySelector(s);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

let _items = [];

async function load() {
  const params = new URLSearchParams();
  const u = $("#filter-user").value.trim();
  const k = $("#filter-kind").value;
  if (u) params.set("username", u);
  if (k) params.set("kind", k);
  const r = await fetch(`${API}/api/items?` + params.toString());
  if (!r.ok) {
    $("#grid").textContent = "Failed to load.";
    return;
  }
  _items = await r.json();
  $("#count").textContent = `${_items.length} item${_items.length === 1 ? "" : "s"}`;
  render();
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function render() {
  const grid = $("#grid");
  if (_items.length === 0) {
    grid.innerHTML = `<div class="muted small">Empty. Save items via the browser extension's "Save to vault" button on a post / story / highlight.</div>`;
    return;
  }
  grid.innerHTML = _items.map((it) => {
    const url = `${API}/api/media/${it.id}`;
    const preview = it.media_type === "video"
      ? `<video src="${escapeHtml(url)}" muted></video>`
      : `<img src="${escapeHtml(url)}" alt="" />`;
    return `
      <div class="tile" data-id="${it.id}">
        ${preview}
        <span class="tile-kind">${escapeHtml(it.kind)}</span>
        <div class="tile-meta">@${escapeHtml(it.username)}</div>
      </div>
    `;
  }).join("");
  document.querySelectorAll(".tile").forEach((el) =>
    el.addEventListener("click", () => openViewer(parseInt(el.dataset.id, 10)))
  );
}

function openViewer(id) {
  const item = _items.find((x) => x.id === id);
  if (!item) return;
  const url = `${API}/api/media/${item.id}`;
  const media = item.media_type === "video"
    ? `<video src="${escapeHtml(url)}" controls autoplay></video>`
    : `<img src="${escapeHtml(url)}" alt="" />`;
  $("#viewer-content").innerHTML = `
    ${media}
    <div class="viewer-meta">
      <div><strong>@${escapeHtml(item.username)}</strong> · ${escapeHtml(item.kind)}</div>
      <div>Saved ${escapeHtml(fmtDate(item.saved_at))}</div>
      ${item.ig_url ? `<div><a href="${escapeHtml(item.ig_url)}" target="_blank" rel="noopener">Original on IG ↗</a></div>` : ""}
      ${item.caption ? `<div style="margin-top:8px">${escapeHtml(item.caption)}</div>` : ""}
    </div>
    <button class="btn-delete" data-id="${item.id}">Delete from vault</button>
  `;
  $("#viewer").hidden = false;
  $(".btn-delete").addEventListener("click", async () => {
    if (!confirm("Permanently delete this from the vault?")) return;
    const r = await fetch(`${API}/api/items/${item.id}`, { method: "DELETE" });
    if (r.ok) {
      $("#viewer").hidden = true;
      await load();
    }
  });
}

document.querySelectorAll("[data-close]").forEach((el) =>
  el.addEventListener("click", () => { $("#viewer").hidden = true; })
);

$("#filter-user").addEventListener("input", load);
$("#filter-kind").addEventListener("change", load);

load();
