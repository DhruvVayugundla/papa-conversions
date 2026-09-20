const els = {
  nameFilter: document.getElementById("nameFilter"),
  counts: document.getElementById("counts"),
  en: document.getElementById("en"),
  te: document.getElementById("te"),
  hi: document.getElementById("hi"),
  oid: document.getElementById("oid"),
  note: document.getElementById("note"),
  nextBtn: document.getElementById("nextBtn"),
  okBtn: document.getElementById("okBtn"),
  status: document.getElementById("status"),
};

let current = null;
let totalCount = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderList(items) {
  if (!Array.isArray(items) || items.length === 0) return "<p>—</p>";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderDoc(doc) {
  if (!doc) return "<p>No document for this OID.</p>";
  return `
    <h3>${escapeHtml(doc.name || "Untitled")}</h3>
    <div class="field">Issue</div>
    <p>${escapeHtml(doc.issue)}</p>
    <div class="field">Ingredients</div>
    ${renderList(doc.ingredients)}
    <div class="field">Procedure</div>
    <p>${escapeHtml(doc.procedure)}</p>
    <div class="field">Precautions</div>
    <p>${escapeHtml(doc.precautions)}</p>
  `;
}

function setCounts({ remaining, total, saved, visited }) {
  if (remaining == null) return;
  if (total != null) totalCount = total;
  els.counts.textContent = `${remaining} remaining of ${totalCount} · ${saved} saved · ${visited} visited`;
}

function showCurrent(item) {
  current = item;
  if (!item) {
    els.en.innerHTML = "<p>All items have been visited.</p>";
    els.te.innerHTML = "<p>All items have been visited.</p>";
    els.hi.innerHTML = "<p>All items have been visited.</p>";
    els.oid.textContent = "—";
    els.note.value = "";
    els.nextBtn.disabled = true;
    els.okBtn.disabled = true;
    return;
  }
  els.en.innerHTML = renderDoc(item.en);
  els.te.innerHTML = renderDoc(item.te);
  els.hi.innerHTML = renderDoc(item.hi);
  els.oid.textContent = item.oid;
  els.note.value = "";
  els.nextBtn.disabled = false;
  els.okBtn.disabled = false;
  els.nameFilter.value = item.oid;
}

async function loadBootstrap() {
  const res = await fetch("/api/bootstrap");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load");
  els.nameFilter.innerHTML = data.names
    .map((item) => `<option value="${escapeHtml(item.oid)}">${escapeHtml(item.name)}</option>`)
    .join("");
  showCurrent(data.current);
  setCounts(data);
}

async function loadItem(oid) {
  const res = await fetch(`/api/item/${encodeURIComponent(oid)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load item");
  showCurrent(data.current);
}

async function postAction(url, body) {
  els.status.textContent = "";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  showCurrent(data.current);
  setCounts(data);
}

els.nameFilter.addEventListener("change", async () => {
  try {
    await loadItem(els.nameFilter.value);
  } catch (err) {
    els.status.textContent = err.message;
  }
});

els.nextBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    await postAction("/api/next", { oid: current.oid, text: els.note.value });
  } catch (err) {
    els.status.textContent = err.message;
  }
});

els.okBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    await postAction("/api/ok", { oid: current.oid });
  } catch (err) {
    els.status.textContent = err.message;
  }
});

loadBootstrap().catch((err) => {
  els.status.textContent = err.message;
  els.en.textContent = "Could not load data.";
});
