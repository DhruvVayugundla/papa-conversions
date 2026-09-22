const els = {
  nameFilter: document.getElementById("nameFilter"),
  counts: document.getElementById("counts"),
  en: document.getElementById("en"),
  te: document.getElementById("te"),
  hi: document.getElementById("hi"),
  oid: document.getElementById("oid"),
  note: document.getElementById("note"),
  noteDisplay: document.getElementById("noteDisplay"),
  editBtn: document.getElementById("editBtn"),
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
    els.note.style.display = "none";
    els.noteDisplay.textContent = "—";
    els.editBtn.textContent = "Edit";
    els.okBtn.disabled = true;
    return;
  }
  els.en.innerHTML = renderDoc(item.en);
  els.te.innerHTML = renderDoc(item.te);
  els.hi.innerHTML = renderDoc(item.hi);
  els.oid.textContent = item.oid;
  // show last saved note if present, otherwise placeholder
  const lastNote =
    item?.te?.entries && item.te.entries.length
      ? item.te.entries[item.te.entries.length - 1]
      : null;
  els.noteDisplay.textContent = lastNote ? `${lastNote.text}` : "—";
  els.note.value = lastNote ? lastNote.text : "";
  els.note.style.display = "none";
  els.editBtn.textContent = "Edit";
  els.okBtn.disabled = false;
}

function setEditable(enabled) {
  [els.en, els.te, els.hi].forEach((el) => {
    if (!el) return;
    el.contentEditable = enabled ? "true" : "false";
    el.classList.toggle("editable", enabled);
  });
}

function parseDocElement(el) {
  if (!el) return null;
  const doc = {};
  const h3 = el.querySelector("h3");
  doc.name = h3 ? h3.textContent.trim() : "";
  // issue is the first <p> after a .field with text 'Issue'
  const fields = Array.from(el.querySelectorAll(".field"));
  for (const field of fields) {
    const label = field.textContent.trim().toLowerCase();
    const next = field.nextElementSibling;
    if (!next) continue;
    if (label === "issue") doc.issue = next.textContent.trim();
    if (label === "ingredients") {
      doc.ingredients = Array.from(next.querySelectorAll("li")).map((li) =>
        li.textContent.trim(),
      );
    }
    if (label === "procedure") doc.procedure = next.textContent.trim();
    if (label === "precautions") doc.precautions = next.textContent.trim();
  }
  return doc;
}

async function loadBootstrap() {
  const res = await fetch("/api/bootstrap");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load");
  els.nameFilter.innerHTML =
    `<option value="">All issues</option>` +
    data.issues
      .map(
        (issue) =>
          `<option value="${escapeHtml(issue)}">${escapeHtml(issue)}</option>`,
      )
      .join("");
  showCurrent(data.current);
  setCounts(data);
}

async function loadFilter(issue) {
  const res = await fetch(`/api/filter?issue=${encodeURIComponent(issue)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load item");
  showCurrent(data.current);
  setCounts(data);
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
    await loadFilter(els.nameFilter.value);
  } catch (err) {
    els.status.textContent = err.message;
  }
});

els.editBtn.addEventListener("click", () => {
  const editing = els.en.contentEditable === "true";
  if (!editing) {
    setEditable(true);
    els.editBtn.textContent = "Cancel";
  } else {
    setEditable(false);
    els.editBtn.textContent = "Edit";
    // reload current to reset any unsaved edits
    showCurrent(current);
  }
});

// Next button removed: OK will save edits (if any) and advance.

els.okBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    // collect edited docs from the three panels
    const enDoc = parseDocElement(els.en);
    const teDoc = parseDocElement(els.te);
    const hiDoc = parseDocElement(els.hi);
    await postAction("/api/ok", {
      oid: current.oid,
      issue: els.nameFilter.value,
      en: enDoc,
      te: teDoc,
      hi: hiDoc,
    });
    // stop editing after save
    setEditable(false);
    els.editBtn.textContent = "Edit";
  } catch (err) {
    els.status.textContent = err.message;
  }
});

loadBootstrap().catch((err) => {
  els.status.textContent = err.message;
  els.en.textContent = "Could not load data.";
});
