// The data model and every calculation on it. Pure functions only: no DOM, no storage.
// Money is always integer cents. Quantities (shares, coins, grams) are plain numbers.

import { ym, uid, sum, addMonths, isDate } from "./util.js?v=5";

export const SCHEMA = 2;

export const CATS = {
  out: ["Supermercado", "Restaurantes", "Vivienda", "Transporte", "Suscripciones", "Ocio", "Estudios", "Salud", "Ropa", "Regalos", "Hogar", "Otros gastos"],
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
  out.seq = Math.max(Number(d.seq) || 0, out.tx.length + out.assets.length);
  return out;
}

export const nextSeq = d => (d.seq = (d.seq || 0) + 1);

/* ---------------- movements and accounts ---------------- */

/** True when a movement counts as real income or spending (not a transfer, an investment or an adjustment). */
export const isStat = t => (t.type === "in" || t.type === "out") && !t.asset && !t.adj;

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

export const netWorth = (d, upto) => sum(Object.values(accountBalances(d, upto))) + savingsSummary(d, upto).total;

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
