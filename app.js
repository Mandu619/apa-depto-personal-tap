/******************************************************
 * APA - Sistema de Registros (TAP)
 * app.js FINAL (APP.HTML) - SIN LOGIN
 *
 * Requisitos:
 * - firebase.js debe exportar: auth, db, secondaryAuth
 * - Firestore collections:
 *   entries, assignments, scrap, requests, employees, users
 ******************************************************/

import { auth, db, secondaryAuth } from "./firebase.js";

import {
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  limit,
  deleteDoc,
  updateDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =====================================================
   Utils internos
===================================================== */
const $ = (id) => document.getElementById(id);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

function on(id, evt, fn) {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
}

function safeNum(v, defVal = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateToTs(iso) {
  if (!iso) return 0;
  const t = Date.parse(`${iso}T00:00:00`);
  return Number.isFinite(t) ? t : 0;
}

function escapeHtml(str) {
  const s = String(str == null ? "" : str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg";
  if (kind) el.classList.add(kind);
}

function formatTimestamp(tsObj) {
  if (!tsObj) return "";
  try {
    const d = tsObj.toDate();
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function withinRange(ts, fromISO, toISO) {
  const from = parseDateToTs(fromISO);
  const to = parseDateToTs(toISO);
  if (from && ts < from) return false;
  if (to && ts > (to + 24 * 60 * 60 * 1000 - 1)) return false;
  return true;
}

function scrollTopInstant() {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  } catch {
    window.scrollTo(0, 0);
  }
}

function toCSV(rows, headers) {
  function esc(v) {
    const s = String(v == null ? "" : v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
  const head = headers.join(",");
  const body = rows
    .map((r) => headers.map((h) => esc(r[h])).join(","))
    .join("\n");
  return `${head}\n${body}`;
}

function downloadText(filename, text, mime) {
  const m = mime || "text/plain";
  const blob = new Blob([text], { type: m });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =====================================================
   DOM principales
===================================================== */
const navTabs = $("navTabs");
const appShell = $("appShell");
const btnLogout = $("btnLogout");
const userName = $("userName");
const userRole = $("userRole");
const views = qsa(".view");

/* =====================================================
   Estado de sesión + cachés
===================================================== */
let currentUser = null;
let currentUserProfile = null;

let entriesCache = [];
let assignmentsCache = [];
let scrapCache = [];
let requestsCache = [];
let employeesCache = [];

let reportRows = [];

/* =====================================================
   Roles
===================================================== */
function role() {
  return (currentUserProfile && currentUserProfile.role) ? currentUserProfile.role : "consulta";
}
function canWrite() {
  const r = role();
  return r === "admin" || r === "operator";
}
function isAdmin() {
  return role() === "admin";
}

/* =====================================================
   UI: mostrar/ocultar
===================================================== */
function showAppOnly() {
  if (navTabs) navTabs.hidden = false;
  if (appShell) appShell.hidden = false;
  if (btnLogout) btnLogout.disabled = false;
  scrollTopInstant();
}

/* =====================================================
   Tabs / Views
===================================================== */
function showView(viewId) {
  views.forEach((v) => (v.hidden = v.id !== viewId));
  qsa(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === viewId));
  scrollTopInstant();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  const viewId = tab.dataset.view;
  if (!viewId) return;
  showView(viewId);
});

/* =====================================================
   Aplicar permisos a UI
===================================================== */
function applyRoleToUI() {
  const writer = canWrite();

  const entryBtn = $("formEntry") ? $("formEntry").querySelector('button[type="submit"]') : null;
  if (entryBtn) entryBtn.disabled = !writer;

  const assignBtn = $("formAssign") ? $("formAssign").querySelector('button[type="submit"]') : null;
  if (assignBtn) assignBtn.disabled = !writer;

  const scrapBtn = $("formScrap") ? $("formScrap").querySelector('button[type="submit"]') : null;
  if (scrapBtn) scrapBtn.disabled = !writer;

  // Mostrar tab empleados solo admin
  const empTab = document.querySelector('[data-view="view-employees"]');
  if (empTab) empTab.hidden = !isAdmin();

  // Mostrar tab Admin solo admin
  const adminTab = document.querySelector('[data-view="view-admin"]');
  if (adminTab) adminTab.hidden = !isAdmin();
}

/* =====================================================
   Password toggles (solo EMPLEADO)
===================================================== */
function setupPasswordToggles() {
  on("btnToggleEmpPass", "click", () => {
    const input = $("empPass");
    const btn = $("btnToggleEmpPass");
    if (!input || !btn) return;
    const isPwd = input.type === "password";
    input.type = isPwd ? "text" : "password";

    btn.setAttribute("aria-label", isPwd ? "Ocultar contraseña" : "Mostrar contraseña");
    btn.setAttribute("title", isPwd ? "Ocultar contraseña" : "Mostrar contraseña");
  });
}


  });
}

/* =====================================================
   LOGOUT (Salir) - FIX REAL
===================================================== */
if (btnLogout) {
  btnLogout.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.warn("Logout warning:", e);
    } finally {
      window.location.replace("./index.html");
    }
  });
}

/* =====================================================
   Firestore: fetch
===================================================== */
async function fetchEntries(n) {
  const max = n || 500;
  try {
    const qRef = query(collection(db, "entries"), orderBy("dateTS", "desc"), limit(max));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchEntries", e);
    return [];
  }
}

async function fetchAssignments(n) {
  const max = n || 500;
  try {
    const qRef = query(collection(db, "assignments"), orderBy("dateTS", "desc"), limit(max));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchAssignments", e);
    return [];
  }
}

async function fetchScrap(n) {
  const max = n || 500;
  try {
    const qRef = query(collection(db, "scrap"), orderBy("dateTS", "desc"), limit(max));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchScrap", e);
    return [];
  }
}

async function fetchRequests(n) {
  const max = n || 500;
  try {
    const qRef = query(collection(db, "requests"), orderBy("createdAt", "desc"), limit(max));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchRequests", e);
    return [];
  }
}

async function fetchEmployees(n) {
  const max = n || 1000;
  try {
    const qRef = query(collection(db, "employees"), orderBy("name", "asc"), limit(max));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchEmployees", e);
    return [];
  }
}

async function preloadAll() {
  entriesCache = await fetchEntries(800);
  assignmentsCache = await fetchAssignments(800);
  scrapCache = await fetchScrap(800);
  requestsCache = await fetchRequests(800);
  // Necesario para dropdowns de trabajador (asignación + informes) en TODOS los roles
  employeesCache = await fetchEmployees(1200);
}

/* =====================================================
   Perfil usuario: users/{uid}
===================================================== */
async function loadUserProfile(uid) {
  try {
    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.error("loadUserProfile", e);
    return null;
  }
}

/* =====================================================
   AUTH STATE (si no hay sesión -> login)
===================================================== */
onAuthStateChanged(auth, async (u) => {
  currentUser = u;

  if (!u) {
    window.location.replace("./index.html");
    return;
  }

  currentUserProfile = await loadUserProfile(u.uid);

  if (!currentUserProfile) {
    alert("Usuario existe en Auth, pero falta perfil en Firestore (users/{uid}). Debe crearlo Admin.");
    await signOut(auth);
    window.location.replace("./index.html");
    return;
  }

  if (userName) userName.textContent = currentUserProfile.name || u.email || "Usuario";
  if (userRole) userRole.textContent = `Rol: ${currentUserProfile.role || "—"}`;

  showAppOnly();
  applyRoleToUI();

  await preloadAll();
  fillWorkersUIFromEmployees();
  fillReportPrimarySelect();
  await refreshEntryDropdowns();

  await refreshDashboard();
  await refreshEntries();
  await refreshAssignments();
  await refreshScrap();
  await refreshRequests();

  if (isAdmin()) {
    await refreshAdminTable();
  }

  if (isAdmin()) {
    await refreshEmployees();
  }

  showView("view-dashboard");
});

/* =====================================================
   DASHBOARD
===================================================== */
async function refreshDashboard() {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const entries30 = entriesCache.filter((e) => safeNum(e.dateTS) >= since).length;
  const assigns30 = assignmentsCache.filter((a) => safeNum(a.dateTS) >= since).length;
  const scrap30 = scrapCache.filter((s) => safeNum(s.dateTS) >= since).length;
  const pending = requestsCache
    .filter((r) => {
      if (!canWrite()) {
        return (r.createdBy || "") === (currentUser && currentUser.uid ? currentUser.uid : "");
      }
      return true;
    })
    .filter((r) => (r.status || "Pendiente") === "Pendiente").length;

  if ($("kpiEntries")) $("kpiEntries").textContent = String(entries30);
  if ($("kpiAssignments")) $("kpiAssignments").textContent = String(assigns30);
  if ($("kpiScrap")) $("kpiScrap").textContent = String(scrap30);
  if ($("kpiPending")) $("kpiPending").textContent = String(pending);

  renderLastEntries(entriesCache.slice(0, 6));
  renderLastAssignments(assignmentsCache.slice(0, 6));

  const dashMsg = $("dashMsg");
  if (dashMsg) setMsg(dashMsg, "Panel actualizado.", "ok");
}

function renderLastEntries(rows) {
  const tbody = $("tblLastEntries") ? $("tblLastEntries").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Sin datos</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.dateISO || "") + "</td>" +
      "<td>" + escapeHtml(r.type || "") + "</td>" +
      "<td>" + escapeHtml(r.desc || "") + "</td>" +
      '<td class="right">' + escapeHtml(String(r.qty || 0)) + "</td>" +
      '<td class="right">' + escapeHtml(String(r.available || 0)) + "</td>";
    tbody.appendChild(tr);
  });
}

function renderLastAssignments(rows) {
  const tbody = $("tblLastAssignments") ? $("tblLastAssignments").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Sin datos</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.dateISO || "") + "</td>" +
      "<td>" + escapeHtml(r.worker || "") + "</td>" +
      "<td>" + escapeHtml(r.entryLabel || r.entryDesc || "") + "</td>" +
      '<td class="right">' + escapeHtml(String(r.qty || 0)) + "</td>";
    tbody.appendChild(tr);
  });
}

/* =====================================================
   ENTRADAS
===================================================== */
on("formEntry", "submit", async (e) => {
  e.preventDefault();
  const msg = $("entryMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar entradas.", "bad");
    return;
  }

  const dateISO = $("entryDate") ? $("entryDate").value : "";
  const type = $("entryType") ? $("entryType").value : "";
  const desc = ($("entryDesc") ? $("entryDesc").value : "").trim();
  const ref = ($("entryRef") ? $("entryRef").value : "").trim();
  const qty = safeNum($("entryQty") ? $("entryQty").value : 0, 0);

  if (!dateISO || !type || !desc || qty <= 0) {
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

    setMsg(msg, "✅ Entrada registrada correctamente.", "ok");

    if ($("formEntry")) $("formEntry").reset();
    if ($("entryDate")) $("entryDate").value = todayISO();

    entriesCache = await fetchEntries(800);
    await refreshEntries();
    await refreshEntryDropdowns();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    setMsg(msg, "❌ No se pudo guardar la entrada. Revisa permisos/reglas.", "bad");
  }
});

on("btnReloadEntries", "click", async () => {
  entriesCache = await fetchEntries(800);
  await refreshEntries();
  await refreshEntryDropdowns();
  await refreshDashboard();
});

async function refreshEntries() {
  const tbody = $("tblEntries") ? $("tblEntries").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  const typeFilter = $("filterEntryType") ? $("filterEntryType").value : "";
  const textFilter = ($("filterEntryText") ? $("filterEntryText").value : "").trim().toLowerCase();

  const rows = entriesCache.filter((r) => {
    if (typeFilter && r.type !== typeFilter) return false;
    const hay = ((r.desc || "") + " " + (r.ref || "")).toLowerCase();
    if (textFilter && hay.indexOf(textFilter) < 0) return false;
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Sin resultados</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.dateISO || "") + "</td>" +
      "<td>" + escapeHtml(r.type || "") + "</td>" +
      "<td>" + escapeHtml(r.desc || "") + "</td>" +
      "<td>" + escapeHtml(r.ref || "") + "</td>" +
      '<td class="right">' + escapeHtml(String(r.qty || 0)) + "</td>" +
      '<td class="right">' + escapeHtml(String(r.available || 0)) + "</td>" +
      "<td>" + escapeHtml(r.createdByName || "") + "</td>";
    tbody.appendChild(tr);
  });
}

async function refreshEntryDropdowns() {
  const assignsSel = $("assignEntryId");
  const scrapSel = $("scrapEntryId");

  const list = entriesCache
    .slice()
    .sort((a, b) => safeNum(b.dateTS) - safeNum(a.dateTS))
    .filter((e) => safeNum(e.available) > 0);

  function opt(e) {
    const label = `${e.type || ""} · ${e.desc || ""} (Disp: ${String(e.available || 0)})`;
    return `<option value="${escapeHtml(e.id)}">${escapeHtml(label)}</option>`;
  }

  const html = '<option value="">Seleccionar…</option>' + list.map(opt).join("");

  if (assignsSel) assignsSel.innerHTML = html;
  if (scrapSel) scrapSel.innerHTML = html;
}

/* =====================================================
   ASIGNACIONES
===================================================== */
on("formAssign", "submit", async (e) => {
  e.preventDefault();
  const msg = $("assignMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar asignaciones.", "bad");
    return;
  }

  const dateISO = $("assignDate") ? $("assignDate").value : "";
  const entryId = $("assignEntryId") ? $("assignEntryId").value : "";
  const qty = safeNum($("assignQty") ? $("assignQty").value : 0, 0);
  const reason = ($("assignReason") ? $("assignReason").value : "").trim();

  const worker = ($("assignWorkerSelect") ? $("assignWorkerSelect").value : "").trim();

  if (!dateISO || !entryId || qty <= 0 || !worker || !reason) {
    setMsg(msg, "Campos inválidos. Revisa fecha, trabajador, ítem, cantidad y motivo.", "warn");
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const entryRef = doc(db, "entries", entryId);
      const entrySnap = await tx.get(entryRef);
      if (!entrySnap.exists()) throw new Error("ENTRY_NOT_FOUND");

      const entry = entrySnap.data();
      const available = safeNum(entry.available, 0);
      if (qty > available) throw new Error("NO_STOCK");

      tx.update(entryRef, { available: available - qty });

      const label = (entry.type || "") + " · " + (entry.desc || "");
      const assignRef = doc(collection(db, "assignments"));

      tx.set(assignRef, {
        dateISO,
        dateTS: parseDateToTs(dateISO),
        worker,
        qty,
        entryId,
        entryLabel: label,
        entryType: entry.type || "",
        entryDesc: entry.desc || "",
        reason,
        createdBy: currentUser.uid,
        createdByName: currentUserProfile.name || currentUser.email || "Usuario",
        createdAt: serverTimestamp()
      });
    });

    setMsg(msg, "✅ Asignación registrada.", "ok");
    if ($("formAssign")) $("formAssign").reset();
    if ($("assignDate")) $("assignDate").value = todayISO();

    entriesCache = await fetchEntries(800);
    assignmentsCache = await fetchAssignments(800);

    await refreshEntryDropdowns();
    await refreshAssignments();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    if (String(err.message).includes("NO_STOCK")) {
      setMsg(msg, "❌ Cantidad supera disponible del ítem.", "bad");
    } else {
      setMsg(msg, "❌ No se pudo guardar. Revisa permisos/reglas.", "bad");
    }
  }
});

on("btnReloadAssignments", "click", async () => {
  assignmentsCache = await fetchAssignments(800);
  await refreshAssignments();
  await refreshDashboard();
});

async function refreshAssignments() {
  const tbody = $("tblAssignments") ? $("tblAssignments").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  const workerFilter = ($("filterAssignWorker") ? $("filterAssignWorker").value : "").trim().toLowerCase();
  const fromISO = $("filterAssignFrom") ? $("filterAssignFrom").value : "";
  const toISO = $("filterAssignTo") ? $("filterAssignTo").value : "";

  const rows = assignmentsCache.filter((a) => {
    if (!withinRange(safeNum(a.dateTS), fromISO, toISO)) return false;
    if (workerFilter) {
      const hay = (a.worker || "").toLowerCase();
      if (!hay.includes(workerFilter)) return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Sin resultados</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.dateISO || "") + "</td>" +
      "<td>" + escapeHtml(r.worker || "") + "</td>" +
      "<td>" + escapeHtml(r.entryLabel || (r.entryType || "") + " · " + (r.entryDesc || "")) + "</td>" +
      '<td class="right">' + escapeHtml(String(r.qty || 0)) + "</td>" +
      "<td>" + escapeHtml(r.reason || "") + "</td>" +
      "<td>" + escapeHtml(r.createdByName || "") + "</td>";
    tbody.appendChild(tr);
  });
}

/* =====================================================
   MERMA
===================================================== */
on("formScrap", "submit", async (e) => {
  e.preventDefault();
  const msg = $("scrapMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar merma.", "bad");
    return;
  }

  const dateISO = $("scrapDate") ? $("scrapDate").value : "";
  const entryId = $("scrapEntryId") ? $("scrapEntryId").value : "";
  const qty = safeNum($("scrapQty") ? $("scrapQty").value : 0, 0);
  const reason = $("scrapReason") ? $("scrapReason").value : "";
  const detail = ($("scrapDetail") ? $("scrapDetail").value : "").trim();

  if (!dateISO || !entryId || qty <= 0 || !reason) {
    setMsg(msg, "Campos inválidos. Revisa fecha, ítem, cantidad y motivo.", "warn");
    return;
  }
  if (reason === "Otro" && !detail) {
    setMsg(msg, "Debes ingresar detalle cuando motivo es 'Otro'.", "warn");
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const entryRef = doc(db, "entries", entryId);
      const entrySnap = await tx.get(entryRef);
      if (!entrySnap.exists()) throw new Error("ENTRY_NOT_FOUND");

      const entry = entrySnap.data();
      const available = safeNum(entry.available, 0);
      if (qty > available) throw new Error("NO_STOCK");

      tx.update(entryRef, { available: available - qty });

      const label = (entry.type || "") + " · " + (entry.desc || "");
      const scrapRef = doc(collection(db, "scrap"));

      tx.set(scrapRef, {
        dateISO,
        dateTS: parseDateToTs(dateISO),
        entryId,
        entryLabel: label,
        entryType: entry.type || "",
        entryDesc: entry.desc || "",
        qty,
        reason,
        detail: reason === "Otro" ? detail : "",
        createdBy: currentUser.uid,
        createdByName: currentUserProfile.name || currentUser.email || "Usuario",
        createdAt: serverTimestamp()
      });
    });

    setMsg(msg, "✅ Merma registrada.", "ok");
    if ($("formScrap")) $("formScrap").reset();
    if ($("scrapDate")) $("scrapDate").value = todayISO();

    entriesCache = await fetchEntries(800);
    scrapCache = await fetchScrap(800);

    await refreshEntryDropdowns();
    await refreshScrap();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    if (String(err.message).includes("NO_STOCK")) {
      setMsg(msg, "❌ Cantidad supera disponible del ítem.", "bad");
    } else {
      setMsg(msg, "❌ No se pudo guardar. Revisa permisos/reglas.", "bad");
    }
  }
});

async function refreshScrap() {
  const tbody = $("tblScrap") ? $("tblScrap").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!scrapCache.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Sin datos</td></tr>';
    return;
  }

  scrapCache.forEach((r) => {
    const motivo = r.reason === "Otro" ? (r.reason + ": " + (r.detail || "")) : (r.reason || "");
    const itemLabel = r.entryLabel || ((r.entryType || "") + " · " + (r.entryDesc || "")).trim();
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.dateISO || "") + "</td>" +
      "<td>" + escapeHtml(itemLabel) + "</td>" +
      "<td>" + escapeHtml(r.entryType || "") + "</td>" +
      "<td>" + escapeHtml(r.entryDesc || "") + "</td>" +
      '<td class="right">' + escapeHtml(String(r.qty || 0)) + "</td>" +
      "<td>" + escapeHtml(motivo) + "</td>" +
      "<td>" + escapeHtml(r.createdByName || "") + "</td>";
    tbody.appendChild(tr);
  });
}

/* =====================================================
   SOLICITUDES
===================================================== */
function ensureRequestTypeHasSolicitud() {
  const sel = $("reqType");
  if (!sel) return;

  const exists = Array.from(sel.options).some((o) => (o.value || "").toLowerCase() === "solicitud");
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = "Solicitud";
    opt.textContent = "Solicitud";
    sel.appendChild(opt);
  }
}

on("formRequest", "submit", async (e) => {
  e.preventDefault();
  const msg = $("reqMsg");
  setMsg(msg, "");

  const type = $("reqType") ? $("reqType").value : "";
  const text = ($("reqText") ? $("reqText").value : "").trim();
  const priority = $("reqPriority") ? $("reqPriority").value : "Normal";

  if (!type || !text) {
    setMsg(msg, "Completa tipo y detalle.", "warn");
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
      createdByEmail: currentUser.email || "",
      createdAt: serverTimestamp()
    });

    setMsg(msg, "✅ Solicitud creada.", "ok");
    if ($("formRequest")) $("formRequest").reset();

    requestsCache = await fetchRequests(800);
    await refreshRequests();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    setMsg(msg, "❌ No se pudo crear. Revisa permisos/reglas.", "bad");
  }
});

on("btnReloadRequests", "click", async () => {
  requestsCache = await fetchRequests(800);
  await refreshRequests();
  await refreshDashboard();
});

async function refreshRequests() {
  ensureRequestTypeHasSolicitud();

  const tbody = $("tblRequests") ? $("tblRequests").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  const statusFilter = $("filterReqStatus") ? $("filterReqStatus").value : "";
  const textFilter = ($("filterReqText") ? $("filterReqText").value : "").trim().toLowerCase();

  const rows = requestsCache.filter((r) => {
    // Visibilidad por rol:
    // - consulta: solo ve sus propias solicitudes
    // - operator/admin: ve todas
    if (!canWrite()) {
      if ((r.createdBy || "") !== (currentUser && currentUser.uid ? currentUser.uid : "")) return false;
    }

    const status = r.status || "Pendiente";
    if (statusFilter && status !== statusFilter) return false;

    const hay = ((r.type || "") + " " + (r.createdByName || "") + " " + (r.createdByEmail || "") + " " + (r.text || "")).toLowerCase();
    if (textFilter && !hay.includes(textFilter)) return false;

    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Sin resultados</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const isPending = (r.status || "Pendiente") === "Pendiente";
    const canAnswer = canWrite() && isPending;

    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(formatTimestamp(r.createdAt) || "") + "</td>" +
      "<td>" + escapeHtml(r.type || "") + "</td>" +
      "<td>" + escapeHtml(r.createdByName || r.createdByEmail || r.createdBy || "") + "</td>" +
      "<td>" + escapeHtml(r.text || "") + "</td>" +
      "<td>" + escapeHtml(r.priority || "") + "</td>" +
      "<td>" + escapeHtml(r.status || "") + "</td>" +
      "<td>" + escapeHtml(r.response || "") + "</td>" +
      "<td>" +
      (canAnswer
        ? '<button class="btn btn--ghost" data-action="answer" data-id="' + escapeHtml(r.id) + '">Responder</button>'
        : '<span class="muted small">—</span>') +
      "</td>";

    tbody.appendChild(tr);
  });

  tbody.onclick = async (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "answer") {
      await answerRequest(btn.dataset.id);
    }
  };
}

async function answerRequest(requestId) {
  if (!canWrite()) return;
  const response = prompt("Ingrese respuesta (quedará registrada):");
  if (response === null) return;
  const txt = response.trim();
  if (!txt) return;

  try {
    await updateDoc(doc(db, "requests", requestId), {
      status: "Respondida",
      response: txt,
      respondedBy: currentUser.uid,
      respondedByName: currentUserProfile.name || currentUser.email || "Usuario",
      respondedAt: serverTimestamp()
    });

    requestsCache = await fetchRequests(800);
    await refreshRequests();
    await refreshDashboard();
  } catch (e) {
    console.error(e);
    alert("No se pudo responder (¿permisos?).");
  }
}

/* =====================================================
   INFORMES
===================================================== */
on("btnRunReport", "click", async () => {
  await runReport();
});

on("btnExportCSV", "click", () => {
  if (!reportRows.length) return;
  const headers = ["Fecha", "TipoMov", "TipoEntrada", "Trabajador", "Entrada", "Descripcion", "Cantidad", "Motivo"];
  const csv = toCSV(reportRows, headers);
  downloadText("reporte_apa.csv", csv, "text/csv");
});

async function runReport() {
  const msg = $("reportMsg");
  setMsg(msg, "Generando informe...", "info");

  entriesCache = await fetchEntries(1200);
  assignmentsCache = await fetchAssignments(1200);
  scrapCache = await fetchScrap(1200);

  const mode = $("reportMode") ? $("reportMode").value : "assign_worker";
  const primary = ($("reportPrimarySelect") ? $("reportPrimarySelect").value : "").trim();
  const text = ($("reportFilter") ? $("reportFilter").value : "").trim().toLowerCase();

  const fromISO = $("reportFrom") ? $("reportFrom").value : "";
  const toISO = $("reportTo") ? $("reportTo").value : "";

  const rows = [];

  // 1) Asignaciones por trabajador
  if (mode === "assign_worker") {
    assignmentsCache.forEach((a) => {
      const ts = safeNum(a.dateTS);
      if (!withinRange(ts, fromISO, toISO)) return;
      if (primary && (a.worker || "") !== primary) return;

      const hay = ((a.worker || "") + " " + (a.entryType || "") + " " + (a.entryDesc || "") + " " + (a.reason || "")).toLowerCase();
      if (text && !hay.includes(text)) return;

      rows.push({
        Fecha: a.dateISO || "",
        TipoMov: "Asignación",
        TipoEntrada: a.entryType || "",
        Trabajador: a.worker || "",
        Entrada: a.entryId || "",
        Descripcion: a.entryDesc || "",
        Cantidad: safeNum(a.qty),
        Motivo: a.reason || ""
      });
    });
  }

  // 2) Movimientos por tipo (Asignación + Merma)
  if (mode === "mov_type") {
    assignmentsCache.forEach((a) => {
      const ts = safeNum(a.dateTS);
      if (!withinRange(ts, fromISO, toISO)) return;
      if (primary && (a.entryType || "") !== primary) return;
      const hay = ((a.worker || "") + " " + (a.entryType || "") + " " + (a.entryDesc || "") + " " + (a.reason || "")).toLowerCase();
      if (text && !hay.includes(text)) return;

      rows.push({
        Fecha: a.dateISO || "",
        TipoMov: "Asignación",
        TipoEntrada: a.entryType || "",
        Trabajador: a.worker || "",
        Entrada: a.entryId || "",
        Descripcion: a.entryDesc || "",
        Cantidad: safeNum(a.qty),
        Motivo: a.reason || ""
      });
    });

    scrapCache.forEach((s) => {
      const ts = safeNum(s.dateTS);
      if (!withinRange(ts, fromISO, toISO)) return;
      if (primary && (s.entryType || "") !== primary) return;
      const motivo = s.reason === "Otro" ? (s.reason + ": " + (s.detail || "")) : (s.reason || "");
      const hay = ((s.entryType || "") + " " + (s.entryDesc || "") + " " + motivo).toLowerCase();
      if (text && !hay.includes(text)) return;

      rows.push({
        Fecha: s.dateISO || "",
        TipoMov: "Merma",
        TipoEntrada: s.entryType || "",
        Trabajador: "",
        Entrada: s.entryId || "",
        Descripcion: s.entryDesc || "",
        Cantidad: safeNum(s.qty),
        Motivo: motivo
      });
    });
  }

  // 3) Stock actual (no depende de fechas)
  if (mode === "stock") {
    entriesCache.forEach((e) => {
      if (primary && (e.type || "") !== primary) return;
      const hay = ((e.type || "") + " " + (e.desc || "") + " " + (e.ref || "")).toLowerCase();
      if (text && !hay.includes(text)) return;

      rows.push({
        Fecha: e.dateISO || "",
        TipoMov: "Stock",
        TipoEntrada: e.type || "",
        Trabajador: "",
        Entrada: e.id || "",
        Descripcion: e.desc || "",
        Cantidad: safeNum(e.available),
        Motivo: "Disponible"
      });
    });
  }

  rows.sort((a, b) => parseDateToTs(b.Fecha) - parseDateToTs(a.Fecha));
  reportRows = rows;

  renderReportTable(rows);

  const totalCount = rows.length;
  const totalQty = rows.reduce((acc, r) => acc + safeNum(r.Cantidad), 0);
  const totalScrap = rows.filter((r) => r.TipoMov === "Merma").reduce((acc, r) => acc + safeNum(r.Cantidad), 0);
  const remainingTotal = entriesCache.reduce((acc, e) => acc + safeNum(e.available), 0);

  if ($("reportCount")) $("reportCount").textContent = String(totalCount);
  if ($("reportQty")) $("reportQty").textContent = String(totalQty);
  if ($("reportScrapTotal")) $("reportScrapTotal").textContent = String(totalScrap);
  if ($("reportRemainingTotal")) $("reportRemainingTotal").textContent = String(remainingTotal);

  const btnCSV = $("btnExportCSV");
  if (btnCSV) btnCSV.disabled = rows.length === 0;

  setMsg(msg, `✅ Informe listo (${totalCount} registros).`, "ok");
}

function renderReportTable(rows) {
  const tbody = $("tblReport") ? $("tblReport").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Sin resultados</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.Fecha) + "</td>" +
      "<td>" + escapeHtml(r.TipoEntrada) + "</td>" +
      "<td>" + escapeHtml(r.Trabajador || "") + "</td>" +
      "<td>" + escapeHtml(r.Entrada) + "</td>" +
      "<td>" + escapeHtml(r.Descripcion) + "</td>" +
      '<td class="right">' + escapeHtml(String(r.Cantidad)) + "</td>" +
      "<td>" + escapeHtml(r.Motivo || r.TipoMov) + "</td>";
    tbody.appendChild(tr);
  });
}

/* =====================================================
   ADMIN (solo admin): eliminar / corregir BD
===================================================== */
on("btnAdminLoad", "click", async () => {
  await loadAdminTable();
});

async function loadAdminTable() {
  const msg = $("adminMsg");
  if (!isAdmin()) {
    setMsg(msg, "❌ Solo admin.", "bad");
    return;
  }

  const entity = $("adminEntity") ? $("adminEntity").value : "assignments";
  const n = safeNum($("adminLimit") ? $("adminLimit").value : 50, 50);

  setMsg(msg, "Cargando...", "info");

  let rows = [];
  try {
    rows = await fetchAdminEntity(entity, n);
    renderAdminTable(entity, rows);
    setMsg(msg, `✅ Listo (${rows.length}).`, "ok");
  } catch (e) {
    console.error(e);
    setMsg(msg, "❌ No se pudo cargar. Revisa permisos/reglas.", "bad");
  }
}

async function fetchAdminEntity(entity, n) {
  const max = n || 50;
  if (entity === "employees") {
    const qRef = query(collection(db, "employees"), orderBy("name", "asc"), limit(max));
    const snap = await getDocs(qRef);
    const out = [];
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  }
  if (entity === "requests") {
    const qRef = query(collection(db, "requests"), orderBy("createdAt", "desc"), limit(max));
    const snap = await getDocs(qRef);
    const out = [];
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  }

  // entries / assignments / scrap
  const qRef = query(collection(db, entity), orderBy("dateTS", "desc"), limit(max));
  const snap = await getDocs(qRef);
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

function renderAdminTable(entity, rows) {
  const tbody = $("tblAdmin") ? $("tblAdmin").querySelector("tbody") : null;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Sin datos</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");

    let fecha = "";
    let detalle = "";
    let cant = "";

    if (entity === "assignments") {
      fecha = r.dateISO || "";
      detalle = `${r.worker || ""} · ${(r.entryLabel || (r.entryType || "") + " · " + (r.entryDesc || ""))}`;
      cant = String(r.qty || 0);
    } else if (entity === "scrap") {
      fecha = r.dateISO || "";
      detalle = `${r.entryLabel || (r.entryType || "") + " · " + (r.entryDesc || "")}`;
      cant = String(r.qty || 0);
    } else if (entity === "entries") {
      fecha = r.dateISO || "";
      detalle = `${r.type || ""} · ${r.desc || ""} (Disp: ${String(r.available || 0)})`;
      cant = String(r.qty || 0);
    } else if (entity === "requests") {
      fecha = formatTimestamp(r.createdAt) || "";
      detalle = `${r.type || ""} · ${r.text || ""}`;
      cant = (r.status || "");
    } else if (entity === "employees") {
      fecha = "—";
      detalle = `${r.name || ""} · ${r.email || ""} · rol: ${r.role || ""} · activo: ${r.active === false ? "No" : "Sí"}`;
      cant = "";
    }

    tr.innerHTML =
      "<td>" + escapeHtml(fecha) + "</td>" +
      "<td>" + escapeHtml(detalle) + "</td>" +
      '<td class="right">' + escapeHtml(cant) + "</td>" +
      '<td><button class="btn btn--danger" data-entity="' + escapeHtml(entity) + '" data-id="' + escapeHtml(r.id) + '">Eliminar</button></td>';

    tbody.appendChild(tr);
  });

  tbody.onclick = async (ev) => {
    const btn = ev.target.closest("button[data-id]");
    if (!btn) return;
    const entity = btn.dataset.entity;
    const id = btn.dataset.id;
    await adminDeleteEntity(entity, id);
  };
}

async function adminDeleteEntity(entity, id) {
  if (!isAdmin()) return;
  const msg = $("adminMsg");

  const ok = confirm(`¿Eliminar definitivamente este registro (${entity})?`);
  if (!ok) return;

  try {
    // Asignación: devolver stock y borrar
    if (entity === "assignments") {
      await runTransaction(db, async (tx) => {
        const aRef = doc(db, "assignments", id);
        const aSnap = await tx.get(aRef);
        if (!aSnap.exists()) throw new Error("NOT_FOUND");
        const a = aSnap.data();

        const entryId = a.entryId;
        const qty = safeNum(a.qty, 0);
        if (entryId && qty > 0) {
          const eRef = doc(db, "entries", entryId);
          const eSnap = await tx.get(eRef);
          if (eSnap.exists()) {
            const e = eSnap.data();
            const avail = safeNum(e.available, 0);
            tx.update(eRef, { available: avail + qty });
          }
        }
        tx.delete(aRef);
      });
      setMsg(msg, "✅ Asignación eliminada (stock repuesto).", "ok");
    }

    // Merma: devolver stock y borrar
    else if (entity === "scrap") {
      await runTransaction(db, async (tx) => {
        const sRef = doc(db, "scrap", id);
        const sSnap = await tx.get(sRef);
        if (!sSnap.exists()) throw new Error("NOT_FOUND");
        const s = sSnap.data();

        const entryId = s.entryId;
        const qty = safeNum(s.qty, 0);
        if (entryId && qty > 0) {
          const eRef = doc(db, "entries", entryId);
          const eSnap = await tx.get(eRef);
          if (eSnap.exists()) {
            const e = eSnap.data();
            const avail = safeNum(e.available, 0);
            tx.update(eRef, { available: avail + qty });
          }
        }
        tx.delete(sRef);
      });
      setMsg(msg, "✅ Merma eliminada (stock repuesto).", "ok");
    }

    // Entrada: solo si no tiene movimientos asociados
    else if (entity === "entries") {
      // Bloqueo simple usando caché local
      const hasAssign = (assignmentsCache || []).some((a) => a.entryId === id);
      const hasScrap = (scrapCache || []).some((s) => s.entryId === id);
      if (hasAssign || hasScrap) {
        setMsg(msg, "❌ No se puede eliminar esta entrada: tiene asignaciones y/o mermas asociadas.", "warn");
        return;
      }
      await deleteDoc(doc(db, "entries", id));
      setMsg(msg, "✅ Entrada eliminada.", "ok");
    }

    // Solicitud
    else if (entity === "requests") {
      await deleteDoc(doc(db, "requests", id));
      setMsg(msg, "✅ Solicitud eliminada.", "ok");
    }

    // Empleado (perfil): elimina documents employees/{uid} y users/{uid}. Auth NO se elimina.
    else if (entity === "employees") {
      await deleteDoc(doc(db, "employees", id));
      try { await deleteDoc(doc(db, "users", id)); } catch {}
      setMsg(msg, "✅ Perfil eliminado (Auth queda intacto).", "ok");
    }

    // Refrescar caches clave
    await preloadAll();
    fillWorkersUIFromEmployees();
    await refreshEntryDropdowns();
    await refreshDashboard();
    await refreshEntries();
    await refreshAssignments();
    await refreshScrap();
    await refreshRequests();
    if (isAdmin()) await refreshEmployees();

    // Recargar admin table
    await loadAdminTable();
  } catch (e) {
    console.error(e);
    setMsg(msg, "❌ No se pudo eliminar (¿permisos?).", "bad");
  }
}

/* =====================================================
   EMPLEADOS (ADMIN)
===================================================== */
on("btnCreateEmployee", "click", async () => {
  const msg = $("empMsg");
  setMsg(msg, "");

  if (!isAdmin()) {
    setMsg(msg, "❌ Solo admin puede crear empleados.", "bad");
    return;
  }

  if (!secondaryAuth) {
    setMsg(msg, "❌ secondaryAuth no disponible. Revisa firebase.js.", "bad");
    return;
  }

  const first = ($("empFirst") ? $("empFirst").value : "").trim();
  const last = ($("empLast") ? $("empLast").value : "").trim();
  const email = ($("empEmail") ? $("empEmail").value : "").trim().toLowerCase();
  const pass = $("empPass") ? $("empPass").value : "";
  const r = $("empRole") ? $("empRole").value : "consulta";
  const active = ($("empActive") ? $("empActive").value : "true") === "true";

  if (!first || !last || !email || pass.length < 6) {
    setMsg(msg, "Completa nombre, apellidos, correo y clave (mínimo 6).", "warn");
    return;
  }

  setMsg(msg, "Creando usuario en Authentication...", "info");

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pass);
    try { await updateProfile(cred.user, { displayName: `${first} ${last}` }); } catch {}

    const uid = cred.user.uid;
    const fullName = `${first} ${last}`;

    setMsg(msg, "Guardando perfil en Firestore...", "info");

    await setDoc(doc(db, "employees", uid), {
      uid,
      first,
      last,
      name: fullName,
      email,
      role: r,
      active,
      createdBy: currentUser.uid,
      createdByName: currentUserProfile.name || currentUser.email || "Usuario",
      createdAt: serverTimestamp()
    });

    await setDoc(doc(db, "users", uid), {
      first, last, name: fullName, email, role: r, active
    });

    ["empFirst","empLast","empEmail","empPass"].forEach((id) => { if ($(id)) $(id).value = ""; });
    if ($("empRole")) $("empRole").value = "consulta";
    if ($("empActive")) $("empActive").value = "true";

    setMsg(msg, "✅ Empleado creado. Ya puede iniciar sesión.", "ok");

    await refreshEmployees();
    fillWorkersUIFromEmployees();
  } catch (err) {
    console.error(err);
    const code = err && err.code ? err.code : "";
    if (code.includes("auth/email-already-in-use")) {
      setMsg(msg, "❌ Ese correo ya está registrado.", "bad");
    } else {
      setMsg(msg, `❌ Error al crear empleado (${code || "desconocido"}).`, "bad");
    }
  }
});

on("btnReloadEmployees", "click", async () => {
  await refreshEmployees();
  fillWorkersUIFromEmployees();
});

async function refreshEmployees() {
  employeesCache = await fetchEmployees(1200);
  renderEmployeesTable();
}

function renderEmployeesTable() {
  const tbody = $("tblEmployees") ? $("tblEmployees").querySelector("tbody") : null;
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!employeesCache.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Sin datos</td></tr>';
    return;
  }

  employeesCache.forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(e.name || `${e.first || ""} ${e.last || ""}`) + "</td>" +
      "<td>" + escapeHtml(e.email || "") + "</td>" +
      "<td>" + escapeHtml(e.role || "") + "</td>" +
      "<td>" + (e.active === false ? "No" : "Sí") + "</td>";
    tbody.appendChild(tr);
  });
}

/* =====================================================
   Trabajadores: llenar selects desde employees
===================================================== */
function fillWorkersUIFromEmployees() {
  const active = (employeesCache || []).filter((e) => e.active !== false);

  const selAssign = $("assignWorkerSelect");
  if (selAssign) {
    selAssign.innerHTML =
      '<option value="">(Seleccionar trabajador)</option>' +
      active.map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
  }

  fillReportPrimarySelect();
}

/* =====================================================
   INFORMES - UI coherente
===================================================== */
function fillReportPrimarySelect() {
  const mode = $("reportMode") ? $("reportMode").value : "assign_worker";
  const sel = $("reportPrimarySelect");
  if (!sel) return;

  if (mode === "assign_worker") {
    const active = (employeesCache || []).filter((e) => e.active !== false);
    sel.innerHTML =
      '<option value="">(Todos / sin filtro)</option>' +
      active.map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
    return;
  }

  // Para movimientos por tipo y stock: filtrar por tipo de entrada
  const types = ["EPP", "Uniforme", "Documentación", "Insumo", "Otro"];
  sel.innerHTML =
    '<option value="">(Todos los tipos)</option>' +
    types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
}

on("reportMode", "change", () => {
  fillReportPrimarySelect();
});

/* =====================================================
   BOOT
===================================================== */
(function boot() {
  console.log("[APA] app.js cargado OK");
  setupPasswordToggles();

  // Fechas por defecto si existen
  ["entryDate","assignDate","scrapDate"].forEach((id) => {
    const el = $(id);
    if (el) el.value = todayISO();
  });

  // Asegurar que reqType tenga "Solicitud"
  ensureRequestTypeHasSolicitud();
})();



