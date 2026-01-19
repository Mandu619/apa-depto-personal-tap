import { auth, db, secondaryAuth } from "./firebase.js";
import { $, setMsg, todayISO, safeNum, escapeHtml, downloadCSV } from "./utils.js";

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
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
  where,
  orderBy,
  limit,
  updateDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* -------------------------
  Estado global
------------------------- */
let currentUser = null;
let currentProfile = null; // users/{uid}: {first,last,name,role,email,active}
let lastReportRows = null;

let entryCache = new Map();      // entries
let assignmentsCache = [];       // assignments
let scrapCache = [];             // scrap
let requestsCache = [];          // requests
let employeesCache = [];         // employees

/* -------------------------
  Helpers de rol
------------------------- */
function role(){ return currentProfile?.role || "consulta"; }
function canWrite(){ return role() === "admin" || role() === "operator"; }
function isAdmin(){ return role() === "admin"; }

/* -------------------------
  UI base: mostrar/ocultar
------------------------- */
function showLoginOnly(){
  // Solo login visible
  $("loginWrap").hidden = false;
  $("appShell").hidden = true;
  $("userBox").hidden = true;
}
function showAppOnly(){
  // Solo app visible
  $("loginWrap").hidden = true;
  $("appShell").hidden = false;
  $("userBox").hidden = false;
}

/* -------------------------
  Tabs
------------------------- */
function setupTabs(){
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("is-active"));
      btn.classList.add("is-active");

      const target = btn.dataset.tab;
      document.querySelectorAll(".tabpage").forEach(p => p.hidden = true);
      $(target).hidden = false;

      if (target === "tabDashboard") loadDashboard();
      if (target === "tabEntries") loadEntries(true);
      if (target === "tabAssignments") { fillEntryDropdowns(); fillEmployeeDropdowns(); loadAssignments(true); }
      if (target === "tabScrap") { fillEntryDropdowns(); loadScrap(true); }
      if (target === "tabRequests") loadRequests(true);
      if (target === "tabReports") { fillEmployeeDropdowns(); }
      if (target === "tabEmployees") { if (isAdmin()) loadEmployees(true); }
    });
  });
}

/* -------------------------
  Toggle password
------------------------- */
function setupTogglePassword(){
  const btn = $("btnTogglePassword");
  if (btn){
    btn.addEventListener("click", () => {
      const input = $("loginPassword");
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      btn.textContent = isPassword ? "🙈" : "👁️";
    });
  }

  const btn2 = $("btnToggleEmpPass");
  if (btn2){
    btn2.addEventListener("click", () => {
      const input = $("empPass");
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      btn2.textContent = isPassword ? "🙈" : "👁️";
    });
  }
}

/* -------------------------
  Auth
------------------------- */
function setupAuthButtons(){
  $("btnLogin").addEventListener("click", async () => {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const msg = $("loginMsg");
    const btn = $("btnLogin");

    setMsg(msg, "");
    if (!email || !password){
      setMsg(msg, "Debes ingresar correo y contraseña.", "warn");
      return;
    }

    btn.disabled = true;
    setMsg(msg, "Verificando credenciales...", "info");

    try{
      await signInWithEmailAndPassword(auth, email, password);
      setMsg(msg, "✅ Ingreso exitoso. Cargando sistema...", "ok");
    }catch(err){
      const code = err?.code || "";
      if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password")){
        setMsg(msg, "❌ Correo o contraseña incorrectos.", "bad");
      } else if (code.includes("auth/user-not-found")){
        setMsg(msg, "❌ No existe un usuario con ese correo en Firebase Auth.", "bad");
      } else if (code.includes("auth/too-many-requests")){
        setMsg(msg, "⚠️ Demasiados intentos. Espera un momento y prueba de nuevo.", "warn");
      } else if (code.includes("auth/unauthorized-domain")){
        setMsg(msg, "❌ Dominio no autorizado en Firebase Auth (Authorized domains).", "bad");
      } else {
        setMsg(msg, `❌ Error de autenticación (${code || "desconocido"}).`, "bad");
      }
      console.error(err);
    }finally{
      btn.disabled = false;
    }
  });

  $("btnLogout").addEventListener("click", async () => {
    await signOut(auth);
  });
}

async function loadProfile(uid){
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

async function onUserReady(user){
  currentUser = user;
  currentProfile = await loadProfile(user.uid);

  if (!currentProfile?.role){
    showLoginOnly();
    setMsg($("loginMsg"),
      "⚠️ Tu usuario existe, pero falta tu perfil en Firestore: users/{uid} con role (admin/operator/consulta).",
      "warn"
    );
    return;
  }

  // si está inactivo
  if (currentProfile.active === false){
    showLoginOnly();
    setMsg($("loginMsg"), "❌ Usuario inactivo. Contacta al administrador.", "bad");
    await signOut(auth);
    return;
  }

  $("userName").textContent = currentProfile.name || currentProfile.email || user.email || "Usuario";
  $("userRole").textContent = `Rol: ${currentProfile.role}`;

  // habilitar tab empleados solo admin
  $("tabEmployeesBtn").hidden = !isAdmin();

  applyRoleUI();
  showAppOnly();

  // precargas
  setupTabs();
  await loadEmployees(false); // para dropdowns
  await loadEntries(false);

  loadDashboard();
}

function applyRoleUI(){
  ["btnSaveEntry","btnSaveAssign","btnSaveScrap"].forEach(id => {
    const b = $(id);
    if (!b) return;
    b.disabled = !canWrite();
    b.title = canWrite() ? "" : "No tienes permisos para registrar (solo admin/operator).";
  });

  // Empleados: solo admin
  if ($("btnCreateEmployee")) $("btnCreateEmployee").disabled = !isAdmin();
}

/* -------------------------
  Empleados (admin)
  Colección: employees/{uid}
  Perfil/roles: users/{uid}
------------------------- */
function setupEmployees(){
  $("btnCreateEmployee").addEventListener("click", async () => {
    const msg = $("empMsg");
    setMsg(msg, "");

    if (!isAdmin()){
      setMsg(msg, "❌ Solo admin puede crear empleados.", "bad");
      return;
    }

    const first = $("empFirst").value.trim();
    const last = $("empLast").value.trim();
    const email = $("empEmail").value.trim().toLowerCase();
    const pass = $("empPass").value;
    const roleSel = $("empRole").value;
    const active = $("empActive").value === "true";

    if (!first || !last || !email || pass.length < 6){
      setMsg(msg, "Completa nombre, apellidos, correo y clave (mínimo 6).", "warn");
      return;
    }

    try{
      setMsg(msg, "Creando usuario en Firebase Auth...", "info");

      // Crear usuario en Auth secundario (no cambia la sesión del admin)
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pass);

      // Set display name en ese usuario (opcional)
      try{
        await updateProfile(cred.user, { displayName: `${first} ${last}` });
      }catch{}

      const uid = cred.user.uid;
      const fullName = `${first} ${last}`;

      setMsg(msg, "Guardando perfil y empleado en Firestore...", "info");

      // employees/{uid}
      await setDoc(doc(db, "employees", uid), {
        uid,
        first,
        last,
        name: fullName,
        email,
        role: roleSel,
        active,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp()
      });

      // users/{uid} -> usado por el sistema para permisos
      await setDoc(doc(db, "users", uid), {
        first,
        last,
        name: fullName,
        email,
        role: roleSel,
        active
      });

      // limpiar form
      $("empFirst").value = "";
      $("empLast").value = "";
      $("empEmail").value = "";
      $("empPass").value = "";
      $("empRole").value = "consulta";
      $("empActive").value = "true";

      setMsg(msg, "✅ Empleado creado. Ya puede iniciar sesión con su correo/clave.", "ok");

      await loadEmployees(true);
      fillEmployeeDropdowns();

    }catch(err){
      console.error(err);
      const code = err?.code || "";
      if (code.includes("auth/email-already-in-use")){
        setMsg(msg, "❌ Ese correo ya está registrado en Firebase Auth.", "bad");
      } else {
        setMsg(msg, `❌ Error al crear empleado (${code || "desconocido"}).`, "bad");
      }
    }
  });

  $("btnReloadEmployees").addEventListener("click", () => loadEmployees(true));
}

async function loadEmployees(showMsg){
  const msg = $("empListMsg");
  if (showMsg && msg) setMsg(msg, "Cargando empleados...", "info");

  employeesCache = [];
  try{
    const qy = query(collection(db, "employees"), orderBy("name","asc"), limit(500));
    const snap = await getDocs(qy);
    snap.forEach(d => employeesCache.push({ id:d.id, ...d.data() }));

    renderEmployeesTable();
    fillEmployeeDropdowns();

    if (showMsg && msg) setMsg(msg, `✅ Empleados cargados: ${employeesCache.length}`, "ok");
  }catch(e){
    console.error(e);
    if (showMsg && msg) setMsg(msg, "❌ No se pudieron cargar empleados (¿permisos?).", "bad");
  }
}

function renderEmployeesTable(){
  const tbody = $("tblEmployees")?.querySelector("tbody");
  if (!tbody) return;

  tbody.innerHTML = employeesCache.map(e => `
    <tr>
      <td>${escapeHtml(e.name || `${e.first||""} ${e.last||""}`)}</td>
      <td>${escapeHtml(e.email || "")}</td>
      <td>${escapeHtml(e.role || "")}</td>
      <td>${e.active === false ? "No" : "Sí"}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;
}

function fillEmployeeDropdowns(){
  // dropdown en Asignación
  const selAs = $("asWorkerSelect");
  // dropdown en Informes
  const selRp = $("rpWorkerSelect");

  const options =
    `<option value="">(Todos / sin filtro)</option>` +
    employeesCache
      .filter(e => e.active !== false)
      .map(e => `<option value="${escapeHtml(e.name || "")}">${escapeHtml(e.name || "")}</option>`)
      .join("");

  if (selAs){
    // aquí no queremos "todos", queremos selección obligatoria
    const optAs =
      `<option value="">(Selecciona trabajador)</option>` +
      employeesCache
        .filter(e => e.active !== false)
        .map(e => `<option value="${escapeHtml(e.name || "")}">${escapeHtml(e.name || "")}</option>`)
        .join("");
    selAs.innerHTML = optAs;
  }

  if (selRp){
    selRp.innerHTML = options;
  }
}

/* -------------------------
  Entradas
------------------------- */
function setupEntries(){
  $("entDate").value = todayISO();

  $("btnSaveEntry").addEventListener("click", async () => {
    const msg = $("entMsg");
    setMsg(msg, "");

    if (!canWrite()){
      setMsg(msg, "No tienes permisos para registrar entradas.", "bad");
      return;
    }

    const date = $("entDate").value || todayISO();
    const type = $("entType").value;
    const desc = $("entDesc").value.trim();
    const unit = $("entUnit").value.trim();
    const qty = safeNum($("entQty").value);
    const docRef = $("entDoc").value.trim();

    if (!desc || qty <= 0){
      setMsg(msg, "Completa descripción y cantidad válida.", "warn");
      return;
    }

    try{
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
      loadDashboard();
    }catch(e){
      console.error(e);
      setMsg(msg, "❌ Error al guardar entrada (revisa reglas/rol).", "bad");
    }
  });

  $("btnReloadEntries").addEventListener("click", () => loadEntries(true));
  $("entSearch").addEventListener("input", () => renderEntriesTable());
  $("entFilterType").addEventListener("change", () => renderEntriesTable());
}

async function loadEntries(showMsg){
  const msg = $("entListMsg");
  if (showMsg) setMsg(msg, "Cargando entradas...", "info");

  entryCache.clear();

  try{
    const qy = query(collection(db, "entries"), orderBy("date","desc"), limit(500));
    const snap = await getDocs(qy);
    snap.forEach(d => entryCache.set(d.id, { id:d.id, ...d.data() }));

    renderEntriesTable();
    fillEntryDropdowns();

    if (showMsg) setMsg(msg, `✅ Entradas cargadas: ${entryCache.size}`, "ok");
  }catch(e){
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar entradas.", "bad");
  }
}

function renderEntriesTable(){
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

function fillEntryDropdowns(){
  const opts = Array.from(entryCache.values())
    .sort((a,b) => (b.date || "").localeCompare(a.date || ""))
    .map(r => {
      const label = `${r.date || ""} • ${r.type} • ${r.desc} (Disp: ${safeNum(r.available)})`;
      return `<option value="${r.id}">${escapeHtml(label)}</option>`;
    }).join("");

  $("asEntry").innerHTML = opts || `<option value="">(Sin entradas)</option>`;
  $("scEntry").innerHTML = opts || `<option value="">(Sin entradas)</option>`;
}

/* -------------------------
  Asignaciones
------------------------- */
function setupAssignments(){
  $("asDate").value = todayISO();

  $("btnSaveAssign").addEventListener("click", async () => {
    const msg = $("asMsg");
    setMsg(msg, "");

    if (!canWrite()){
      setMsg(msg, "No tienes permisos para registrar asignaciones.", "bad");
      return;
    }

    const entryId = $("asEntry").value;
    const date = $("asDate").value || todayISO();
    const worker = $("asWorkerSelect").value; // ahora desde base
    const qty = safeNum($("asQty").value);
    const reason = $("asReason").value.trim();

    if (!entryId || !worker || qty <= 0){
      setMsg(msg, "Completa entrada, trabajador y cantidad válida.", "warn");
      return;
    }

    try{
      setMsg(msg, "Guardando asignación...", "info");

      await runTransaction(db, async (tx) => {
        const eRef = doc(db, "entries", entryId);
        const eSnap = await tx.get(eRef);
        if (!eSnap.exists()) throw new Error("Entrada no existe");
        const e = eSnap.data();
        const available = safeNum(e.available);

        if (qty > available) throw new Error("Cantidad excede disponible");

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

        tx.update(eRef, { available: available - qty });
      });

      setMsg(msg, "✅ Asignación registrada y stock actualizado.", "ok");
      $("asQty").value = "";
      $("asReason").value = "";

      await loadEntries(false);
      await loadAssignments(true);
      loadDashboard();
    }catch(e){
      console.error(e);
      if (String(e.message).includes("excede")){
        setMsg(msg, "❌ La cantidad asignada supera el stock disponible.", "bad");
      }else{
        setMsg(msg, "❌ Error al guardar asignación.", "bad");
      }
    }
  });

  $("btnReloadAssignments").addEventListener("click", () => loadAssignments(true));
  $("asSearch").addEventListener("input", () => renderAssignmentsTable());
}

async function loadAssignments(showMsg){
  const msg = $("asListMsg");
  if (showMsg) setMsg(msg, "Cargando asignaciones...", "info");

  assignmentsCache = [];
  try{
    const qy = query(collection(db, "assignments"), orderBy("date","desc"), limit(500));
    const snap = await getDocs(qy);
    snap.forEach(d => assignmentsCache.push({ id:d.id, ...d.data() }));

    renderAssignmentsTable();
    if (showMsg) setMsg(msg, `✅ Asignaciones cargadas: ${assignmentsCache.length}`, "ok");
  }catch(e){
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar asignaciones.", "bad");
  }
}

function renderAssignmentsTable(){
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
function setupScrap(){
  $("scDate").value = todayISO();

  $("btnSaveScrap").addEventListener("click", async () => {
    const msg = $("scMsg");
    setMsg(msg, "");

    if (!canWrite()){
      setMsg(msg, "No tienes permisos para registrar merma.", "bad");
      return;
    }

    const entryId = $("scEntry").value;
    const date = $("scDate").value || todayISO();
    const qty = safeNum($("scQty").value);
    const reason = $("scReason").value;
    const detail = $("scDetail").value.trim();

    if (!entryId || qty <= 0){
      setMsg(msg, "Completa entrada y cantidad válida.", "warn");
      return;
    }
    if (reason === "Otro" && !detail){
      setMsg(msg, "Si motivo es 'Otro', el detalle es obligatorio.", "warn");
      return;
    }

    try{
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
      loadDashboard();
    }catch(e){
      console.error(e);
      if (String(e.message).includes("excede")){
        setMsg(msg, "❌ La cantidad de merma supera el stock disponible.", "bad");
      }else{
        setMsg(msg, "❌ Error al guardar merma.", "bad");
      }
    }
  });

  $("btnReloadScrap").addEventListener("click", () => loadScrap(true));
  $("scSearch").addEventListener("input", () => renderScrapTable());
}

async function loadScrap(showMsg){
  const msg = $("scListMsg");
  if (showMsg) setMsg(msg, "Cargando mermas...", "info");

  scrapCache = [];
  try{
    const qy = query(collection(db, "scrap"), orderBy("date","desc"), limit(500));
    const snap = await getDocs(qy);
    snap.forEach(d => scrapCache.push({ id:d.id, ...d.data() }));

    renderScrapTable();
    if (showMsg) setMsg(msg, `✅ Mermas cargadas: ${scrapCache.length}`, "ok");
  }catch(e){
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar mermas.", "bad");
  }
}

function renderScrapTable(){
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
function setupRequests(){
  $("btnSaveRequest").addEventListener("click", async () => {
    const msg = $("rqMsg");
    setMsg(msg, "");

    const type = $("rqType").value;
    const priority = $("rqPriority").value;
    const detail = $("rqDetail").value.trim();

    if (!detail){
      setMsg(msg, "El detalle es obligatorio.", "warn");
      return;
    }

    try{
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
    }catch(e){
      console.error(e);
      setMsg(msg, "❌ Error al enviar solicitud.", "bad");
    }
  });

  $("btnReloadRequests").addEventListener("click", () => loadRequests(true));
  $("rqFilterStatus").addEventListener("change", () => renderRequestsTable());
}

async function loadRequests(showMsg){
  const msg = $("rqListMsg");
  if (showMsg) setMsg(msg, "Cargando solicitudes...", "info");

  requestsCache = [];
  try{
    const qy = query(collection(db, "requests"), orderBy("createdAt","desc"), limit(500));
    const snap = await getDocs(qy);
    snap.forEach(d => requestsCache.push({ id:d.id, ...d.data() }));

    renderRequestsTable();
    if (showMsg) setMsg(msg, `✅ Solicitudes cargadas: ${requestsCache.length}`, "ok");
  }catch(e){
    console.error(e);
    if (showMsg) setMsg(msg, "❌ No se pudieron cargar solicitudes.", "bad");
  }
}

function renderRequestsTable(){
  const tbody = $("tblRequests").querySelector("tbody");
  const f = $("rqFilterStatus").value;

  const rows = requestsCache.filter(r => !f || r.status === f);

  tbody.innerHTML = rows.map(r => {
    const actionHtml = canWrite()
      ? `<button class="btn btn--primary" data-act="respond" data-id="${r.id}">Responder</button>`
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

  tbody.querySelectorAll("button[data-act='respond']").forEach(b => {
    b.addEventListener("click", () => openRespondPrompt(b.dataset.id));
  });
}

async function openRespondPrompt(requestId){
  const msg = $("rqListMsg");
  if (!canWrite()){
    setMsg(msg, "No tienes permisos para responder.", "bad");
    return;
  }

  const text = prompt("Escribe la respuesta para cerrar la solicitud:");
  if (text === null) return;

  const response = text.trim();
  if (!response){
    setMsg(msg, "La respuesta no puede estar vacía.", "warn");
    return;
  }

  try{
    setMsg(msg, "Guardando respuesta...", "info");
    await updateDoc(doc(db, "requests", requestId), { status:"Respondida", response });
    setMsg(msg, "✅ Solicitud respondida.", "ok");
    await loadRequests(false);
    loadDashboard();
  }catch(e){
    console.error(e);
    setMsg(msg, "❌ Error al responder solicitud.", "bad");
  }
}

/* -------------------------
  Informes (mejorado)
  - Selección trabajador desde employees
  - Incluye mermas
  - Incluye resumen stock total restante
------------------------- */
function setupReports(){
  $("btnRunReport").addEventListener("click", async () => {
    const msg = $("rpMsg");
    const msg2 = $("rpSummaryMsg");
    setMsg(msg, "Generando informe...", "info");
    setMsg(msg2, "");
    $("btnExportCSV").disabled = true;
    lastReportRows = null;

    try{
      const mode = $("rpMode").value;
      const worker = $("rpWorkerSelect").value; // ahora desde base
      const from = $("rpFrom").value;
      const to = $("rpTo").value;

      // Cargamos datasets (simple, sin índices extra)
      const [enSnap, asSnap, scSnap] = await Promise.all([
        getDocs(query(collection(db, "entries"), orderBy("date","desc"), limit(1000))),
        getDocs(query(collection(db, "assignments"), orderBy("date","desc"), limit(1000))),
        getDocs(query(collection(db, "scrap"), orderBy("date","desc"), limit(1000)))
      ]);

      const entries = [];
      enSnap.forEach(d => entries.push({ id:d.id, ...d.data() }));
      const assignments = [];
      asSnap.forEach(d => assignments.push({ id:d.id, ...d.data() }));
      const scrap = [];
      scSnap.forEach(d => scrap.push({ id:d.id, ...d.data() }));

      const inRange = (d) => {
        if (!d) return true;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      };

      // helper: stock total restante (sum available)
      const totalRemaining = entries.reduce((acc, e) => acc + safeNum(e.available), 0);
      const totalEntered = entries.reduce((acc, e) => acc + safeNum(e.qty), 0);
      const totalAssigned = assignments.reduce((acc, a) => acc + safeNum(a.qty), 0);
      const totalScrap = scrap.reduce((acc, s2) => acc + safeNum(s2.qty), 0);

      const agg = new Map();

      if (mode === "worker"){
        const filtered = assignments
          .filter(a => inRange(a.date))
          .filter(a => !worker || a.worker === worker);

        filtered.forEach(a => {
          const key = a.worker || "(Sin nombre)";
          agg.set(key, (agg.get(key) || 0) + safeNum(a.qty));
        });

        setMsg(msg2, `Resumen global (no filtrado): Entradas=${totalEntered} • Asignaciones=${totalAssigned} • Mermas=${totalScrap} • Stock restante=${totalRemaining}`, "info");

      } else if (mode === "type"){
        // Entradas por tipo
        entries.filter(e => inRange(e.date)).forEach(e => {
          const key = `Entradas • ${e.type || "Otro"}`;
          agg.set(key, (agg.get(key) || 0) + safeNum(e.qty));
        });
        // Asignaciones por tipo
        assignments.filter(a => inRange(a.date)).forEach(a => {
          const key = `Asignaciones • ${a.entryType || "Otro"}`;
          agg.set(key, (agg.get(key) || 0) + safeNum(a.qty));
        });
        // Mermas por tipo
        scrap.filter(s2 => inRange(s2.date)).forEach(s2 => {
          const key = `Mermas • ${s2.entryType || "Otro"}`;
          agg.set(key, (agg.get(key) || 0) + safeNum(s2.qty));
        });

        setMsg(msg2, `Stock total restante (todas las entradas): ${totalRemaining}`, "info");

      } else {
        // mode === "stock"
        // Resumen total + por tipo de disponible
        agg.set("Total Entradas", totalEntered);
        agg.set("Total Asignaciones", totalAssigned);
        agg.set("Total Mermas", totalScrap);
        agg.set("Stock Total Restante", totalRemaining);

        // disponible por tipo (sum available)
        const byType = new Map();
        entries.forEach(e => {
          const t = e.type || "Otro";
          byType.set(t, (byType.get(t)||0) + safeNum(e.available));
        });
        Array.from(byType.entries()).forEach(([t, v]) => {
          agg.set(`Disponible • ${t}`, v);
        });

        setMsg(msg2, "Incluye disponible por tipo + totales (entradas/asignaciones/mermas).", "info");
      }

      const rows = Array.from(agg.entries())
        .sort((a,b) => b[1] - a[1])
        .map(([concept, qty]) => ({ concept, qty }));

      renderReport(rows);
      lastReportRows = rows;
      $("btnExportCSV").disabled = rows.length === 0;

      setMsg(msg, `✅ Informe generado (${rows.length} filas).`, "ok");

    }catch(e){
      console.error(e);
      setMsg(msg, "❌ Error al generar informe (revisa permisos/reglas).", "bad");
    }
  });

  $("btnExportCSV").addEventListener("click", () => {
    if (!lastReportRows) return;
    const rows = [
      ["Concepto","Cantidad"],
      ...lastReportRows.map(r => [r.concept, r.qty])
    ];
    downloadCSV("informe_apa.csv", rows);
  });
}

function renderReport(rows){
  const tbody = $("tblReport").querySelector("tbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.concept)}</td>
      <td class="right">${safeNum(r.qty)}</td>
    </tr>
  `).join("") || `<tr><td colspan="2" class="muted">Sin resultados</td></tr>`;
}

/* -------------------------
  Dashboard (se corrige error visual: no se muestra antes de login)
------------------------- */
async function loadDashboard(){
  const msg = $("dashMsg");
  setMsg(msg, "Cargando panel...", "info");

  try{
    const now = new Date();
    const d30 = new Date(now.getTime() - 30*24*60*60*1000);
    const from = `${d30.getFullYear()}-${String(d30.getMonth()+1).padStart(2,"0")}-${String(d30.getDate()).padStart(2,"0")}`;

    const [enSnap, asSnap, scSnap, rqSnap] = await Promise.all([
      getDocs(query(collection(db, "entries"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "assignments"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "scrap"), orderBy("date","desc"), limit(300))),
      getDocs(query(collection(db, "requests"), orderBy("createdAt","desc"), limit(300)))
    ]);

    const entries = []; enSnap.forEach(d => entries.push({ id:d.id, ...d.data() }));
    const assignments = []; asSnap.forEach(d => assignments.push({ id:d.id, ...d.data() }));
    const scrap = []; scSnap.forEach(d => scrap.push({ id:d.id, ...d.data() }));
    const requests = []; rqSnap.forEach(d => requests.push({ id:d.id, ...d.data() }));

    const en30 = entries.filter(x => (x.date || "") >= from).length;
    const as30 = assignments.filter(x => (x.date || "") >= from).length;
    const sc30 = scrap.filter(x => (x.date || "") >= from).length;
    const pend = requests.filter(x => x.status === "Pendiente").length;

    $("kpiEntries").textContent = String(en30);
    $("kpiAssignments").textContent = String(as30);
    $("kpiScrap").textContent = String(sc30);
    $("kpiPending").textContent = String(pend);

    // últimos
    const lastE = entries.slice(0, 6);
    $("tblLastEntries").querySelector("tbody").innerHTML = lastE.map(r => `
      <tr>
        <td>${escapeHtml(r.date || "")}</td>
        <td>${escapeHtml(r.type || "")}</td>
        <td>${escapeHtml(r.desc || "")}</td>
        <td class="right">${safeNum(r.qty)}</td>
        <td class="right">${safeNum(r.available)}</td>
      </tr>
    `).join("") || `<tr><td colspan="5" class="muted">Sin datos</td></tr>`;

    const lastA = assignments.slice(0, 6);
    $("tblLastAssignments").querySelector("tbody").innerHTML = lastA.map(r => `
      <tr>
        <td>${escapeHtml(r.date || "")}</td>
        <td>${escapeHtml(r.worker || "")}</td>
        <td>${escapeHtml(`${r.entryType || ""} • ${r.entryDesc || ""}`)}</td>
        <td class="right">${safeNum(r.qty)}</td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;

    setMsg(msg, "✅ Panel actualizado.", "ok");
  }catch(e){
    console.error(e);
    setMsg(msg, "❌ No se pudo cargar el panel (¿permisos?).", "bad");
  }
}

/* -------------------------
  INIT
------------------------- */
function boot(){
  // defaults
  if ($("entDate")) $("entDate").value = todayISO();
  if ($("asDate")) $("asDate").value = todayISO();
  if ($("scDate")) $("scDate").value = todayISO();

  setupTogglePassword();
  setupAuthButtons();

  setupEmployees();
  setupEntries();
  setupAssignments();
  setupScrap();
  setupRequests();
  setupReports();

  window.addEventListener("error", () => {
    const m = $("loginMsg");
    if (m) setMsg(m, "❌ Error de JavaScript. Revisa consola (F12 → Console).", "bad");
  });

  // Antes de saber el estado auth: solo login (no mostrar app)
  showLoginOnly();
  setMsg($("loginMsg"), "Ingresa tus credenciales para continuar.", "info");

  onAuthStateChanged(auth, async (user) => {
    if (!user){
      currentUser = null;
      currentProfile = null;
      showLoginOnly();
      setMsg($("loginMsg"), "Ingresa tus credenciales para continuar.", "info");
      return;
    }
    await onUserReady(user);
  });
}

boot();


