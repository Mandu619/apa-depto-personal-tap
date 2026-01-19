export function nowTs() {
  return Date.now();
}

export function todayISO() {
  return new Date().toISOString().slice(0,10);
}

export function setMsg(el, text, type="info") {
  if (!el) return;
  el.textContent = text || "";
  el.style.color =
    type === "ok" ? "var(--ok)" :
    type === "bad" ? "var(--bad)" :
    type === "warn" ? "var(--warn)" :
    "var(--muted)";
}

export function escapeHtml(str="") {
  return str.replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

export function toCSV(rows, headers) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g,'""')}"`;
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const r of rows) {
    lines.push(headers.map(h => esc(r[h])).join(","));
  }
  return lines.join("\n");
}

export function downloadText(filename, content, mime="text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function parseDateToTs(isoDate) {
  // isoDate: "YYYY-MM-DD"
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00");
  return d.getTime();
}
