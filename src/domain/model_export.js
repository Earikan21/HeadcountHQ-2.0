/**
 * One place that turns a built model into a spreadsheet matrix of *linked* cells —
 * formulas, not hardcoded numbers — so a workbook stays live: edit a base salary and
 * loaded monthly, every month, and the totals all recalculate.
 *
 * The same matrix feeds the CSV download and the Excel-Online push, so both agree.
 *
 * Layout (header on row 1, data from row 2):
 *   A Department  B Name  C Role  D Status  E Start  F End
 *   G Annual Base  H Load %  I Bonus %  J Salary Growth %  K Cost per Hire
 *   L Loaded Monthly = G/12 * (1+H/100) * (1+I/100)         [a formula]
 *   M.. one column per month = $L * <activity factor>       [formulas]
 * The activity factor folds in the worked fraction of the month and salary growth
 * (both schedule/assumption-derived, never a dollar amount), and the one-time cost
 * per hire is added in the hire month. The TOTAL row is =SUM() down each column.
 */

/** A1 column letter for a 0-based column index (0 -> A, 26 -> AA). */
export function colLetter(n) {
  let s = "";
  n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const round = (x, p = 6) => Math.round((Number(x) || 0) * 10 ** p) / 10 ** p;

/**
 * Build the 2D matrix. Returns { headers, rows, total } where every cost/loaded cell
 * is an A1 formula string ("=…") and only inputs (base, %, dates) are literals.
 * The matrix assumes it lives with its header at A1 (so the A1 formulas resolve).
 */
export function modelMatrix(model) {
  const { cols, roster } = model;
  const headers = ["Department", "Name", "Role", "Status", "Start", "End",
    "Annual Base", "Load %", "Bonus %", "Salary Growth %", "Cost per Hire", "Loaded Monthly"]
    .concat(cols.map((c) => c.fullLabel));
  const FIRST = 2;              // first data row (row 1 is the header)
  const MONTH0 = 12;           // 0-based index of the first month column (M)

  const rows = roster.map((r, i) => {
    const rowNum = FIRST + i;
    const bonusMult = 1 + (Number(r.bonusPct) || 0) / 100;
    const perBonusLoaded = (Number(r.loadedMonthly) || 0) * bonusMult; // == the L formula's value
    const loaded = `=G${rowNum}/12*(1+H${rowNum}/100)*(1+I${rowNum}/100)`;
    const hireMonth = r.active.findIndex((a) => a > 0);
    const cph = Math.round(Number(r.costPerHire) || 0);

    const months = cols.map((c, j) => {
      const oneTime = cph && j === hireMonth ? cph : 0;
      const recurring = (Number(r.monthlyCost[j]) || 0) - oneTime;
      if (recurring <= 0 && !oneTime) return 0;
      // factor: how much of L this month costs (proration × growth). Exact from the
      // engine's own numbers, so no cost logic is re-derived in the sheet.
      const factor = perBonusLoaded > 0 ? round(recurring / perBonusLoaded) : 0;
      const term = factor ? `$L${rowNum}*${factor}` : "";
      const expr = [term, oneTime ? String(oneTime) : ""].filter(Boolean).join("+");
      return expr ? "=" + expr : 0;
    });

    return [
      r.department || "", r.name || "", r.role || "", r.status || "",
      r.startDate || "", r.endDate || "",
      Math.round(r.annualBase), Number(r.loadPct) || 0, Number(r.bonusPct) || 0,
      Number(r.growthPct) || 0, cph, loaded,
    ].concat(months);
  });

  const last = FIRST + roster.length - 1;
  const sum = (L) => (roster.length ? `=SUM(${L}${FIRST}:${L}${last})` : 0);
  const total = ["TOTAL", "", "", "", "", "", sum("G"), "", "", "", sum("K"), sum("L")]
    .concat(cols.map((c, j) => sum(colLetter(MONTH0 + j))));

  return { headers, rows, total };
}

/** Flatten to a plain 2D array: header row, data rows, then the TOTAL row. */
export function modelMatrixCells(model) {
  const { headers, rows, total } = modelMatrix(model);
  return [headers, ...rows, total];
}


// ---- values export (for Power Query) ---------------------------------------
// Power Query loads a table of VALUES that it re-fetches on Refresh. Formulas would
// import as literal text, so this variant emits computed numbers with no TOTAL row
// (the user's own tabs aggregate the loaded table with SUMIFS / pivots).
export function modelValuesRows(model) {
  const { cols, roster } = model;
  const headers = ["Department", "Name", "Role", "Status", "Start", "End",
    "Annual Base", "Load %", "Bonus %", "Salary Growth %", "Cost per Hire", "Loaded Monthly"]
    .concat(cols.map((c) => c.fullLabel));
  const rows = roster.map((r) => {
    const loadedWithBonus = Math.round((Number(r.loadedMonthly) || 0) * (1 + (Number(r.bonusPct) || 0) / 100));
    return [
      r.department || "", r.name || "", r.role || "", r.status || "",
      r.startDate || "", r.endDate || "",
      Math.round(r.annualBase), Number(r.loadPct) || 0, Number(r.bonusPct) || 0,
      Number(r.growthPct) || 0, Math.round(Number(r.costPerHire) || 0), loadedWithBonus,
    ].concat(r.monthlyCost.map((v) => Math.round(Number(v) || 0)));
  });
  return { headers, rows };
}

const csvCell = (v) => { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

/** The values table as CSV (header + one row per person). */
export function modelValuesCsv(model) {
  const { headers, rows } = modelValuesRows(model);
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
