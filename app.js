// Cuentas claras — UI layer. Renders from the in-memory data of the open profile and
// writes every change through the encrypted Session.

import * as U from "./util.js";
import * as V from "./vault.js";
import * as M from "./model.js";
import { analyze, scoreWord } from "./advisor.js";

const { esc, fmt, fmt0, fmtBal, fmtSigned, fmtNum, fmtPct, sum } = U;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ic = (id, extra = "") => `<svg class="i" ${extra}><use href="#i-${id}"/></svg>`;
const root = $("#root");
const LOCK_AFTER_MS = 5 * 60 * 1000;
const TABS = [
  { id: "inicio", label: "Inicio", icon: "home" },
  { id: "movimientos", label: "Movimientos", icon: "list" },
  { id: "ahorros", label: "Ahorros", icon: "vault" },
  { id: "asesor", label: "Asesor", icon: "spark" },
  { id: "perfil", label: "Perfil", icon: "user" },
];
const KIND_ICON = { cash: "cash", bank: "bank", stock: "chart", crypto: "coin", metal: "bar", other: "box" };
const ACCT_ICON = { cash: "cash", card: "card" };

let session = null;
let D = null;
let hiddenAt = 0;
let freshId = null;
const today = () => U.todayStr();
const view = { tab: "inicio", month: U.ym(U.todayStr()), q: "", type: "all", acct: "", cat: "", movTab: "list" };

/* ======================================================================
   Toasts
   ====================================================================== */
function toast(msg, actionLabel, action) {
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status");
  const s = document.createElement("span"); s.textContent = msg; t.append(s);
  let timer, left = actionLabel ? 6000 : 2600, start = 0;
  const dismiss = () => { clearTimeout(timer); document.removeEventListener("visibilitychange", vis); t.classList.add("out"); setTimeout(() => t.remove(), 300); };
  const run = () => { start = Date.now(); clearTimeout(timer); timer = setTimeout(dismiss, left); };
  const pause = () => { clearTimeout(timer); left -= Date.now() - start; };
  const vis = () => (document.hidden ? pause() : run());
  if (actionLabel) { const b = document.createElement("button"); b.textContent = actionLabel; b.onclick = () => { action(); dismiss(); }; t.append(b); }
  t.addEventListener("pointerenter", pause); t.addEventListener("pointerleave", run);
  document.addEventListener("visibilitychange", vis);
  $$("#toasts .toast:not(.out)").forEach(old => { old.classList.add("out"); setTimeout(() => old.remove(), 300); });
  $("#toasts").append(t); run();
}

/* ======================================================================
   Sheet (side panel on desktop, bottom sheet on phone)
   ====================================================================== */
const sheet = $("#sheet"), scrim = $("#scrim");
let sheetState = null;

function openSheet({ title, body, foot = "", mount, instant = false, onClose }) {
  const wasOpen = sheet.classList.contains("on");
  if (!wasOpen) sheetState = { lastFocus: document.activeElement };
  sheetState.onClose = onClose;
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = body;
  $("#sheetFoot").innerHTML = foot;
  $("#sheetBody").scrollTop = 0;
  sheet.classList.toggle("instant", instant); scrim.classList.toggle("instant", instant);
  sheet.classList.add("on"); scrim.classList.add("on");
  document.documentElement.style.overflow = "hidden";
  mount && mount(sheet);
  const first = $("[autofocus]", sheet);
  if (first && matchMedia("(pointer:fine)").matches) first.focus({ preventScroll: true });
  else if (!wasOpen) $("[data-sheet-close]", sheet).focus({ preventScroll: true });
}
function closeSheet() {
  if (!sheet.classList.contains("on")) return;
  sheet.classList.remove("on", "instant"); scrim.classList.remove("on", "instant");
  document.documentElement.style.overflow = "";
  const st = sheetState; sheetState = null;
  st?.onClose && st.onClose();
  if (st?.lastFocus?.isConnected) st.lastFocus.focus({ preventScroll: true });
  setTimeout(() => { if (!sheet.classList.contains("on")) { $("#sheetBody").innerHTML = ""; $("#sheetFoot").innerHTML = ""; } }, 450);
}
scrim.addEventListener("click", closeSheet);
sheet.addEventListener("click", e => { if (e.target.closest("[data-sheet-close]")) closeSheet(); });
sheet.addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const f = $$("button:not([disabled]),input:not([type=radio]):not([type=hidden]),input[type=radio]:checked,select,textarea,[tabindex='0']", sheet).filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
(() => { // drag the bottom sheet down to close it
  let y0 = null, t0 = 0, dy = 0;
  const handles = [$(".grab", sheet), $(".sheet-head", sheet)];
  const down = e => { if (innerWidth > 760 || e.target.closest("button")) return; y0 = e.clientY; t0 = performance.now(); dy = 0; sheet.style.transition = "none"; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = e => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy}px)`; };
  const up = () => { if (y0 === null) return; const v = dy / (performance.now() - t0); sheet.style.transition = ""; sheet.style.transform = ""; y0 = null; if (dy > 110 || v > 0.5) closeSheet(); };
  for (const h of handles) { h.addEventListener("pointerdown", down); h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up); }
})();

/* small form helpers */
function setErrors(scope, errors) {
  $$(".field", scope).forEach(f => f.classList.remove("bad"));
  $$(".err", scope).forEach(e => (e.textContent = ""));
  let first = null;
  for (const [k, msg] of Object.entries(errors)) {
    const el = $(`[data-err="${k}"]`, scope); if (!el) continue;
    el.textContent = msg; el.closest(".field")?.classList.add("bad");
    first ||= $(`[name="${k}"]`, scope);
  }
  if (first) first.focus();
  return Object.keys(errors).length === 0;
}
const radio = (scope, name) => $(`input[name="${name}"]:checked`, scope)?.value ?? "";
function busy(btn, on, label) { if (!btn) return; btn.classList.toggle("loading", on); if (label) btn.textContent = label; }
const moneyField = (name, label, value = "", { big = false, auto = false, hint = "", optional = false } = {}) => `
  <label class="field"><span class="lbl">${label}${optional ? ` <span class="opt">(opcional)</span>` : ""}</span>
    <div class="money${big ? " big" : ""}"><input class="in num" name="${name}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(value)}"${auto ? " autofocus" : ""}><em>€</em></div>
    ${hint ? `<small class="hint">${hint}</small>` : ""}<small class="err" data-err="${name}"></small></label>`;
const textField = (name, label, value = "", { placeholder = "", optional = false, max = 80, auto = false, type = "text", hint = "" } = {}) => `
  <label class="field"><span class="lbl">${label}${optional ? ` <span class="opt">(opcional)</span>` : ""}</span>
    <input class="in" name="${name}" type="${type}" autocomplete="off" maxlength="${max}" placeholder="${esc(placeholder)}" value="${esc(value)}"${auto ? " autofocus" : ""}>
    ${hint ? `<small class="hint">${hint}</small>` : ""}<small class="err" data-err="${name}"></small></label>`;
const centsToInput = c => (c ? (c / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) : "");
const qtyToInput = n => (n ? String(n).replace(".", ",") : "");
function dateField(value, name = "date") {
  const t = today(), y = U.addDays(t, -1);
  return `<div class="field"><span class="lbl" id="lbl-${name}">Fecha</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap" role="group" aria-labelledby="lbl-${name}">
      <div class="chips" data-datechips="${name}">
        <label><input type="radio" name="${name}-q" value="${t}"${value === t ? " checked" : ""}><span>Hoy</span></label>
        <label><input type="radio" name="${name}-q" value="${y}"${value === y ? " checked" : ""}><span>Ayer</span></label>
      </div>
      <input class="in" style="flex:1;min-width:150px" type="date" name="${name}" value="${esc(value)}" max="${U.addDays(t, 366)}" aria-label="Fecha">
    </div><small class="err" data-err="${name}"></small></div>`;
}
function wireDate(scope, name = "date") {
  const inp = $(`input[name="${name}"]`, scope);
  scope.addEventListener("change", e => {
    if (e.target.name === `${name}-q`) inp.value = e.target.value;
    if (e.target === inp) $$(`input[name="${name}-q"]`, scope).forEach(r => (r.checked = r.value === inp.value));
  });
}
function accountChips(name, selected, { none = false, noneLabel = "Ninguna", exclude = null } = {}) {
  const bal = M.accountBalances(D);
  return `<div class="chips">${none ? `<label><input type="radio" name="${name}" value=""${!selected ? " checked" : ""}><span>${esc(noneLabel)}</span></label>` : ""}${D.accounts.filter(a => a.id !== exclude).map(a =>
    `<label><input type="radio" name="${name}" value="${esc(a.id)}"${a.id === selected ? " checked" : ""}><span>${ic(ACCT_ICON[a.kind] || "card")}${esc(a.name)} <small class="num">${fmtBal(bal[a.id])}</small></span></label>`).join("")}</div>`;
}

/* ======================================================================
   Files: share sheet on iPhone, download elsewhere
   ====================================================================== */
async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia("(pointer:coarse)").matches) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (e) { if (e && e.name === "AbortError") return false; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  return true;
}
const readFile = f => f.text();

/* ======================================================================
   Auth: profiles on this device
   ====================================================================== */
function renderAuth(mode, ctx = {}) {
  closeSheet();
  document.title = "Cuentas claras";
  if (!V.storageAvailable()) {
    root.innerHTML = `<div class="auth"><div class="auth-card"><div class="auth-brand"><div class="mark"><span></span><span></span><span></span></div><b>Cuentas claras</b></div>
      <h1>No se puede guardar en este navegador</h1><p>Parece que estás en una ventana privada o el navegador bloquea el almacenamiento. Abre la app en una ventana normal.</p></div></div>`;
    return;
  }
  const profiles = V.listProfiles();
  if (!mode) mode = profiles.length ? "list" : "welcome";
  const brand = `<div class="auth-brand"><div class="mark"><span></span><span></span><span></span></div><b>Cuentas claras</b></div>`;
  const privacy = `<div class="privacy">${ic("lock")}<span>Tus datos se cifran con tu contraseña y se guardan solo en este dispositivo. Nadie más puede leerlos, ni siquiera nosotros.</span></div>`;
  let html = "";
  if (mode === "welcome") {
    html = `${brand}<h1>Tus cuentas, tus ahorros y un asesor que las entiende</h1>
      <p>Apunta lo que gastas en efectivo y con tarjeta, registra tus ahorros e inversiones y recibe un análisis de tu situación.</p>
      ${privacy}
      <button class="btn btn-primary btn-block" data-auth="create">Crear mi perfil</button>
      <div class="auth-foot"><button class="link" data-auth="restore">Restaurar una copia de seguridad</button></div>`;
  } else if (mode === "list") {
    html = `${brand}<h1>¿Quién eres?</h1>
      <div class="profiles">${profiles.map(p => `<button class="profile-btn" data-auth="unlock" data-id="${esc(p.id)}"><span class="avatar">${esc(p.name.trim().charAt(0).toUpperCase())}</span><span><b>${esc(p.name)}</b><small>Perfil protegido con contraseña</small></span>${ic("right")}</button>`).join("")}</div>
      <button class="btn btn-block" data-auth="create">${ic("plus")}Crear otro perfil</button>
      ${privacy}
      <div class="auth-foot"><button class="link" data-auth="restore">Restaurar una copia de seguridad</button></div>`;
  } else if (mode === "unlock") {
    const p = profiles.find(x => x.id === ctx.id);
    if (!p) return renderAuth();
    html = `${brand}<div style="display:flex;gap:12px;align-items:center"><span class="avatar" style="width:48px;height:48px;font-size:20px">${esc(p.name.charAt(0).toUpperCase())}</span><h1 style="font-size:34px">Hola, ${esc(p.name)}</h1></div>
      <form class="form" id="authForm" novalidate>
        <label class="field"><span class="lbl">Contraseña</span><div class="pw"><input class="in" type="password" name="password" autocomplete="current-password" autofocus required>
          <button type="button" data-auth="peek" aria-label="Mostrar contraseña">${ic("eye")}</button></div><small class="err" data-err="password"></small></label>
        <button class="btn btn-primary btn-block" type="submit">Entrar</button>
      </form>
      <div class="auth-foot"><button class="link" data-auth="list">Cambiar de perfil</button></div>`;
  } else if (mode === "create") {
    html = `${brand}<h1>Crea tu perfil</h1>
      <form class="form" id="authForm" novalidate>
        ${textField("name", "Tu nombre", "", { placeholder: "Ej. Lucía", max: 40, auto: true })}
        <label class="field"><span class="lbl">Contraseña</span><div class="pw"><input class="in" type="password" name="password" autocomplete="new-password" minlength="8">
          <button type="button" data-auth="peek" aria-label="Mostrar contraseña">${ic("eye")}</button></div><small class="hint">Mínimo 8 caracteres.</small><small class="err" data-err="password"></small></label>
        <label class="field"><span class="lbl">Repite la contraseña</span><input class="in" type="password" name="confirm" autocomplete="new-password"><small class="err" data-err="confirm"></small></label>
        <label class="field"><span class="check"><input type="checkbox" name="ack"><span>Entiendo que si olvido la contraseña <b>no se pueden recuperar</b> mis datos. Por eso haré copias de seguridad.</span></span><small class="err" data-err="ack"></small></label>
        <button class="btn btn-primary btn-block" type="submit">Crear perfil</button>
      </form>
      ${privacy}
      <div class="auth-foot">${profiles.length ? `<button class="link" data-auth="list">Volver</button>` : ""}</div>`;
  } else if (mode === "restore") {
    html = `${brand}<h1>Restaurar una copia</h1>
      <p>Elige el archivo de copia que exportaste desde Perfil y escribe la contraseña que tenía ese perfil.</p>
      <form class="form" id="authForm" novalidate>
        <label class="field"><span class="lbl">Archivo de copia</span><input class="in" type="file" name="file" accept=".json,application/json" style="padding-top:10px"><small class="err" data-err="file"></small></label>
        <label class="field"><span class="lbl">Contraseña de esa copia</span><div class="pw"><input class="in" type="password" name="password" autocomplete="current-password">
          <button type="button" data-auth="peek" aria-label="Mostrar contraseña">${ic("eye")}</button></div><small class="err" data-err="password"></small></label>
        <button class="btn btn-primary btn-block" type="submit">Restaurar</button>
      </form>
      <div class="auth-foot"><button class="link" data-auth="${profiles.length ? "list" : "welcome"}">Volver</button></div>`;
  }
  root.innerHTML = `<div class="auth"><div class="auth-card">${html}</div></div>`;
  const form = $("#authForm");
  if (form) form.addEventListener("submit", e => { e.preventDefault(); submitAuth(mode, form, ctx); });
  const af = $("[autofocus]", root); if (af && matchMedia("(pointer:fine)").matches) af.focus();
}

root.addEventListener("click", e => {
  const b = e.target.closest("[data-auth]"); if (!b) return;
  const a = b.dataset.auth;
  if (a === "peek") { const inp = b.parentElement.querySelector("input"); inp.type = inp.type === "password" ? "text" : "password"; b.setAttribute("aria-label", inp.type === "password" ? "Mostrar contraseña" : "Ocultar contraseña"); return; }
  renderAuth(a, { id: b.dataset.id });
});

async function submitAuth(mode, form, ctx) {
  const btn = $("button[type=submit]", form);
  const val = n => form.elements[n]?.value ?? "";
  try {
    if (mode === "unlock") {
      if (!val("password")) return setErrors(form, { password: "Escribe tu contraseña." });
      busy(btn, true, "Abriendo…");
      const s = await V.unlock(ctx.id, val("password"));
      startSession(s);
    } else if (mode === "create") {
      const errs = V.validateNewProfile(val("name"), val("password"), val("confirm"));
      if (!form.elements.ack.checked) errs.ack = "Marca la casilla para continuar.";
      if (!setErrors(form, errs)) return;
      busy(btn, true, "Creando…");
      const s = await V.createProfile(val("name"), val("password"), M.emptyData());
      startSession(s);
    } else if (mode === "restore") {
      const f = form.elements.file.files[0];
      const errs = {};
      if (!f) errs.file = "Elige el archivo de copia.";
      if (!val("password")) errs.password = "Escribe la contraseña de la copia.";
      if (!setErrors(form, errs)) return;
      busy(btn, true, "Restaurando…");
      const s = await V.importBackup(await readFile(f), val("password"));
      startSession(s);
      toast(`Copia restaurada como «${s.name}»`);
    }
  } catch (err) {
    busy(btn, false, mode === "unlock" ? "Entrar" : mode === "create" ? "Crear perfil" : "Restaurar");
    if (err.code === "bad_password") setErrors(form, { password: mode === "restore" ? "Esa no es la contraseña de esta copia." : "La contraseña no es correcta." });
    else if (err.code === "format") setErrors(form, { file: err.message });
    else if (err.code === "invalid") setErrors(form, { name: err.message });
    else toast(err.message || "Algo ha fallado. Inténtalo de nuevo.");
  }
}

function startSession(s) {
  session = s;
  D = M.migrate(s.data);
  s.data = D;
  s.onError = e => toast(e.message || "No se pudo guardar.");
  view.tab = TABS.some(t => "#" + t.id === location.hash) ? location.hash.slice(1) : "inicio";
  view.month = U.ym(today());
  renderShell();
  if (!D.settings.onboarded) openOnboarding();
}

async function lock(reason) {
  if (!session) return;
  closeSheet();
  try { await session.flush(); } catch {}
  session.close(); session = null; D = null;
  history.replaceState(null, "", location.pathname);
  renderAuth();
  if (reason) toast(reason);
}

document.addEventListener("visibilitychange", () => {
  if (!session) return;
  if (document.hidden) { hiddenAt = Date.now(); session.flush(); }
  else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lock("Por seguridad, la sesión se ha cerrado. Vuelve a entrar.");
});
addEventListener("pagehide", () => { session && session.flush(); });

/* ======================================================================
   Data changes: every change is undoable and saved encrypted
   ====================================================================== */
function commit(mutate, message, { undo = true } = {}) {
  const before = structuredClone(D);
  const result = mutate(D);
  session.save();
  renderView();
  if (message) toast(message, undo ? "Deshacer" : null, () => { D = before; session.data = D; session.save(); renderView(); });
  return result;
}

/* ======================================================================
   Shell
   ====================================================================== */
function renderShell() {
  const initial = esc(session.name.trim().charAt(0).toUpperCase());
  root.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="brand"><div class="mark sm" aria-hidden="true"><span></span><span></span><span></span></div><span>Cuentas claras</span></div>
    <nav class="tabs" aria-label="Secciones">${TABS.map(t => `<button class="tab" data-tab="${t.id}">${ic(t.icon)}${t.label}</button>`).join("")}</nav>
    <div class="top-actions">
      <button class="btn btn-primary top-new" data-act="newTx">${ic("plus")}Nuevo movimiento</button>
      <button class="btn btn-ghost who" data-tab="perfil" aria-label="Perfil de ${esc(session.name)}"><span class="avatar">${initial}</span><span class="name">${esc(session.name)}</span></button>
      <button class="btn btn-ghost btn-icon" data-act="lock" aria-label="Cerrar sesión" title="Cerrar sesión">${ic("lock")}</button>
    </div>
  </div></header>
  <main class="view wrap" id="view"></main>
  <nav class="tabbar" aria-label="Secciones">${TABS.map(t => `<button data-tab="${t.id}">${ic(t.icon)}<span>${t.label}</span></button>`).join("")}</nav>
  <button class="fab" data-act="newTx" aria-label="Nuevo movimiento">${ic("plus")}</button>`;
  renderView();
}

function setTab(tab) {
  if (!TABS.some(t => t.id === tab)) tab = "inicio";
  view.tab = tab;
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  renderView();
  scrollTo({ top: 0 });
}
addEventListener("hashchange", () => { if (session) { const t = location.hash.slice(1); if (t && t !== view.tab) setTab(t); } });

function renderView() {
  if (!session) return;
  $$("[data-tab]").forEach(b => { if (b.dataset.tab === view.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const el = $("#view"); if (!el) return;
  const fn = { inicio: viewInicio, movimientos: viewMovs, ahorros: viewAhorros, asesor: viewAsesor, perfil: viewPerfil }[view.tab];
  el.innerHTML = fn();
  document.title = `${TABS.find(t => t.id === view.tab).label} · Cuentas claras`;
  if (view.tab === "inicio") drawChart();
}

/* ======================================================================
   Global actions
   ====================================================================== */
document.addEventListener("click", e => {
  if (!session) return;
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn && !sheet.contains(tabBtn)) { setTab(tabBtn.dataset.tab); return; }
  const a = e.target.closest("[data-act]"); if (!a) return;
  const { act, id } = a.dataset;
  switch (act) {
    case "lock": lock(); break;
    case "newTx": openTx(null, { type: a.dataset.type || "out", account: a.dataset.account }); break;
    case "editTx": { const t = D.tx.find(x => x.id === id); if (t) openTx(t); break; }
    case "prevMonth": view.month = U.addMonths(view.month, -1); renderView(); break;
    case "nextMonth": if (view.month < U.ym(today())) { view.month = U.addMonths(view.month, 1); renderView(); } break;
    case "goMonth": view.month = id; renderView(); break;
    case "movTab": view.movTab = a.dataset.v; renderView(); break;
    case "resetFilters": Object.assign(view, { q: "", type: "all", acct: "", cat: "" }); renderView(); break;
    case "budget": editBudget(a); break;
    case "newAsset": openAssetKind(); break;
    case "asset": openAsset(id); break;
    case "acctEdit": openAccount(id); break;
    case "acctNew": openAccount(null); break;
    case "acctAdjust": openAdjust(id); break;
    case "rename": openRename(); break;
    case "password": openPassword(); break;
    case "backup": doBackup(); break;
    case "csv": doCsv(); break;
    case "importCsv": openImportCsv(); break;
    case "deleteProfile": openDeleteProfile(); break;
    case "budgetsAll": setTab("movimientos"); view.movTab = "cats"; renderView(); break;
  }
});
document.addEventListener("input", e => {
  if (!session) return;
  if (e.target.id === "q") { view.q = e.target.value; const box = $("#movList"); if (box) box.innerHTML = listBody(); }
});
document.addEventListener("change", e => {
  if (!session || sheet.contains(e.target)) return;
  if (e.target.name === "ftype") { view.type = e.target.value; renderView(); }
  if (e.target.id === "facct") { view.acct = e.target.value; renderView(); }
  if (e.target.id === "fcat") { view.cat = e.target.value; renderView(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheet.classList.contains("on")) { closeSheet(); return; }
  if (!session || sheet.classList.contains("on") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); openTx(null, { type: "out" }, true); }
});

/* ======================================================================
   View: Inicio
   ====================================================================== */
const isCurrentMonth = () => view.month === U.ym(today());
const monthNav = () => `<div class="month-nav"><button class="btn btn-ghost btn-icon" data-act="prevMonth" aria-label="Mes anterior">${ic("left")}</button><b>${U.cap(U.monthName(view.month))}</b><button class="btn btn-ghost btn-icon" data-act="nextMonth" aria-label="Mes siguiente"${isCurrentMonth() ? " disabled" : ""}>${ic("right")}</button></div>`;

function deltaText(cur, prev, goodUp) {
  if (!prev) return `<span>Sin datos del mes anterior</span>`;
  const p = Math.round((cur - prev) / prev * 100);
  if (p === 0) return `<span>Igual que el mes anterior</span>`;
  const up = p > 0, good = up === goodUp;
  const pm = U.monthShort(U.addMonths(view.month, -1));
  return `<b class="${good ? "pos" : "neg"}">${up ? "+" : "−"}${Math.abs(p)} %</b><span>vs. ${isCurrentMonth() ? `1–${Number(today().slice(8))} ${pm}` : U.MONTHS[Number(U.addMonths(view.month, -1).slice(5)) - 1]}</span>`;
}

function viewInicio() {
  const bal = M.accountBalances(D), avail = sum(Object.values(bal));
  const sav = M.savingsSummary(D);
  const worth = avail + sav.total;
  const t = M.monthTotals(D, view.month);
  const p = M.monthTotals(D, U.addMonths(view.month, -1), isCurrentMonth() ? Number(today().slice(8)) : 0);
  const rate = t.i ? Math.round(t.n / t.i * 100) : null;
  const monthTx = M.txInMonth(D, view.month);
  const byAcct = id => { let o = 0, i = 0; for (const x of monthTx) if (M.isStat(x) && x.account === id) x.type === "out" ? (o += x.amount) : (i += x.amount); return { o, i }; };
  const recent = [...D.tx].sort(txSort).slice(0, 5);
  const adv = analyze(D, today());
  const top = adv.insights[0];

  return `
  <section class="section">
    <div class="hero">
      <div><div class="kicker-num">Patrimonio total</div><div class="big num">${fmtBal(worth)}</div>
        <p class="muted" style="margin-top:10px">Dinero disponible ${fmtBal(avail)} · Ahorros ${fmtBal(sav.total)}</p></div>
      <div class="breakdown">
        ${D.accounts.map(a => `<button class="line" data-act="newTx" data-account="${esc(a.id)}"><span>${ic(ACCT_ICON[a.kind] || "card")}${esc(a.name)}</span><b class="num${bal[a.id] < 0 ? " neg" : ""}">${fmtBal(bal[a.id])}</b></button>`).join("")}
        <button class="line" data-tab="ahorros"><span>${ic("vault")}Ahorros e inversiones</span><b class="num">${fmtBal(sav.total)}</b></button>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="sec-head"><h2>Tu dinero para el día a día</h2><span class="sub">Toca una cuenta para apuntar un gasto</span></div>
    <div class="accounts">${D.accounts.map(a => { const m = byAcct(a.id); return `
      <button class="acct" style="text-align:left" data-act="newTx" data-account="${esc(a.id)}">
        <span class="acct-top">${ic(ACCT_ICON[a.kind] || "card")}${esc(a.name)}</span>
        <span class="mid num${bal[a.id] < 0 ? " neg" : ""}">${fmtBal(bal[a.id], 2)}</span>
        <small class="num">${U.cap(U.MONTHS[Number(view.month.slice(5)) - 1])}: −${fmt0(m.o)} gastado · +${fmt0(m.i)} ingresado</small>
      </button>`; }).join("")}</div>
    <div class="quick">
      <button class="btn" data-act="newTx" data-type="out">${ic("up")}Apuntar gasto</button>
      <button class="btn" data-act="newTx" data-type="in">${ic("down")}Apuntar ingreso</button>
      <button class="btn" data-act="newTx" data-type="transfer">${ic("swap")}Mover dinero</button>
    </div>
  </section>

  <section class="section">
    <div class="sec-head"><h2>Resumen del mes</h2>${monthNav()}</div>
    <div class="stats3">
      <div class="stat"><h3>Ahorro del mes</h3><div class="mid num${t.n < 0 ? " neg" : ""}">${fmtBal(t.n)}</div>
        <div class="delta">${rate === null ? "<span>Aún no hay ingresos este mes</span>" : rate >= 0 ? `<span>Guardas el</span><b class="pos">${rate} %</b><span>de lo que ingresas</span>` : `<span>Gastas</span><b class="neg">${fmt0(-t.n)}</b><span>más de lo que ingresas</span>`}</div></div>
      <div class="stat"><h3><i class="dot" style="background:var(--in)"></i>Ingresos</h3><div class="mid num">${fmt0(t.i)}</div><div class="delta">${deltaText(t.i, p.i, true)}</div></div>
      <div class="stat"><h3><i class="dot" style="background:var(--out)"></i>Gastos</h3><div class="mid num">${fmt0(t.o)}</div><div class="delta">${deltaText(t.o, p.o, false)}</div>
        ${t.o ? `<div class="delta"><span>Efectivo ${fmt0(t.cashOut)} · Tarjeta ${fmt0(t.cardOut)}</span></div>` : ""}</div>
    </div>
  </section>

  <section class="section">
    <div class="sec-head"><h2>Ingresos y gastos, últimos 6 meses</h2><div class="legend" aria-hidden="true"><span><i class="dot" style="background:var(--in)"></i>Ingresos</span><span><i class="dot" style="background:var(--out)"></i>Gastos</span></div></div>
    <div class="chart" id="chart"><div class="tip" id="tip"></div></div>
    <details class="data"><summary>Ver los datos en tabla</summary><div class="tbl"><table id="chartTable"></table></div></details>
  </section>

  ${top ? `<section class="section">
    <div class="sec-head"><h2>Tu asesor</h2>${adv.score !== null ? `<span class="sub">Salud financiera: ${adv.score}/100 · ${scoreWord(adv.score)}</span>` : ""}</div>
    ${insightCard(top)}
    <div class="quick"><button class="btn" data-tab="asesor">Ver el análisis completo${ic("arrow")}</button></div>
  </section>` : ""}

  <section class="section">
    <div class="sec-head"><h2>Últimos movimientos</h2>${D.tx.length ? `<button class="btn btn-ghost" data-tab="movimientos">Ver todos${ic("arrow")}</button>` : ""}</div>
    ${recent.length ? `<div class="txl">${recent.map(txRow).join("")}</div>` : emptyMovs(false)}
  </section>`;
}

function drawChart() {
  const el = $("#chart"); if (!el) return;
  const tip = $("#tip");
  const W = el.clientWidth, H = el.clientHeight; if (W < 120 || H < 60) return;
  const data = M.monthSeries(D, view.month, 6);
  const maxV = Math.max(0, ...data.map(d => Math.max(d.i, d.o)));
  const niceStep = raw => { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const step = maxV ? niceStep(maxV / 4) : 25000, top = maxV ? Math.ceil(maxV / step) * step : step * 4;
  const axis = c => { const v = c / 100; return v >= 1000 ? (v / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " k€" : v.toLocaleString("es-ES") + " €"; };
  const padL = 48, padB = 26, padT = 8, iw = W - padL, ih = H - padB - padT;
  const cw = iw / data.length, bw = Math.max(6, Math.min(28, (cw - 20) / 2)), gap = 2;
  const y = v => padT + ih - (v / top) * ih;
  const bar = (x, v) => { const h = (v / top) * ih; if (h < 1) return ""; const r = Math.min(4, h, bw / 2), yt = padT + ih - h, yb = padT + ih; return `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${yb}Z`; };
  let s = `<svg role="img" aria-label="Ingresos y gastos de ${U.monthName(data[0].k)} a ${U.monthName(data[5].k)}"><g class="grid axis">`;
  for (let v = 0; v <= top + 1; v += step) s += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${axis(v)}</text>`;
  s += `</g>`;
  data.forEach((d, i) => {
    const cx = padL + cw * i + cw / 2, x0 = cx - bw - gap / 2;
    s += `<g class="col${d.k === view.month ? " sel" : ""}" data-i="${i}"><rect class="band" x="${padL + cw * i + 3}" y="${padT}" width="${Math.max(0, cw - 6)}" height="${ih}" rx="6"/>`;
    s += `<path fill="var(--in)" d="${bar(x0, d.i)}"/><path fill="var(--out)" d="${bar(x0 + bw + gap, d.o)}"/>`;
    s += `<rect x="${padL + cw * i}" y="0" width="${cw}" height="${H}" fill="transparent"/></g>`;
    s += `<g class="axis"><text x="${cx}" y="${H - 6}" text-anchor="middle" class="${d.k === view.month ? "cur" : ""}">${U.monthShort(d.k)}</text></g>`;
  });
  el.querySelector("svg")?.remove();
  el.insertAdjacentHTML("afterbegin", s + "</svg>");
  $$(".col", el).forEach(g => {
    const d = data[g.dataset.i];
    g.addEventListener("pointerenter", e => {
      if (e.pointerType === "touch") return;
      tip.innerHTML = `<h4>${U.cap(U.monthName(d.k))}</h4><div><span><i class="dot" style="background:var(--in)"></i>Ingresos</span><b class="num">${fmt0(d.i)}</b></div><div><span><i class="dot" style="background:var(--out)"></i>Gastos</span><b class="num">${fmt0(d.o)}</b></div><div><span>Ahorro</span><b class="num">${fmtBal(d.n)}</b></div>`;
      const i = Number(g.dataset.i), cx = padL + cw * i + cw / 2, tw = 190;
      let left = cx + cw / 2; if (left + tw > W) left = cx - cw / 2 - tw; if (left < 0) left = 0;
      tip.style.left = left + "px"; tip.style.top = Math.max(0, y(Math.max(d.i, d.o)) - 20) + "px"; tip.classList.add("on");
    });
    g.addEventListener("pointerleave", () => tip.classList.remove("on"));
    g.addEventListener("click", () => { tip.classList.remove("on"); if (d.k !== view.month) { view.month = d.k; renderView(); } });
  });
  $("#chartTable").innerHTML = `<thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Ahorro</th></tr></thead><tbody>${data.map(d => `<tr><td>${U.cap(U.monthName(d.k))}</td><td class="num">${fmt0(d.i)}</td><td class="num">${fmt0(d.o)}</td><td class="num">${fmtBal(d.n)}</td></tr>`).join("")}</tbody>`;
}
new ResizeObserver(() => { if (session && view.tab === "inicio") drawChart(); }).observe(document.documentElement);

/* ======================================================================
   View: Movimientos
   ====================================================================== */
const txSort = (a, b) => b.date.localeCompare(a.date) || (b.seq || 0) - (a.seq || 0);
const acctName = id => D.accounts.find(a => a.id === id)?.name || "Cuenta eliminada";

function txRow(t) {
  const cls = t.type === "transfer" ? "" : "ic-" + t.type;
  const iconId = t.type === "transfer" ? "swap" : t.asset ? "vault" : t.type === "in" ? "down" : "up";
  const sub = t.type === "transfer" ? `${esc(acctName(t.account))} → ${esc(acctName(t.to))}` : `${esc(t.cat)} · ${esc(acctName(t.account))}`;
  const amt = t.type === "transfer" ? fmt(t.amount) : (t.type === "in" ? "+" : "−") + fmt(t.amount);
  return `<button class="tx${t.id === freshId ? " fresh" : ""}" data-act="editTx" data-id="${esc(t.id)}">
    <span class="tx-ic ${cls}">${ic(iconId)}</span>
    <span class="tx-main"><b>${esc(t.concept || "Traspaso")}</b><small>${sub}${t.note ? " · " + esc(t.note) : ""}</small></span>
    <span class="tx-amt num${t.type === "in" ? " pos" : ""}">${amt}<small>${U.dayLabel(t.date)}</small></span></button>`;
}
function emptyMovs(filtered) {
  if (filtered) return `<div class="empty"><b>Ningún movimiento coincide</b><span>Prueba con otra búsqueda o quita los filtros.</span><div class="btns"><button class="btn" data-act="resetFilters">Quitar filtros</button></div></div>`;
  return `<div class="empty"><b>Apunta tu primer movimiento</b><span>Cada gasto o ingreso que añadas, en efectivo o con tarjeta, aparece aquí.</span><div class="btns">
    <button class="btn btn-primary" data-act="newTx" data-type="out">${ic("plus")}Apuntar gasto</button><button class="btn" data-act="newTx" data-type="in">Apuntar ingreso</button></div></div>`;
}

function viewMovs() {
  const head = `<section class="section" style="padding-bottom:12px;border-bottom:0">
    <div class="sec-head"><h2 style="font:400 34px/1.1 var(--serif)">Movimientos</h2>${monthNav()}</div>
    <div class="seg" role="tablist" aria-label="Vista">
      <label><input type="radio" name="movTab" value="list" data-act="movTab" data-v="list"${view.movTab === "list" ? " checked" : ""}><span>Lista</span></label>
      <label><input type="radio" name="movTab" value="cats" data-act="movTab" data-v="cats"${view.movTab === "cats" ? " checked" : ""}><span>Por categoría y presupuestos</span></label>
    </div></section>`;
  return head + (view.movTab === "cats" ? viewCats() : viewList());
}

function listBody() {
  const q = view.q.trim().toLowerCase();
  const all = M.txInMonth(D, view.month);
  const rows = all
    .filter(t => view.type === "all" || t.type === view.type)
    .filter(t => !view.acct || t.account === view.acct || t.to === view.acct)
    .filter(t => !view.cat || t.cat === view.cat)
    .filter(t => !q || `${t.concept} ${t.note || ""} ${t.cat || ""}`.toLowerCase().includes(q))
    .sort(txSort);
  const filtered = q || view.type !== "all" || view.acct || view.cat;
  let body;
  if (!rows.length) body = all.length || filtered ? emptyMovs(true) : (D.tx.length ? `<div class="empty"><b>Sin movimientos en ${U.monthName(view.month)}</b><div class="btns"><button class="btn btn-primary" data-act="newTx">${ic("plus")}Nuevo movimiento</button></div></div>` : emptyMovs(false));
  else {
    const days = {};
    for (const t of rows) (days[t.date] ||= []).push(t);
    body = Object.entries(days).map(([d, list]) => {
      const net = sum(list.filter(M.isStat).map(t => t.type === "in" ? t.amount : -t.amount));
      return `<div class="day"><span>${U.cap(new Date(d + "T00:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }))}</span><span class="num">${net ? fmtSigned(net) : ""}</span></div><div class="txl">${list.map(txRow).join("")}</div>`;
    }).join("");
    const st = rows.filter(M.isStat);
    body += `<div class="list-foot"><span>${rows.length} ${rows.length === 1 ? "movimiento" : "movimientos"}</span><span class="num">Ingresos ${fmt0(sum(st.filter(t => t.type === "in").map(t => t.amount)))} · Gastos ${fmt0(sum(st.filter(t => t.type === "out").map(t => t.amount)))}</span></div>`;
  }
  return body;
}
function viewList() {
  const all = M.txInMonth(D, view.month);
  const cats = [...new Set([...(view.type !== "in" ? M.CATS.out : []), ...(view.type !== "out" ? M.CATS.in : []), ...all.map(t => t.cat).filter(Boolean)])];
  return `<section class="section" style="padding-top:8px">
    <div class="filters">
      <label class="search"><span class="sr">Buscar</span>${ic("search")}<input class="in" id="q" type="search" placeholder="Buscar por concepto" value="${esc(view.q)}"></label>
      <div class="seg" role="radiogroup" aria-label="Tipo">${[["all", "Todo"], ["out", "Gastos"], ["in", "Ingresos"], ["transfer", "Traspasos"]].map(([v, l]) => `<label><input type="radio" name="ftype" value="${v}"${view.type === v ? " checked" : ""}><span>${l}</span></label>`).join("")}</div>
      <select class="in" id="facct" aria-label="Cuenta"><option value="">Cuentas</option>${D.accounts.map(a => `<option value="${esc(a.id)}"${view.acct === a.id ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
      <select class="in" id="fcat" aria-label="Categoría"><option value="">Categorías</option>${cats.map(c => `<option${view.cat === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
    </div>
    <div id="movList">${listBody()}</div>
  </section>`;
}

function viewCats() {
  const sums = M.categorySums(D, view.month, "out");
  const ins = M.categorySums(D, view.month, "in");
  const list = [...new Set([...Object.keys(sums), ...Object.keys(D.budgets).filter(c => D.budgets[c] > 0)])].sort((a, b) => (sums[b] || 0) - (sums[a] || 0));
  const total = sum(Object.values(sums));
  const outHtml = list.length ? `<ul class="cats">${list.map(c => {
    const s = sums[c] || 0, b = D.budgets[c] || 0, over = b && s > b, w = b ? Math.min(100, s / b * 100) : total ? s / total * 100 : 0;
    return `<li class="cat${over ? " over" : ""}"><span class="cat-name">${esc(c)}${over ? ` <span class="flag">${ic("alert")}Excedido ${fmt0(s - b)}</span>` : ""}</span>
      <span class="cat-amt num"><b>${fmt0(s)}</b> ${b ? "de" : "·"} <button class="budget num" data-act="budget" data-cat="${esc(c)}" aria-label="Presupuesto de ${esc(c)}: ${b ? fmt0(b) : "sin presupuesto"}. Cambiar">${b ? fmt0(b) : "poner presupuesto"}</button></span>
      <div class="track" aria-hidden="true"><i style="width:${w}%"></i></div></li>`;
  }).join("")}</ul>` : `<p class="muted">Aún no hay gastos en ${U.monthName(view.month)}.</p>`;
  const unused = M.CATS.out.filter(c => !list.includes(c));
  return `<section class="section" style="padding-top:8px">
    <div class="sec-head"><h2>Gastos por categoría</h2><span class="sub num">Total ${fmt0(total)}</span></div>
    ${outHtml}
    ${unused.length ? `<details class="data" style="margin-top:18px"><summary>Poner presupuesto a otra categoría</summary><div class="chips" style="margin-top:12px">${unused.map(c => `<button class="btn" data-act="budget" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div></details>` : ""}
  </section>
  <section class="section">
    <div class="sec-head"><h2>Ingresos por origen</h2><span class="sub num">Total ${fmt0(sum(Object.values(ins)))}</span></div>
    ${Object.keys(ins).length ? Object.entries(ins).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="line"><span>${esc(c)}</span><b class="num">${fmt0(v)}</b></div>`).join("") : `<p class="muted">Aún no hay ingresos en ${U.monthName(view.month)}.</p>`}
  </section>`;
}

function editBudget(btn) {
  const c = btn.dataset.cat;
  const inp = document.createElement("input");
  inp.className = "budget-in num"; inp.inputMode = "decimal"; inp.value = D.budgets[c] ? centsToInput(D.budgets[c]) : "";
  inp.setAttribute("aria-label", `Presupuesto mensual de ${c} en euros`); inp.placeholder = "0";
  btn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    if (ok) {
      const v = U.parseMoney(inp.value);
      if (Number.isNaN(v) || v < 0) { toast("Escribe el presupuesto solo con números."); renderView(); return; }
      if (v !== (D.budgets[c] || 0)) { commit(d => { if (v > 0) d.budgets[c] = v; else delete d.budgets[c]; }, v > 0 ? `Presupuesto de ${c}: ${fmt0(v)} al mes` : `Presupuesto de ${c} quitado`); return; }
    }
    renderView();
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") { e.stopPropagation(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
}

/* ======================================================================
   Movement form
   ====================================================================== */
function openTx(t, preset = {}, instant = false) {
  if (t && t.asset) {
    const a = D.assets.find(x => x.id === t.asset);
    openSheet({ title: "Movimiento de ahorro", body: `<div class="form"><p class="muted">Este movimiento se creó al registrar una operación en <b>${esc(a?.name || "tus ahorros")}</b>. Para cambiarlo o borrarlo, hazlo desde esa operación en Ahorros.</p>
      <div class="facts"><div><small>Importe</small><b class="num">${fmt(t.amount)}</b></div><div><small>Cuenta</small><b>${esc(acctName(t.account))}</b></div><div><small>Fecha</small><b>${U.dayLabel(t.date)}</b></div></div></div>`,
      foot: a ? `<button class="btn btn-primary" data-sheet-close id="goAsset">Ir a ${esc(a.name)}</button>` : "", mount: s => { $("#goAsset", s)?.addEventListener("click", () => setTimeout(() => { setTab("ahorros"); openAsset(a.id); }, 0)); } });
    return;
  }
  const f = t ? { ...t } : { type: preset.type || "out", amount: 0, account: preset.account || (D.accounts.find(a => a.kind === "card") || D.accounts[0]).id, to: "", cat: "", concept: "", date: isCurrentMonth() ? today() : `${view.month}-01`, note: "" };
  if (f.type === "transfer" && !f.to) f.to = (D.accounts.find(a => a.id !== f.account) || {}).id || "";
  const edit = !!t;
  const render = () => {
    const isT = f.type === "transfer";
    const cats = isT ? [] : M.CATS[f.type];
    if (!isT && !cats.includes(f.cat)) f.cat = cats.includes(t?.cat) ? t.cat : cats[0];
    $("#sheetBody").innerHTML = `<form class="form" id="txForm" novalidate>
      ${t?.adj ? `<p class="hint">Este es un ajuste de saldo. Solo afecta al saldo de la cuenta, no a tus estadísticas.</p>` : `<div class="seg full type" role="radiogroup" aria-label="Tipo">
        <label><input type="radio" name="type" value="out"${f.type === "out" ? " checked" : ""}><span>Gasto</span></label>
        <label><input type="radio" name="type" value="in"${f.type === "in" ? " checked" : ""}><span>Ingreso</span></label>
        <label><input type="radio" name="type" value="transfer"${isT ? " checked" : ""}><span>Mover dinero</span></label></div>`}
      ${moneyField("amount", "Importe", f.amount ? centsToInput(f.amount) : "", { big: true, auto: true })}
      ${isT ? `<fieldset class="field"><legend>Desde</legend>${accountChips("account", f.account)}<small class="err" data-err="account"></small></fieldset>
        <fieldset class="field"><legend>Hacia</legend>${accountChips("to", f.to)}<small class="err" data-err="to"></small></fieldset>
        <p class="hint">Por ejemplo, sacar dinero del cajero es mover de Tarjeta a Efectivo.</p>`
      : `<fieldset class="field"><legend>${f.type === "out" ? "Pagado con" : "Cobrado en"}</legend>${accountChips("account", f.account)}<small class="err" data-err="account"></small></fieldset>
        ${textField("concept", "Concepto", f.concept, { placeholder: f.type === "out" ? "Ej. Menú del día" : "Ej. Clases particulares" })}
        ${t?.adj ? "" : `<fieldset class="field"><legend>Categoría</legend><div class="chips">${cats.map((c, i) => `<label><input type="radio" name="cat" value="${esc(c)}"${c === f.cat ? " checked" : ""}><span>${esc(c)}</span></label>`).join("")}</div></fieldset>`}`}
      ${dateField(f.date)}
      ${textField("note", "Nota", f.note, { optional: true, max: 120 })}
      <button type="submit" hidden></button></form>`;
    const form = $("#txForm");
    wireDate(form);
    form.addEventListener("change", e => {
      if (e.target.name === "type") { read(); f.type = e.target.value; if (f.type === "transfer" && (!f.to || f.to === f.account)) f.to = (D.accounts.find(a => a.id !== f.account) || {}).id || ""; render(); }
    });
    form.addEventListener("submit", e => { e.preventDefault(); save(); });
    const amt = form.elements.amount;
    amt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); (form.elements.concept || form.elements.note).focus(); } });
  };
  const read = () => {
    const form = $("#txForm"); if (!form) return;
    f.amount = U.parseMoney(form.elements.amount.value);
    f.account = radio(form, "account");
    f.to = radio(form, "to");
    f.cat = radio(form, "cat") || f.cat;
    f.concept = (form.elements.concept?.value ?? f.concept).trim();
    f.date = form.elements.date.value;
    f.note = form.elements.note.value.trim();
  };
  const save = () => {
    read();
    const tx = { type: f.type, amount: f.amount, account: f.account, date: f.date, note: f.note };
    if (f.type === "transfer") { tx.to = f.to; tx.concept = "Traspaso"; tx.cat = ""; }
    else { tx.cat = t?.adj ? t.cat : f.cat; tx.concept = f.concept; }
    const errs = M.validateTx(D, tx);
    if (!setErrors($("#txForm"), errs)) return;
    let id;
    commit(d => {
      if (edit) { const o = d.tx.find(x => x.id === t.id); for (const k of ["to"]) delete o[k]; Object.assign(o, tx); id = o.id; }
      else { const n = { id: U.uid(), seq: M.nextSeq(d), ...tx }; d.tx.push(n); id = n.id; }
    }, edit ? "Cambios guardados" : f.type === "transfer" ? "Dinero movido" : "Movimiento apuntado");
    freshId = id; view.month = U.ym(f.date);
    closeSheet(); renderView(); freshId = null;
  };
  openSheet({
    title: edit ? "Editar movimiento" : "Nuevo movimiento", body: "", instant,
    foot: `${edit ? `<button class="btn btn-ghost btn-danger" id="txDel">${ic("trash")}Eliminar</button>` : ""}<button class="btn btn-primary" id="txSave">${edit ? "Guardar cambios" : "Guardar"}</button>`,
    mount: s => {
      render();
      $("#txSave", s).addEventListener("click", save);
      $("#txDel", s)?.addEventListener("click", () => { closeSheet(); commit(d => { d.tx = d.tx.filter(x => x.id !== t.id); }, `«${t.concept || "Traspaso"}» eliminado`); });
    },
  });
}

/* ======================================================================
   View: Ahorros
   ====================================================================== */
function assetSubtitle(a, s) {
  const k = M.ASSET_KINDS[a.kind];
  if (a.kind === "metal") return `${fmtNum(s.units, 3)} g de ${esc((a.metal || "oro").toLowerCase())}${a.purity && a.purity < 0.999 ? ` (${Math.round(a.purity * 1000)})` : ""} · ${s.price ? fmt(Math.round(s.price)) + "/g" : "sin precio"}`;
  if (k.unit) return `${fmtNum(s.units)} ${esc(a.ticker || (a.kind === "crypto" ? "uds." : "part."))} · ${s.price ? fmt(Math.round(s.price)) + " c/u" : "sin precio"}`;
  if (a.kind === "bank") return `${esc(a.entity || "Cuenta")}${a.apr ? ` · ${String(a.apr).replace(".", ",")} % TAE` : ""}`;
  return k.label;
}
function viewAhorros() {
  const sav = M.savingsSummary(D);
  const kinds = M.KIND_ORDER.filter(k => sav.byKind[k] > 0);
  if (!D.assets.length) return `<section class="section"><div class="sec-head"><h2 style="font:400 34px/1.1 var(--serif)">Ahorros</h2></div>
    <div class="empty"><b>Registra lo que tienes ahorrado</b><span>Efectivo guardado, cuentas bancarias, acciones, criptomonedas, oro o plata. Verás tu patrimonio completo y cómo evoluciona.</span>
    <div class="btns"><button class="btn btn-primary" data-act="newAsset">${ic("plus")}Añadir ahorro</button></div></div></section>`;
  const gainItems = sav.items.filter(x => !M.ASSET_KINDS[x.asset.kind].liquid && x.invested > 0);
  const g = sum(gainItems.map(x => x.gain)), inv = sum(gainItems.map(x => x.invested));
  return `<section class="section">
    <div class="sec-head"><h2 style="font:400 34px/1.1 var(--serif)">Ahorros</h2><button class="btn btn-primary" data-act="newAsset">${ic("plus")}Añadir ahorro</button></div>
    <div class="kicker-num">Total ahorrado e invertido</div><div class="big num">${fmt0(sav.total)}</div>
    ${inv ? `<p class="muted" style="margin-top:8px">En inversiones has puesto ${fmt0(inv)} y ahora valen ${fmt0(inv + g)}: <b class="${g >= 0 ? "pos" : "neg"}">${fmtSigned(g, 0)} (${g >= 0 ? "+" : "−"}${fmtPct(Math.abs(g / inv), 1)})</b></p>` : ""}
    ${sav.total > 0 ? `<div class="alloc" role="img" aria-label="Reparto: ${kinds.map(k => `${M.ASSET_KINDS[k].short} ${fmtPct(sav.byKind[k] / sav.total)}`).join(", ")}">${kinds.map(k => `<i style="width:${sav.byKind[k] / sav.total * 100}%;background:var(--k-${k})"></i>`).join("")}</div>
    <div class="kinds">${kinds.map(k => `<div class="line"><span><i class="dot" style="background:var(--k-${k})"></i>${M.ASSET_KINDS[k].short}</span><b class="num">${fmt0(sav.byKind[k])} <span class="faint">${fmtPct(sav.byKind[k] / sav.total)}</span></b></div>`).join("")}</div>` : ""}
  </section>
  ${M.KIND_ORDER.filter(k => D.assets.some(a => a.kind === k)).map(k => `<section class="section">
    <div class="sec-head"><h2>${M.ASSET_KINDS[k].label}</h2><span class="sub num">${fmt0(sav.byKind[k])}</span></div>
    <div class="assets">${sav.items.filter(x => x.asset.kind === k).sort((a, b) => b.value - a.value).map(x => `
      <button class="asset" data-act="asset" data-id="${esc(x.asset.id)}">
        <span class="asset-ic" style="background:var(--k-${k})">${ic(KIND_ICON[k])}</span>
        <span class="asset-main"><b>${esc(x.asset.name)}</b><small class="num">${assetSubtitle(x.asset, x)}</small></span>
        <span class="asset-val num"><b>${fmt(x.value)}</b>${!M.ASSET_KINDS[k].liquid && x.invested > 0 ? `<small class="${x.gain >= 0 ? "pos" : "neg"}">${fmtSigned(x.gain, 0)} · ${x.gain >= 0 ? "+" : "−"}${fmtPct(Math.abs(x.gainPct), 1)}</small>` : ""}</span>
      </button>`).join("")}</div></section>`).join("")}`;
}

function openAssetKind() {
  openSheet({
    title: "Añadir ahorro",
    body: `<p class="muted" style="margin-bottom:16px">¿Qué quieres registrar?</p><div class="kind-grid">${M.KIND_ORDER.map(k => `
      <button class="kind-btn" data-kind="${k}"><span class="asset-ic" style="background:var(--k-${k})">${ic(KIND_ICON[k])}</span><b>${M.ASSET_KINDS[k].label}</b></button>`).join("")}</div>`,
    mount: s => $$("[data-kind]", s).forEach(b => b.addEventListener("click", () => openAssetForm(b.dataset.kind))),
  });
}

const NAME_HINT = { cash: "Ej. Hucha de casa", bank: "Ej. Cuenta de ahorro", stock: "Ej. MSCI World o Apple", crypto: "Ej. Bitcoin", metal: "Ej. Lingote de 10 g", other: "Ej. Coche, reloj, cámara" };

function openAssetForm(kind, existing) {
  const k = M.ASSET_KINDS[kind];
  const a = existing;
  const edit = !!a;
  const purityOpts = (sel) => M.PURITIES.map(p => `<option value="${p.v}"${p.v === sel ? " selected" : ""}>${p.l}</option>`).join("");
  let body = `<form class="form" id="assetForm" novalidate>${textField("name", "Nombre", a?.name || "", { placeholder: NAME_HINT[kind], max: 50, auto: !edit })}`;
  if (kind === "bank") body += `<div class="row2">${textField("entity", "Banco", a?.entity || "", { placeholder: "Ej. ING", optional: true, max: 40 })}${textField("apr", "Interés anual (TAE %)", a?.apr ? String(a.apr).replace(".", ",") : "", { placeholder: "Ej. 2,5", optional: true, max: 6 })}</div>`;
  if (kind === "stock" || kind === "crypto") body += textField("ticker", "Símbolo", a?.ticker || "", { placeholder: kind === "crypto" ? "Ej. BTC" : "Ej. AAPL o IWDA", optional: true, max: 12 });
  if (kind === "metal") body += `<div class="row2"><label class="field"><span class="lbl">Metal</span><select class="in" name="metal">${M.METALS.map(m => `<option${(a?.metal || "Oro") === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
    <label class="field"><span class="lbl">Pureza</span><select class="in" name="purity">${purityOpts(a?.purity ?? 0.999)}</select></label></div>`;
  if (!edit) {
    if (k.unit) {
      body += `<div class="row2"><label class="field"><span class="lbl">${k.qty}</span><input class="in num" name="units" inputmode="decimal" autocomplete="off" placeholder="0"><small class="err" data-err="units"></small></label>
        ${moneyField("price", k.priceLabel + " hoy", "", { hint: kind === "metal" ? "Busca «precio oro gramo» del día." : "" })}</div>
        ${moneyField("paid", "Lo que pagaste en total", "", { optional: true, hint: "Si lo dejas vacío, usamos el valor de hoy." })}`;
    } else {
      body += moneyField("value", kind === "other" ? "Lo que vale hoy" : "Cantidad que tienes", "", { big: kind !== "other" });
      if (kind === "other") body += moneyField("paid", "Lo que pagaste", "", { optional: true });
    }
    body += `<fieldset class="field"><legend>¿Lo pagas ahora desde una de tus cuentas?</legend>${accountChips("account", "", { none: true, noneLabel: "No, ya lo tenía" })}
      <small class="hint">Si eliges una cuenta, también se descuenta de ella.</small></fieldset>${dateField(today())}`;
  }
  body += `<button type="submit" hidden></button></form>`;
  openSheet({
    title: edit ? `Editar ${a.name}` : k.label, body,
    foot: `${edit ? "" : `<button class="btn btn-ghost" id="back">${ic("left")}Atrás</button>`}<button class="btn btn-primary" id="assetSave">${edit ? "Guardar cambios" : "Añadir"}</button>`,
    mount: s => {
      const form = $("#assetForm", s);
      if (!edit) wireDate(form);
      $("#back", s)?.addEventListener("click", openAssetKind);
      const save = () => {
        const v = n => form.elements[n]?.value?.trim() ?? "";
        const errs = {};
        const name = v("name"); if (!name) errs.name = "Ponle un nombre para reconocerlo.";
        let apr = 0; if (kind === "bank" && v("apr")) { apr = Number(v("apr").replace(",", ".")); if (!(apr >= 0 && apr < 100)) errs.apr = "Escribe el interés como un número, por ejemplo 2,5."; }
        const meta = { name, ticker: v("ticker").toUpperCase(), entity: v("entity"), apr, metal: v("metal") || undefined, purity: form.elements.purity ? Number(form.elements.purity.value) : undefined };
        if (edit) {
          if (!setErrors(form, errs)) return;
          closeSheet();
          commit(d => { const x = d.assets.find(y => y.id === a.id); Object.assign(x, Object.fromEntries(Object.entries(meta).filter(([, val]) => val !== undefined))); }, "Cambios guardados");
          openAsset(a.id);
          return;
        }
        const date = v("date"); if (!U.isDate(date)) errs.date = "Elige una fecha válida.";
        const account = radio(form, "account");
        let ops = [];
        if (k.unit) {
          const units = U.parseQty(v("units")), price = U.parseMoney(v("price")), paidRaw = v("paid"), paid = U.parseMoney(paidRaw);
          if (!(units > 0)) errs.units = Number.isNaN(units) ? "Escribe la cantidad solo con números, por ejemplo 0,25." : "Escribe una cantidad mayor que 0.";
          if (!(price > 0)) errs.price = Number.isNaN(price) ? "Escribe el precio solo con números." : "Escribe el precio de hoy.";
          if (paidRaw && !(paid > 0)) errs.paid = "Escribe un importe válido o déjalo vacío.";
          if (!setErrors(form, errs)) return;
          const purity = kind === "metal" ? meta.purity : 1;
          const total = paidRaw ? paid : Math.round(units * purity * price);
          ops = [{ type: "buy", date, units, amount: total }, { type: "price", date, price }];
        } else {
          const value = U.parseMoney(v("value")), paidRaw = v("paid"), paid = U.parseMoney(paidRaw);
          if (!(value >= 0) || Number.isNaN(value) || v("value") === "") errs.value = "Escribe la cantidad solo con números.";
          if (paidRaw && !(paid > 0)) errs.paid = "Escribe un importe válido o déjalo vacío.";
          if (!setErrors(form, errs)) return;
          ops = [{ type: "buy", date, amount: paidRaw ? paid : value }];
          if (paidRaw && paid !== value) ops.push({ type: "value", date, value });
        }
        const id = U.uid();
        closeSheet();
        commit(d => {
          d.assets.push({ id, kind, ...Object.fromEntries(Object.entries(meta).filter(([, val]) => val !== undefined && val !== "")), ops: [], createdAt: new Date().toISOString() });
          ops.forEach((op, i) => M.addAssetOp(d, id, op, i === 0 ? account : ""));
        }, `${name} añadido a tus ahorros`);
      };
      $("#assetSave", s).addEventListener("click", save);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

const OP_LABEL = { buy: "Compra / aportación", sell: "Venta / retirada", price: "Precio actualizado", value: "Valor actualizado" };
function openAsset(id) {
  const a = D.assets.find(x => x.id === id); if (!a) { closeSheet(); return; }
  const k = M.ASSET_KINDS[a.kind], s = M.assetState(a);
  const ops = [...a.ops].sort((x, y) => y.date.localeCompare(x.date) || (y.seq || 0) - (x.seq || 0));
  const opText = o => {
    if (o.type === "price") return `${fmt(Math.round(o.price))} ${a.kind === "metal" ? "por gramo" : "por unidad"}`;
    if (o.type === "value") return fmt(o.value);
    return `${k.unit ? `${fmtNum(o.units)} ${a.kind === "metal" ? "g" : esc(a.ticker || "uds.")} · ` : ""}${fmt(o.amount)}${o.tx ? ` · ${esc(acctName(D.tx.find(t => t.id === o.tx)?.account))}` : ""}`;
  };
  const facts = [
    ["Valor actual", fmt(s.value)],
    ...(k.liquid ? [] : [["Has puesto", fmt(s.invested)], ["Ganancia", `<span class="${s.gain >= 0 ? "pos" : "neg"}">${fmtSigned(s.gain)}${s.invested ? ` (${s.gain >= 0 ? "+" : "−"}${fmtPct(Math.abs(s.gainPct), 1)})` : ""}</span>`]]),
    ...(k.unit ? [[k.qty, `${fmtNum(s.units)}${a.kind === "metal" ? " g" : ""}`], [k.priceLabel, s.price ? fmt(Math.round(s.price)) : "—"]] : []),
    ...(a.kind === "bank" && a.apr ? [["Interés anual", `${String(a.apr).replace(".", ",")} % TAE`], ["Intereses en un año", `≈ ${fmt0(s.value * a.apr / 100)}`]] : []),
  ];
  openSheet({
    title: a.name,
    body: `<div class="form">
      <div class="facts">${facts.map(([l, v]) => `<div><small>${l}</small><b class="num">${v}</b></div>`).join("")}</div>
      <div class="actions-row">
        <button class="btn" data-op="buy">${ic("plus")}${k.unit ? "Comprar" : "Añadir"}</button>
        <button class="btn" data-op="sell"${(k.unit ? s.units : s.value) > 0 ? "" : " disabled"}>${ic("up")}${k.unit ? "Vender" : "Retirar"}</button>
        <button class="btn" data-op="${k.unit ? "price" : "value"}">${ic("chart")}${k.unit ? "Actualizar precio" : "Actualizar valor"}</button>
      </div>
      <div><div class="sec-head" style="margin:8px 0 0"><h2 style="font-size:15px">Historial</h2></div>
      <ul class="ops">${ops.map(o => `<li><span>${OP_LABEL[o.type]}<small>${U.dayLabel(o.date)}${o.date.slice(0, 4) !== today().slice(0, 4) ? " " + o.date.slice(0, 4) : ""}</small></span><span class="num">${opText(o)}</span>
        <button class="btn btn-ghost btn-icon" data-delop="${esc(o.id)}" aria-label="Borrar esta operación"${a.ops.length === 1 ? " disabled" : ""}>${ic("trash")}</button></li>`).join("")}</ul></div>
    </div>`,
    foot: `<button class="btn btn-ghost btn-danger" id="assetDel">${ic("trash")}Eliminar</button><button class="btn" id="assetEdit">Editar</button>`,
    mount: el => {
      $$("[data-op]", el).forEach(b => b.addEventListener("click", () => openAssetOp(a.id, b.dataset.op)));
      $$("[data-delop]", el).forEach(b => b.addEventListener("click", () => {
        commit(d => M.removeAssetOp(d, a.id, b.dataset.delop), "Operación borrada");
        openAsset(a.id);
      }));
      $("#assetEdit", el).addEventListener("click", () => openAssetForm(a.kind, a));
      $("#assetDel", el).addEventListener("click", () => {
        closeSheet();
        const linked = new Set(a.ops.map(o => o.tx).filter(Boolean));
        commit(d => { d.assets = d.assets.filter(x => x.id !== a.id); d.tx = d.tx.filter(t => !linked.has(t.id)); }, `${a.name} eliminado`);
      });
    },
  });
}

function openAssetOp(id, type) {
  const a = D.assets.find(x => x.id === id), k = M.ASSET_KINDS[a.kind], s = M.assetState(a);
  const titles = { buy: k.unit ? "Comprar más" : "Añadir dinero", sell: k.unit ? "Vender" : "Retirar dinero", price: "Actualizar precio", value: "Actualizar valor" };
  let body = `<form class="form" id="opForm" novalidate><p class="muted">${esc(a.name)}</p>`;
  if (type === "buy" || type === "sell") {
    if (k.unit) body += `<div class="row2"><label class="field"><span class="lbl">${k.qty}</span><input class="in num" name="units" inputmode="decimal" autocomplete="off" placeholder="0" autofocus>${type === "sell" ? `<small class="hint">Tienes ${fmtNum(s.units)}.</small>` : ""}<small class="err" data-err="units"></small></label>
      ${moneyField("amount", type === "buy" ? "Total pagado" : "Total recibido")}</div>`;
    else body += moneyField("amount", type === "buy" ? "Cantidad que añades" : "Cantidad que retiras", "", { big: true, auto: true, hint: type === "sell" ? `Hay ${fmt(s.value)}.` : "" });
    body += `<fieldset class="field"><legend>${type === "buy" ? "¿Sale de una de tus cuentas?" : "¿Entra en una de tus cuentas?"}</legend>${accountChips("account", "", { none: true, noneLabel: "No" })}</fieldset>`;
  } else if (type === "price") {
    body += moneyField("price", k.priceLabel, s.price ? centsToInput(Math.round(s.price)) : "", { big: true, auto: true, hint: a.kind === "metal" ? "Precio del metal puro por gramo." : "" });
  } else {
    body += moneyField("value", "Valor actual", centsToInput(s.value), { big: true, auto: true, hint: a.kind === "bank" ? "Por ejemplo, después de cobrar intereses." : "" });
  }
  body += `${dateField(today())}<button type="submit" hidden></button></form>`;
  openSheet({
    title: titles[type], body,
    foot: `<button class="btn btn-ghost" id="opBack">${ic("left")}Atrás</button><button class="btn btn-primary" id="opSave">Guardar</button>`,
    mount: el => {
      const form = $("#opForm", el); wireDate(form);
      $("#opBack", el).addEventListener("click", () => openAsset(id));
      const save = () => {
        const v = n => form.elements[n]?.value ?? "";
        const op = { type, date: v("date") };
        if (type === "buy" || type === "sell") { op.amount = U.parseMoney(v("amount")); if (k.unit) op.units = U.parseQty(v("units")); }
        if (type === "price") op.price = U.parseMoney(v("price"));
        if (type === "value") { op.value = U.parseMoney(v("value")); if (v("value").trim() === "") op.value = NaN; }
        if (!setErrors(form, M.validateAssetOp(a, op))) return;
        const account = radio(form, "account");
        commit(d => M.addAssetOp(d, id, op, account), "Operación guardada");
        openAsset(id);
      };
      $("#opSave", el).addEventListener("click", save);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

/* ======================================================================
   View: Asesor
   ====================================================================== */
const LVL = { critical: ["Importante", "alert"], warn: ["Atención", "alert"], info: ["Consejo", "info"], good: ["Bien", "check"] };
function insightCard(x) {
  return `<article class="insight ${x.level}"><span class="badge">${ic(LVL[x.level][1])}</span><span class="lvl">${LVL[x.level][0]}</span><h3>${esc(x.title)}</h3><div><p>${esc(x.body)}</p>${x.action ? `<p class="do">${ic("arrow")}<span>${esc(x.action)}</span></p>` : ""}</div></article>`;
}
function viewAsesor() {
  const r = analyze(D, today());
  const m = r.metrics;
  const ringColor = r.score === null ? "var(--rule)" : r.score >= 60 ? "var(--good)" : r.score >= 40 ? "var(--warn)" : "var(--crit)";
  const metrics = [
    ["Tasa de ahorro", m.rate === null ? "—" : fmtPct(m.rate), m.refMonths ? `media de ${m.refMonths === 1 ? "1 mes" : m.refMonths + " meses"}` : "sin datos aún"],
    ["Colchón para imprevistos", m.monthsCovered === null ? "—" : `${m.monthsCovered.toLocaleString("es-ES", { maximumFractionDigits: 1 })} meses`, "lo recomendable: 3 a 6"],
    ["Gasto medio al mes", m.avgOut ? fmt0(m.avgOut) : "—", "sin traspasos ni inversiones"],
    ["Ingreso medio al mes", m.avgIn ? fmt0(m.avgIn) : "—", ""],
    ["Patrimonio", fmtBal(m.worth), `${fmt0(m.liquid)} líquido`],
    ...(r.projection ? [["En 12 meses, a este ritmo", fmtBal(r.projection.value), `${r.projection.monthlySaving >= 0 ? "ahorrando" : "perdiendo"} ${fmt0(Math.abs(r.projection.monthlySaving))} al mes`]] : []),
  ];
  return `<section class="section">
    <div class="sec-head"><h2 style="font:400 34px/1.1 var(--serif)">Tu asesor</h2><span class="sub">Analiza todo lo que registras, en tu dispositivo</span></div>
    ${r.score !== null ? `<div class="score">
      <div class="ring" style="--p:${r.score};--ring:${ringColor}" role="img" aria-label="Salud financiera ${r.score} de 100"><div><span><b class="num">${r.score}</b><small>${scoreWord(r.score)}</small></span></div></div>
      <div class="parts">${r.scoreParts.map(p => `<div class="part"><span>${p.label}</span><div class="track" aria-hidden="true"><i style="width:${p.pts / 25 * 100}%"></i></div><b class="num">${p.pts}/25</b></div>`).join("")}</div>
    </div>` : `<p class="muted">Con algo más de información te daré una puntuación de salud financiera.</p>`}
  </section>
  <section class="section"><div class="metrics">${metrics.map(([l, v, sub]) => `<div class="metric"><small>${l}</small><b class="num">${v}</b><span>${sub}</span></div>`).join("")}</div></section>
  <section class="section"><div class="sec-head"><h2>Qué veo en tus finanzas</h2></div><div class="insights">${r.insights.map(insightCard).join("")}</div></section>
  <section class="section"><p class="disclaimer">Este análisis es automático y orientativo. Se basa solo en lo que has registrado y no sustituye a un asesor financiero profesional ni es una recomendación para comprar o vender ningún producto.</p></section>`;
}

/* ======================================================================
   View: Perfil
   ====================================================================== */
function viewPerfil() {
  const bal = M.accountBalances(D);
  return `<section class="section">
    <div class="sec-head"><h2 style="font:400 34px/1.1 var(--serif)">${esc(session.name)}</h2><button class="btn" data-act="rename">Cambiar nombre</button></div>
    <div class="privacy">${ic("lock")}<span>Tus datos están cifrados con tu contraseña y solo existen en este dispositivo. La sesión se cierra sola tras 5 minutos fuera de la app.</span></div>
  </section>
  <section class="section"><div class="sec-head"><h2>Cuentas para el día a día</h2><button class="btn" data-act="acctNew">${ic("plus")}Añadir cuenta</button></div>
    <div class="settings">${D.accounts.map(a => `<div class="set-row"><div><b>${esc(a.name)}</b><small>${M.ACCOUNT_KINDS[a.kind]} · saldo <span class="num">${fmtBal(bal[a.id], 2)}</span></small></div>
      <div class="btns"><button class="btn" data-act="acctAdjust" data-id="${esc(a.id)}">Ajustar saldo</button><button class="btn btn-ghost" data-act="acctEdit" data-id="${esc(a.id)}">Editar</button></div></div>`).join("")}</div>
  </section>
  <section class="section"><div class="sec-head"><h2>Seguridad</h2></div><div class="settings">
    <div class="set-row"><div><b>Contraseña</b><small>Cámbiala cuando quieras. La antigua dejará de funcionar.</small></div><div class="btns"><button class="btn" data-act="password">Cambiar contraseña</button></div></div>
    <div class="set-row"><div><b>Cerrar sesión</b><small>Vuelve a la pantalla de perfiles.</small></div><div class="btns"><button class="btn" data-act="lock">${ic("lock")}Cerrar sesión</button></div></div>
  </div></section>
  <section class="section"><div class="sec-head"><h2>Copias y datos</h2></div><div class="settings">
    <div class="set-row"><div><b>Copia de seguridad cifrada</b><small>Guárdala en Archivos o iCloud. Sirve para recuperar tu perfil en otro dispositivo con tu contraseña.</small></div><div class="btns"><button class="btn btn-primary" data-act="backup">${ic("down")}Exportar copia</button></div></div>
    <div class="set-row"><div><b>Movimientos en CSV</b><small>Para abrir en Excel o Numbers. Este archivo no va cifrado.</small></div><div class="btns"><button class="btn" data-act="csv">Exportar CSV</button><button class="btn btn-ghost" data-act="importCsv">Importar CSV</button></div></div>
  </div></section>
  <section class="section"><div class="sec-head"><h2>Eliminar perfil</h2></div><div class="settings">
    <div class="set-row"><div><b>Borrar este perfil y todos sus datos</b><small>No se puede deshacer. Exporta antes una copia si la quieres conservar.</small></div><div class="btns"><button class="btn btn-danger" data-act="deleteProfile">${ic("trash")}Eliminar perfil</button></div></div>
  </div></section>
  <section class="section"><p class="disclaimer">Cuentas claras · versión 2.0 · Sin servidores, sin anuncios, sin rastreo.</p></section>`;
}

function openOnboarding() {
  const legacy = V.legacyData();
  openSheet({
    title: "¿Cuánto tienes ahora?",
    body: `<form class="form" id="obForm" novalidate>
      <p class="muted">Empieza con tus saldos de hoy. Podrás cambiarlos cuando quieras en Perfil.</p>
      ${moneyField("cash", `${ic("cash")} Efectivo en la cartera`, "", { auto: true })}
      ${moneyField("card", `${ic("card")} Dinero en tu tarjeta o cuenta`, "")}
      ${legacy ? `<label class="check"><input type="checkbox" name="legacy" checked><span>Traer los ${legacy.tx.filter(t => !t.demo).length} movimientos que apuntaste en la versión anterior de la app. Se guardarán en Tarjeta y se borrará la copia antigua sin cifrar.</span></label>` : ""}
      <button type="submit" hidden></button></form>`,
    foot: `<button class="btn btn-ghost" id="obSkip">Ahora no</button><button class="btn btn-primary" id="obSave">Empezar</button>`,
    onClose: () => { if (D && !D.settings.onboarded) { D.settings.onboarded = true; session.save(); } },
    mount: el => {
      const form = $("#obForm", el);
      const save = () => {
        const cash = U.parseMoney(form.elements.cash.value), card = U.parseMoney(form.elements.card.value);
        const errs = {};
        if (Number.isNaN(cash)) errs.cash = "Escribe la cantidad solo con números.";
        if (Number.isNaN(card)) errs.card = "Escribe la cantidad solo con números.";
        if (!setErrors(form, errs)) return;
        let n = 0;
        D.accounts.find(a => a.id === "cash") && (D.accounts.find(a => a.id === "cash").initial = cash || 0);
        D.accounts.find(a => a.id === "card") && (D.accounts.find(a => a.id === "card").initial = card || 0);
        if (legacy && form.elements.legacy?.checked) { n = M.importLegacy(D, legacy); V.clearLegacy(); }
        D.settings.onboarded = true;
        session.save(true); closeSheet(); renderView();
        toast(n ? `Listo. ${n} movimientos importados.` : "Listo. Ya puedes apuntar tus movimientos.");
      };
      $("#obSave", el).addEventListener("click", save);
      $("#obSkip", el).addEventListener("click", closeSheet);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

function openAccount(id) {
  const a = id ? D.accounts.find(x => x.id === id) : null;
  const used = a && D.tx.some(t => t.account === a.id || t.to === a.id);
  openSheet({
    title: a ? `Editar ${a.name}` : "Nueva cuenta",
    body: `<form class="form" id="acForm" novalidate>
      ${textField("name", "Nombre", a?.name || "", { placeholder: "Ej. Tarjeta del banco", max: 30, auto: true })}
      <fieldset class="field"><legend>Tipo</legend><div class="seg full">${Object.entries(M.ACCOUNT_KINDS).map(([k, l]) => `<label><input type="radio" name="kind" value="${k}"${(a?.kind || "card") === k ? " checked" : ""}><span>${l}</span></label>`).join("")}</div></fieldset>
      ${a ? "" : moneyField("initial", "Saldo actual", "")}
      <button type="submit" hidden></button></form>`,
    foot: `${a ? `<button class="btn btn-ghost btn-danger" id="acDel"${used || D.accounts.length < 2 ? " disabled" : ""}>${ic("trash")}Eliminar</button>` : ""}<button class="btn btn-primary" id="acSave">Guardar</button>`,
    mount: el => {
      const form = $("#acForm", el);
      if (a && used) $("#acDel", el).title = "Tiene movimientos: no se puede eliminar";
      const save = () => {
        const name = form.elements.name.value.trim(), kind = radio(form, "kind");
        const errs = {};
        if (!name) errs.name = "Ponle un nombre.";
        else if (D.accounts.some(x => x.id !== a?.id && x.name.toLowerCase() === name.toLowerCase())) errs.name = "Ya tienes una cuenta con ese nombre.";
        const initial = a ? 0 : U.parseMoney(form.elements.initial.value);
        if (Number.isNaN(initial)) errs.initial = "Escribe la cantidad solo con números.";
        if (!setErrors(form, errs)) return;
        closeSheet();
        commit(d => { if (a) Object.assign(d.accounts.find(x => x.id === a.id), { name, kind }); else d.accounts.push({ id: U.uid(), name, kind, initial }); }, a ? "Cuenta guardada" : `Cuenta «${name}» creada`);
      };
      $("#acSave", el).addEventListener("click", save);
      $("#acDel", el)?.addEventListener("click", () => { closeSheet(); commit(d => { d.accounts = d.accounts.filter(x => x.id !== a.id); }, `Cuenta «${a.name}» eliminada`); });
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

function openAdjust(id) {
  const a = D.accounts.find(x => x.id === id), cur = M.accountBalances(D)[id];
  openSheet({
    title: `Ajustar ${a.name}`,
    body: `<form class="form" id="adjForm" novalidate><p class="muted">Según lo apuntado tienes <b class="num">${fmtBal(cur, 2)}</b>. Si el saldo real es otro, escríbelo y crearé un ajuste que no cuenta como gasto ni ingreso.</p>
      ${moneyField("real", "Saldo real ahora", centsToInput(cur), { big: true, auto: true })}<button type="submit" hidden></button></form>`,
    foot: `<button class="btn btn-primary" id="adjSave">Ajustar</button>`,
    mount: el => {
      const form = $("#adjForm", el);
      const save = () => {
        const real = U.parseMoney(form.elements.real.value);
        if (Number.isNaN(real) || form.elements.real.value.trim() === "") return setErrors(form, { real: "Escribe el saldo solo con números." });
        const diff = real - cur;
        closeSheet();
        if (!diff) { toast("El saldo ya era ese."); return; }
        commit(d => d.tx.push({ id: U.uid(), seq: M.nextSeq(d), type: diff > 0 ? "in" : "out", amount: Math.abs(diff), account: id, cat: "Ajuste de saldo", concept: "Ajuste de saldo", date: today(), note: "", adj: true }), `Saldo de ${a.name}: ${fmtBal(real, 2)}`);
      };
      $("#adjSave", el).addEventListener("click", save);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

function openRename() {
  openSheet({
    title: "Cambiar nombre",
    body: `<form class="form" id="rnForm" novalidate>${textField("name", "Nombre del perfil", session.name, { max: 40, auto: true })}<button type="submit" hidden></button></form>`,
    foot: `<button class="btn btn-primary" id="rnSave">Guardar</button>`,
    mount: el => {
      const form = $("#rnForm", el);
      const save = () => { try { session.rename(form.elements.name.value); closeSheet(); renderShell(); toast("Nombre cambiado"); } catch (e) { setErrors(form, { name: e.message }); } };
      $("#rnSave", el).addEventListener("click", save);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

function openPassword() {
  const pw = (n, l, ac) => `<label class="field"><span class="lbl">${l}</span><input class="in" type="password" name="${n}" autocomplete="${ac}"><small class="err" data-err="${n}"></small></label>`;
  openSheet({
    title: "Cambiar contraseña",
    body: `<form class="form" id="pwForm" novalidate>${pw("current", "Contraseña actual", "current-password")}${pw("next", "Contraseña nueva", "new-password")}${pw("confirm", "Repite la nueva", "new-password")}<button type="submit" hidden></button></form>`,
    foot: `<button class="btn btn-primary" id="pwSave">Cambiar</button>`,
    mount: el => {
      const form = $("#pwForm", el), btn = $("#pwSave", el);
      const save = async () => {
        const c = form.elements.current.value, n = form.elements.next.value, k = form.elements.confirm.value;
        const errs = {};
        if (!c) errs.current = "Escribe tu contraseña actual.";
        if (n.length < 8) errs.next = "La contraseña nueva necesita al menos 8 caracteres.";
        else if (n !== k) errs.confirm = "Las dos contraseñas no coinciden.";
        if (!setErrors(form, errs)) return;
        busy(btn, true, "Cambiando…");
        try { await session.changePassword(c, n); closeSheet(); toast("Contraseña cambiada. Exporta una copia nueva."); }
        catch (e) { busy(btn, false, "Cambiar"); setErrors(form, e.code === "bad_password" ? { current: "La contraseña actual no es correcta." } : { next: e.message }); }
      };
      btn.addEventListener("click", save);
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
    },
  });
}

function openDeleteProfile() {
  openSheet({
    title: "Eliminar perfil",
    body: `<form class="form" id="delForm" novalidate><p class="muted">Se borrarán <b>todos</b> los movimientos, cuentas y ahorros de ${esc(session.name)} en este dispositivo. No se puede deshacer.</p>
      <label class="field"><span class="lbl">Escribe tu contraseña para confirmar</span><input class="in" type="password" name="password" autocomplete="current-password"><small class="err" data-err="password"></small></label><button type="submit" hidden></button></form>`,
    foot: `<button class="btn btn-ghost" data-sheet-close>Cancelar</button><button class="btn btn-primary" id="delGo" style="background:var(--crit);border-color:var(--crit);color:#fff">Eliminar para siempre</button>`,
    mount: el => {
      const form = $("#delForm", el), btn = $("#delGo", el);
      const go = async () => {
        if (!form.elements.password.value) return setErrors(form, { password: "Escribe tu contraseña." });
        busy(btn, true, "Eliminando…");
        try { const id = session.id; await V.deleteProfile(id, form.elements.password.value); session.close(); session = null; D = null; closeSheet(); history.replaceState(null, "", location.pathname); renderAuth(); toast("Perfil eliminado"); }
        catch (e) { busy(btn, false, "Eliminar para siempre"); setErrors(form, { password: e.code === "bad_password" ? "La contraseña no es correcta." : e.message }); }
      };
      btn.addEventListener("click", go);
      form.addEventListener("submit", e => { e.preventDefault(); go(); });
    },
  });
}

async function doBackup() {
  const text = await session.exportBackup();
  const name = `cuentas-claras-${session.name.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "perfil"}-${today()}.json`;
  if (await saveFile(name, text, "application/json")) toast("Copia cifrada lista. Guárdala en un sitio seguro.");
}

function buildCsv() {
  const head = ["fecha", "tipo", "cuenta", "hacia", "categoria", "concepto", "importe", "nota"];
  const rows = [...D.tx].sort((a, b) => a.date.localeCompare(b.date)).map(t => [
    t.date, t.type === "in" ? "ingreso" : t.type === "out" ? "gasto" : "traspaso", acctName(t.account), t.to ? acctName(t.to) : "", t.cat || "", t.concept || "",
    ((t.type === "out" ? -1 : 1) * t.amount / 100).toFixed(2).replace(".", ","), t.note || ""]);
  const cell = v => { let s = String(v); if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  return "﻿" + [head, ...rows].map(r => r.map(cell).join(";")).join("\n");
}
async function doCsv() {
  if (!D.tx.length) return toast("Aún no hay movimientos que exportar.");
  if (await saveFile(`movimientos-${today()}.csv`, buildCsv(), "text/csv")) toast("CSV exportado");
}

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n")[0].match(/;/g) || []).length >= (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
function openImportCsv() {
  openSheet({
    title: "Importar CSV",
    body: `<form class="form" id="csvForm" novalidate><p class="muted">Acepta el CSV que exporta esta app (también el de la versión anterior). Los movimientos repetidos se saltan.</p>
      <label class="field"><span class="lbl">Archivo CSV</span><input class="in" type="file" name="file" accept=".csv,text/csv" style="padding-top:10px"><small class="err" data-err="file"></small></label>
      <fieldset class="field"><legend>Si el archivo no indica cuenta, guardar en</legend>${accountChips("account", D.accounts[D.accounts.length > 1 ? 1 : 0].id)}</fieldset></form>`,
    foot: `<button class="btn btn-primary" id="csvGo">Importar</button>`,
    mount: el => {
      const form = $("#csvForm", el);
      $("#csvGo", el).addEventListener("click", async () => {
        const f = form.elements.file.files[0];
        if (!f) return setErrors(form, { file: "Elige un archivo." });
        const rows = parseCsv(await readFile(f));
        if (!rows.length) return setErrors(form, { file: "El archivo está vacío." });
        const header = rows[0].map(h => h.trim().toLowerCase());
        const hasHead = header.includes("fecha");
        const idx = n => header.indexOf(n);
        const get = (r, n, pos) => (hasHead ? (idx(n) >= 0 ? r[idx(n)] : "") : r[pos] || "").trim();
        const fallback = radio(form, "account");
        const seen = new Set(D.tx.map(t => [t.date, t.type, t.concept, t.amount].join("|")));
        const byName = Object.fromEntries(D.accounts.map(a => [a.name.toLowerCase(), a.id]));
        const add = []; let bad = 0;
        for (const r of hasHead ? rows.slice(1) : rows) {
          const date = get(r, "fecha", 0), tipo = get(r, "tipo", 1).toLowerCase(), amount = U.parseMoney(get(r, "importe", hasHead ? 6 : 4));
          const concept = get(r, "concepto", 3) || "Movimiento", cat = get(r, "categoria", 2), note = get(r, "nota", 5);
          if (!U.isDate(date) || !amount || Number.isNaN(amount)) { bad++; continue; }
          const type = tipo.startsWith("tras") ? "transfer" : tipo.startsWith("ing") || (!tipo.startsWith("gas") && amount > 0) ? "in" : "out";
          const account = byName[get(r, "cuenta", -1).toLowerCase()] || fallback;
          const to = type === "transfer" ? byName[get(r, "hacia", -1).toLowerCase()] : undefined;
          if (type === "transfer" && (!to || to === account)) { bad++; continue; }
          const t = { id: U.uid(), type, amount: Math.abs(amount), account, cat: type === "transfer" ? "" : ([...M.CATS[type]].includes(cat) ? cat : type === "in" ? "Otros ingresos" : "Otros gastos"), concept: concept.slice(0, 80), date, note: note.slice(0, 120) };
          if (to) t.to = to;
          const key = [t.date, t.type, t.concept, t.amount].join("|"); if (seen.has(key)) continue; seen.add(key);
          add.push(t);
        }
        if (!add.length) return setErrors(form, { file: bad ? "No he encontrado movimientos válidos en el archivo." : "Todos esos movimientos ya estaban." });
        closeSheet();
        commit(d => add.forEach(t => d.tx.push({ ...t, seq: M.nextSeq(d) })), `${add.length} ${add.length === 1 ? "movimiento importado" : "movimientos importados"}${bad ? ` · ${bad} ${bad === 1 ? "fila no válida" : "filas no válidas"}` : ""}`);
      });
    },
  });
}

/* ======================================================================
   Boot
   ====================================================================== */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (!window.crypto?.subtle) {
  root.innerHTML = `<div class="auth"><div class="auth-card"><h1>Abre la app desde su dirección segura</h1><p>El cifrado necesita una conexión https. Abre la app desde su enlace oficial.</p></div></div>`;
} else renderAuth();
