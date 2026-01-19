import { auth, db } from "./firebase.js";
import { $, setMsg, todayISO, safeNum, escapeHtml, downloadCSV } from "./utils.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  updateDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* -------------------------
  Estado global
------------------------- */
let currentUser = null;
let currentProfile = null; // {name, role}
let lastReportRows = null; // para export CSV
let entryCache = new Map(); // id -> entry doc data

/* -------------------------
  Helpers de rol
------------------------- */
function role() {
  return currentProfile?.role || "consulta";
}
function canWrite() {
  return role() === "admin" || role() === "operator";
}
function isAdmin() {
  return role() === "admin";
}

/* -------------------------
  UI: Tabs
------------------------- */
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("is-active"));
      btn.classList.add("is-active");

      const target = btn.dataset.tab;
      document.querySelectorAll(".tabpage").forEach(p => p.hidden = true);
      $(target).hidden = false;

      // refrescos según tab
      if (target === "tabEntries") loadEntries(true);
      if (target === "tabAssignments") { fillEntryDropdowns(); loadAssignments(true); }
      if (target === "tabScrap") { fillEntryDropdowns(); loadScrap(true); }
      if (target === "tabRequests") loadRequests(true);
      if (target === "tabDashboard") loadDashboard();
    });
  });
}

/* -------------------------
  UI: Toggle password
------------------------- */
function setupTogglePassword() {
  const btn = $("btnTogglePassword");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const input = $("loginPassword");
    if (!input) return;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    btn.textContent = isPassword ? "🙈" : "👁️";
  });
}

/* -------------------------
  Login / Logout
------------------------- */
function setupAuthButtons() {
  $("btnLogin").addEventListener("click", async () => {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const msg = $("loginMsg");
    const btn = $("btnLogin");

    setMsg(msg, "");
    if (!email || !password) {
      setMsg(msg, "Debes ingresar correo y contraseña.", "warn");
      return;
    }

    btn.disabled = true;
    setMsg(msg, "Verificando credenciales...", "info");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      setMsg(msg, "✅ Ingreso exitoso. Cargando sistema...", "ok");
    } catch (err) {
      const code = err?.code || "";
      if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password")) {
        setMsg(msg, "❌ Correo o contraseña incorrectos.", "bad");
      } else if (code.includes("auth/user-not-found")) {
        setMsg(msg, "❌ No existe un usuario con ese correo en Firebase Auth.", "bad");
      } else if (code.includes("auth/too-many-requests")) {
        setMsg(msg, "⚠️ Demasiados intentos. Espera un momento y prueba de nuevo.", "warn");
      } else if (code.includes("auth/unauthorized-domain")) {
        setMsg(msg, "❌ Dominio no autorizado en Firebase Auth (Authorized domains).", "bad");
      } else {
        setMsg(msg, `❌ Error de autenticación (${code || "desconocido"}).`, "bad");
      }
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  $("btnLogout").addEventListener("click", async () => {
    await signOut(auth);
  });
}

/* -------------------------
  Carga de perfil desde Firestore
------------------------- */
async function loadProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

/* -------------------------
  Arranque y AuthState
------------------------- */
function showLogin() {
  $("loginCard").hidden = false;
  $("appShell").hidden = true;
  $("userBox").hidden = true;
}
function showApp() {
  $("loginCard").hidden = true;
  $("appShell").hidden = false;
  $("userBox").hidden = false;
}

async function onUserReady(user) {
  currentUser = user;
  currentProfile = await loadProfile(user.uid);

  if (!currentProfile?.role) {
    // Si no hay doc users/{uid}, no puede operar
    showLogin();
    setMsg($("loginMsg"),
      "⚠️ Tu usuario existe, pero falta tu perfil en Firestore: users/{uid} con role (admin/operator/consulta).",
      "warn"
    );
    return;
  }

  $("userName").textContent = currentProfile.name || user.email || "Usuario";
  $("userRole").textContent = `Rol: ${currentProfile.role}`;

  // restricciones UI según rol
  applyRoleUI();

  showApp();
  setupTabs();
  loadDashboard();
  loadEntries(true); // para caché y dropdown
}

function applyRoleUI() {
  // Si no puede escribir, deshabilita botones de guardado
  const writeButtons = ["btnSaveEntry", "btnSaveAssign", "btnSaveScrap"];
  writeButtons.forEach(id => {
    const b = $(id);
    if (!b) return;
    b.disabled = !canWrite();
    b.title = canWrite() ? "" : "No tienes permisos para registrar (solo admin/operator).";
  });
}

/* -------------------------
  Entradas
------------------------- */
function setupEntries() {
  $("entDate").value = todayISO();

  $("btnSaveEntry").addEventListener("click", async () => {
    const msg = $("entMsg");
    setMsg(msg, "");

    if (!canWrite()) {
      setMsg(msg, "No tienes permisos para registrar entradas.", "bad");
      return;
    }

    const date = $("entDate").value || todayISO();
    const type = $("entType").value;
    const desc = $("entDesc").value.trim();
    const unit = $("entUnit").value.trim();
    const qty = safeNum($("entQty").value);
    const docRef = $("entDoc").value.trim();

    if (!desc || qty <= 0) {
      setMsg(msg, "Completa descripción y cantidad válida.", "warn");
      return;
    }

    try {
      setMsg(msg, "Guardando entrada...", "info");

      await addDoc(collection(db, "entries"), {
        date,
        type,
        desc,
        unit,
        qty,
        available: qty,
        docRef,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp()
      });

      setMsg(msg, "✅ Entrada registrada correctamente.", "ok");
      $("entDesc").value = "";
      $("entUnit").value = "";
      $("entQty").value = "";
      $("entDoc").value = "";

      await loadEntries(true);
      fillEntryDropdowns();
      loadDashboard();
    } catch (e) {
      console.error(e);
      setMsg(msg, "❌ Error al guardar entrada (revisa reglas/rol).", "bad");
    }
  });

  $("btnReloadEntries").addEventListener("click", () => loadEntries(true));
  $("entSearch").addEventListener("input", () => renderEntriesTable());
  $("entFilterType").addEventListener("change", () => renderEntriesTable());
}

async function loadEntries(showMsg) {
  const msg = $("entListMsg");
  if (showMsg) setMsg(msg, "Cargando entradas...", "info");

  entryCache.clear();

  try {
    const q = query(collection(db, "entries"), orderBy("date", "desc"), limit(200));
    const snap = await getDocs(q);
    snap.forEach(d => entryCache.set(d.id, { id: d.id, ...d.data() }));

    renderEntriesTable();
    fillEntryDropdowns();

    if (showMsg) setMsg(msg, `✅ Entradas cargadas: ${entryCache.size}`, "ok");
  } catch (e) {
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar entradas (¿login/permiso?).", "bad");
  }
}

function renderEntriesTable() {
  const tbody = $("tblEntries").querySelector("tbody");
  const search = ($("entSearch").value || "").toLowerCase();
  const fType = $("entFilterType").value;

  const rows = Array.from(entryCache.values())
    .filter(r => !fType || r.type === fType)
    .filter(r => {
      const txt = `${r.type} ${r.desc} ${r.unit} ${r.docRef}`.toLowerCase();
      return !search || txt.includes(search);
    });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.date || "")}</td>
      <td>${escapeHtml(r.type || "")}</td>
      <td>${escapeHtml(r.desc || "")}</td>
      <td>${escapeHtml(r.unit || "")}</td>
      <td class="right">${safeNum(r.qty)}</td>
      <td class="right">${safeNum(r.available)}</td>
      <td>${escapeHtml(r.docRef || "")}</td>
    </tr>
  `).join("") || `<tr><td colspan="7" class="muted">Sin datos</td></tr>`;
}

function fillEntryDropdowns() {
  const opts = Array.from(entryCache.values())
    .sort((a,b) => (b.date || "").localeCompare(a.date || ""))
    .map(r => {
      const label = `${r.date || ""} • ${r.type} • ${r.desc} (Disp: ${safeNum(r.available)})`;
      return `<option value="${r.id}">${escapeHtml(label)}</option>`;
    }).join("");

  const selA = $("asEntry");
  const selS = $("scEntry");
  if (selA) selA.innerHTML = opts || `<option value="">(Sin entradas)</option>`;
  if (selS) selS.innerHTML = opts || `<option value="">(Sin entradas)</option>`;
}

/* -------------------------
  Asignaciones
------------------------- */
function setupAssignments() {
  $("asDate").value = todayISO();

  $("btnSaveAssign").addEventListener("click", async () => {
    const msg = $("asMsg");
    setMsg(msg, "");

    if (!canWrite()) {
      setMsg(msg, "No tienes permisos para registrar asignaciones.", "bad");
      return;
    }

    const entryId = $("asEntry").value;
    const date = $("asDate").value || todayISO();
    const worker = $("asWorker").value.trim();
    const qty = safeNum($("asQty").value);
    const reason = $("asReason").value.trim();

    if (!entryId || !worker || qty <= 0) {
      setMsg(msg, "Completa entrada, trabajador y cantidad válida.", "warn");
      return;
    }

    try {
      setMsg(msg, "Guardando asignación...", "info");

      await runTransaction(db, async (tx) => {
        const eRef = doc(db, "entries", entryId);
        const eSnap = await tx.get(eRef);
        if (!eSnap.exists()) throw new Error("Entrada no existe");
        const e = eSnap.data();
        const available = safeNum(e.available);

        if (qty > available) throw new Error("Cantidad excede disponible");

        // crear asignación
        const aRef = doc(collection(db, "assignments"));
        tx.set(aRef, {
          entryId,
          entryDesc: e.desc || "",
          entryType: e.type || "",
          worker,
          qty,
          reason,
          date,
          createdBy: currentUser.uid,
          createdAt: serverTimestamp()
        });

        // actualizar disponible
        tx.update(eRef, { available: available - qty });
      });

      setMsg(msg, "✅ Asignación registrada y stock actualizado.", "ok");
      $("asWorker").value = "";
      $("asQty").value = "";
      $("asReason").value = "";

      await loadEntries(false);
      await loadAssignments(true);
      fillEntryDropdowns();
      loadDashboard();
    } catch (e) {
      console.error(e);
      if (String(e.message).includes("excede")) {
        setMsg(msg, "❌ La cantidad asignada supera el stock disponible.", "bad");
      } else {
        setMsg(msg, "❌ Error al guardar asignación (reglas/rol/entrada).", "bad");
      }
    }
  });

  $("btnReloadAssignments").addEventListener("click", () => loadAssignments(true));
  $("asSearch").addEventListener("input", () => renderAssignmentsTable());
}

let assignmentsCache = [];
async function loadAssignments(showMsg) {
  const msg = $("asListMsg");
  if (showMsg) setMsg(msg, "Cargando asignaciones...", "info");

  assignmentsCache = [];
  try {
    const q = query(collection(db, "assignments"), orderBy("date", "desc"), limit(200));
    const snap = await getDocs(q);
    snap.forEach(d => assignmentsCache.push({ id: d.id, ...d.data() }));

    renderAssignmentsTable();
    if (showMsg) setMsg(msg, `✅ Asignaciones cargadas: ${assignmentsCache.length}`, "ok");
  } catch (e) {
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar asignaciones.", "bad");
  }
}

function renderAssignmentsTable() {
  const tbody = $("tblAssignments").querySelector("tbody");
  const s = ($("asSearch").value || "").toLowerCase();

  const rows = assignmentsCache.filter(r => {
    const txt = `${r.worker} ${r.entryDesc} ${r.entryType} ${r.reason}`.toLowerCase();
    return !s || txt.includes(s);
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.date || "")}</td>
      <td>${escapeHtml(r.worker || "")}</td>
      <td>${escapeHtml(`${r.entryType || ""} • ${r.entryDesc || ""}`)}</td>
      <td class="right">${safeNum(r.qty)}</td>
      <td>${escapeHtml(r.reason || "")}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">Sin datos</td></tr>`;
}

/* -------------------------
  Merma
------------------------- */
function setupScrap() {
  $("scDate").value = todayISO();

  $("btnSaveScrap").addEventListener("click", async () => {
    const msg = $("scMsg");
    setMsg(msg, "");

    if (!canWrite()) {
      setMsg(msg, "No tienes permisos para registrar merma.", "bad");
      return;
    }

    const entryId = $("scEntry").value;
    const date = $("scDate").value || todayISO();
    const qty = safeNum($("scQty").value);
    const reason = $("scReason").value;
    const detail = $("scDetail").value.trim();

    if (!entryId || qty <= 0) {
      setMsg(msg, "Completa entrada y cantidad válida.", "warn");
      return;
    }
    if (reason === "Otro" && !detail) {
      setMsg(msg, "Si motivo es 'Otro', el detalle es obligatorio.", "warn");
      return;
    }

    try {
      setMsg(msg, "Guardando merma...", "info");

      await runTransaction(db, async (tx) => {
        const eRef = doc(db, "entries", entryId);
        const eSnap = await tx.get(eRef);
        if (!eSnap.exists()) throw new Error("Entrada no existe");
        const e = eSnap.data();
        const available = safeNum(e.available);

        if (qty > available) throw new Error("Cantidad excede disponible");

        const sRef = doc(collection(db, "scrap"));
        tx.set(sRef, {
          entryId,
          entryDesc: e.desc || "",
          entryType: e.type || "",
          qty,
          reason,
          detail: reason === "Otro" ? detail : "",
          date,
          createdBy: currentUser.uid,
          createdAt: serverTimestamp()
        });

        tx.update(eRef, { available: available - qty });
      });

      setMsg(msg, "✅ Merma registrada y stock actualizado.", "ok");
      $("scQty").value = "";
      $("scDetail").value = "";

      await loadEntries(false);
      await loadScrap(true);
      fillEntryDropdowns();
      loadDashboard();
    } catch (e) {
      console.error(e);
      if (String(e.message).includes("excede")) {
        setMsg(msg, "❌ La cantidad de merma supera el stock disponible.", "bad");
      } else {
        setMsg(msg, "❌ Error al guardar merma (reglas/rol/entrada).", "bad");
      }
    }
  });

  $("btnReloadScrap").addEventListener("click", () => loadScrap(true));
  $("scSearch").addEventListener("input", () => renderScrapTable());
}

let scrapCache = [];
async function loadScrap(showMsg) {
  const msg = $("scListMsg");
  if (showMsg) setMsg(msg, "Cargando mermas...", "info");

  scrapCache = [];
  try {
    const q = query(collection(db, "scrap"), orderBy("date", "desc"), limit(200));
    const snap = await getDocs(q);
    snap.forEach(d => scrapCache.push({ id: d.id, ...d.data() }));

    renderScrapTable();
    if (showMsg) setMsg(msg, `✅ Mermas cargadas: ${scrapCache.length}`, "ok");
  } catch (e) {
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar mermas.", "bad");
  }
}

function renderScrapTable() {
  const tbody = $("tblScrap").querySelector("tbody");
  const s = ($("scSearch").value || "").toLowerCase();

  const rows = scrapCache.filter(r => {
    const txt = `${r.entryDesc} ${r.entryType} ${r.reason} ${r.detail}`.toLowerCase();
    return !s || txt.includes(s);
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.date || "")}</td>
      <td>${escapeHtml(`${r.entryType || ""} • ${r.entryDesc || ""}`)}</td>
      <td class="right">${safeNum(r.qty)}</td>
      <td>${escapeHtml(r.reason || "")}</td>
      <td>${escapeHtml(r.detail || "")}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">Sin datos</td></tr>`;
}

/* -------------------------
  Solicitudes
------------------------- */
function setupRequests() {
  $("btnSaveRequest").addEventListener("click", async () => {
    const msg = $("rqMsg");
    setMsg(msg, "");

    const type = $("rqType").value;
    const priority = $("rqPriority").value;
    const detail = $("rqDetail").value.trim();

    if (!detail) {
      setMsg(msg, "El detalle es obligatorio.", "warn");
      return;
    }

    try {
      setMsg(msg, "Enviando solicitud...", "info");

      await addDoc(collection(db, "requests"), {
        type,
        priority,
        detail,
        status: "Pendiente",
        response: "",
        createdBy: currentUser.uid,
        createdAt: serverTimestamp(),
        date: todayISO()
      });

      $("rqDetail").value = "";
      setMsg(msg, "✅ Solicitud enviada.", "ok");
      await loadRequests(true);
      loadDashboard();
    } catch (e) {
      console.error(e);
      setMsg(msg, "❌ Error al enviar solicitud.", "bad");
    }
  });

  $("btnReloadRequests").addEventListener("click", () => loadRequests(true));
  $("rqFilterStatus").addEventListener("change", () => renderRequestsTable());
}

let requestsCache = [];
async function loadRequests(showMsg) {
  const msg = $("rqListMsg");
  if (showMsg) setMsg(msg, "Cargando solicitudes...", "info");

  requestsCache = [];
  try {
    const q = query(collection(db, "requests"), orderBy("createdAt", "desc"), limit(200));
    const snap = await getDocs(q);
    snap.forEach(d => requestsCache.push({ id: d.id, ...d.data() }));

    renderRequestsTable();
    if (showMsg) setMsg(msg, `✅ Solicitudes cargadas: ${requestsCache.length}`, "ok");
  } catch (e) {
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar solicitudes.", "bad");
  }
}

function renderRequestsTable() {
  const tbody = $("tblRequests").querySelector("tbody");
  const f = $("rqFilterStatus").value;

  const rows = requestsCache.filter(r => !f || r.status === f);

  tbody.innerHTML = rows.map(r => {
    const canRespond = canWrite();
    const actionHtml = canRespond
      ? `<button class="btn btn--primary btnSmall" data-act="respond" data-id="${r.id}">Responder</button>`
      : `<span class="muted small">—</span>`;

    return `
      <tr>
        <td>${escapeHtml(r.date || "")}</td>
        <td>${escapeHtml(r.type || "")}</td>
        <td>${escapeHtml(r.priority || "")}</td>
        <td>${escapeHtml(r.detail || "")}</td>
        <td>${escapeHtml(r.status || "")}</td>
        <td>${escapeHtml(r.response || "")}</td>
        <td class="right">${actionHtml}</td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="7" class="muted">Sin datos</td></tr>`;

  // bind acciones
  tbody.querySelectorAll("button[data-act='respond']").forEach(b => {
    b.addEventListener("click", () => openRespondPrompt(b.dataset.id));
  });
}

async function openRespondPrompt(requestId) {
  const msg = $("rqListMsg");
  if (!canWrite()) {
    setMsg(msg, "No tienes permisos para responder.", "bad");
    return;
  }

  const text = prompt("Escribe la respuesta para cerrar la solicitud:");
  if (text === null) return;

  const response = text.trim();
  if (!response) {
    setMsg(msg, "La respuesta no puede estar vacía.", "warn");
    return;
  }

  try {
    setMsg(msg, "Guardando respuesta...", "info");
    await updateDoc(doc(db, "requests", requestId), {
      status: "Respondida",
      response
    });
    setMsg(msg, "✅ Solicitud respondida.", "ok");
    await loadRequests(false);
    loadDashboard();
  } catch (e) {
    console.error(e);
    setMsg(msg, "❌ Error al responder solicitud.", "bad");
  }
}

/* -------------------------
  Informes
------------------------- */
function setupReports() {
  $("btnRunReport").addEventListener("click", async () => {
    const msg = $("rpMsg");
    setMsg(msg, "Generando informe...", "info");
    $("btnExportCSV").disabled = true;
    lastReportRows = null;

    try {
      const mode = $("rpMode").value;
      const worker = $("rpWorker").value.trim();
      const from = $("rpFrom").value;
      const to = $("rpTo").value;

      // cargamos datasets base
      // (consulta simple: no usamos queries complejas para no pelear con índices en TAP)
      const [asSnap, enSnap] = await Promise.all([
        getDocs(query(collection(db, "assignments"), orderBy("date", "desc"), limit(500))),
        getDocs(query(collection(db, "entries"), orderBy("date", "desc"), limit(500)))
      ]);

      const assignments = [];
      asSnap.forEach(d => assignments.push({ id: d.id, ...d.data() }));

      const entries = [];
      enSnap.forEach(d => entries.push({ id: d.id, ...d.data() }));

      // filtros por fecha (ISO string)
      const inRange = (d) => {
        if (!d) return true;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      };

      const agg = new Map(); // key -> sum qty

      if (mode === "worker") {
        const filtered = assignments
          .filter(a => inRange(a.date))
          .filter(a => !worker || (a.worker || "").toLowerCase().includes(worker.toLowerCase()));

        filtered.forEach(a => {
          const key = a.worker || "(Sin nombre)";
          agg.set(key, (agg.get(key) || 0) + safeNum(a.qty));
        });

      } else {
        // mode === type
        // sumamos entradas y asignaciones por tipo (para mostrar trazabilidad por tipo)
        entries.filter(e => inRange(e.date)).forEach(e => {
          const key = `Entradas • ${e.type || "Otro"}`;
          agg.set(key, (agg.get(key) || 0) + safeNum(e.qty));
        });
        assignments.filter(a => inRange(a.date)).forEach(a => {
          const key = `Asignaciones • ${a.entryType || "Otro"}`;
          agg.set(key, (agg.get(key) || 0) + safeNum(a.qty));
        });
      }

      const rows = Array.from(agg.entries())
        .sort((a,b) => b[1] - a[1])
        .map(([key, qty]) => ({ key, qty }));

      renderReport(rows);
      lastReportRows = rows;
      $("btnExportCSV").disabled = rows.length === 0;

      setMsg(msg, `✅ Informe generado (${rows.length} filas).`, "ok");
    } catch (e) {
      console.error(e);
      setMsg(msg, "❌ Error al generar informe (revisa permisos/reglas).", "bad");
    }
  });

  $("btnExportCSV").addEventListener("click", () => {
    if (!lastReportRows) return;
    const rows = [
      ["Clave", "Cantidad"],
      ...lastReportRows.map(r => [r.key, r.qty])
    ];
    downloadCSV("informe_apa.csv", rows);
  });
}

function renderReport(rows) {
  const tbody = $("tblReport").querySelector("tbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.key)}</td>
      <td class="right">${safeNum(r.qty)}</td>
    </tr>
  `).join("") || `<tr><td colspan="2" class="muted">Sin resultados</td></tr>`;
}

/* -------------------------
  Dashboard
------------------------- */
async function loadDashboard() {
  const msg = $("dashMsg");
  setMsg(msg, "Cargando panel...", "info");

  try {
    // Últimos 30 días (ISO)
    const now = new Date();
    const d30 = new Date(now.getTime() - 30*24*60*60*1000);
    const from = `${d30.getFullYear()}-${String(d30.getMonth()+1).padStart(2,"0")}-${String(d30.getDate()).padStart(2,"0")}`;

    const [enSnap, asSnap, scSnap, rqSnap] = await Promise.all([
      getDocs(query(collection(db, "entries"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "assignments"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "scrap"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "requests"), orderBy("createdAt","desc"), limit(300)))
    ]);

    const entries = [];
    enSnap.forEach(d => entries.push({ id:d.id, ...d.data() }));
    const assignments = [];
    asSnap.forEach(d => assignments.push({ id:d.id, ...d.data() }));
    const scrap = [];
    scSnap.forEach(d => scrap.push({ id:d.id, ...d.data() }));
    const requests = [];
    rqSnap.forEach(d => requests.push({ id:d.id, ...d.data() }));

    const en30 = entries.filter(x => (x.date || "") >= from).length;
    const as30 = assignments.filter(x => (x.date || "") >= from).length;
    const sc30 = scrap.filter(x => (x.date || "") >= from).length;
    const pend = requests.filter(x => x.status === "Pendiente").length;

    $("kpiEntries").textContent = String(en30);
    $("kpiAssignments").textContent = String(as30);
    $("kpiScrap").textContent = String(sc30);
    $("kpiPending").textContent = String(pend);

    // last tables
    const lastE = entries.slice(0, 6);
    const tbodyE = $("tblLastEntries").querySelector("tbody");
    tbodyE.innerHTML = lastE.map(r => `
      <tr>
        <td>${escapeHtml(r.date || "")}</td>
        <td>${escapeHtml(r.type || "")}</td>
        <td>${escapeHtml(r.desc || "")}</td>
        <td class="right">${safeNum(r.qty)}</td>
        <td class="right">${safeNum(r.available)}</td>
      </tr>
    `).join("") || `<tr><td colspan="5" class="muted">Sin datos</td></tr>`;

    const lastA = assignments.slice(0, 6);
    const tbodyA = $("tblLastAssignments").querySelector("tbody");
    tbodyA.innerHTML = lastA.map(r => `
      <tr>
        <td>${escapeHtml(r.date || "")}</td>
        <td>${escapeHtml(r.worker || "")}</td>
        <td>${escapeHtml(`${r.entryType || ""} • ${r.entryDesc || ""}`)}</td>
        <td class="right">${safeNum(r.qty)}</td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;

    setMsg(msg, "✅ Panel actualizado.", "ok");
  } catch (e) {
    console.error(e);
    setMsg(msg, "❌ No se pudo cargar el panel (¿permisos?).", "bad");
  }
}

/* -------------------------
  Init
------------------------- */
function boot() {
  // Defaults fechas
  if ($("entDate")) $("entDate").value = todayISO();
  if ($("asDate")) $("asDate").value = todayISO();
  if ($("scDate")) $("scDate").value = todayISO();

  setupTogglePassword();
  setupAuthButtons();

  setupEntries();
  setupAssignments();
  setupScrap();
  setupRequests();
  setupReports();

  // Si el script muere por cualquier motivo, deja evidencia en loginMsg
  window.addEventListener("error", () => {
    const m = $("loginMsg");
    if (m) setMsg(m, "❌ Error de JavaScript. Revisa consola (F12 → Console).", "bad");
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null;
      currentProfile = null;
      showLogin();
      setMsg($("loginMsg"), "Ingresa tus credenciales para continuar.", "info");
      return;
    }
    await onUserReady(user);
  });
}

boot();

