// Live market prices from free public sources. Every price is returned in EUR cents per unit
// (metals: per gram of pure metal). Only symbols are sent to the providers; amounts and
// balances never leave the device.
//
//   Metals  → api.gold-api.com (USD per troy ounce, no key) + 24 h change from tokenised gold/silver on CoinGecko
//   Crypto  → api.coingecko.com (EUR, no key)
//   Stocks  → api.twelvedata.com (search without key; quotes and charts need the person's free key)
//   FX      → api.frankfurter.dev (ECB reference rates)

export const OZ = 31.1034768; // grams in a troy ounce

export const METAL_SYMBOL = { Oro: "XAU", Plata: "XAG", Platino: "XPT", Paladio: "XPD" };
export const METAL_NAME = { XAU: "Oro", XAG: "Plata", XPT: "Platino", XPD: "Paladio" };
const METAL_PROXY = { XAU: "pax-gold", XAG: "kinesis-silver" }; // tokens backed 1:1 by an ounce, used for change and charts

export class QuoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let fetchImpl = (...a) => fetch(...a);
/** Tests swap the network for a fake. */
export function _setFetch(fn) { fetchImpl = fn; }

async function getJSON(url, { timeout = 9000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try { r = await fetchImpl(url, { signal: ctl.signal, referrerPolicy: "no-referrer", credentials: "omit" }); }
  catch { throw new QuoteError("offline", "No hay conexión con el proveedor de precios."); }
  finally { clearTimeout(t); }
  if (r.status === 429) throw new QuoteError("rate", "Demasiadas consultas seguidas. Espera un minuto.");
  if (r.status === 401 || r.status === 403) throw new QuoteError("auth", "La clave de bolsa no es válida.");
  let j;
  try { j = await r.json(); } catch { throw new QuoteError("bad", "El proveedor de precios ha respondido algo inesperado."); }
  if (!r.ok) throw new QuoteError("bad", j?.message || "El proveedor de precios no ha respondido bien.");
  return j;
}

/* ---------------- currency ---------------- */
let fx = null; // { at, rates: { USD: 1.12, ... } } — units of currency per 1 EUR
export async function fxRates(force = false) {
  if (fx && !force && Date.now() - fx.at < 6 * 3600e3) return fx.rates;
  const j = await getJSON("https://api.frankfurter.dev/v1/latest?from=EUR");
  if (!j?.rates || typeof j.rates.USD !== "number") throw new QuoteError("bad", "No se pudo obtener el cambio de divisas.");
  fx = { at: Date.now(), rates: { ...j.rates, EUR: 1 } };
  return fx.rates;
}
/** Converts an amount in `currency` (major units) to EUR cents. Handles pence quotes (GBp/GBX). */
export function toEurCents(amount, currency, rates) {
  let cur = String(currency || "EUR"), v = Number(amount);
  if (!Number.isFinite(v)) return NaN;
  if (cur === "GBp" || cur === "GBX") { cur = "GBP"; v /= 100; }
  cur = cur.toUpperCase();
  const r = cur === "EUR" ? 1 : rates?.[cur];
  if (!r) return NaN;
  return (v / r) * 100;
}

/* ---------------- metals ---------------- */
export async function metalQuotes() {
  const [rates, ...spots] = await Promise.all([
    fxRates(),
    ...Object.keys(METAL_NAME).map(s => getJSON(`https://api.gold-api.com/price/${s}`).catch(() => null)),
  ]);
  let changes = {};
  try {
    const ids = Object.values(METAL_PROXY).join(",");
    const j = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    for (const [sym, id] of Object.entries(METAL_PROXY)) if (j?.[id]?.usd_24h_change != null) changes[sym] = j[id].usd_24h_change;
  } catch { changes = {}; }
  const out = {};
  Object.keys(METAL_NAME).forEach((s, i) => {
    const j = spots[i];
    if (!j || typeof j.price !== "number" || !(j.price > 0)) return;
    const ozEur = toEurCents(j.price, j.currency || "USD", rates);
    out[s] = { key: `metal:${s}`, price: ozEur / OZ, perOz: ozEur, change: changes[s] ?? null, at: j.updatedAt || new Date().toISOString(), name: METAL_NAME[s], symbol: s };
  });
  if (!Object.keys(out).length) throw new QuoteError("offline", "No se pudieron obtener los precios de los metales.");
  return out;
}

/* ---------------- crypto ---------------- */
export async function cryptoQuotes(ids) {
  if (!ids.length) return {};
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&ids=${encodeURIComponent(ids.join(","))}&sparkline=true&price_change_percentage=24h`);
  return parseCryptoMarkets(j);
}
export async function cryptoTop(n = 10) {
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&order=market_cap_desc&per_page=${n}&page=1&sparkline=true&price_change_percentage=24h`);
  return Object.values(parseCryptoMarkets(j));
}
export function parseCryptoMarkets(j) {
  const out = {};
  if (!Array.isArray(j)) return out;
  for (const c of j) {
    if (!c || typeof c.current_price !== "number") continue;
    out[c.id] = {
      key: `crypto:${c.id}`, id: c.id, name: c.name, symbol: String(c.symbol || "").toUpperCase(),
      price: c.current_price * 100, change: c.price_change_percentage_24h ?? null,
      high: c.high_24h != null ? c.high_24h * 100 : null, low: c.low_24h != null ? c.low_24h * 100 : null,
      cap: c.market_cap ?? null, rank: c.market_cap_rank ?? null,
      spark: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.filter((_, i, a) => i % 4 === 0 || i === a.length - 1) : null,
      at: c.last_updated || new Date().toISOString(),
    };
  }
  return out;
}
export async function searchCrypto(q) {
  const j = await getJSON(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
  return (j?.coins || []).slice(0, 8).map(c => ({ src: "crypto", id: c.id, name: c.name, symbol: String(c.symbol || "").toUpperCase(), sub: c.market_cap_rank ? `Cripto · nº ${c.market_cap_rank}` : "Cripto" }));
}

/* ---------------- stocks and ETFs ---------------- */
const curRank = c => ({ EUR: 0, USD: 1, GBP: 2, GBp: 2, CHF: 3 }[c] ?? 9);
const STOCK_TYPES = /common stock|etf|fund|reit|preferred|depositary/i;
export async function searchStocks(q) {
  const j = await getJSON(`https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=20`);
  const seen = new Set();
  return (j?.data || [])
    .filter(s => STOCK_TYPES.test(s.instrument_type || ""))
    .filter(s => { const k = s.symbol + s.mic_code; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => curRank(a.currency) - curRank(b.currency))
    .slice(0, 10)
    .map(s => ({ src: "stock", id: `${s.symbol}:${s.mic_code}`, symbol: s.symbol, mic: s.mic_code, name: s.instrument_name, currency: s.currency,
      sub: `${/etf/i.test(s.instrument_type) ? "ETF" : "Acción"} · ${s.exchange} · ${s.currency}` }));
}

export function parseStockQuote(j, rates) {
  if (!j || j.code || j.status === "error") {
    const msg = String(j?.message || "");
    if (/plan|upgrade|available starting/i.test(msg)) throw new QuoteError("plan", "Tu plan gratuito de Twelve Data no incluye este mercado.");
    if (/api ?key/i.test(msg)) throw new QuoteError("auth", "La clave de bolsa no es válida.");
    if (/credits|limit/i.test(msg)) throw new QuoteError("rate", "Has llegado al límite de consultas gratuitas por minuto. Espera un poco.");
    throw new QuoteError("bad", msg || "No hay precio para este valor.");
  }
  const close = Number(j.close), prev = Number(j.previous_close);
  const price = toEurCents(close, j.currency, rates);
  if (!Number.isFinite(price)) throw new QuoteError("bad", "No se pudo convertir el precio a euros.");
  return {
    key: `stock:${j.symbol}:${j.mic_code}`, symbol: j.symbol, mic: j.mic_code, name: j.name, exchange: j.exchange, currency: j.currency,
    price, native: close, change: Number.isFinite(Number(j.percent_change)) ? Number(j.percent_change) : (prev ? (close - prev) / prev * 100 : null),
    open: toEurCents(j.open, j.currency, rates), high: toEurCents(j.high, j.currency, rates), low: toEurCents(j.low, j.currency, rates),
    prev: toEurCents(prev, j.currency, rates),
    w52: j.fifty_two_week ? { low: toEurCents(j.fifty_two_week.low, j.currency, rates), high: toEurCents(j.fifty_two_week.high, j.currency, rates) } : null,
    open_now: !!j.is_market_open,
    at: j.last_quote_at ? new Date(j.last_quote_at * 1000).toISOString() : new Date().toISOString(),
  };
}
export async function stockQuote(id, key) {
  if (!key) throw new QuoteError("nokey", "Conecta tu clave gratuita de bolsa para ver este precio.");
  const [symbol, mic] = id.split(":");
  const [rates, j] = await Promise.all([fxRates(), getJSON(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}${mic ? `&mic_code=${encodeURIComponent(mic)}` : ""}&apikey=${encodeURIComponent(key)}`)]);
  return parseStockQuote(j, rates);
}
export async function testStockKey(key) {
  const j = await getJSON(`https://api.twelvedata.com/api_usage?apikey=${encodeURIComponent(key)}`);
  if (j?.code || j?.status === "error") throw new QuoteError("auth", "Esa clave no funciona. Cópiala de nuevo desde tu panel de Twelve Data.");
  return j;
}

/* ---------------- charts: [{t: ms, p: EUR cents}] ---------------- */
export const RANGES = { "1D": 1, "1S": 7, "1M": 30, "1A": 365 };
export async function chart(link, range, key) {
  const days = RANGES[range] || 1;
  if (link.src === "crypto" || (link.src === "metal" && METAL_PROXY[link.id])) {
    const id = link.src === "crypto" ? link.id : METAL_PROXY[link.id];
    const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${days}`);
    const scale = link.src === "metal" ? 100 / OZ : 100;
    return thin((j?.prices || []).filter(p => Array.isArray(p) && typeof p[1] === "number").map(([t, p]) => ({ t, p: p * scale })), 160);
  }
  if (link.src === "stock") {
    if (!key) throw new QuoteError("nokey", "Conecta tu clave gratuita de bolsa para ver el gráfico.");
    const [symbol, mic] = link.id.split(":");
    const iv = { "1D": ["5min", 80], "1S": ["1h", 50], "1M": ["1day", 23], "1A": ["1week", 53] }[range] || ["1day", 30];
    const [rates, j] = await Promise.all([fxRates(), getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}${mic ? `&mic_code=${encodeURIComponent(mic)}` : ""}&interval=${iv[0]}&outputsize=${iv[1]}&apikey=${encodeURIComponent(key)}`)]);
    if (j?.code || j?.status === "error") parseStockQuote(j, rates); // throws the right error
    const cur = j?.meta?.currency;
    return (j?.values || []).map(v => ({ t: Date.parse(v.datetime.replace(" ", "T")), p: toEurCents(v.close, cur, rates) })).filter(x => Number.isFinite(x.p) && Number.isFinite(x.t)).reverse();
  }
  throw new QuoteError("nochart", "No hay gráfico disponible para este valor.");
}
function thin(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]); out.push(arr[arr.length - 1]); return out; }

/** Stable key for a link: "metal:XAU", "crypto:bitcoin", "stock:AAPL:XNGS". */
export const linkKey = l => `${l.src}:${l.id}`;
