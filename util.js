// Small shared helpers: money, dates, ids, escaping. No DOM state lives here.

export const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" });

/** Cents → "1.234,56 €". */
export const fmt = c => eur.format((c || 0) / 100);
/** Cents → always the exact amount, with cents ("1.234,56 €"). Kept as a name for older call sites. */
export const fmt0 = c => fmt(Math.round(c || 0));
/** Signed, with a real minus sign. */
export const fmtSigned = (c, digits = 2) => {
  const shown = Math.round(c); // the sign follows what is displayed, so no "−0,00 €"
  return (shown < 0 ? "−" : shown > 0 ? "+" : "") + fmt(Math.abs(shown));
};
/** Signed percentage from a ratio (0.092 → "+9,2 %"), without "−0,0 %". */
export const fmtPctSigned = (r, digits = 1) => {
  const shown = Math.round(r * 100 * 10 ** digits);
  return (shown < 0 ? "−" : shown > 0 ? "+" : "") + fmtPct(Math.abs(r), digits);
};
/** Cents without sign, with a minus when negative (for balances). */
export const fmtBal = c => (Math.round(c) < 0 ? "−" : "") + fmt(Math.abs(Math.round(c)));

/** Plain number with up to `max` decimals, Spanish style ("0,0125"). */
export const fmtNum = (n, max = 8) => (Number(n) || 0).toLocaleString("es-ES", { maximumFractionDigits: max });
export const fmtPct = (n, digits = 0) => `${(n * 100).toLocaleString("es-ES", { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`;

/**
 * Parses what a person types as money ("12,50", "1.234,5", "12.5", "€ 30") into cents.
 * Returns 0 for empty, NaN for garbage. Never throws.
 */
export function parseMoney(v) {
  let s = String(v ?? "").trim().replace(/[\s€]/g, "");
  if (!s) return 0;
  const neg = s.startsWith("-") || s.startsWith("−");
  s = s.replace(/^[-−+]/, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  else if (/^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(".", ""); // "1.500" → 1500 €
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return NaN;
  const n = Math.round(Number(s) * 100);
  return neg ? -n : n;
}

/** Parses a quantity (shares, coins, grams). Returns NaN for garbage, 0 for empty. */
export function parseQty(v) {
  let s = String(v ?? "").trim().replace(/\s/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return NaN;
  return Number(s);
}

export const pad = n => String(n).padStart(2, "0");
export const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = d => d.slice(0, 7);
export const todayStr = () => dstr(new Date());
export const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return dstr(new Date(y, m - 1, d + n)); };
export function addMonths(key, n) {
  let [y, m] = key.split("-").map(Number);
  m += n;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad(m)}`;
}
export const monthName = key => { const [y, m] = key.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
export const monthShort = key => MONTHS[Number(key.slice(5)) - 1].slice(0, 3);
export const daysInMonth = key => { const [y, m] = key.split("-").map(Number); return new Date(y, m, 0).getDate(); };
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00"));
export const dayLabel = s => { const [, m, d] = s.split("-"); return `${Number(d)} ${MONTHS[Number(m) - 1].slice(0, 3)}`; };
export const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Date.now().toString(36) + Array.from(b, x => x.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/** Escapes text for safe insertion into HTML (text and double-quoted attributes). */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const sum = arr => arr.reduce((a, b) => a + b, 0);
