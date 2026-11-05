// The in-app advisor: a deterministic analysis of everything the person has recorded.
// It runs entirely on the device. It gives general financial-health guidance, never
// buy/sell recommendations for specific products.

import { ym, addMonths, daysInMonth, sum, fmt0, fmtPct, MONTHS } from "./util.js?v=5";
import { isStat, monthTotals, categorySums, accountBalances, savingsSummary, ASSET_KINDS } from "./model.js?v=5";

const LEVEL = { critical: 0, warn: 1, info: 2, good: 3 };

/** Months (YYYY-MM) that have at least one real movement, oldest first. */
function activeMonths(d) {
  return [...new Set(d.tx.filter(isStat).map(t => ym(t.date)))].sort();
}

/**
 * @returns {{ score:number|null, scoreParts:object[], metrics:object, insights:object[], enoughData:boolean }}
 */
export function analyze(d, today) {
  const cur = ym(today);
  const day = Number(today.slice(8));
  const dim = daysInMonth(cur);
  const months = activeMonths(d);
  const full = [1, 2, 3].map(i => addMonths(cur, -i)).filter(k => months.includes(k)); // up to 3 complete months with data
  const ref = full.length ? full : (months.includes(cur) ? [cur] : []);
  const refTotals = ref.map(k => monthTotals(d, k));
  const avgIn = ref.length ? sum(refTotals.map(t => t.i)) / ref.length : 0;
  const avgOut = ref.length ? sum(refTotals.map(t => t.o)) / ref.length : 0;
  const now = monthTotals(d, cur);

  const bal = accountBalances(d);
  const available = sum(Object.values(bal));
  const sav = savingsSummary(d);
  const liquid = available + sav.liquidSavings;
  const worth = available + sav.total;
  const invested = sav.total - sav.liquidSavings;

  const insights = [];
  const add = (level, title, body, action) => insights.push({ level, title, body, action });

  const enoughData = months.length > 0;
  if (!enoughData) {
    add("info", "Empieza a registrar tus movimientos",
      "Cuando apuntes tus ingresos y gastos durante unas semanas podré decirte cuánto ahorras, en qué se va tu dinero y cómo de protegido estás ante un imprevisto.",
      "Apunta cada gasto el mismo día, aunque sea pequeño. Un mes completo ya da un buen análisis.");
  }

  // 1. Savings rate
  const rateBase = full.length ? { i: avgIn, o: avgOut } : now;
  const rate = rateBase.i > 0 ? (rateBase.i - rateBase.o) / rateBase.i : null;
  if (rate !== null) {
    const span = full.length ? `de media en los últimos ${full.length === 1 ? "mes" : full.length + " meses"}` : "este mes";
    if (rate < 0) add("critical", "Gastas más de lo que ingresas",
      `${span.charAt(0).toUpperCase() + span.slice(1)} gastas ${fmt0(rateBase.o - rateBase.i)} más de lo que entra. Así, tus ahorros bajan cada mes.`,
      "Revisa las dos categorías en las que más gastas y fija un presupuesto para cada una en Movimientos.");
    else if (rate < 0.1) add("warn", "Tu margen de ahorro es pequeño",
      `Ahorras el ${fmtPct(rate)} de lo que ingresas ${span}. Una referencia habitual es apartar entre el 10 % y el 20 %.`,
      `Apartar ${fmt0(Math.max(0, rateBase.i * 0.1 - (rateBase.i - rateBase.o)))} más al mes te llevaría al 10 %.`);
    else if (rate < 0.2) add("info", "Ahorras a buen ritmo",
      `Guardas el ${fmtPct(rate)} de lo que ingresas ${span}.`,
      "Si quieres subir al 20 %, prueba a mover el dinero a ahorros justo al cobrar, antes de gastar.");
    else add("good", "Excelente capacidad de ahorro",
      `Guardas el ${fmtPct(rate)} de lo que ingresas ${span}. Estás por encima del 20 % que suele recomendarse.`, null);
  }

  // 2. Emergency fund
  const monthsCovered = avgOut > 0 ? liquid / avgOut : null;
  if (monthsCovered !== null) {
    const m = monthsCovered.toLocaleString("es-ES", { maximumFractionDigits: 1 });
    if (monthsCovered < 1) add("critical", "No tienes colchón para imprevistos",
      `Tu dinero disponible y tus ahorros líquidos (${fmt0(liquid)}) cubren menos de un mes de tus gastos habituales (${fmt0(avgOut)} al mes).`,
      "Antes de invertir, intenta reunir al menos un mes de gastos en efectivo o en una cuenta.");
    else if (monthsCovered < 3) add("warn", "Tu fondo de emergencia es corto",
      `Con ${fmt0(liquid)} líquidos cubrirías unos ${m} meses de gastos. Lo recomendable son entre 3 y 6 meses.`,
      `Te faltan unos ${fmt0(avgOut * 3 - liquid)} para llegar a 3 meses.`);
    else if (monthsCovered <= 6) add("good", "Tienes un buen fondo de emergencia",
      `Tu liquidez cubre unos ${m} meses de gastos, dentro de lo recomendable.`, null);
    else add("info", "Tienes mucha liquidez",
      `Tu liquidez cubre unos ${m} meses de gastos. Por encima de 6 meses, la inflación va restando valor a ese dinero parado.`,
      "Infórmate sobre opciones para el dinero que no vayas a necesitar a corto plazo, como cuentas remuneradas o depósitos.");
  }

  // 3. Categories growing vs. the reference months (only complete months as reference)
  if (full.length) {
    const avgCat = {};
    for (const k of full) for (const [c, v] of Object.entries(categorySums(d, k))) avgCat[c] = (avgCat[c] || 0) + v / full.length;
    const curCat = categorySums(d, cur);
    const pace = dim / Math.max(1, day);
    const rising = Object.entries(curCat)
      .map(([c, v]) => ({ c, v, proj: v * pace, avg: avgCat[c] || 0 }))
      .filter(x => x.avg > 0 && x.proj > x.avg * 1.3 && x.proj - x.avg > 3000 && day >= 7)
      .sort((a, b) => (b.proj - b.avg) - (a.proj - a.avg)).slice(0, 2);
    for (const x of rising) add("warn", `${x.c}: vas por encima de lo habitual`,
      `Llevas ${fmt0(x.v)} este mes. A este ritmo acabarías en unos ${fmt0(x.proj)}, frente a ${fmt0(x.avg)} de media.`,
      "Si no es un gasto puntual, ponle un presupuesto a esta categoría.");
  }

  // 4. Budgets
  const curCat = categorySums(d, cur);
  for (const [c, b] of Object.entries(d.budgets || {})) {
    if (!(b > 0)) continue;
    const s = curCat[c] || 0;
    if (s > b) add("warn", `Has superado el presupuesto de ${c}`,
      `Llevas ${fmt0(s)} de ${fmt0(b)} (${fmt0(s - b)} de más).`, null);
    else if (day >= 5 && day < dim && s / day * dim > b * 1.1) add("info", `${c} va camino de superar su presupuesto`,
      `Llevas ${fmt0(s)} de ${fmt0(b)} y ${dim - day === 1 ? "queda 1 día" : `quedan ${dim - day} días`} de mes.`,
      `Para no pasarte, intenta no gastar más de ${fmt0(Math.max(0, (b - s) / (dim - day)))} al día en ${c.toLowerCase()}.`);
  }

  // 5. Small everyday spending ("gastos hormiga") in the last 30 days
  const from = addDays30(today);
  const small = d.tx.filter(t => isStat(t) && t.type === "out" && t.amount < 600 && t.date > from && t.date <= today);
  const smallSum = sum(small.map(t => t.amount));
  if (small.length >= 12 && smallSum >= 4000) add("info", "Los gastos pequeños suman",
    `En los últimos 30 días has hecho ${small.length} gastos de menos de 6 € que suman ${fmt0(smallSum)}.`,
    "Cafés, snacks o envíos: no hace falta eliminarlos, pero ponerles un límite semanal ayuda mucho.");

  // 6. Recurring payments (same concept in at least 3 of the last 4 months)
  const last4 = [0, 1, 2, 3].map(i => addMonths(cur, -i));
  const seen = {};
  for (const t of d.tx) if (isStat(t) && t.type === "out" && last4.includes(ym(t.date))) {
    const k = t.concept.trim().toLowerCase(); (seen[k] ||= { name: t.concept.trim(), months: new Set(), total: 0 });
    seen[k].months.add(ym(t.date)); seen[k].total += t.amount;
  }
  const recurring = Object.values(seen).filter(x => x.months.size >= 3).map(x => ({ name: x.name, monthly: Math.round(x.total / x.months.size) })).sort((a, b) => b.monthly - a.monthly);
  if (recurring.length) {
    const tot = sum(recurring.map(r => r.monthly));
    add("info", "Tus pagos fijos",
      `Hay ${recurring.length === 1 ? "un gasto que se repite" : `${recurring.length} gastos que se repiten`} casi todos los meses, unos ${fmt0(tot)} al mes en total: ${recurring.slice(0, 4).map(r => `${r.name} (${fmt0(r.monthly)})`).join(", ")}${recurring.length > 4 ? "…" : ""}.`,
      "Revisa cada pocos meses si sigues usando todas tus suscripciones.");
  }

  // 7. Cash usage this month
  if (now.o > 0 && now.cashOut / now.o > 0.6 && now.cashOut > 5000) add("info", "Pagas mucho en efectivo",
    `El ${fmtPct(now.cashOut / now.o)} de tus gastos de este mes ha sido en efectivo.`,
    "Apunta cada pago en efectivo en el momento: es el dinero que más fácil se escapa del control.");
  for (const a of d.accounts) if (bal[a.id] < 0) add("critical", `${a.name} está en negativo`,
    `Según lo registrado, el saldo de ${a.name} es de −${fmt0(-bal[a.id])}.`,
    "Si no es un error al apuntar, revisa el saldo real y usa «Ajustar saldo» en Perfil para corregirlo.");

  // 8. Savings: diversification and risk
  if (sav.total > 0) {
    const items = sav.items.filter(x => x.value > 0);
    const investItems = items.filter(x => !ASSET_KINDS[x.asset.kind].liquid);
    if (investItems.length && invested > 0) {
      const top = investItems.sort((a, b) => b.value - a.value)[0];
      const share = top.value / invested;
      if (investItems.length >= 1 && share > 0.6 && invested > 50000) add("warn", "Tu inversión está muy concentrada",
        `${top.asset.name} supone el ${fmtPct(share)} de todo lo que tienes invertido. Si baja, arrastra a todo tu patrimonio.`,
        "Repartir entre varios tipos de activo reduce el riesgo de depender de uno solo.");
    }
    const crypto = sav.byKind.crypto || 0;
    if (worth > 0 && crypto / worth > 0.3) add("warn", "Mucho peso en criptomonedas",
      `Las criptomonedas son el ${fmtPct(crypto / worth)} de tu patrimonio. Su precio puede caer mucho en poco tiempo.`,
      "Una pauta prudente es no tener en activos muy volátiles más de lo que podrías perder sin que afecte a tu día a día.");
    if (monthsCovered !== null && monthsCovered < 1 && invested > 0) add("warn", "Inviertes sin colchón",
      `Tienes ${fmt0(invested)} invertidos pero menos de un mes de gastos en liquidez. Ante un imprevisto podrías tener que vender en mal momento.`,
      "Prioriza el fondo de emergencia antes de seguir invirtiendo.");
    const withCost = sav.items.filter(x => !ASSET_KINDS[x.asset.kind].liquid && x.invested > 0);
    if (withCost.length) {
      const g = sum(withCost.map(x => x.gain)), inv = sum(withCost.map(x => x.invested));
      add(g >= 0 ? "good" : "info", g >= 0 ? "Tus inversiones van en positivo" : "Tus inversiones están en negativo",
        `Has invertido ${fmt0(inv)} y ahora valen ${fmt0(inv + g)} (${g >= 0 ? "+" : "−"}${fmt0(Math.abs(g))}, ${g >= 0 ? "+" : "−"}${fmtPct(Math.abs(g / inv), 1)}).`,
        g < 0 ? "Las caídas son normales a corto plazo; lo importante es que el plazo de cada inversión encaje con cuándo necesitarás el dinero." : "Recuerda actualizar los precios de vez en cuando para que el dato sea real.");
    }
    const stale = sav.items.filter(x => ASSET_KINDS[x.asset.kind].unit && x.units > 0 && daysSincePrice(x.asset, today) > 45);
    if (stale.length) add("info", "Precios sin actualizar",
      `${stale.map(x => x.asset.name).join(", ")} ${stale.length === 1 ? "lleva" : "llevan"} más de 45 días sin actualizar el precio.`,
      "Abre Mercado o Ahorros con conexión para traer el precio de hoy, o usa «Actualizar precio».");
  } else if (enoughData && monthsCovered !== null && monthsCovered >= 1) {
    add("info", "Aún no has registrado ahorros",
      "En Ahorros puedes apuntar el efectivo guardado, tus cuentas, acciones, criptomonedas u oro para ver tu patrimonio completo.", null);
  }

  // 9. Income stability
  if (full.length >= 3) {
    const ins = refTotals.map(t => t.i), mean = sum(ins) / ins.length;
    const sd = Math.sqrt(sum(ins.map(x => (x - mean) ** 2)) / ins.length);
    if (mean > 0 && sd / mean > 0.35) add("info", "Tus ingresos varían mucho",
      "De un mes a otro, tus ingresos cambian bastante. Con ingresos irregulares conviene un colchón algo mayor, de 6 meses o más.",
      "Calcula tu presupuesto con el mes de ingresos más bajo, no con la media.");
  }

  // Projection
  const monthlySaving = rateBase.i - rateBase.o;
  const projection = ref.length ? { months: 12, value: worth + monthlySaving * 12, monthlySaving } : null;

  // Score: four parts, each 0–25
  const parts = [];
  if (rate !== null) parts.push({ label: "Ahorro", pts: Math.round(25 * clamp01(rate / 0.2)) });
  if (monthsCovered !== null) parts.push({ label: "Colchón", pts: Math.round(25 * clamp01(monthsCovered / 6)) });
  const budgets = Object.entries(d.budgets || {}).filter(([, b]) => b > 0);
  if (budgets.length) parts.push({ label: "Presupuestos", pts: Math.round(25 * budgets.filter(([c, b]) => (curCat[c] || 0) <= b).length / budgets.length) });
  if (sav.total > 0) {
    const kinds = Object.values(sav.byKind).filter(v => v > 0).length;
    const cryptoShare = worth > 0 ? (sav.byKind.crypto || 0) / worth : 0;
    parts.push({ label: "Diversificación", pts: Math.round(25 * clamp01((Math.min(kinds, 3) / 3) * (cryptoShare > 0.3 ? 0.5 : 1))) });
  }
  const score = parts.length >= 2 ? Math.round(sum(parts.map(p => p.pts)) / (parts.length * 25) * 100) : null;

  insights.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
  return {
    score, scoreParts: parts, enoughData, insights, projection,
    metrics: { avgIn, avgOut, rate, monthsCovered, liquid, worth, available, invested, savings: sav.total, refMonths: ref.length, recurring },
  };
}

const clamp01 = x => Math.max(0, Math.min(1, x));
function addDays30(today) { const [y, m, d] = today.split("-").map(Number); const t = new Date(y, m - 1, d - 30); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; }
function daysSincePrice(a, today) {
  const dates = a.ops.filter(o => o.type === "price" || o.type === "buy" || o.type === "sell").map(o => o.date);
  if (a.live?.at) dates.push(String(a.live.at).slice(0, 10));
  const last = dates.sort().pop();
  if (!last) return 0;
  return Math.round((new Date(today + "T00:00:00") - new Date(last + "T00:00:00")) / 864e5);
}
export const scoreWord = s => s >= 80 ? "Muy buena" : s >= 60 ? "Buena" : s >= 40 ? "Mejorable" : "Delicada";
export { MONTHS };
