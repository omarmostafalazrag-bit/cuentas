// The in-app advisor: a deterministic analysis of everything the person has recorded.
// It runs entirely on the device. It gives general financial-health guidance, never
// buy/sell recommendations for specific products.

import { ym, addMonths, daysInMonth, sum, fmt0, fmtPct, MONTHS } from "./util.js?v=7";
import { isStat, monthTotals, categorySums, accountBalances, savingsSummary, debtsSummary, debtState, fixedSummary, ASSET_KINDS } from "./model.js?v=7";

const LEVEL = { critical: 0, warn: 1, info: 2, good: 3 };
/** Spending categories that count as needs in the 50/30/20 split. */
export const NEEDS = ["Supermercado", "Vivienda", "Transporte", "Salud", "Estudios", "Hogar"];

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
  const debts = debtsSummary(d);
  const worth = available + sav.total + debts.owed - debts.owe;
  const invested = sav.total - sav.liquidSavings;

  const insights = [];
  const add = (level, title, body, action, src) => insights.push({ level, title, body, action, src: src || null });

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
      "Revisa las dos categorías en las que más gastas y fija un presupuesto para cada una en Movimientos.", "Gasta menos de lo que ganas · base de toda planificación");
    else if (rate < 0.1) add("warn", "Tu margen de ahorro es pequeño",
      `Ahorras el ${fmtPct(rate)} de lo que ingresas ${span}. Una referencia habitual es apartar entre el 10 % y el 20 %.`,
      `Págate primero: el día que cobres, aparta ${fmt0(Math.max(0, rateBase.i * 0.1))} a ahorros antes de gastar nada. Así llegarías al 10 %.`, "«Págate primero a ti» · George S. Clason, El hombre más rico de Babilonia");
    else if (rate < 0.2) add("info", "Ahorras a buen ritmo",
      `Guardas el ${fmtPct(rate)} de lo que ingresas ${span}.`,
      "Si quieres subir al 20 %, automatiza: mueve el dinero a ahorros justo al cobrar, antes de gastar.", "Ahorro automático · Ramit Sethi");
    else add("good", "Excelente capacidad de ahorro",
      `Guardas el ${fmtPct(rate)} de lo que ingresas ${span}. Estás por encima del 20 % que suele recomendarse.`, null);
  }

  // 2. Emergency fund
  const monthsCovered = avgOut > 0 ? liquid / avgOut : null;
  if (monthsCovered !== null) {
    const m = monthsCovered.toLocaleString("es-ES", { maximumFractionDigits: 1 });
    if (monthsCovered < 1) add("critical", "No tienes colchón para imprevistos",
      `Tu dinero disponible y tus ahorros líquidos (${fmt0(liquid)}) cubren menos de un mes de tus gastos habituales (${fmt0(avgOut)} al mes).`,
      "Antes de invertir, intenta reunir al menos un mes de gastos en efectivo o en una cuenta.", "Fondo de emergencia · Dave Ramsey y Suze Orman");
    else if (monthsCovered < 3) add("warn", "Tu fondo de emergencia es corto",
      `Con ${fmt0(liquid)} líquidos cubrirías unos ${m} meses de gastos. Lo recomendable son entre 3 y 6 meses.`,
      `Te faltan unos ${fmt0(avgOut * 3 - liquid)} para llegar a 3 meses.`, "Fondo de emergencia de 3 a 6 meses · Suze Orman");
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
    // One-off monthly charges (rent, a yearly bill) must not be projected forward:
    // only categories with several movements this month are extrapolated.
    const countCur = {};
    for (const t of d.tx) if (isStat(t) && t.type === "out" && ym(t.date) === cur) countCur[t.cat] = (countCur[t.cat] || 0) + 1;
    const rising = Object.entries(curCat)
      .map(([c, v]) => ({ c, v, proj: (countCur[c] || 0) >= 3 ? v * pace : v, avg: avgCat[c] || 0 }))
      .filter(x => x.avg > 0 && x.proj > x.avg * 1.3 && x.proj - x.avg > 3000 && day >= 7)
      .sort((a, b) => (b.proj - b.avg) - (a.proj - a.avg)).slice(0, 2);
    for (const x of rising) add("warn", `${x.c}: vas por encima de lo habitual`,
      x.proj > x.v ? `Llevas ${fmt0(x.v)} este mes. A este ritmo acabarías en unos ${fmt0(x.proj)}, frente a ${fmt0(x.avg)} de media.` : `Llevas ${fmt0(x.v)} este mes, frente a ${fmt0(x.avg)} de media.`,
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
  const fixedNames = new Set((d.fixed || []).map(f => f.name.trim().toLowerCase()));
  for (const t of d.tx) if (t.fixed) fixedNames.add(t.concept.trim().toLowerCase());
  const recurring = Object.entries(seen).filter(([k, x]) => x.months.size >= 3 && !fixedNames.has(k)).map(([, x]) => ({ name: x.name, monthly: Math.round(x.total / x.months.size) })).sort((a, b) => b.monthly - a.monthly);
  if (recurring.length) {
    const tot = sum(recurring.map(r => r.monthly));
    add("info", "Gastos que se repiten cada mes",
      `Hay ${recurring.length === 1 ? "un gasto que se repite" : `${recurring.length} gastos que se repiten`} casi todos los meses y no están en tus gastos fijos, unos ${fmt0(tot)} al mes: ${recurring.slice(0, 4).map(r => `${r.name} (${fmt0(r.monthly)})`).join(", ")}${recurring.length > 4 ? "…" : ""}.`,
      "Añádelos en Movimientos → Fijos para verlos venir y que se apunten solos.");
  }

  // 6b. Weight of fixed costs (fixed expenses plus debt instalments) on income
  const fx = fixedSummary(d, today);
  // Instalments already set up as fixed expenses are counted once, inside fx.monthlyOut.
  const linkedDebts = new Set((d.fixed || []).filter(f => f.debt && !f.paused).map(f => f.debt));
  const unlinkedInstalments = sum(debts.items.filter(x => x.debt.dir === "owe" && !x.done && !linkedDebts.has(x.debt.id)).map(x => x.debt.monthly || 0));
  const fixedLoad = fx.monthlyOut + unlinkedInstalments;
  const incomeRef = Math.max(avgIn, fx.monthlyIn);
  if (fixedLoad > 0 && incomeRef > 0) {
    const share = fixedLoad / incomeRef;
    if (share > 0.5) add("warn", "Tus gastos fijos se llevan más de la mitad",
      `Entre gastos fijos${debts.monthly ? " y cuotas de deudas" : ""} pagas ${fmt0(fixedLoad)} al mes, el ${fmtPct(share)} de tus ingresos. Te deja poco margen para imprevistos.`,
      "Revisa suscripciones que no uses y si puedes renegociar alguna tarifa (móvil, luz, seguros).");
    else add("info", "Tus gastos fijos", `Pagas ${fmt0(fixedLoad)} al mes en gastos fijos${debts.monthly ? " y cuotas" : ""}, el ${fmtPct(share)} de tus ingresos.${fx.leftThisMonth > 0 ? ` Este mes aún te quedan ${fmt0(fx.leftThisMonth)} por pagar.` : ""}`, null);
  }

  // 6c. Debts
  for (const x of debts.items) {
    if (x.done) continue;
    const dbt = x.debt;
    if (dbt.dir === "owe" && dbt.due && dbt.due < today) add("critical", `Deuda vencida con ${dbt.who}`,
      `Tenías que haber devuelto ${fmt0(x.remaining)} antes del ${new Date(dbt.due + "T00:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" })}.`,
      "Habla cuanto antes con quien te prestó el dinero y acordad un plan de pago realista.");
    else if (dbt.dir === "owed" && dbt.due && dbt.due < today) add("info", `${dbt.who} ya debería haberte pagado`,
      `Te debe ${fmt0(x.remaining)} y el plazo acabó el ${new Date(dbt.due + "T00:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long" })}.`,
      "Un recordatorio amable a tiempo evita malentendidos.");
    if (dbt.dir === "owe" && dbt.apr >= 10) add("warn", `Interés alto: ${dbt.who}`,
      `Esta deuda tiene un ${String(dbt.apr).replace(".", ",")} % de interés anual: te cuesta unos ${fmt0(x.remaining * dbt.apr / 100 / 12)} al mes solo en intereses.`,
      liquid > x.remaining * 1.5 ? "Tienes liquidez para adelantar su pago; suele ser la mejor «inversión» posible." : "Si tienes varias deudas, paga primero la de mayor interés.", "Método avalancha");
  }
  if (debts.owe > 0 && avgIn > 0 && debts.monthly / avgIn > 0.35) add("warn", "Tus cuotas de deuda pesan mucho",
    `Pagas ${fmt0(debts.monthly)} al mes en cuotas, el ${fmtPct(debts.monthly / avgIn)} de tus ingresos. Por encima del 35 % se considera arriesgado.`,
    "Evita pedir más préstamos hasta reducir esta proporción.");
  if (debts.owed > 0) add("info", "Dinero que te deben", `Te deben ${fmt0(debts.owed)} en total. Cuenta en tu patrimonio, pero no es dinero disponible hasta que te lo devuelvan.`, null);

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
        "Repartir entre muchos activos distintos reduce el riesgo de depender de uno solo.", "Diversificación · Harry Markowitz y John Bogle");
    }
    const crypto = sav.byKind.crypto || 0;
    if (worth > 0 && crypto / worth > 0.3) add("warn", "Mucho peso en criptomonedas",
      `Las criptomonedas son el ${fmtPct(crypto / worth)} de tu patrimonio. Su precio puede caer mucho en poco tiempo.`,
      "Una pauta prudente es no tener en activos muy volátiles más de lo que podrías perder sin que afecte a tu día a día.", "Gestión del riesgo · Benjamin Graham");
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


  // ---- Principles from well-known personal-finance authors ------------------------------
  const refCats = {};
  const catMonths = full.length ? full : (months.includes(cur) ? [cur] : []);
  for (const k of catMonths) for (const [c, v] of Object.entries(categorySums(d, k))) refCats[c] = (refCats[c] || 0) + v / catMonths.length;
  const activeOwe = debts.items.filter(x => x.debt.dir === "owe" && !x.done);
  const instalments = sum(activeOwe.map(x => x.debt.monthly || 0));

  // P1. 50/30/20 (Elizabeth Warren): needs, wants, savings
  let split = null;
  if (avgIn > 0 && catMonths.length) {
    const needs = sum(NEEDS.map(c => refCats[c] || 0)) + instalments;
    const give = refCats.Donaciones || 0;
    const wants = sum(Object.entries(refCats).filter(([c]) => !NEEDS.includes(c) && c !== "Donaciones").map(([, v]) => v));
    const save = avgIn - needs - wants - give;
    split = { income: avgIn, needs, wants, give, save, pNeeds: needs / avgIn, pWants: (wants + give) / avgIn, pSave: save / avgIn };
    const p = x => fmtPct(Math.max(0, x));
    const body = `Ahora mismo: necesidades ${p(split.pNeeds)}, caprichos ${p(split.pWants)} y ahorro ${p(split.pSave)} de tus ingresos. La referencia es 50 % · 30 % · 20 %.`;
    if (split.pNeeds > 0.6) add("warn", "Tus gastos básicos pesan mucho", body,
      "Vivienda y transporte suelen ser lo que más mueve la aguja: compartir piso, cambiar de tarifa o de abono pesa más que recortar cafés.", "Regla 50/30/20 · Elizabeth Warren");
    else if (split.pWants > 0.35) add("warn", "Los caprichos se llevan mucho", body,
      `Si los bajas al 30 %, liberarías unos ${fmt0((split.pWants - 0.3) * avgIn)} al mes para ahorrar.`, "Regla 50/30/20 · Elizabeth Warren");
    else if (split.pSave >= 0.2) add("good", "Tu reparto es sano", body, null, "Regla 50/30/20 · Elizabeth Warren");
    else add("info", "Cómo repartes tu dinero", body,
      "Intenta que cada euro tenga un destino al empezar el mes: primero ahorro, luego básicos, luego el resto.", "Regla 50/30/20 · Elizabeth Warren");
  }

  // P2. Several debts: avalanche (highest interest first) vs. snowball (smallest first)
  if (activeOwe.length >= 2) {
    const aval = [...activeOwe].sort((a, b) => (b.debt.apr || 0) - (a.debt.apr || 0) || a.remaining - b.remaining);
    const snow = [...activeOwe].sort((a, b) => a.remaining - b.remaining);
    const hasApr = activeOwe.some(x => x.debt.apr > 0);
    const list = arr => arr.slice(0, 4).map((x, i) => `${i + 1}. ${x.debt.who} (${fmt0(x.remaining)}${x.debt.apr ? `, ${String(x.debt.apr).replace(".", ",")} %` : ""})`).join(" · ");
    add("info", "Plan para salir de tus deudas",
      hasApr ? `Paga el mínimo en todas y destina todo lo extra a una sola, por este orden de interés: ${list(aval)}.` : `Paga el mínimo en todas y destina todo lo extra a la más pequeña: ${list(snow)}.`,
      hasApr && aval[0] !== snow[0] ? `Si te motiva más ver deudas cerradas pronto, el orden «bola de nieve» empieza por ${snow[0].debt.who} (${fmt0(snow[0].remaining)}). Ahorra menos intereses el primero; el segundo ayuda a no abandonar.` : "Cada deuda que cierres libera su cuota para la siguiente.",
      hasApr ? "Método avalancha · y bola de nieve de Dave Ramsey" : "Bola de nieve · Dave Ramsey");
  }

  // P3. Investing while carrying expensive debt
  const pricey = activeOwe.filter(x => x.debt.apr >= 7).sort((a, b) => b.debt.apr - a.debt.apr)[0];
  if (pricey && invested > 0) add("warn", "Inviertes mientras pagas intereses altos",
    `Tienes ${fmt0(invested)} invertidos y a la vez una deuda al ${String(pricey.debt.apr).replace(".", ",")} % con ${pricey.debt.who}. Pagarla equivale a una rentabilidad segura de ese ${String(pricey.debt.apr).replace(".", ",")} %, algo que casi ninguna inversión garantiza.`,
    "Antes de aportar más a inversiones, valora adelantar el pago de esa deuda.", "Idea defendida por Warren Buffett");

  // P4. Lifestyle creep: spending growing faster than income
  const recent3 = [1, 2, 3].map(i => addMonths(cur, -i)), prev3 = [4, 5, 6].map(i => addMonths(cur, -i));
  if (recent3.every(k => months.includes(k)) && prev3.filter(k => months.includes(k)).length >= 2) {
    const avg = (ks, f) => { const xs = ks.filter(k => months.includes(k)).map(k => monthTotals(d, k)[f]); return sum(xs) / xs.length; };
    const oR = avg(recent3, "o"), oP = avg(prev3, "o"), iR = avg(recent3, "i"), iP = avg(prev3, "i");
    const gO = oP > 0 ? oR / oP - 1 : 0, gI = iP > 0 ? iR / iP - 1 : 0;
    if (gO > 0.15 && gO - gI > 0.1 && oR - oP > 5000) add("info", "Tu gasto crece más rápido que tus ingresos",
      `En los últimos 3 meses gastas un ${fmtPct(gO)} más que en los 3 anteriores, mientras que tus ingresos ${gI > 0.005 ? `han subido un ${fmtPct(gI)}` : "no han subido"}.`,
      "Cuando ganes más, decide antes qué parte va a ahorro. La riqueza es lo que no gastas.", "Inflación del estilo de vida · Morgan Housel, La psicología del dinero");
  }

  // P5. Subscriptions audit
  const subs = refCats.Suscripciones || 0;
  if (avgIn > 0 && subs > 1500 && subs / avgIn > 0.05) add("info", "Revisa tus suscripciones",
    `Pagas unos ${fmt0(subs)} al mes en suscripciones, el ${fmtPct(subs / avgIn)} de lo que ingresas.`,
    "Cancela todas las que no hayas usado en el último mes. Si echas alguna de menos, la vuelves a contratar.", "Gasto consciente · Ramit Sethi");

  // P6. Donations
  const give = refCats.Donaciones || 0;
  if (give > 0 && avgIn > 0) {
    const g = give / avgIn;
    if (monthsCovered !== null && monthsCovered < 1 && g > 0.1) add("info", "Donas mucho para tu colchón actual",
      `Donas el ${fmtPct(g)} de tus ingresos y tu colchón cubre menos de un mes. Dar es muy valioso; hacerlo de forma sostenible te permite seguir dando.`,
      "Puedes mantener una donación fija más pequeña hasta completar tu fondo de emergencia.");
    else add("good", "Tus donaciones", `Destinas unos ${fmt0(give)} al mes a donaciones, el ${fmtPct(g)} de tus ingresos.`,
      "Guarda los justificantes: en España los donativos a ONG acogidas a la Ley 49/2002 desgravan en la declaración de la renta.");
  }

  // P7. Long term and compound interest (illustrative, never a promise)
  const msave = (full.length ? avgIn - avgOut : now.i - now.o);
  if (ref.length && msave > 2000 && monthsCovered !== null && monthsCovered >= 3 && !pricey) {
    const fv = (pm, r, n) => pm * ((Math.pow(1 + r / 12, n) - 1) / (r / 12));
    add("info", "El tiempo es tu mejor aliado",
      `Si invirtieras ${fmt0(msave)} al mes durante 20 años, aportarías ${fmt0(msave * 240)}. Con una rentabilidad hipotética del 5 % anual llegarías a unos ${fmt0(fv(msave, 0.05, 240))}. Ese ejemplo no está garantizado: los mercados suben y bajan.`,
      "Para el largo plazo, suelen recomendarse productos muy diversificados y con comisiones bajas, y no tocarlos en las caídas.", "Interés compuesto · John Bogle y Warren Buffett");
  }

  // Priority ladder: what to focus on now, in order
  const hasData = avgOut > 0;
  const ladder = [
    { t: "Colchón de un mes", d: "Un mes de gastos en efectivo o en cuenta para imprevistos.", ok: hasData && monthsCovered >= 1 },
    { t: "Sin deudas caras", d: "Paga primero las deudas con interés del 7 % o más.", ok: !activeOwe.some(x => x.debt.apr >= 7) },
    { t: "Colchón completo", d: "Entre 3 y 6 meses de gastos guardados.", ok: hasData && monthsCovered >= 3 },
    { t: "Ahorra el 20 %", d: "Aparta al menos el 20 % de lo que ingresas.", ok: rate !== null && rate >= 0.2 },
    { t: "Invierte a largo plazo", d: "Diversificado, con comisiones bajas y sin prisa.", ok: invested > 0 },
  ];
  const curStep = hasData ? ladder.findIndex(x => !x.ok) : 0;
  ladder.forEach((x, i) => { x.state = x.ok ? "done" : i === curStep ? "now" : "next"; });

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
  if (debts.owe > 0) {
    const overdue = debts.items.some(x => !x.done && x.debt.dir === "owe" && x.debt.due && x.debt.due < today);
    const ratio = debts.owe / Math.max(1, (avgIn || fx.monthlyIn) * 6);
    parts.push({ label: "Deudas", pts: overdue ? 0 : Math.round(25 * clamp01(1 - ratio)) });
  }
  const score = parts.length >= 2 ? Math.round(sum(parts.map(p => p.pts)) / (parts.length * 25) * 100) : null;

  insights.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
  return {
    score, scoreParts: parts, enoughData, insights, projection,
    ladder, split, metrics: { avgIn, avgOut, rate, monthsCovered, liquid, worth, available, invested, savings: sav.total, refMonths: ref.length, recurring, owe: debts.owe, owed: debts.owed, fixedLoad },
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
