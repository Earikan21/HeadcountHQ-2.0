/**
 * Headcount financial model (Directive 4.0). Pure builder turning the live roster
 * into a month-by-month build: each person's fully-loaded monthly cost, active over
 * the window from their start month. Rolls up cost by department, supports period
 * aggregation (month / quarter / year), scenario hires, and an annual summary.
 */
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const absOf = (year, month0) => year * 12 + month0;

/** Parse "YYYY-MM-DD" (or a Date string) to {year, month0} or null. */
export function parseMonth(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: Number(m[1]), month0: Number(m[2]) - 1 };
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : { year: d.getFullYear(), month0: d.getMonth() };
}

/** Month columns for a window starting at {year, month0} spanning `months`. */
export function monthColumns(start, months) {
  const base = absOf(start.year, start.month0);
  const cols = [];
  for (let i = 0; i < months; i++) {
    const abs = base + i, year = Math.floor(abs / 12), month0 = abs % 12;
    cols.push({ index: i, year, month0, label: `${MONTH_ABBR[month0]} ${String(year).slice(2)}`, fullLabel: `${MONTH_ABBR[month0]}-${year}` });
  }
  return cols;
}

/** Derive a window from the roster: from the earliest start month (item 7) through
 *  a year past the latest hire, so past and future are both visible. */
export function deriveWindow(employees, now = new Date()) {
  const starts = [];
  for (const e of employees) { const p = parseMonth(e.start_date); if (p) starts.push(absOf(p.year, p.month0)); }
  const nowAbs = absOf(now.getFullYear(), now.getMonth());
  const startAbs = starts.length ? Math.min(...starts, nowAbs) : absOf(now.getFullYear(), 0);
  // Look back to the earliest start, and forward FIVE years (60 months) from now.
  const endAbs = Math.max(nowAbs + 60, ...(starts.length ? starts.map((a) => a + 12) : [nowAbs + 60]));
  let months = endAbs - startAbs + 1;
  months = Math.max(24, Math.min(132, months));
  return { start: { year: Math.floor(startAbs / 12), month0: startAbs % 12 }, months };
}

/** Expand scenario hires into synthetic employee rows flagged _scenario. */
export function scenarioEmployees(scenarioHires = []) {
  const out = [];
  for (const h of scenarioHires || []) {
    const count = Math.max(1, Math.min(200, Number(h.count) || 1));
    const start = h.start_month ? (String(h.start_month).length === 7 ? h.start_month + "-01" : String(h.start_month)) : null;
    for (let i = 0; i < count; i++) {
      out.push({ name: h.role || "Scenario hire", job_title: h.role || "Scenario hire", department_name: h.department || "(scenario)", annual_salary: Number(h.annual_salary) || 0, start_date: start, employment_status: "active", _scenario: true });
    }
  }
  return out;
}

export function buildHeadcountModel({ employees = [], loadedMultiplier = 1.2, start, months, scenarioHires = [], now = new Date() } = {}) {
  const all = employees.concat(scenarioEmployees(scenarioHires));
  if (!start || !months) { const w = deriveWindow(all, now); start = start || w.start; months = months || w.months; }
  const cols = monthColumns(start, months);
  const startAbs = absOf(start.year, start.month0);
  const mult = Number(loadedMultiplier) > 0 ? Number(loadedMultiplier) : 1;
  const benefitsPct = Math.round((mult - 1) * 1000) / 10;

  const roster = all.map((e) => {
    const annual = Number(e.annual_salary) || 0;
    const monthlyBase = annual / 12;
    const loadedMonthly = monthlyBase * mult;
    const monthlyBenefits = loadedMonthly - monthlyBase;
    const inactive = String(e.employment_status || "").toLowerCase() === "inactive";
    const p = parseMonth(e.start_date);
    const hireIdx = p ? absOf(p.year, p.month0) - startAbs : 0;
    const active = cols.map((c) => (!inactive && c.index >= hireIdx ? 1 : 0));
    const monthlyCost = active.map((a) => a * loadedMonthly);
    return {
      name: e.name || "", role: e.job_title || "", department: e.department_name || "(none)",
      status: inactive ? "Inactive" : "Active",
      annualBase: annual, monthlyBase, monthlyBenefits, loadedMonthly,
      hireMonthLabel: hireIdx > 0 && hireIdx < months ? cols[hireIdx].fullLabel : (hireIdx <= 0 ? "From start" : "After window"),
      id: e.id != null ? e.id : null, extId: e.employee_ext_id || "",
      startDate: e.start_date || "", scenario: !!e._scenario, active, monthlyCost,
    };
  });
  roster.sort((a, b) => a.department.localeCompare(b.department) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

  const departments = [...new Set(roster.map((r) => r.department))].sort();
  const deptMonthlyCost = {};
  for (const d of departments) deptMonthlyCost[d] = cols.map(() => 0);
  const totalMonthlyCost = cols.map(() => 0);
  const monthlyHeadcount = cols.map(() => 0);
  for (const r of roster) for (let i = 0; i < cols.length; i++) {
    deptMonthlyCost[r.department][i] += r.monthlyCost[i];
    totalMonthlyCost[i] += r.monthlyCost[i];
    monthlyHeadcount[i] += r.active[i];
  }

  // annual summary over each calendar year in the window
  const yearsSet = [...new Set(cols.map((c) => c.year))];
  const years = yearsSet.map((yr) => {
    const idxs = cols.filter((c) => c.year === yr).map((c) => c.index);
    const totalCost = idxs.reduce((a, i) => a + totalMonthlyCost[i], 0);
    const hc = idxs.map((i) => monthlyHeadcount[i]);
    const avgHc = hc.length ? Math.round(hc.reduce((a, b) => a + b, 0) / hc.length) : 0;
    const yearEndHc = monthlyHeadcount[idxs[idxs.length - 1]] || 0;
    const avgCostPerHead = avgHc ? Math.round(totalCost / idxs.length / avgHc) : 0;
    return { year: yr, totalCost, avgHc, yearEndHc, avgCostPerHead, months: idxs.length };
  });

  return { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, mult, years, months, start };
}

/** Group month columns into display periods (item 9): month | quarter | year. */
export function periodBuckets(cols, period = "month") {
  if (period === "year") {
    const by = new Map();
    for (const c of cols) { if (!by.has(c.year)) by.set(c.year, []); by.get(c.year).push(c.index); }
    return [...by.entries()].map(([y, idxs]) => ({ label: String(y), idxs }));
  }
  if (period === "quarter") {
    const by = new Map();
    for (const c of cols) { const q = Math.floor(c.month0 / 3) + 1; const key = `${c.year}-Q${q}`; if (!by.has(key)) by.set(key, { label: `Q${q} '${String(c.year).slice(2)}`, idxs: [] }); by.get(key).idxs.push(c.index); }
    return [...by.values()];
  }
  return cols.map((c) => ({ label: c.label, idxs: [c.index] }));
}

/** Aggregate a monthly series into period buckets. mode 'sum' (cost) or 'end' (headcount). */
export function periodize(monthly, buckets, mode = "sum") {
  return buckets.map((b) => mode === "end" ? monthly[b.idxs[b.idxs.length - 1]] : b.idxs.reduce((a, i) => a + (monthly[i] || 0), 0));
}
