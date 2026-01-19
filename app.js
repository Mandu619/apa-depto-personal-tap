import { auth, db } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  collection, addDoc, doc, getDoc, getDocs, query, where, orderBy, limit,
  updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  todayISO, setMsg, escapeHtml, toCSV, downloadText, parseDateToTs
} from "./utils.js";

/* ---------------------------
   DOM helpers
--------------------------- */
const $ = (id) => document.getElementById(id);

const loginCard = $("loginCard");
const navTabs = $("navTabs");
const btnLogout = $("btnLogout");

const userName = $("userName");
const userRole = $("userRole");

/* Views */
const views = Array.from(document.querySelectorAll(".view"));
function showView(viewId) {
  views.forEach(v => v.hidden = (v.id !== viewId));
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === viewId);
  });
}

/* Tabs */
document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  showView(tab.dataset.view);
});

/* Defaults */
["entryDate","assignDate","scrapDate"].forEach(id => {
  const el = $(id);
  if (el) el.value = todayISO();
});

/* ---------------------------
   Session + Role
--------------------------- */
let currentUser = null;
let currentUserProfile = null; // from /users/{uid} {name, role}
let reportRows = [];

async function loadUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

function applyRoleToUI(role) {
  // Puedes restringir botones/módulos en UI además de reglas Firestore.
  // Ej: usuarios "consulta" no deberían guardar entradas/asignaciones/merma/responder solicitudes.
  const isWriter = role === "admin" || role === "operator";

  // Entradas
  $("formEntry").querySelector("button[type=submit]").disabled = !isWriter;
  // Asignaciones
  $("formAssign").querySelector("button[type=submit]").disabled = !isWriter;
  // Merma
  $("formScrap").querySelector("button[type=submit]").disabled = !isWriter;

  // Para solicitudes: cualquiera crea, pero solo writer responde (controlado al pintar la tabla)
}

/* ---------------------------
   Auth
--------------------------- */
$("btnLogin").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const msg = $("loginMsg");

  setMsg(msg, "");
  if (!email || !password) {
    setMsg(msg, "Debes ingresar correo y contraseña.", "warn");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    setMsg(msg, "Ingreso exitoso.", "ok");
  } catch (err) {
    setMsg(msg, "Error de autenticación. Verifica credenciales.", "bad");
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (u) => {
  currentUser = u;
  if (!u) {
    currentUserProfile = null;
    userName.textContent = "No autenticado";
    userRole.textContent = "—";
    loginCard.hidden = false;
    navTabs.hidden = true;
    views.forEach(v => v.hidden = true);
    btnLogout.disabled = true;
    return;
  }

  btnLogout.disabled = false;
  loginCard.hidden = true;
  navTabs.hidden = false;

  currentUserProfile = await loadUserProfile(u.uid);

  if (!currentUserProfile) {
    userName.textContent = u.email || "Usuario";
    userRole.textContent = "Sin perfil";
    alert("Tu usuario existe en Auth, pero falta tu documento en Firestore: users/{uid}. Pide al admin crear tu perfil.");
    return;
  }

  userName.textContent = currentUserProfile.name || (u.email || "Usuario");
  userRole.textContent = currentUserProfile.role || "—";

  applyRoleToUI(currentUserProfile.role);

  // Cargar data inicial
  showView("view-dashboard");
  await refreshDashboard();
  await refreshEntries();
  await refreshEntryDropdowns();
  await refreshAssignments();
  await refreshScrap();
  await refreshRequests();
});

/* ---------------------------
   Helpers data
--------------------------- */
function canWrite() {
  const r = currentUserProfile?.role;
  return r === "admin" || r === "operator";
}

function withinRange(ts, fromISO, toISO) {
  const from = parseDateToTs(fromISO);
  const to = parseDateToTs(toISO);
  if (from && ts < from) return false;
  if (to && ts > (to + 24*60*60*1000 - 1)) return false;
  return true;
}

/* ---------------------------
   ENTRIES (Entradas)
   Estructura doc:
   entries: { dateISO, type, desc, ref, qty, available, createdBy, createdByName, createdAt }
--------------------------- */
$("formEntry").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("entryMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar entradas.", "bad");
    return;
  }

  const dateISO = $("entryDate").value;
  const type = $("entryType").value;
  const qty = Number($("entryQty").value);
  const desc = $("entryDesc").value.trim();
  const ref = $("entryRef").value.trim();

  if (!dateISO || !type || !desc || !Number.isFinite(qty) || qty <= 0) {
    setMsg(msg, "Campos inválidos. Revisa fecha, tipo, descripción y cantidad.", "warn");
    return;
  }

  try {
    await addDoc(collection(db, "entries"), {
      dateISO,
      dateTS: parseDateToTs(dateISO),
      type,
      desc,
      ref,
      qty,
      available: qty,
      createdBy: currentUser.uid,
      createdByName: currentUserProfile.name || currentUser.email || "Usuario",
      createdAt: serverTimestamp()
    });

    setMsg(msg, "Entrada registrada correctamente.", "ok");
    e.target.reset();
    $("entryDate").value = todayISO();
    await refreshEntries();
    await refreshEntryDropdowns();
    await refreshDashboard();
  } catch (err) {
    setMsg(msg, "No se pudo guardar la entrada. Revisa permisos/reglas.", "bad");
  }
});

$("btnReloadEntries").addEventListener("click", async () => {
  await refreshEntries();
});

async function refreshEntries() {
  const tbody = $("tblEntries").querySelector("tbody");
  tbody.innerHTML = "";

  const typeFilter = $("filterEntryType").value;
  const textFilter = $("filterEntryText").value.trim().toLowerCase();

  const qRef = query(collection(db, "entries"), orderBy("dateTS", "desc"), limit(200));
  const snap = await getDocs(qRef);

  const rows = [];
  snap.forEach(docSnap => {
    const d = docSnap.data();
    if (typeFilter && d.type !== typeFilter) return;

    const hay = `${d.desc ?? ""} ${d.ref ?? ""}`.toLowerCase();
    if (textFilter && !hay.includes(textFilter)) return;

    rows.push({ id: docSnap.id, ...d });
  });

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.desc)}</td>
      <td>${escapeHtml(r.ref || "")}</td>
      <td>${escapeHtml(String(r.qty))}</td>
      <td>${escapeHtml(String(r.available))}</td>
      <td>${escapeHtml(r.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  }

  // dashboard last entries
  await refreshDashboardTables(rows);
}

async function refreshEntryDropdowns() {
  const selects = [$("assignEntryId"), $("scrapEntryId")];
  selects.forEach(s => {
    s.innerHTML = `<option value="">Seleccionar…</option>`;
  });

  const qRef = query(collection(db, "entries"), orderBy("dateTS", "desc"), limit(200));
  const snap = await getDocs(qRef);

  const entries = [];
  snap.forEach(docSnap => {
    const d = docSnap.data();
    entries.push({ id: docSnap.id, ...d });
  });

  for (const e of entries) {
    const label = `${e.dateISO} · ${e.type} · ${e.desc} (Disp: ${e.available})`;
    for (const s of selects) {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = label;
      opt.dataset.available = String(e.available);
      opt.dataset.type = e.type;
      opt.dataset.desc = e.desc;
      s.appendChild(opt);
    }
  }
}

/* ---------------------------
   ASSIGNMENTS (Asignaciones)
   assignments: { dateISO, dateTS, worker, entryId, entryType, entryDesc, qty, reason, createdByName }
   Efecto: descuenta available de entry
--------------------------- */
$("formAssign").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("assignMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar asignaciones.", "bad");
    return;
  }

  const dateISO = $("assignDate").value;
  const worker = $("assignWorker").value.trim();
  const qty = Number($("assignQty").value);
  const entryId = $("assignEntryId").value;
  const reason = $("assignReason").value.trim();

  if (!dateISO || !worker || !entryId || !reason || !Number.isFinite(qty) || qty <= 0) {
    setMsg(msg, "Campos inválidos. Revisa fecha, trabajador, entrada, cantidad y motivo.", "warn");
    return;
  }

  // Validar disponibilidad real
  const entryRef = doc(db, "entries", entryId);
  const entrySnap = await getDoc(entryRef);
  if (!entrySnap.exists()) {
    setMsg(msg, "La entrada seleccionada no existe.", "bad");
    return;
  }
  const entry = entrySnap.data();
  if ((entry.available ?? 0) < qty) {
    setMsg(msg, `Cantidad supera lo disponible. Disponible: ${entry.available}.`, "warn");
    return;
  }

  try {
    // 1) Crear asignación
    await addDoc(collection(db, "assignments"), {
      dateISO,
      dateTS: parseDateToTs(dateISO),
      worker,
      entryId,
      entryType: entry.type,
      entryDesc: entry.desc,
      qty,
      reason,
      createdBy: currentUser.uid,
      createdByName: currentUserProfile.name || currentUser.email || "Usuario",
      createdAt: serverTimestamp()
    });

    // 2) Descontar disponible
    await updateDoc(entryRef, {
      available: (entry.available - qty)
    });

    setMsg(msg, "Asignación guardada y stock disponible actualizado.", "ok");
    e.target.reset();
    $("assignDate").value = todayISO();

    await refreshEntryDropdowns();
    await refreshAssignments();
    await refreshEntries();
    await refreshDashboard();
  } catch (err) {
    setMsg(msg, "No se pudo guardar la asignación. Revisa permisos/reglas.", "bad");
  }
});

$("btnReloadAssignments").addEventListener("click", async () => {
  await refreshAssignments();
});

async function refreshAssignments() {
  const tbody = $("tblAssignments").querySelector("tbody");
  tbody.innerHTML = "";

  const workerFilter = $("filterAssignWorker").value.trim().toLowerCase();
  const fromISO = $("filterAssignFrom").value;
  const toISO = $("filterAssignTo").value;

  const qRef = query(collection(db, "assignments"), orderBy("dateTS", "desc"), limit(300));
  const snap = await getDocs(qRef);

  const rows = [];
  snap.forEach(docSnap => {
    const d = docSnap.data();

    if (workerFilter && !(String(d.worker || "").toLowerCase().includes(workerFilter))) return;
    if (!withinRange(d.dateTS, fromISO, toISO)) return;

    rows.push({ id: docSnap.id, ...d });
  });

  for (const a of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(a.dateISO)}</td>
      <td>${escapeHtml(a.worker)}</td>
      <td>${escapeHtml(a.entryId)}</td>
      <td>${escapeHtml(a.entryType)}</td>
      <td>${escapeHtml(a.entryDesc)}</td>
      <td>${escapeHtml(String(a.qty))}</td>
      <td>${escapeHtml(a.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  }

  // dashboard last assignments
  await refreshDashboardTables(null, rows);
}

/* ---------------------------
   SCRAP (Merma)
   scrap: { dateISO, dateTS, entryId, entryType, entryDesc, qty, reason, detail, createdByName }
   Efecto: descuenta available de entry
--------------------------- */
$("formScrap").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("scrapMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar merma.", "bad");
    return;
  }

  const dateISO = $("scrapDate").value;
  const entryId = $("scrapEntryId").value;
  const qty = Number($("scrapQty").value);
  const reason = $("scrapReason").value;
  const detail = $("scrapDetail").value.trim();

  if (!dateISO || !entryId || !reason || !Number.isFinite(qty) || qty <= 0) {
    setMsg(msg, "Campos inválidos. Revisa fecha, entrada, cantidad y motivo.", "warn");
    return;
  }

  if (reason === "Otro" && !detail) {
    setMsg(msg, "Si el motivo es 'Otro', debes detallar la causa.", "warn");
    return;
  }

  const entryRef = doc(db, "entries", entryId);
  const entrySnap = await getDoc(entryRef);
  if (!entrySnap.exists()) {
    setMsg(msg, "La entrada asociada no existe.", "bad");
    return;
  }
  const entry = entrySnap.data();
  if ((entry.available ?? 0) < qty) {
    setMsg(msg, `Merma supera lo disponible. Disponible: ${entry.available}.`, "warn");
    return;
  }

  try {
    await addDoc(collection(db, "scrap"), {
      dateISO,
      dateTS: parseDateToTs(dateISO),
      entryId,
      entryType: entry.type,
      entryDesc: entry.desc,
      qty,
      reason,
      detail: reason === "Otro" ? detail : "",
      createdBy: currentUser.uid,
      createdByName: currentUserProfile.name || currentUser.email || "Usuario",
      createdAt: serverTimestamp()
    });

    await updateDoc(entryRef, {
      available: (entry.available - qty)
    });

    setMsg(msg, "Merma registrada y stock disponible actualizado.", "ok");
    e.target.reset();
    $("scrapDate").value = todayISO();

    await refreshEntryDropdowns();
    await refreshScrap();
    await refreshEntries();
    await refreshDashboard();
  } catch (err) {
    setMsg(msg, "No se pudo guardar la merma. Revisa permisos/reglas.", "bad");
  }
});

async function refreshScrap() {
  const tbody = $("tblScrap").querySelector("tbody");
  tbody.innerHTML = "";

  const qRef = query(collection(db, "scrap"), orderBy("dateTS", "desc"), limit(300));
  const snap = await getDocs(qRef);

  snap.forEach(docSnap => {
    const s = docSnap.data();
    const motivo = s.reason === "Otro" ? `Otro: ${s.detail}` : s.reason;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.dateISO)}</td>
      <td>${escapeHtml(s.entryId)}</td>
      <td>${escapeHtml(s.entryType)}</td>
      <td>${escapeHtml(s.entryDesc)}</td>
      <td>${escapeHtml(String(s.qty))}</td>
      <td>${escapeHtml(motivo)}</td>
      <td>${escapeHtml(s.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ---------------------------
   REQUESTS (Solicitudes)
--------------------------- */
$("formRequest").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("reqMsg");
  setMsg(msg, "");

  const type = $("reqType").value;
  const text = $("reqText").value.trim();
  const priority = $("reqPriority").value;

  if (!type || !text || !priority) {
    setMsg(msg, "Completa tipo, detalle y prioridad.", "warn");
    return;
  }

  try {
    await addDoc(collection(db, "requests"), {
      type,
      text,
      priority,
      status: "Pendiente",
      response: "",
      createdBy: currentUser.uid,
      createdByName: currentUserProfile.name || currentUser.email || "Usuario",
      createdAt: serverTimestamp(),
      dateTS: Date.now()
    });

    setMsg(msg, "Solicitud creada correctamente.", "ok");
    e.target.reset();
    await refreshRequests();
    await refreshDashboard();
  } catch (err) {
    setMsg(msg, "No se pudo crear la solicitud. Revisa permisos.", "bad");
  }
});

$("btnReloadRequests").addEventListener("click", async () => {
  await refreshRequests();
});

async function refreshRequests() {
  const tbody = $("tblRequests").querySelector("tbody");
  tbody.innerHTML = "";

  const statusFilter = $("filterReqStatus").value;
  const textFilter = $("filterReqText").value.trim().toLowerCase();

  const qRef = query(collection(db, "requests"), orderBy("dateTS", "desc"), limit(300));
  const snap = await getDocs(qRef);

  const isWriter = canWrite();
  snap.forEach(docSnap => {
    const r = docSnap.data();
    if (statusFilter && r.status !== statusFilter) return;

    const hay = `${r.type ?? ""} ${r.text ?? ""} ${r.response ?? ""}`.toLowerCase();
    if (textFilter && !hay.includes(textFilter)) return;

    const tr = document.createElement("tr");
    const actionBtn = (isWriter && r.status === "Pendiente")
      ? `<button class="btn btn--ghost" data-action="respond" data-id="${docSnap.id}">Marcar respondida</button>`
      : `<span class="muted">—</span>`;

    tr.innerHTML = `
      <td>${new Date(r.dateTS).toISOString().slice(0,10)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.text)}</td>
      <td>${escapeHtml(r.priority)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.response || "")}</td>
      <td>${actionBtn}</td>
    `;
    tbody.appendChild(tr);
  });

  // Delegación evento para responder
  tbody.querySelectorAll("button[data-action='respond']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const response = prompt("Ingresa respuesta/observación breve para cerrar la solicitud:");
      if (response === null) return;

      try {
        await updateDoc(doc(db, "requests", id), {
          status: "Respondida",
          response: response.trim(),
          respondedAt: serverTimestamp(),
          respondedBy: currentUser.uid,
          respondedByName: currentUserProfile.name || currentUser.email || "Usuario"
        });
        await refreshRequests();
        await refreshDashboard();
      } catch (err) {
        alert("No se pudo actualizar. Verifica permisos/reglas.");
      }
    });
  });
}

/* ---------------------------
   REPORTS (Informes)
   Reporte basado principalmente en asignaciones, porque es lo que se entrega por trabajador/tipo.
--------------------------- */
$("btnRunReport").addEventListener("click", async () => {
  await runReport();
});

$("btnExportCSV").addEventListener("click", () => {
  if (!reportRows.length) return;
  const headers = ["dateISO","entryType","worker","entryId","entryDesc","qty","reason"];
  const csv = toCSV(reportRows, headers);
  downloadText(`reporte_${new Date().toISOString().slice(0,10)}.csv`, csv, "text/csv");
});

async function runReport() {
  const msg = $("reportMsg");
  setMsg(msg, "");

  const mode = $("reportMode").value;
  const filter = $("reportFilter").value.trim().toLowerCase();
  const fromISO = $("reportFrom").value;
  const toISO = $("reportTo").value;

  const tbody = $("tblReport").querySelector("tbody");
  tbody.innerHTML = "";
  reportRows = [];

  // Tomamos asignaciones como base
  const qRef = query(collection(db, "assignments"), orderBy("dateTS", "desc"), limit(800));
  const snap = await getDocs(qRef);

  let totalQty = 0;

  snap.forEach(docSnap => {
    const a = docSnap.data();

    if (!withinRange(a.dateTS, fromISO, toISO)) return;

    if (filter) {
      if (mode === "worker" && !String(a.worker || "").toLowerCase().includes(filter)) return;
      if (mode === "type" && !String(a.entryType || "").toLowerCase().includes(filter)) return;
    }

    const row = {
      dateISO: a.dateISO,
      entryType: a.entryType,
      worker: a.worker,
      entryId: a.entryId,
      entryDesc: a.entryDesc,
      qty: a.qty,
      reason: a.reason
    };

    reportRows.push(row);
    totalQty += Number(a.qty) || 0;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.dateISO)}</td>
      <td>${escapeHtml(row.entryType)}</td>
      <td>${escapeHtml(row.worker)}</td>
      <td>${escapeHtml(row.entryId)}</td>
      <td>${escapeHtml(row.entryDesc)}</td>
      <td>${escapeHtml(String(row.qty))}</td>
      <td>${escapeHtml(row.reason)}</td>
    `;
    tbody.appendChild(tr);
  });

  $("reportCount").textContent = String(reportRows.length);
  $("reportQty").textContent = String(totalQty);
  $("btnExportCSV").disabled = reportRows.length === 0;

  setMsg(msg, reportRows.length ? "Reporte generado correctamente." : "Sin resultados para los filtros seleccionados.", reportRows.length ? "ok" : "warn");
}

/* ---------------------------
   DASHBOARD
--------------------------- */
async function refreshDashboard() {
  // últimos 30 días
  const now = Date.now();
  const since = now - 30*24*60*60*1000;

  // Entries
  const eSnap = await getDocs(query(collection(db, "entries"), orderBy("dateTS", "desc"), limit(500)));
  let eCount = 0;
  const lastEntries = [];
  eSnap.forEach(s => {
    const d = s.data();
    if ((d.dateTS ?? 0) >= since) eCount++;
    if (lastEntries.length < 6) lastEntries.push({ id: s.id, ...d });
  });

  // Assignments
  const aSnap = await getDocs(query(collection(db, "assignments"), orderBy("dateTS", "desc"), limit(500)));
  let aCount = 0;
  const lastAssignments = [];
  aSnap.forEach(s => {
    const d = s.data();
    if ((d.dateTS ?? 0) >= since) aCount++;
    if (lastAssignments.length < 6) lastAssignments.push({ id: s.id, ...d });
  });

  // Scrap
  const sSnap = await getDocs(query(collection(db, "scrap"), orderBy("dateTS", "desc"), limit(500)));
  let sCount = 0;
  sSnap.forEach(s => {
    const d = s.data();
    if ((d.dateTS ?? 0) >= since) sCount++;
  });

  // Requests pending
  const rSnap = await getDocs(query(collection(db, "requests"), where("status","==","Pendiente"), limit(200)));
  const pending = rSnap.size;

  $("kpiEntries").textContent = String(eCount);
  $("kpiAssignments").textContent = String(aCount);
  $("kpiScrap").textContent = String(sCount);
  $("kpiPending").textContent = String(pending);

  // tables
  await refreshDashboardTables(lastEntries, lastAssignments);
}

async function refreshDashboardTables(entries = null, assignments = null) {
  // Si vienen null, no tocar. Si vienen array, pintar.
  if (entries) {
    const tbody = $("tblLastEntries").querySelector("tbody");
    tbody.innerHTML = "";
    entries.slice(0,6).forEach(e => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(e.dateISO)}</td>
        <td>${escapeHtml(e.type)}</td>
        <td>${escapeHtml(e.desc)}</td>
        <td>${escapeHtml(String(e.qty))}</td>
        <td>${escapeHtml(String(e.available))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  if (assignments) {
    const tbody = $("tblLastAssignments").querySelector("tbody");
    tbody.innerHTML = "";
    assignments.slice(0,6).forEach(a => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(a.dateISO)}</td>
        <td>${escapeHtml(a.worker)}</td>
        <td>${escapeHtml(a.entryId)}</td>
        <td>${escapeHtml(String(a.qty))}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}
