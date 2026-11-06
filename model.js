// The data model and every calculation on it. Pure functions only: no DOM, no storage.
// Money is always integer cents. Quantities (shares, coins, grams) are plain numbers.

import { ym, uid, sum, addMonths, addDays, isDate, daysInMonth } from "./util.js?v=7";

export const SCHEMA = 2;

export const CATS = {
  out: ["Supermercado", "Restaurantes", "Vivienda", "Transporte", "Suscripciones", "Ocio", "Estudios", "Salud", "Ropa", "Regalos", "Donaciones", "Hogar", "Otros gastos"],
  in: ["Nómina", "Facturación", "Beca", "Ayuda familiar", "Ventas", "Intereses", "Otros ingresos"],
};

export const ACCOUNT_KINDS = { cash: "Efectivo", card: "Tarjeta / cuenta" };

/** Kinds of savings. `unit` kinds hold a quantity at a price; the rest hold a value. */
export const ASSET_KINDS = {
  cash:   { label: "Efectivo ahorrado", short: "Efectivo", unit: false, liquid: true },
  bank:   { label: "Cuenta bancaria o depósito", short: "Cuentas", unit: false, liquid: true },
  stock:  { label: "Acciones, ETF o fondos", short: "Acciones", unit: true, qty: "Participaciones", priceLabel: "Precio por participación" },
  crypto: { label: "Criptomonedas", short: "Cripto", unit: true, qty: "Cantidad", priceLabel: "Precio por unidad" },
  metal:  { label: "Oro, plata y metales", short: "Metales", unit: true, qty: "Gramos", priceLabel: "Precio por gramo puro" },
  other:  { label: "Otros bienes", short: "Otros", unit: false },
};
export const KIND_ORDER = ["cash", "bank", "metal", "stock", "crypto", "other"];

export const METALS = ["Oro", "Plata", "Platino", "Paladio"];
export const PURITIES = [
  { v: 0.9999, l: "Puro (999,9)" }, { v: 0.999, l: "999" }, { v: 0.916, l: "22 quilates (916)" },
  { v: 0.75, l: "18 quilates (750)" }, { v: 0.585, l: "14 quilates (585)" }, { v: 0.925, l: "Plata de ley (925)" },
];

export function emptyData() {
  return {
    v: SCHEMA, seq: 0,
    accounts: [
      { id: "cash", name: "Efectivo", kind: "cash", initial: 0 },
      { id: "card", name: "Tarjeta", kind: "card", initial: 0 },
    ],
    tx: [], assets: [], budgets: {},
    settings: { onboarded: false },
    market: { watch: [], tdKey: "" },
    debts: [], fixed: [],
    quotes: {},
  };
}

/** Brings data from any older shape up to the current schema without losing anything. */
export function migrate(d) {
  const base = emptyData();
  if (!d || typeof d !== "object") return base;
  const out = { ...base, ...d };
  out.v = SCHEMA;
  out.accounts = Array.isArray(d.accounts) && d.accounts.length ? d.accounts : base.accounts;
  out.tx = Array.isArray(d.tx) ? d.tx.filter(t => t && t.id && isDate(t.date) && Number.isFinite(t.amount)) : [];
  out.assets = Array.isArray(d.assets) ? d.assets.map(a => ({ ...a, ops: Array.isArray(a.ops) ? a.ops : [] })) : [];
  out.budgets = d.budgets && typeof d.budgets === "object" ? d.budgets : {};
  out.settings = { ...base.settings, ...(d.settings || {}) };
  out.market = { ...base.market, ...(d.market || {}) };
  if (!Array.isArray(out.market.watch)) out.market.watch = [];
  out.quotes = d.quotes && typeof d.quotes === "object" ? d.quotes : {};
  out.debts = Array.isArray(d.debts) ? d.debts.map(x => ({ ...x, ops: Array.isArray(x.ops) ? x.ops : [] })) : [];
  out.fixed = Array.isArray(d.fixed) ? d.fixed.filter(f => f && f.id && isDate(f.start) && f.amount > 0) : [];
  out.seq = Math.max(Number(d.seq) || 0, out.tx.length + out.assets.length);
  return out;
}

export const nextSeq = d => (d.seq = (d.seq || 0) + 1);

/* ---------------- movements and accounts ---------------- */

/** True when a movement counts as real income or spending (not a transfer, an investment or an adjustment). */
export const isStat = t => (t.type === "in" || t.type === "out") && !t.asset && !t.adj && !t.debt;

export function accountBalances(d, upto) {
  const bal = Object.fromEntries(d.accounts.map(a => [a.id, a.initial || 0]));
  for (const t of d.tx) {
    if (upto && t.date > upto) continue;
    if (t.type === "in" && t.account in bal) bal[t.account] += t.amount;
    else if (t.type === "out" && t.account in bal) bal[t.account] -= t.amount;
    else if (t.type === "transfer") {
      if (t.account in bal) bal[t.account] -= t.amount;
      if (t.to in bal) bal[t.to] += t.amount;
    }
  }
  return bal;
}
export const availableMoney = d => sum(Object.values(accountBalances(d)));

export const txInMonth = (d, key) => d.tx.filter(t => ym(t.date) === key);

export function monthTotals(d, key, uptoDay = 0) {
  let i = 0, o = 0, cashOut = 0, cardOut = 0;
  const kindOf = Object.fromEntries(d.accounts.map(a => [a.id, a.kind]));
  for (const t of d.tx) {
    if (ym(t.date) !== key || !isStat(t)) continue;
    if (uptoDay && Number(t.date.slice(8)) > uptoDay) continue;
    if (t.type === "in") i += t.amount;
    else { o += t.amount; if (kindOf[t.account] === "cash") cashOut += t.amount; else cardOut += t.amount; }
  }
  return { i, o, n: i - o, cashOut, cardOut };
}

export function categorySums(d, key, type = "out") {
  const s = {};
  for (const t of d.tx) if (ym(t.date) === key && isStat(t) && t.type === type) s[t.cat] = (s[t.cat] || 0) + t.amount;
  return s;
}

export function validateTx(d, t) {
  const e = {};
  if (!(t.amount > 0)) e.amount = Number.isNaN(t.amount) ? "Escribe el importe solo con números, por ejemplo 45,90." : "Escribe un importe mayor que 0.";
  if (t.type !== "transfer" && !String(t.concept || "").trim()) e.concept = "Pon un concepto para reconocer el movimiento luego.";
  if (!d.accounts.some(a => a.id === t.account)) e.account = "Elige de dónde sale o a dónde va el dinero.";
  if (t.type === "transfer") {
    if (!d.accounts.some(a => a.id === t.to)) e.to = "Elige la cuenta de destino.";
    else if (t.to === t.account) e.to = "El origen y el destino tienen que ser distintos.";
  }
  if (!isDate(t.date)) e.date = "Elige una fecha válida.";
  return e;
}

/* ---------------- savings ---------------- */

const opOrder = (a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0);

/**
 * Folds an asset's operations into its current state.
 * Unit kinds: units and average-cost invested; price from the latest trade or price update.
 * Value kinds: value moves with contributions and withdrawals; a valuation sets it outright.
 */
export function assetState(a, upto) {
  const unit = ASSET_KINDS[a.kind]?.unit;
  const purity = a.kind === "metal" ? (a.purity || 1) : 1;
  let units = 0, invested = 0, price = 0, value = 0;
  for (const op of [...a.ops].sort(opOrder)) {
    if (upto && op.date > upto) continue;
    if (unit) {
      if (op.type === "buy") {
        units += op.units || 0; invested += op.amount || 0;
        if (op.units > 0 && op.amount > 0) price = op.amount / (op.units * purity);
      } else if (op.type === "sell") {
        const u = Math.min(op.units || 0, units);
        const avg = units > 0 ? invested / units : 0;
        invested -= avg * u; units -= u;
        if (u > 0 && op.amount > 0) price = op.amount / (u * purity);
        if (units < 1e-12) { units = 0; invested = 0; }
      } else if (op.type === "price") price = op.price || 0;
    } else {
      if (op.type === "buy") { value += op.amount || 0; invested += op.amount || 0; }
      else if (op.type === "sell") { const w = Math.min(op.amount || 0, value); value -= w; invested = Math.max(0, invested - w); }
      else if (op.type === "value") value = op.value || 0;
    }
  }
  if (unit && a.live && a.live.price > 0 && !upto) {
    const lastManual = a.ops.filter(o => o.type === "price" || o.type === "buy" || o.type === "sell").map(o => o.date).sort().pop() || "";
    if (String(a.live.at || "").slice(0, 10) >= lastManual) price = a.live.price;
  }
  if (unit) value = units * purity * price;
  value = Math.round(value); invested = Math.round(invested);
  return { units, invested, price, value, gain: value - invested, gainPct: invested > 0 ? (value - invested) / invested : 0 };
}

export function savingsSummary(d, upto) {
  const byKind = Object.fromEntries(KIND_ORDER.map(k => [k, 0]));
  let total = 0, invested = 0, liquidSavings = 0;
  const items = d.assets.map(a => {
    const s = assetState(a, upto);
    byKind[a.kind] = (byKind[a.kind] || 0) + s.value;
    total += s.value; invested += s.invested;
    if (ASSET_KINDS[a.kind]?.liquid) liquidSavings += s.value;
    return { asset: a, ...s };
  });
  return { total, invested, gain: total - invested, byKind, items, liquidSavings };
}

export const netWorth = (d, upto) => { const db = debtsSummary(d); return sum(Object.values(accountBalances(d, upto))) + savingsSummary(d, upto).total + db.owed - db.owe; };

export function validateAssetOp(a, op) {
  const e = {};
  const unit = ASSET_KINDS[a.kind].unit;
  if (!isDate(op.date)) e.date = "Elige una fecha válida.";
  if (op.type === "buy" || op.type === "sell") {
    if (unit) {
      if (!(op.units > 0)) e.units = Number.isNaN(op.units) ? "Escribe la cantidad solo con números, por ejemplo 0,25." : "Escribe una cantidad mayor que 0.";
      else if (op.type === "sell" && op.units > assetState(a).units + 1e-9) e.units = "No puedes vender más de lo que tienes.";
    }
    if (!(op.amount > 0) && !(unit && op.type === "buy" && op.amount === 0)) e.amount = Number.isNaN(op.amount) ? "Escribe el importe solo con números." : "Escribe un importe mayor que 0.";
    if (!unit && op.type === "sell" && op.amount > assetState(a).value) e.amount = "No puedes retirar más de lo que hay.";
  }
  if (op.type === "price" && !(op.price > 0)) e.price = "Escribe un precio mayor que 0.";
  if (op.type === "value" && !(op.value >= 0) ) e.value = "Escribe un valor válido.";
  return e;
}

/**
 * Records an operation on an asset. When `account` is given, the money also moves in that
 * account (paid from cash or card, or received into it) through a linked movement.
 */
export function addAssetOp(d, assetId, op, account) {
  const a = d.assets.find(x => x.id === assetId);
  const full = { id: uid(), seq: nextSeq(d), note: "", ...op };
  if (account && (op.type === "buy" || op.type === "sell") && op.amount > 0) {
    const t = {
      id: uid(), seq: nextSeq(d), type: op.type === "buy" ? "out" : "in", amount: op.amount, account,
      cat: op.type === "buy" ? "Ahorro e inversión" : "Venta de ahorro", concept: `${op.type === "buy" ? "A" : "De"} ${a.name}`,
      date: op.date, note: "", asset: assetId,
    };
    d.tx.push(t); full.tx = t.id;
  }
  a.ops.push(full);
  return full;
}

export function removeAssetOp(d, assetId, opId) {
  const a = d.assets.find(x => x.id === assetId);
  const op = a.ops.find(o => o.id === opId);
  a.ops = a.ops.filter(o => o.id !== opId);
  if (op?.tx) d.tx = d.tx.filter(t => t.id !== op.tx);
  return op;
}

/** Asset key for live prices, or "" when the asset is not linked to a market. */
export function assetLinkKey(a) {
  if (a.kind === "metal") { const s = { Oro: "XAU", Plata: "XAG", Platino: "XPT", Paladio: "XPD" }[a.metal || "Oro"]; return s ? `metal:${s}` : ""; }
  return a.link ? `${a.link.src}:${a.link.id}` : "";
}

/** Writes fresh quotes into the cache and into every linked asset. Returns how many assets changed. */
export function applyQuotes(d, quotes) {
  let n = 0;
  for (const q of Object.values(quotes)) {
    if (!q || !q.key || !(q.price > 0)) continue;
    d.quotes[q.key] = { price: q.price, change: q.change ?? null, at: q.at, name: q.name, symbol: q.symbol };
  }
  for (const a of d.assets) {
    const k = assetLinkKey(a); const q = k && d.quotes[k];
    if (!q) continue;
    if (!a.live || a.live.price !== q.price || a.live.at !== q.at) { a.live = { price: q.price, change: q.change, at: q.at }; n++; }
  }
  return n;
}

/* ---------------- history for charts ---------------- */

export function monthSeries(d, endKey, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const k = addMonths(endKey, -i); out.push({ k, ...monthTotals(d, k) }); }
  return out;
}

/* ---------------- version 1 import ---------------- */

export function importLegacy(d, legacy) {
  let n = 0;
  for (const t of legacy.tx || []) {
    if (t.demo || !isDate(t.date) || !(t.amount > 0)) continue;
    const type = t.type === "in" ? "in" : "out";
    const cats = CATS[type];
    d.tx.push({ id: uid(), seq: nextSeq(d), type, amount: Math.round(t.amount), account: "card", cat: cats.includes(t.cat) ? t.cat : (type === "in" ? "Otros ingresos" : "Otros gastos"), concept: String(t.concept || "Movimiento").slice(0, 80), date: t.date, note: String(t.note || "").slice(0, 120) });
    n++;
  }
  for (const [k, v] of Object.entries(legacy.budgets || {})) if (CATS.out.includes(k) && v > 0) d.budgets[k] = v;
  return n;
}

/* ---------------- debts ---------------- */

export const DEBT_KINDS = { person: "Persona", bank: "Banco o préstamo", card: "Tarjeta de crédito", other: "Otro" };

/** Folds a debt's operations: start and add increase it, pay reduces it (never below 0). */
export function debtState(debt, upto) {
  let total = 0, paid = 0;
  for (const op of [...debt.ops].sort(opOrder)) {
    if (upto && op.date > upto) continue;
    if (op.type === "start" || op.type === "add") total += op.amount || 0;
    else if (op.type === "pay") paid += op.amount || 0;
  }
  const remaining = Math.max(0, total - paid);
  return { total, paid: Math.min(paid, total), remaining, progress: total > 0 ? Math.min(1, paid / total) : 0, done: total > 0 && remaining === 0 };
}

export function debtsSummary(d) {
  let owe = 0, owed = 0, monthly = 0;
  const items = (d.debts || []).map(x => { const s = debtState(x); if (x.dir === "owe") { owe += s.remaining; if (!s.done) monthly += x.monthly || 0; } else owed += s.remaining; return { debt: x, ...s }; });
  return { owe, owed, monthly, items };
}

export function validateDebt(x) {
  const e = {};
  if (!String(x.who || "").trim()) e.who = x.dir === "owe" ? "Escribe a quién le debes." : "Escribe quién te debe.";
  if (!(x.amount > 0)) e.amount = Number.isNaN(x.amount) ? "Escribe el importe solo con números." : "Escribe un importe mayor que 0.";
  if (!isDate(x.date)) e.date = "Elige una fecha válida.";
  if (x.due && !isDate(x.due)) e.due = "Elige una fecha válida o déjala vacía.";
  if (x.apr != null && !(x.apr >= 0 && x.apr < 100)) e.apr = "Escribe el interés como un número, por ejemplo 7,5.";
  if (x.monthly != null && Number.isNaN(x.monthly)) e.monthly = "Escribe la cuota solo con números.";
  return e;
}

/**
 * Records a debt operation. With an account, the money also moves there through a linked
 * movement that never counts as income or spending (borrowing is not income; repaying is not spending).
 */
export function addDebtOp(d, debtId, op, account) {
  const x = d.debts.find(y => y.id === debtId);
  const full = { id: uid(), seq: nextSeq(d), note: "", ...op };
  if (account && op.amount > 0) {
    // owe: money in when it starts or grows, out when you pay. owed: the reverse.
    const moneyIn = (x.dir === "owe") === (op.type !== "pay");
    const verb = x.dir === "owe" ? (op.type === "pay" ? "Pago a" : "Préstamo de") : (op.type === "pay" ? "Cobro de" : "Préstamo a");
    const t = { id: uid(), seq: nextSeq(d), type: moneyIn ? "in" : "out", amount: op.amount, account, cat: "Deudas", concept: `${verb} ${x.who}`, date: op.date, note: "", debt: debtId };
    d.tx.push(t); full.tx = t.id;
  }
  x.ops.push(full);
  return full;
}
export function removeDebtOp(d, debtId, opId) {
  const x = d.debts.find(y => y.id === debtId);
  const op = x.ops.find(o => o.id === opId);
  x.ops = x.ops.filter(o => o.id !== opId);
  if (op?.tx) d.tx = d.tx.filter(t => t.id !== op.tx);
  return op;
}
export function removeDebt(d, debtId) {
  const x = d.debts.find(y => y.id === debtId); if (!x) return;
  const linked = new Set(x.ops.map(o => o.tx).filter(Boolean));
  d.debts = d.debts.filter(y => y.id !== debtId);
  d.tx = d.tx.filter(t => !linked.has(t.id));
  for (const f of d.fixed) if (f.debt === debtId) delete f.debt;
}

/* ---------------- fixed (recurring) expenses and income ---------------- */

export const FREQS = { monthly: "Cada mes", quarterly: "Cada 3 meses", yearly: "Cada año", weekly: "Cada semana" };
const PER_MONTH = { monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, weekly: 52 / 12 };
export const fixedMonthly = f => Math.round(f.amount * (PER_MONTH[f.freq] ?? 1));

/** Charge dates of a fixed item in (fromExclusive, toInclusive], oldest first, at most `cap`. */
export function occurrences(f, fromExclusive, toInclusive, cap = 60) {
  const out = [];
  if (!isDate(f.start) || toInclusive < f.start) return out;
  const [sy, sm, sd] = f.start.split("-").map(Number);
  const push = s => { if (s > fromExclusive && s <= toInclusive && s >= f.start && (!f.end || s <= f.end)) out.push(s); };
  if (f.freq === "weekly") {
    let cur = f.start, guard = 0;
    if (fromExclusive > f.start) { const days = Math.floor((Date.parse(fromExclusive) - Date.parse(f.start)) / 864e5); cur = addDays(f.start, Math.max(0, Math.floor(days / 7) * 7)); }
    while (cur <= toInclusive && out.length < cap && guard++ < 1000) { push(cur); cur = addDays(cur, 7); }
    return out;
  }
  const step = f.freq === "yearly" ? 12 : f.freq === "quarterly" ? 3 : 1;
  let key = `${sy}-${String(sm).padStart(2, "0")}`, guard = 0;
  if (fromExclusive > f.start) { // jump close to the window instead of walking from the start
    const [fy, fm] = fromExclusive.split("-").map(Number);
    const diff = (fy - sy) * 12 + (fm - sm);
    key = addMonths(key, Math.max(0, Math.floor(diff / step) * step - step));
  }
  while (out.length < cap && guard++ < 2000) {
    const day = Math.min(sd, daysInMonth(key));
    const s = `${key}-${String(day).padStart(2, "0")}`;
    if (s > toInclusive) break;
    push(s);
    key = addMonths(key, step);
  }
  return out;
}
/** Next charge on or after `today` (today counts only if it has not been logged yet). */
export function nextCharge(f, today) {
  const from = f.posted && f.posted >= today ? today : addDays(today, -1);
  return occurrences(f, from, addDays(today, 800), 1)[0] || null;
}

export function validateFixed(d, f) {
  const e = {};
  if (!String(f.name || "").trim()) e.name = "Ponle un nombre, por ejemplo «Netflix».";
  if (!(f.amount > 0)) e.amount = Number.isNaN(f.amount) ? "Escribe el importe solo con números." : "Escribe un importe mayor que 0.";
  if (!isDate(f.start)) e.start = "Elige la fecha del primer cobro.";
  if (!FREQS[f.freq]) e.freq = "Elige cada cuánto se paga.";
  if (!d.accounts.some(a => a.id === f.account)) e.account = "Elige con qué cuenta se paga.";
  return e;
}

/**
 * Logs every charge that has come due since the last run (only items with auto on).
 * Idempotent: running it twice on the same day creates nothing new.
 */
export function postFixed(d, today) {
  const created = [];
  for (const f of d.fixed) {
    if (!f.auto || f.paused) continue;
    const since = f.posted || addDays(f.start, -1);
    for (const date of occurrences(f, since, today, 24)) {
      if (f.debt && d.debts.some(x => x.id === f.debt)) {
        const op = addDebtOp(d, f.debt, { type: "pay", date, amount: f.amount, note: f.name }, f.account);
        const t = d.tx.find(x => x.id === op.tx); if (t) { t.fixed = f.id; t.concept = f.name; created.push(t); }
      } else {
        const t = { id: uid(), seq: nextSeq(d), type: f.type === "in" ? "in" : "out", amount: f.amount, account: f.account, cat: f.cat || (f.type === "in" ? "Otros ingresos" : "Suscripciones"), concept: f.name, date, note: "", fixed: f.id };
        d.tx.push(t); created.push(t);
      }
    }
    if (today > since) f.posted = today;
  }
  return created;
}

export function fixedSummary(d, today) {
  const active = d.fixed.filter(f => !f.paused);
  const out = active.filter(f => f.type !== "in"), inc = active.filter(f => f.type === "in");
  const monthKey = ym(today);
  const first = `${monthKey}-01`, last = `${monthKey}-${String(daysInMonth(monthKey)).padStart(2, "0")}`;
  let dueThisMonth = 0, paidThisMonth = 0;
  for (const f of out) for (const s of occurrences(f, addDays(first, -1), last)) { dueThisMonth += f.amount; if (s <= today) paidThisMonth += f.amount; }
  return { monthlyOut: sum(out.map(fixedMonthly)), monthlyIn: sum(inc.map(fixedMonthly)), dueThisMonth, paidThisMonth, leftThisMonth: dueThisMonth - paidThisMonth };
}
