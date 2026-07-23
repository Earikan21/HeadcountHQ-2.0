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
export function modelMatrix(model, buckets = null) {
  const { cols, roster } = model;
  // Columns are monthly by default, or period buckets ({ label, idxs }) when given —
  // a quarter/year cell just sums the monthly factors of the months it spans, so the
  // formulas stay linked to the base salary and still recompute in the sheet.
  const cells = Array.isArray(buckets) && buckets.length
    ? buckets
    : cols.map((c, j) => ({ label: c.fullLabel, idxs: [j] }));
  const headers = ["Department", "Name", "Role", "Status", "Start", "End",
    "Annual Base", "Load %", "Bonus %", "Salary Growth %", "Cost per Hire", "Loaded Monthly"]
    .concat(cells.map((b) => b.label));
  const FIRST = 2;              // first data row (row 1 is the header)
  const MONTH0 = 12;           // 0-based index of the first period column (M)

  const rows = roster.map((r, i) => {
    const rowNum = FIRST + i;
    const bonusMult = 1 + (Number(r.bonusPct) || 0) / 100;
    const perBonusLoaded = (Number(r.loadedMonthly) || 0) * bonusMult; // == the L formula's value
    const loaded = `=G${rowNum}/12*(1+H${rowNum}/100)*(1+I${rowNum}/100)`;
    const hireMonth = r.active.findIndex((a) => a > 0);
    const cph = Math.round(Number(r.costPerHire) || 0);

    const periodCells = cells.map((b) => {
      let factorSum = 0, oneTimeSum = 0;
      for (const j of b.idxs) {
        const oneTime = cph && j === hireMonth ? cph : 0;
        const recurring = (Number(r.monthlyCost[j]) || 0) - oneTime;
        // factor: how much of L this month costs (proration × growth). Exact from the
        // engine's own numbers, so no cost logic is re-derived in the sheet.
        if (recurring > 0 && perBonusLoaded > 0) factorSum += recurring / perBonusLoaded;
        oneTimeSum += oneTime;
      }
      factorSum = round(factorSum);
      const term = factorSum ? `$L${rowNum}*${factorSum}` : "";
      const expr = [term, oneTimeSum ? String(oneTimeSum) : ""].filter(Boolean).join("+");
      return expr ? "=" + expr : 0;
    });

    return [
      r.department || "", r.name || "", r.role || "", r.status || "",
      r.startDate || "", r.endDate || "",
      Math.round(r.annualBase), Number(r.loadPct) || 0, Number(r.bonusPct) || 0,
      Number(r.growthPct) || 0, cph, loaded,
    ].concat(periodCells);
  });

  const last = FIRST + roster.length - 1;
  const sum = (L) => (roster.length ? `=SUM(${L}${FIRST}:${L}${last})` : 0);
  const total = ["TOTAL", "", "", "", "", "", sum("G"), "", "", "", sum("K"), sum("L")]
    .concat(cells.map((b, j) => sum(colLetter(MONTH0 + j))));

  return { headers, rows, total };
}

/** Flatten to a plain 2D array: header row, data rows, then the TOTAL row. */
export function modelMatrixCells(model, buckets = null) {
  const { headers, rows, total } = modelMatrix(model, buckets);
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

// The first six columns (Department, Name, Role, Status, Start, End) are free text
// that can come from an imported roster; the rest are engine-computed numbers. Only
// the text columns need formula-injection neutralization — prefixing a numeric cell
// would corrupt the values table Power Query loads.
const TEXT_COLS = 6;
const csvTextCell = (v) => {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return csvCell(s);
};

/** The values table as CSV (header + one row per person). */
export function modelValuesCsv(model) {
  const { headers, rows } = modelValuesRows(model);
  return [headers, ...rows]
    .map((r) => r.map((c, i) => (i < TEXT_COLS ? csvTextCell(c) : csvCell(c))).join(","))
    .join("\r\n") + "\r\n";
}

// ---- per-department monthly summary (a stable, linkable "mini model") --------
// The same month columns as the detail export, but aggregated to two rows per
// department — Headcount (a count) and Cost (a sum) — plus TOTAL rows. Its row count
// tracks the number of DEPARTMENTS, not people, so adding headcount never moves a cell;
// a formula in Excel pointing at "Sales / Cost / Mar 2027" keeps pointing there. Pass
// `deptOrder` (creation order) so a brand-new department appends at the bottom instead
// of shuffling the rows an alphabetical sort would.
export function modelSummaryMatrix(model, deptOrder = null) {
  const { departments = [], deptMonthlyCost = {}, roster = [], cols = [], totalMonthlyCost = [], monthlyHeadcount = [] } = model;
  // Per-department monthly headcount (a person present that month counts as 1).
  const hc = {};
  for (const d of departments) hc[d] = cols.map(() => 0);
  for (const r of roster) {
    const arr = hc[r.department];
    if (arr) for (let i = 0; i < cols.length; i++) if (r.present && r.present[i]) arr[i] += 1;
  }
  // Stable department order: those named in deptOrder first (in that order), then any
  // remaining model departments (e.g. plan-only scenario teams) in the model's order.
  const inModel = new Set(departments);
  const ordered = [];
  if (Array.isArray(deptOrder)) for (const d of deptOrder) if (inModel.has(d) && !ordered.includes(d)) ordered.push(d);
  for (const d of departments) if (!ordered.includes(d)) ordered.push(d);

  const round = (v) => Math.round(Number(v) || 0);
  const headers = ["Department", "Metric", ...cols.map((c) => c.fullLabel)];
  const rows = [];
  for (const d of ordered) {
    rows.push([d, "Headcount", ...(hc[d] || cols.map(() => 0)).map(round)]);
    rows.push([d, "Cost", ...(deptMonthlyCost[d] || cols.map(() => 0)).map(round)]);
  }
  const totals = [
    ["TOTAL", "Headcount", ...monthlyHeadcount.map(round)],
    ["TOTAL", "Cost", ...totalMonthlyCost.map(round)],
  ];
  return { headers, rows, totals };
}

/** The monthly per-department summary as CSV: header, two rows per department
 *  (Headcount, Cost), then the two TOTAL rows. */
export function modelSummaryCsv(model, deptOrder = null) {
  const { headers, rows, totals } = modelSummaryMatrix(model, deptOrder);
  return [headers, ...rows, ...totals]
    .map((r) => r.map((c, i) => (i < 2 ? csvTextCell(c) : csvCell(c))).join(","))
    .join("\r\n") + "\r\n";
}
