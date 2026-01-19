/******************************************************
 * APA - Sistema de Registros (TAP)
 * app.js FINAL (corrige import downloadText)
 * Requiere firebase.js exportando:
 *   export const auth, db, secondaryAuth
 ******************************************************/

import { auth, db, secondaryAuth } from "./firebase.js";

import {
  signInWithEmailAndPassword,
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
  updateDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  todayISO,
  setMsg,
  escapeHtml,
  toCSV,
  parseDateToTs
} from "./utils.js";

/* ---------------------------------------------------
   Helpers DOM
--------------------------------------------------- */
const $ = (id) => document.getElementById(id);

function on(id, evt, fn) {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
}

function qsa(sel) {
  return Array.from(document.querySelectorAll(sel));
}

function safeNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function scrollTopInstant() {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  } catch {
    window.scrollTo(0, 0);
  }
}

/* ---------------------------------------------------
   ✅ FIX: downloadText dentro de app.js
--------------------------------------------------- */
function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------
   DOM refs
--------------------------------------------------- */
const navTabs = $("navTabs");
const appShell = $("appShell");
const btnLogout = $("btnLogout");
const userName = $("userName");
const userRole = $("userRole");
const views = qsa(".view");

/* ---------------------------------------------------
   View switching
--------------------------------------------------- */
function showView(viewId) {
  views.forEach(v => v.hidden = (v.id !== viewId));
  qsa(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === viewId));
  scrollTopInstant();
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  const viewId = tab.dataset.view;
  if (!viewId) return;
  showView(viewId);
});

/* ---------------------------------------------------
   Default dates
--------------------------------------------------- */
["entryDate", "assignDate", "scrapDate"].forEach(id => {
  if ($(id)) $(id).value = todayISO();
});

/* ---------------------------------------------------
   Session + caches
--------------------------------------------------- */
let currentUser = null;
let currentUserProfile = null;

let entriesCache = [];
let assignmentsCache = [];
let scrapCache = [];
let requestsCache = [];
let employeesCache = [];

let reportRows = [];

/* ---------------------------------------------------
   Roles
--------------------------------------------------- */
function role() {
  return currentUserProfile?.role || "consulta";
}
function canWrite() {
  const r = role();
  return r === "admin" || r === "operator";
}
function isAdmin() {
  return role() === "admin";
}

/* ---------------------------------------------------
   UI state control
--------------------------------------------------- */
function showLoginOnly() {
  if ($("loginCard")) $("loginCard").hidden = false;
  if (navTabs) navTabs.hidden = true;
  if (appShell) appShell.hidden = true;
  views.forEach(v => v.hidden = true);
  if (btnLogout) btnLogout.disabled = true;

  if (userName) userName.textContent = "No autenticado";
  if (userRole) userRole.textContent = "—";

  scrollTopInstant();
}

function showAppShell() {
  if ($("loginCard")) $("loginCard").hidden = true;
  if (appShell) appShell.hidden = false;
  if (navTabs) navTabs.hidden = false;
  if (btnLogout) btnLogout.disabled = false;
  scrollTopInstant();
}

/* ---------------------------------------------------
   Apply role to UI
--------------------------------------------------- */
function applyRoleToUI() {
  const writer = canWrite();

  // Disable submits if cannot write
  const entryBtn = $("formEntry")?.querySelector('button[type="submit"]');
  if (entryBtn) entryBtn.disabled = !writer;

  const assignBtn = $("formAssign")?.querySelector('button[type="submit"]');
  if (assignBtn) assignBtn.disabled = !writer;

  const scrapBtn = $("formScrap")?.querySelector('button[type="submit"]');
  if (scrapBtn) scrapBtn.disabled = !writer;

  // Employees tab only admin
  const empTabBtn = document.querySelector('[data-view="view-employees"]');
  if (empTabBtn) empTabBtn.hidden = !isAdmin();
}

/* ---------------------------------------------------
   Password toggles
--------------------------------------------------- */
function setupPasswordToggles() {
  // Login
  on("btnTogglePassword", "click", () => {
    const input = $("loginPassword");
    const btn = $("btnTogglePassword");
    if (!input || !btn) return;

    const isPwd = input.type === "password";
    input.type = isPwd ? "text" : "password";
    btn.textContent = isPwd ? "🙈" : "👁️";
  });

  // Employee create (admin)
  on("btnToggleEmpPass", "click", () => {
    const input = $("empPass");
    const btn = $("btnToggleEmpPass");
    if (!input || !btn) return;

    const isPwd = input.type === "password";
    input.type = isPwd ? "text" : "password";
    btn.textContent = isPwd ? "🙈" : "👁️";
  });
}

/* ---------------------------------------------------
   Load profile /users/{uid}
--------------------------------------------------- */
async function loadUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

/* ---------------------------------------------------
   AUTH Handlers
--------------------------------------------------- */
on("btnLogin", "click", async () => {
  const email = ($("loginEmail")?.value || "").trim();
  const password = $("loginPassword")?.value || "";
  const msg = $("loginMsg");

  setMsg(msg, "");
  if (!email || !password) {
    setMsg(msg, "Debes ingresar correo y contraseña.", "warn");
    return;
  }

  setMsg(msg, "Verificando credenciales...", "info");

  try {
    await signInWithEmailAndPassword(auth, email, password);
    setMsg(msg, "✅ Ingreso exitoso. Cargando...", "ok");
  } catch (err) {
    console.error(err);
    const code = err?.code || "";

    if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password")) {
      setMsg(msg, "❌ Correo o contraseña incorrectos.", "bad");
    } else if (code.includes("auth/user-not-found")) {
      setMsg(msg, "❌ No existe un usuario con ese correo.", "bad");
    } else if (code.includes("auth/unauthorized-domain")) {
      setMsg(msg, "❌ Dominio no autorizado. Agrega 'mandu619.github.io' en Firebase Auth → Authorized domains.", "bad");
    } else if (code.includes("auth/too-many-requests")) {
      setMsg(msg, "⚠️ Demasiados intentos. Espera un momento y prueba otra vez.", "warn");
    } else {
      setMsg(msg, `❌ Error al ingresar (${code || "desconocido"}).`, "bad");
    }
  }
});

on("btnLogout", "click", async () => {
  try {
    await signOut(auth);
  } catch (e) {
    console.error(e);
  }
});

onAuthStateChanged(auth, async (u) => {
  currentUser = u;

  if (!u) {
    currentUserProfile = null;
    showLoginOnly();
    setMsg($("loginMsg"), "Ingresa tus credenciales para continuar.", "info");
    return;
  }

  currentUserProfile = await loadUserProfile(u.uid);

  if (!currentUserProfile) {
    showLoginOnly();
    setMsg(
      $("loginMsg"),
      "⚠️ Usuario existe en Authentication, pero falta su perfil en Firestore: users/{uid}. Pide al admin crearlo.",
      "warn"
    );
    return;
  }

  if (userName) userName.textContent = currentUserProfile.name || u.email || "Usuario";
  if (userRole) userRole.textContent = `Rol: ${currentUserProfile.role || "—"}`;

  showAppShell();
  applyRoleToUI();

  showView("view-dashboard");

  await preloadAll();
  await refreshDashboard();
  await refreshEntries();
  await refreshEntryDropdowns();
  await refreshAssignments();
  await refreshScrap();
  await refreshRequests();

  if (isAdmin()) {
    await refreshEmployees();
  }

  fillWorkersUIFromEmployees();
});

/* ---------------------------------------------------
   Preload caches
--------------------------------------------------- */
async function preloadAll() {
  entriesCache = await fetchEntries(500);
  assignmentsCache = await fetchAssignments(500);
  scrapCache = await fetchScrap(500);
  requestsCache = await fetchRequests(500);
  employeesCache = isAdmin() ? await fetchEmployees(1000) : [];
}

/* ---------------------------------------------------
   Fetch functions
--------------------------------------------------- */
async function fetchEntries(n = 200) {
  try {
    const qRef = query(collection(db, "entries"), orderBy("dateTS", "desc"), limit(n));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchEntries", e);
    return [];
  }
}

async function fetchAssignments(n = 200) {
  try {
    const qRef = query(collection(db, "assignments"), orderBy("dateTS", "desc"), limit(n));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchAssignments", e);
    return [];
  }
}

async function fetchScrap(n = 200) {
  try {
    const qRef = query(collection(db, "scrap"), orderBy("dateTS", "desc"), limit(n));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchScrap", e);
    return [];
  }
}

async function fetchRequests(n = 200) {
  try {
    const qRef = query(collection(db, "requests"), orderBy("createdAt", "desc"), limit(n));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchRequests", e);
    return [];
  }
}

async function fetchEmployees(n = 200) {
  try {
    const qRef = query(collection(db, "employees"), orderBy("name", "asc"), limit(n));
    const snap = await getDocs(qRef);
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    return rows;
  } catch (e) {
    console.error("fetchEmployees", e);
    return [];
  }
}

/* ---------------------------------------------------
   Dashboard
--------------------------------------------------- */
async function refreshDashboard() {
  const now = Date.now();
  const since = now - 30 * 24 * 60 * 60 * 1000;

  const entries30 = entriesCache.filter(e => safeNum(e.dateTS) >= since).length;
  const assigns30 = assignmentsCache.filter(a => safeNum(a.dateTS) >= since).length;
  const scrap30 = scrapCache.filter(s => safeNum(s.dateTS) >= since).length;
  const pending = requestsCache.filter(r => (r.status || "Pendiente") === "Pendiente").length;

  if ($("kpiEntries")) $("kpiEntries").textContent = String(entries30);
  if ($("kpiAssignments")) $("kpiAssignments").textContent = String(assigns30);
  if ($("kpiScrap")) $("kpiScrap").textContent = String(scrap30);
  if ($("kpiPending")) $("kpiPending").textContent = String(pending);

  renderLastEntries(entriesCache.slice(0, 6));
  renderLastAssignments(assignmentsCache.slice(0, 6));
}

function renderLastEntries(rows) {
  const tbody = $("tblLastEntries")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Sin datos</td></tr>`;
    return;
  }
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO || "")}</td>
      <td>${escapeHtml(r.type || "")}</td>
      <td>${escapeHtml(r.desc || "")}</td>
      <td class="right">${escapeHtml(String(r.qty ?? ""))}</td>
      <td class="right">${escapeHtml(String(r.available ?? ""))}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderLastAssignments(rows) {
  const tbody = $("tblLastAssignments")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;
    return;
  }
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO || "")}</td>
      <td>${escapeHtml(r.worker || "")}</td>
      <td>${escapeHtml(r.entryLabel || r.entryDesc || "")}</td>
      <td class="right">${escapeHtml(String(r.qty ?? ""))}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------
   ENTRADAS
--------------------------------------------------- */
on("formEntry", "submit", async (e) => {
  e.preventDefault();
  const msg = $("entryMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar entradas.", "bad");
    return;
  }

  const dateISO = $("entryDate")?.value;
  const type = $("entryType")?.value;
  const qty = safeNum($("entryQty")?.value, 0);
  const desc = ($("entryDesc")?.value || "").trim();
  const ref = ($("entryRef")?.value || "").trim();

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
    e.target.reset();
    if ($("entryDate")) $("entryDate").value = todayISO();

    entriesCache = await fetchEntries(500);
    await refreshEntries();
    await refreshEntryDropdowns();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    setMsg(msg, "❌ No se pudo guardar la entrada. Revisa permisos/reglas.", "bad");
  }
});

on("btnReloadEntries", "click", async () => {
  entriesCache = await fetchEntries(500);
  await refreshEntries();
  await refreshEntryDropdowns();
  await refreshDashboard();
});

async function refreshEntries() {
  const tbody = $("tblEntries")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const typeFilter = $("filterEntryType")?.value || "";
  const textFilter = ($("filterEntryText")?.value || "").trim().toLowerCase();

  const rows = entriesCache.filter(r => {
    if (typeFilter && r.type !== typeFilter) return false;
    const hay = `${r.desc ?? ""} ${r.ref ?? ""}`.toLowerCase();
    if (textFilter && !hay.includes(textFilter)) return false;
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin resultados</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO || "")}</td>
      <td>${escapeHtml(r.type || "")}</td>
      <td>${escapeHtml(r.desc || "")}</td>
      <td>${escapeHtml(r.ref || "")}</td>
      <td class="right">${escapeHtml(String(r.qty ?? ""))}</td>
      <td class="right">${escapeHtml(String(r.available ?? ""))}</td>
      <td>${escapeHtml(r.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function refreshEntryDropdowns() {
  const list = entriesCache.slice().sort((a, b) => safeNum(b.dateTS) - safeNum(a.dateTS));
  const assignsSel = $("assignEntryId");
  const scrapSel = $("scrapEntryId");

  const optHtml = (e) => {
    const label = `${e.type || ""} · ${e.desc || ""} (Disp: ${e.available ?? 0})`;
    return `<option value="${escapeHtml(e.id)}">${escapeHtml(label)}</option>`;
  };

  if (assignsSel) {
    assignsSel.innerHTML = `<option value="">Seleccionar…</option>` +
      list.filter(e => safeNum(e.available) > 0).map(optHtml).join("");
  }
  if (scrapSel) {
    scrapSel.innerHTML = `<option value="">Seleccionar…</option>` +
      list.filter(e => safeNum(e.available) > 0).map(optHtml).join("");
  }
}

/* ---------------------------------------------------
   ASIGNACIONES
--------------------------------------------------- */
on("formAssign", "submit", async (e) => {
  e.preventDefault();
  const msg = $("assignMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar asignaciones.", "bad");
    return;
  }

  const dateISO = $("assignDate")?.value;
  const entryId = $("assignEntryId")?.value;
  const qty = safeNum($("assignQty")?.value, 0);
  const reason = ($("assignReason")?.value || "").trim();

  const workerSelect = ($("assignWorkerSelect")?.value || "").trim();
  const workerInput = ($("assignWorker")?.value || "").trim();
  const worker = workerSelect || workerInput;

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

      const label = `${entry.type || ""} · ${entry.desc || ""}`;
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
    e.target.reset();
    if ($("assignDate")) $("assignDate").value = todayISO();

    entriesCache = await fetchEntries(500);
    assignmentsCache = await fetchAssignments(500);

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
  assignmentsCache = await fetchAssignments(500);
  await refreshAssignments();
  await refreshDashboard();
});

async function refreshAssignments() {
  const tbody = $("tblAssignments")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const workerFilter = ($("filterAssignWorker")?.value || "").trim().toLowerCase();
  const fromISO = $("filterAssignFrom")?.value || "";
  const toISO = $("filterAssignTo")?.value || "";

  const rows = assignmentsCache.filter(a => {
    const hay = (a.worker || "").toLowerCase();
    if (workerFilter && !hay.includes(workerFilter)) return false;
    if (!withinRange(safeNum(a.dateTS), fromISO, toISO)) return false;
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin resultados</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO || "")}</td>
      <td>${escapeHtml(r.worker || "")}</td>
      <td>${escapeHtml(r.entryId || "")}</td>
      <td>${escapeHtml(r.entryType || "")}</td>
      <td>${escapeHtml(r.entryDesc || "")}</td>
      <td class="right">${escapeHtml(String(r.qty ?? ""))}</td>
      <td>${escapeHtml(r.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------
   MERMA
--------------------------------------------------- */
on("formScrap", "submit", async (e) => {
  e.preventDefault();
  const msg = $("scrapMsg");
  setMsg(msg, "");

  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para registrar merma.", "bad");
    return;
  }

  const dateISO = $("scrapDate")?.value;
  const entryId = $("scrapEntryId")?.value;
  const qty = safeNum($("scrapQty")?.value, 0);
  const reason = $("scrapReason")?.value || "";
  const detail = ($("scrapDetail")?.value || "").trim();

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

      const label = `${entry.type || ""} · ${entry.desc || ""}`;
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
    e.target.reset();
    if ($("scrapDate")) $("scrapDate").value = todayISO();

    entriesCache = await fetchEntries(500);
    scrapCache = await fetchScrap(500);

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
  const tbody = $("tblScrap")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!scrapCache.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin datos</td></tr>`;
    return;
  }

  for (const r of scrapCache) {
    const motivo = r.reason === "Otro" ? `${r.reason}: ${r.detail || ""}` : (r.reason || "");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.dateISO || "")}</td>
      <td>${escapeHtml(r.entryId || "")}</td>
      <td>${escapeHtml(r.entryType || "")}</td>
      <td>${escapeHtml(r.entryDesc || "")}</td>
      <td class="right">${escapeHtml(String(r.qty ?? ""))}</td>
      <td>${escapeHtml(motivo)}</td>
      <td>${escapeHtml(r.createdByName || "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------
   SOLICITUDES
--------------------------------------------------- */
on("formRequest", "submit", async (e) => {
  e.preventDefault();
  const msg = $("reqMsg");
  setMsg(msg, "");

  const type = $("reqType")?.value || "";
  const text = ($("reqText")?.value || "").trim();
  const priority = $("reqPriority")?.value || "Normal";

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
      createdAt: serverTimestamp()
    });

    setMsg(msg, "✅ Solicitud creada.", "ok");
    e.target.reset();

    requestsCache = await fetchRequests(500);
    await refreshRequests();
    await refreshDashboard();
  } catch (err) {
    console.error(err);
    setMsg(msg, "❌ No se pudo crear. Revisa permisos/reglas.", "bad");
  }
});

on("btnReloadRequests", "click", async () => {
  requestsCache = await fetchRequests(500);
  await refreshRequests();
  await refreshDashboard();
});

async function refreshRequests() {
  const tbody = $("tblRequests")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const statusFilter = $("filterReqStatus")?.value || "";
  const textFilter = ($("filterReqText")?.value || "").trim().toLowerCase();

  const rows = requestsCache.filter(r => {
    const status = r.status || "Pendiente";
    if (statusFilter && status !== statusFilter) return false;

    const hay = `${r.type || ""} ${r.text || ""}`.toLowerCase();
    if (textFilter && !hay.includes(textFilter)) return false;

    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin resultados</td></tr>`;
    return;
  }

  for (const r of rows) {
    const isPending = (r.status || "Pendiente") === "Pendiente";
    const canAnswer = canWrite() && isPending;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatTimestamp(r.createdAt) || "")}</td>
      <td>${escapeHtml(r.type || "")}</td>
      <td>${escapeHtml(r.text || "")}</td>
      <td>${escapeHtml(r.priority || "")}</td>
      <td>${escapeHtml(r.status || "")}</td>
      <td>${escapeHtml(r.response || "")}</td>
      <td>
        ${canAnswer ? `<button class="btn btn--ghost" data-action="answer" data-id="${escapeHtml(r.id)}">Responder</button>` : `<span class="muted small">—</span>`}
      </td>
    `;
    tbody.appendChild(tr);
  }

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
    const ref = doc(db, "requests", requestId);
    await updateDoc(ref, {
      status: "Respondida",
      response: txt,
      respondedBy: currentUser.uid,
      respondedByName: currentUserProfile.name || currentUser.email || "Usuario",
      respondedAt: serverTimestamp()
    });

    requestsCache = await fetchRequests(500);
    await refreshRequests();
    await refreshDashboard();
  } catch (e) {
    console.error(e);
    alert("No se pudo responder (¿permisos?).");
  }
}

/* ---------------------------------------------------
   INFORMES
--------------------------------------------------- */
on("btnRunReport", "click", async () => {
  await runReport();
});

on("btnExportCSV", "click", () => {
  if (!reportRows?.length) return;
  const headers = ["Fecha", "TipoMov", "TipoEntrada", "Trabajador", "Entrada", "Descripcion", "Cantidad", "Motivo"];
  const csv = toCSV(reportRows, headers);
  downloadText("reporte_apa.csv", csv, "text/csv");
});

async function runReport() {
  const msg = $("reportMsg");
  setMsg(msg, "Generando informe...", "info");

  entriesCache = await fetchEntries(1000);
  assignmentsCache = await fetchAssignments(1000);
  scrapCache = await fetchScrap(1000);

  const mode = $("reportMode")?.value || "worker";

  const workerSelect = ($("reportWorkerSelect")?.value || "").trim();
  const filterText = ($("reportFilter")?.value || "").trim();
  const effectiveFilter = workerSelect || filterText;

  const fromISO = $("reportFrom")?.value || "";
  const toISO = $("reportTo")?.value || "";

  const rows = [];

  for (const a of assignmentsCache) {
    const ts = safeNum(a.dateTS);
    if (!withinRange(ts, fromISO, toISO)) continue;

    if (mode === "worker") {
      if (effectiveFilter) {
        const hay = (a.worker || "").toLowerCase();
        if (!hay.includes(effectiveFilter.toLowerCase())) continue;
      }
    } else {
      if (effectiveFilter) {
        const hay = (a.entryType || "").toLowerCase();
        if (!hay.includes(effectiveFilter.toLowerCase())) continue;
      }
    }

    rows.push({
      "Fecha": a.dateISO || "",
      "TipoMov": "Asignación",
      "TipoEntrada": a.entryType || "",
      "Trabajador": a.worker || "",
      "Entrada": a.entryId || "",
      "Descripcion": a.entryDesc || "",
      "Cantidad": safeNum(a.qty),
      "Motivo": a.reason || ""
    });
  }

  for (const s of scrapCache) {
    const ts = safeNum(s.dateTS);
    if (!withinRange(ts, fromISO, toISO)) continue;

    if (mode === "worker") {
      if (effectiveFilter) continue;
    } else {
      if (effectiveFilter) {
        const hay = (s.entryType || "").toLowerCase();
        if (!hay.includes(effectiveFilter.toLowerCase())) continue;
      }
    }

    const motivo = s.reason === "Otro" ? `${s.reason}: ${s.detail || ""}` : (s.reason || "");
    rows.push({
      "Fecha": s.dateISO || "",
      "TipoMov": "Merma",
      "TipoEntrada": s.entryType || "",
      "Trabajador": "",
      "Entrada": s.entryId || "",
      "Descripcion": s.entryDesc || "",
      "Cantidad": safeNum(s.qty),
      "Motivo": motivo
    });
  }

  rows.sort((a, b) => (parseDateToTs(b.Fecha) || 0) - (parseDateToTs(a.Fecha) || 0));

  reportRows = rows;
  renderReportTable(rows);

  const totalCount = rows.length;
  const totalQty = rows.reduce((acc, r) => acc + safeNum(r.Cantidad), 0);

  const totalScrap = rows.filter(r => r.TipoMov === "Merma").reduce((acc, r) => acc + safeNum(r.Cantidad), 0);
  const totalRemaining = entriesCache.reduce((acc, e) => acc + safeNum(e.available), 0);

  if ($("reportCount")) $("reportCount").textContent = String(totalCount);
  if ($("reportQty")) $("reportQty").textContent = String(totalQty);
  if ($("reportScrapTotal")) $("reportScrapTotal").textContent = String(totalScrap);
  if ($("reportRemainingTotal")) $("reportRemainingTotal").textContent = String(totalRemaining);

  const btnCSV = $("btnExportCSV");
  if (btnCSV) btnCSV.disabled = rows.length === 0;

  setMsg(msg, `✅ Informe listo (${totalCount} registros).`, "ok");
}

function renderReportTable(rows) {
  const tbody = $("tblReport")?.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin resultados</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.Fecha)}</td>
      <td>${escapeHtml(r.TipoEntrada)}</td>
      <td>${escapeHtml(r.Trabajador || "")}</td>
      <td>${escapeHtml(r.Entrada)}</td>
      <td>${escapeHtml(r.Descripcion)}</td>
      <td class="right">${escapeHtml(String(r.Cantidad))}</td>
      <td>${escapeHtml(r.Motivo || r.TipoMov)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------
   EMPLEADOS (ADMIN)
--------------------------------------------------- */
on("btnCreateEmployee", "click", async () => {
  const msg = $("empMsg");
  setMsg(msg, "");

  if (!isAdmin()) {
    setMsg(msg, "❌ Solo admin puede crear empleados.", "bad");
    return;
  }

  const first = ($("empFirst")?.value || "").trim();
  const last = ($("empLast")?.value || "").trim();
  const email = ($("empEmail")?.value || "").trim().toLowerCase();
  const pass = $("empPass")?.value || "";
  const r = $("empRole")?.value || "consulta";
  const active = ($("empActive")?.value || "true") === "true";

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
      first,
      last,
      name: fullName,
      email,
      role: r,
      active
    });

    $("empFirst").value = "";
    $("empLast").value = "";
    $("empEmail").value = "";
    $("empPass").value = "";
    $("empRole").value = "consulta";
    $("empActive").value = "true";

    setMsg(msg, "✅ Empleado creado. Ya puede iniciar sesión.", "ok");

    await refreshEmployees();
    fillWorkersUIFromEmployees();
  } catch (err) {
    console.error(err);
    const code = err?.code || "";
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
  employeesCache = await fetchEmployees(1000);
  renderEmployeesTable();
  fillWorkersUIFromEmployees();
}

function renderEmployeesTable() {
  const tbody = $("tblEmployees")?.querySelector("tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!employeesCache.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;
    return;
  }

  for (const e of employeesCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(e.name || `${e.first || ""} ${e.last || ""}`)}</td>
      <td>${escapeHtml(e.email || "")}</td>
      <td>${escapeHtml(e.role || "")}</td>
      <td>${e.active === false ? "No" : "Sí"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function fillWorkersUIFromEmployees() {
  const active = (employeesCache || []).filter(e => e.active !== false);

  const selAssign = $("assignWorkerSelect");
  if (selAssign) {
    selAssign.innerHTML =
      `<option value="">(Seleccionar trabajador)</option>` +
      active.map(e => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
  }

  const selReport = $("reportWorkerSelect");
  if (selReport) {
    selReport.innerHTML =
      `<option value="">(Todos / sin filtro)</option>` +
      active.map(e => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
  }
}

/* ---------------------------------------------------
   Utils
--------------------------------------------------- */
function withinRange(ts, fromISO, toISO) {
  const from = parseDateToTs(fromISO);
  const to = parseDateToTs(toISO);
  if (from && ts < from) return false;
  if (to && ts > (to + 24 * 60 * 60 * 1000 - 1)) return false;
  return true;
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

/* ---------------------------------------------------
   BOOT
--------------------------------------------------- */
(function boot() {
  console.log("[APA] app.js cargado OK");
  setupPasswordToggles();
  showLoginOnly();
  setMsg($("loginMsg"), "Ingresa tus credenciales para continuar.", "info");
})();

