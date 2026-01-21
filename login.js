import { auth } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const $ = (id) => document.getElementById(id);

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg";
  if (kind) el.classList.add(kind);
}

function setupToggle() {
  const btn = $("btnTogglePassword");
  const input = $("loginPassword");
  if (!btn || !input) return;

  btn.addEventListener("click", () => {
    const isPwd = input.type === "password";
    input.type = isPwd ? "text" : "password";

    // Importante: NO cambiar textContent (si no, pisa el SVG)
    btn.setAttribute("aria-label", isPwd ? "Ocultar contraseña" : "Mostrar contraseña");
    btn.setAttribute("title", isPwd ? "Ocultar contraseña" : "Mostrar contraseña");
  });
}

$("btnLogin")?.addEventListener("click", async () => {
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
    setMsg(msg, "✅ Ingreso exitoso. Redirigiendo...", "ok");
    window.location.href = "./app.html";
  } catch (err) {
    console.error(err);
    const code = err?.code || "";

    if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password")) {
      setMsg(msg, "❌ Correo o contraseña incorrectos.", "bad");
    } else if (code.includes("auth/user-not-found")) {
      setMsg(msg, "❌ No existe un usuario con ese correo.", "bad");
    } else if (code.includes("auth/unauthorized-domain")) {
      setMsg(msg, "❌ Dominio no autorizado. Agrega 'mandu619.github.io' en Firebase Auth.", "bad");
    } else {
      setMsg(msg, `❌ Error de autenticación (${code || "desconocido"}).`, "bad");
    }
  }
});

// Si ya está logueado, NO mostrar login: mandar a app.html
onAuthStateChanged(auth, (u) => {
  if (u) window.location.href = "./app.html";
});

setupToggle();
