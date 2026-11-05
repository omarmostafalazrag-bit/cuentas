// Profiles and encrypted storage.
//
// Each profile's data is one JSON document, encrypted with AES-256-GCM under a key
// derived from the profile's password (PBKDF2-SHA256, 310 000 iterations, random salt).
// Nothing readable is ever written to storage and nothing leaves the device.
// A wrong password fails GCM authentication, so no password hash is stored at all.
// The derived key lives only in memory for the open session.

const INDEX_KEY = "cc2-profiles";
const DATA_PREFIX = "cc2-data-";
const ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export class VaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function readIndex() {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX_KEY) || "[]");
    return Array.isArray(v) ? v.filter(p => p && p.id && p.name && p.salt) : [];
  } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); }
  catch (e) { throw new VaultError("storage", "No hay espacio para guardar en este dispositivo."); }
}

export function storageAvailable() {
  try { const k = "cc2-probe"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
  catch { return false; }
}

/** Public list for the sign-in screen: ids and names only. */
export function listProfiles() {
  return readIndex().map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt }));
}

async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(key, box) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new VaultError("bad_password", "La contraseña no es correcta.");
  }
}

export function validateNewProfile(name, password, confirm) {
  const errors = {};
  const n = (name || "").trim();
  if (!n) errors.name = "Escribe un nombre para el perfil.";
  else if (n.length > 40) errors.name = "Usa 40 caracteres como máximo.";
  else if (readIndex().some(p => p.name.toLowerCase() === n.toLowerCase())) errors.name = "Ya hay un perfil con ese nombre en este dispositivo.";
  if (!password || password.length < 8) errors.password = "La contraseña necesita al menos 8 caracteres.";
  else if (confirm !== undefined && password !== confirm) errors.confirm = "Las dos contraseñas no coinciden.";
  return errors;
}

/** An open profile: holds the key in memory and saves encrypted snapshots. */
export class Session {
  constructor(meta, key, data) {
    this.meta = meta; this.key = key; this.data = data;
    this._chain = Promise.resolve(); this._timer = null; this.onError = null;
  }
  get id() { return this.meta.id; }
  get name() { return this.meta.name; }

  /** Debounced encrypted save; calls are serialized so a later snapshot always wins. */
  save(immediate = false) {
    clearTimeout(this._timer);
    const run = () => {
      this._chain = this._chain.then(async () => {
        const box = await seal(this.key, this.data);
        try { localStorage.setItem(DATA_PREFIX + this.meta.id, JSON.stringify(box)); }
        catch { throw new VaultError("storage", "No se pudo guardar: el almacenamiento del dispositivo está lleno."); }
      }).catch(e => { this.onError && this.onError(e); });
      return this._chain;
    };
    if (immediate) return run();
    this._timer = setTimeout(run, 250);
    return Promise.resolve();
  }
  flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; return this.save(true); } return this._chain; }

  async changePassword(current, next) {
    if (!next || next.length < 8) throw new VaultError("weak", "La contraseña nueva necesita al menos 8 caracteres.");
    await unlock(this.meta.id, current); // throws bad_password
    await this.flush();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(next, salt);
    const box = await seal(key, this.data);
    const list = readIndex();
    const p = list.find(x => x.id === this.meta.id);
    p.salt = b64(salt); p.iter = ITERATIONS;
    localStorage.setItem(DATA_PREFIX + p.id, JSON.stringify(box));
    writeIndex(list);
    this.key = key; this.meta = { ...p };
  }

  rename(name) {
    const n = name.trim();
    if (!n) throw new VaultError("name", "Escribe un nombre.");
    const list = readIndex();
    if (list.some(p => p.id !== this.meta.id && p.name.toLowerCase() === n.toLowerCase())) throw new VaultError("name", "Ya hay un perfil con ese nombre.");
    const p = list.find(x => x.id === this.meta.id); p.name = n; writeIndex(list); this.meta.name = n;
  }

  /** Encrypted, portable backup. Restoring it needs the same password. */
  async exportBackup() {
    await this.flush();
    const raw = localStorage.getItem(DATA_PREFIX + this.meta.id);
    return JSON.stringify({ app: "cuentas-claras", v: 2, name: this.meta.name, salt: this.meta.salt, iter: this.meta.iter || ITERATIONS, box: JSON.parse(raw), exportedAt: new Date().toISOString() });
  }

  close() { clearTimeout(this._timer); this.key = null; this.data = null; }
}

export async function createProfile(name, password, initialData) {
  const errs = validateNewProfile(name, password);
  if (Object.keys(errs).length) throw new VaultError("invalid", Object.values(errs)[0]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const meta = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim(), salt: b64(salt), iter: ITERATIONS, createdAt: new Date().toISOString() };
  const box = await seal(key, initialData);
  try { localStorage.setItem(DATA_PREFIX + meta.id, JSON.stringify(box)); }
  catch { throw new VaultError("storage", "No hay espacio para guardar en este dispositivo."); }
  writeIndex([...readIndex(), meta]);
  return new Session(meta, key, initialData);
}

export async function unlock(id, password) {
  const meta = readIndex().find(p => p.id === id);
  if (!meta) throw new VaultError("missing", "Ese perfil ya no existe en este dispositivo.");
  let box;
  try { box = JSON.parse(localStorage.getItem(DATA_PREFIX + id)); } catch { box = null; }
  if (!box || !box.iv) throw new VaultError("corrupt", "Los datos de este perfil no se pueden leer.");
  const key = await deriveKey(password, unb64(meta.salt), meta.iter || ITERATIONS);
  const data = await open(key, box);
  return new Session({ ...meta }, key, data);
}

export async function deleteProfile(id, password) {
  await unlock(id, password); // only the owner can delete
  localStorage.removeItem(DATA_PREFIX + id);
  writeIndex(readIndex().filter(p => p.id !== id));
}

/** Restores an encrypted backup as a new profile on this device. */
export async function importBackup(text, password, newName) {
  let b;
  try { b = JSON.parse(text); } catch { throw new VaultError("format", "Ese archivo no es una copia de Cuentas claras."); }
  if (!b || b.app !== "cuentas-claras" || !b.box || !b.salt) throw new VaultError("format", "Ese archivo no es una copia de Cuentas claras.");
  const key = await deriveKey(password, unb64(b.salt), b.iter || ITERATIONS);
  const data = await open(key, b.box);
  let name = (newName || b.name || "Perfil").trim();
  const names = new Set(readIndex().map(p => p.name.toLowerCase()));
  let i = 2; const base = name;
  while (names.has(name.toLowerCase())) name = `${base} (${i++})`;
  const meta = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, salt: b.salt, iter: b.iter || ITERATIONS, createdAt: new Date().toISOString() };
  localStorage.setItem(DATA_PREFIX + meta.id, JSON.stringify(b.box));
  writeIndex([...readIndex(), meta]);
  return new Session(meta, key, data);
}

/** Unencrypted data left by version 1 of the app, if any. */
export function legacyData() {
  try { const s = JSON.parse(localStorage.getItem("cuentas-claras-v1")); return s && Array.isArray(s.tx) && s.tx.length ? s : null; } catch { return null; }
}
export function clearLegacy() { try { localStorage.removeItem("cuentas-claras-v1"); } catch {} }
