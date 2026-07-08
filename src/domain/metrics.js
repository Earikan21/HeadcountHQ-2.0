/**
 * Background analytics layer (Directive 4.0). Pure function that pre-computes a
 * comprehensive set of aggregate metrics from the roster + settings — per-department
 * average / median / range of pay, shares, ratios and multiples, tenure, and a
 * multi-year forward model. Never returns an individual salary tied to a name.
 * `computeMetrics` returns a structured object; `metricsText` renders it for the
 * assistant's context so questions like "avg salary in Engineering" are answerable.
 */
import { buildHeadcountModel } from "./model.js";

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const median = (sorted) => (sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0);
const round1 = (x) => Math.round(x * 10) / 10;

export function computeMetrics({ employees = [], settings = {}, rollup = { totals: {}, departments: [] }, reconciliation = null, financials = null, now = new Date() } = {}) {
  const mult = Number(settings.loaded_cost_multiplier) || 1.2;
  const nowMs = now.getTime();

  const allSals = employees.map((e) => e.annual_salary || 0).filter((x) => x > 0).sort((a, b) => a - b);
  const totalBase = allSals.reduce((a, b) => a + b, 0);

  const byType = {}, byStatus = {};
  for (const e of employees) {
    const t = e.employee_type || "unspecified"; byType[t] = (byType[t] || 0) + 1;
    const st = e.employment_status || "unspecified"; byStatus[st] = (byStatus[st] || 0) + 1;
  }

  const company = {
    headcount: employees.length,
    activeSeats: rollup.totals.active || 0, approvedSeats: rollup.totals.approved || 0, openSeats: rollup.totals.open || 0,
    totalBase, totalLoaded: Math.round(totalBase * mult), loadedMultiplier: mult,
    avgBase: allSals.length ? Math.round(totalBase / allSals.length) : 0,
    avgLoadedPerHead: allSals.length ? Math.round((totalBase * mult) / allSals.length) : 0,
    medianBase: median(allSals), minBase: allSals[0] || 0, maxBase: allSals[allSals.length - 1] || 0,
    employmentTypes: byType, employmentStatus: byStatus,
  };

  // per-department aggregates
  const grp = {};
  for (const e of employees) {
    const d = e.department_name || "(none)";
    if (!grp[d]) grp[d] = { department: d, sals: [], starts: [] };
    if ((e.annual_salary || 0) > 0) grp[d].sals.push(e.annual_salary);
    if (e.start_date) grp[d].starts.push(e.start_date);
  }
  const departments = Object.values(grp).map((g) => {
    const s = g.sals.slice().sort((a, b) => a - b);
    const tot = s.reduce((a, b) => a + b, 0);
    const hc = g.sals.length;
    const avg = hc ? Math.round(tot / hc) : 0;
    const loaded = Math.round(tot * mult);
    const tenures = g.starts.map((sd) => { const t = new Date(sd).getTime(); return isNaN(t) ? null : (nowMs - t) / (1000 * 60 * 60 * 24 * 30.44); }).filter((x) => x != null && x >= 0);
    return {
      department: g.department, headcount: hc,
      totalBase: tot, totalLoaded: loaded, avgBase: avg, medianBase: median(s), minBase: s[0] || 0, maxBase: s[s.length - 1] || 0,
      avgTenureMonths: tenures.length ? Math.round(tenures.reduce((a, b) => a + b, 0) / tenures.length) : null,
      pctHeadcount: company.headcount ? round1((hc / company.headcount) * 100) : 0,
      pctBaseCost: company.totalBase ? round1((tot / company.totalBase) * 100) : 0,
      avgVsCompanyIndex: company.avgBase ? Math.round((avg / company.avgBase) * 100) : 0,
      costPerHeadLoaded: hc ? Math.round(loaded / hc) : 0,
    };
  }).sort((a, b) => b.totalLoaded - a.totalLoaded);

  const deptAvgs = departments.map((d) => d.avgBase).filter((x) => x > 0);
  const ratios = {
    loadedToBaseMultiple: mult,
    largestDeptShareOfCostPct: departments[0] ? departments[0].pctBaseCost : 0,
    avgSalaryRangeMultiple: deptAvgs.length ? Math.round((Math.max(...deptAvgs) / Math.min(...deptAvgs)) * 100) / 100 : null,
    activeToApprovedPct: company.approvedSeats ? Math.round((company.activeSeats / company.approvedSeats) * 100) : null,
  };

  const budget = reconciliation ? {
    headcountCap: reconciliation.allocation.headcount.cap,
    headcountAllocated: reconciliation.allocation.headcount.allocated,
    moneyCap: reconciliation.allocation.money.cap,
    moneyCommitted: reconciliation.company.money.committed,
  } : null;

  const runwayMonths = financials && Number(financials.monthly_burn) > 0 ? Math.floor(Number(financials.cash_balance) / Number(financials.monthly_burn)) : null;
  const fin = financials ? { cash: Number(financials.cash_balance) || 0, monthlyBurn: Number(financials.monthly_burn) || 0, runwayMonths } : null;

  let model = null;
  try {
    const m = buildHeadcountModel({ employees, loadedMultiplier: mult, now });
    let ni = m.cols.findIndex((c) => c.year === now.getFullYear() && c.month0 === now.getMonth());
    if (ni < 0) ni = m.cols.length - 1;
    const in12 = m.monthlyHeadcount[Math.min(ni + 12, m.cols.length - 1)] || 0;
    model = {
      windowStart: m.cols[0] ? m.cols[0].fullLabel : null,
      windowEnd: m.cols[m.cols.length - 1] ? m.cols[m.cols.length - 1].fullLabel : null,
      headcountNow: m.monthlyHeadcount[ni] || 0, headcountIn12mo: in12,
      netNew12mo: in12 - (m.monthlyHeadcount[ni] || 0),
      annualRunRate: Math.round((m.totalMonthlyCost[ni] || 0) * 12),
      costByYear: m.years.map((y) => ({ year: y.year, totalLoaded: y.totalCost, yearEndHeadcount: y.yearEndHc, avgCostPerHead: y.avgCostPerHead })),
      yoyCostGrowthPct: m.years.length >= 2 && m.years[0].totalCost ? round1(((m.years[1].totalCost - m.years[0].totalCost) / m.years[0].totalCost) * 100) : null,
    };
  } catch { /* ignore */ }

  return { company, departments, ratios, budget, financials: fin, model, computedAt: now.toISOString() };
}

/** Render metrics as a compact text block for the assistant context. */
export function metricsText(m) {
  const L = [];
  const c = m.company;
  const types = Object.entries(c.employmentTypes).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a";
  const status = Object.entries(c.employmentStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a";
  L.push(`Company: ${c.headcount} people (${c.activeSeats} active / ${c.approvedSeats} approved / ${c.openSeats} open seats). Types: ${types}. Status: ${status}.`);
  L.push(`Pay: base total ${money(c.totalBase)}, fully-loaded ${money(c.totalLoaded)} (x${c.loadedMultiplier}). Base salary avg ${money(c.avgBase)}, median ${money(c.medianBase)}, min ${money(c.minBase)}, max ${money(c.maxBase)}.`);
  // Stated plainly, because "what's our average salary?" is the single most-asked question.
  L.push(`AVERAGE SALARY (company-wide): ${money(c.avgBase)} base per person${c.avgLoadedPerHead ? `, ${money(c.avgLoadedPerHead)} fully loaded` : ""}, across ${c.headcount} people.`);
  if (m.departments.length) {
    L.push(`AVERAGE SALARY BY DEPARTMENT (base per person): ${m.departments.map((d) => `${d.department} ${money(d.avgBase)} (${d.headcount})`).join("; ")}.`);
  }
  if (m.model) {
    L.push(`Model ${m.model.windowStart}–${m.model.windowEnd}: headcount now ${m.model.headcountNow}, in 12 mo ${m.model.headcountIn12mo} (net ${m.model.netNew12mo >= 0 ? "+" : ""}${m.model.netNew12mo}), annual run-rate ${money(m.model.annualRunRate)}${m.model.yoyCostGrowthPct != null ? `, YoY cost growth ${m.model.yoyCostGrowthPct}%` : ""}.`);
    L.push(`Fully-loaded cost by year: ${m.model.costByYear.map((y) => `${y.year} ${money(y.totalLoaded)} (${y.yearEndHeadcount} EOY, ${money(y.avgCostPerHead)}/head)`).join("; ")}.`);
  }
  if (m.budget) L.push(`Budget: headcount cap ${m.budget.headcountCap || "not set"} (allocated ${m.budget.headcountAllocated}); money cap ${m.budget.moneyCap ? money(m.budget.moneyCap) : "not set"}, committed ${money(m.budget.moneyCommitted)}.`);
  if (m.financials) L.push(`Cash ${money(m.financials.cash)}, monthly burn ${money(m.financials.monthlyBurn)}, runway ${m.financials.runwayMonths != null ? m.financials.runwayMonths + " months" : "n/a"}.`);
  L.push(`Ratios & multiples: loaded/base x${m.ratios.loadedToBaseMultiple}; avg-salary spread across depts ${m.ratios.avgSalaryRangeMultiple != null ? m.ratios.avgSalaryRangeMultiple + "x" : "n/a"}; largest dept = ${m.ratios.largestDeptShareOfCostPct}% of base cost; seats filled ${m.ratios.activeToApprovedPct != null ? m.ratios.activeToApprovedPct + "%" : "n/a"} of approved.`);
  L.push(`Per department — headcount / % HC / avg base / median / range / % of cost / index vs co avg / loaded per head / avg tenure:`);
  for (const d of m.departments) {
    L.push(`  - ${d.department}: ${d.headcount} (${d.pctHeadcount}% HC), avg ${money(d.avgBase)}, median ${money(d.medianBase)}, range ${money(d.minBase)}–${money(d.maxBase)}, ${d.pctBaseCost}% of cost, index ${d.avgVsCompanyIndex} vs co avg, ${money(d.costPerHeadLoaded)}/head loaded${d.avgTenureMonths != null ? `, avg tenure ${d.avgTenureMonths} mo` : ""}`);
  }
  return L.join("\n");
}
