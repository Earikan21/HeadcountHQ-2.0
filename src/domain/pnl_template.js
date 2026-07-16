/**
 * A downloadable, fill-in "profit & loss" template built from the current model.
 *
 * Layout (open it in Excel; the formulas evaluate there):
 *   columns: A Department  B Line  C Assumption  D.. one per month
 *   per department, a block of six rows —
 *     Headcount                      (filled from the model)
 *     Cost                           (filled from the model)
 *     Benefit per head (annual $)    (YOU fill the Assumption cell)
 *     Diminishing return % (0-1)     (YOU fill the Assumption cell)
 *     Benefit                        (formula: applies the two levers to headcount)
 *     Net (Benefit - Cost)           (formula)
 *   then TOTAL rows: Total Benefit, Total Cost, Profit / Loss (SUMIF, so any number
 *   of departments works), and a per-department diminishing-returns CALCULATOR that
 *   estimates the two levers from historical headcount/output you paste in.
 *
 * The benefit curve is geometric diminishing returns: the first head is fully
 * productive, each additional head is worth (1 - dim) of the one before, so total
 * monthly benefit = rate/12 * (1-(1-dim)^H)/dim  (and rate/12*H when dim = 0). It's
 * an ordinary cell formula, so anyone can swap the curve.
 *
 * The calculator inverts that: the marginal benefit of the head at level H is
 * rate*(1-dim)^H, so ln(marginal) = ln(rate) + H*ln(1-dim) — a straight line. Fitting
 * ln(marginal) against headcount (Excel SLOPE/INTERCEPT) recovers dim and rate from
 * real history. It's an estimate; it wants a few rows of growing headcount.
 */
import { colLetter } from "./model_export.js";

const round = (v) => Math.round(Number(v) || 0);
const csvCell = (v) => { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

const CALC_ROWS = 8; // blank history rows offered per department calculator

/** Build the template as a 2-D array of cells (strings/numbers/formulas). */
export function pnlTemplateRows(model, deptOrder = null) {
  const { departments = [], deptMonthlyCost = {}, roster = [], cols = [] } = model;
  // Per-department monthly headcount (a present person counts as 1).
  const hc = {};
  for (const d of departments) hc[d] = cols.map(() => 0);
  for (const r of roster) {
    const a = hc[r.department];
    if (a) for (let i = 0; i < cols.length; i++) if (r.present && r.present[i]) a[i] += 1;
  }
  // Stable department order (creation order + plan-only teams), new departments last.
  const inModel = new Set(departments);
  const ordered = [];
  if (Array.isArray(deptOrder)) for (const d of deptOrder) if (inModel.has(d) && !ordered.includes(d)) ordered.push(d);
  for (const d of departments) if (!ordered.includes(d)) ordered.push(d);

  const N = cols.length;
  const months = Array.from({ length: N }, (_, j) => j);
  const mcol = (j) => colLetter(3 + j); // month j -> its column letter (D is index 3)

  const rows = [];
  const push = (arr) => { rows.push(arr); return rows.length; }; // returns the 1-based row number

  push(["Department", "Line", "Assumption", ...cols.map((c) => c.fullLabel)]);

  const deptRef = [];
  for (const d of ordered) {
    const hcRow = push([d, "Headcount", "", ...hc[d].map(round)]);
    const costRow = push([d, "Cost", "", ...(deptMonthlyCost[d] || cols.map(() => 0)).map(round)]);
    const rateRow = push([d, "Benefit per head (annual $)", "", ...months.map(() => "")]);
    const dimRow = push([d, "Diminishing return % (0-1)", "", ...months.map(() => "")]);
    const benRow = push([d, "Benefit", "", ...months.map((j) => {
      const H = `${mcol(j)}${hcRow}`, rate = `$C$${rateRow}`, dim = `$C$${dimRow}`;
      return `=IF($C$${rateRow}="","",IF(${dim}=0,${rate}/12*${H},${rate}/12*(1-(1-${dim})^${H})/${dim}))`;
    })]);
    push([d, "Net (Benefit - Cost)", "", ...months.map((j) => `=IF(${mcol(j)}${benRow}="","",${mcol(j)}${benRow}-${mcol(j)}${costRow})`)]);
    deptRef.push({ d, rateRow, dimRow });
  }

  const lastData = rows.length; // last row of the department blocks (for SUMIF ranges)
  const totBenRow = push(["TOTAL", "Total Benefit", "", ...months.map((j) => `=SUMIF($B$2:$B$${lastData},"Benefit",${mcol(j)}$2:${mcol(j)}$${lastData})`)]);
  const totCostRow = push(["TOTAL", "Total Cost", "", ...months.map((j) => `=SUMIF($B$2:$B$${lastData},"Cost",${mcol(j)}$2:${mcol(j)}$${lastData})`)]);
  push(["TOTAL", "Profit / Loss", "", ...months.map((j) => `=${mcol(j)}${totBenRow}-${mcol(j)}${totCostRow}`)]);

  // ---- diminishing-returns calculator, one per department --------------------
  push([]);
  push(["Diminishing-returns calculator", "Paste each department's historical headcount and its ANNUAL benefit/output (from your operating model), oldest→newest with growing headcount. Copy each estimate into that department's Assumption cells above."]);
  for (const { d } of deptRef) {
    push([]);
    const headerRow = push([`${d} — calculator`, "Historical headcount", "Historical annual benefit", "Marginal per head", "ln(marginal)"]);
    const firstInput = headerRow + 1;
    for (let k = 0; k < CALC_ROWS; k++) {
      const rn = rows.length + 1;
      const marginal = k === 0 ? "" : `=IFERROR((C${rn}-C${rn - 1})/(B${rn}-B${rn - 1}),"")`;
      const lnm = `=IFERROR(LN(D${rn}),"")`;
      push(["", "", "", marginal, lnm]);
    }
    const lastInput = rows.length;
    // Regress ln(marginal) (E) on headcount (B) over the rows where a marginal exists.
    const eRange = `E${firstInput + 1}:E${lastInput}`, bRange = `B${firstInput + 1}:B${lastInput}`;
    push([`${d}: estimated diminishing % (0-1)`, "", "", `=IFERROR(1-EXP(SLOPE(${eRange},${bRange})),"add ≥2 rows")`]);
    push([`${d}: estimated benefit per head (annual $)`, "", "", `=IFERROR(EXP(INTERCEPT(${eRange},${bRange})),"add ≥2 rows")`]);
  }

  return rows;
}

/** The template as CSV (formulas included; open in Excel, don't load via Power Query). */
export function pnlTemplateCsv(model, deptOrder = null) {
  return pnlTemplateRows(model, deptOrder).map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
