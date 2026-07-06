/**
 * Headcount financial model (Directive 4.0). A pure builder that turns the live
 * roster into a month-by-month "build": each person's fully-loaded monthly cost and
 * an active flag per month (1 from their hire month onward), then rolls up monthly
 * cost by department and an annual summary. No I/O — the route passes in the roster
 * and the fully-loaded multiplier from settings.
 */

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parse "YYYY-MM-DD" (or anything Date understands) to {year, month0} or null. */
export function parseMonth(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: Number(m[1]), month0: Number(m[2]) - 1 };
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : { year: d.getFullYear(), month0: d.getMonth() };
}

/** Month columns for a window starting at (startYear, Jan) spanning `months`. */
export function monthColumns(startYear, months = 24) {
  const cols = [];
  for (let i = 0; i < months; i++) {
    const year = startYear + Math.floor(i / 12);
    const month0 = i % 12;
    cols.push({
      index: i, year, month0,
      label: `${MONTH_ABBR[month0]} ${String(year).slice(2)}`,
      fullLabel: `${MONTH_ABBR[month0]}-${year}`,
    });
  }
  return cols;
}

/**
 * @param {object} o
 * @param {Array} o.employees roster rows (need annual_salary, start_date, department_name, job_title, name, employment_status)
 * @param {number} o.loadedMultiplier fully-loaded multiplier (1.2 == +20% benefits/taxes)
 * @param {number} o.startYear window start year (window is Jan of startYear)
 * @param {number} [o.months] window length (default 24)
 */
export function buildHeadcountModel({ employees = [], loadedMultiplier = 1.2, startYear, months = 24 } = {}) {
  const cols = monthColumns(startYear, months);
  const mult = Number(loadedMultiplier) > 0 ? Number(loadedMultiplier) : 1;
  const benefitsPct = Math.round((mult - 1) * 1000) / 10;

  const roster = employees.map((e) => {
    const annual = Number(e.annual_salary) || 0;
    const monthlyBase = annual / 12;
    const loadedMonthly = monthlyBase * mult;
    const monthlyBenefits = loadedMonthly - monthlyBase;
    const inactive = String(e.employment_status || "").toLowerCase() === "inactive";
    const start = parseMonth(e.start_date);
    const hireIdx = start ? (start.year - startYear) * 12 + start.month0 : 0; // no date => employed at window start
    const active = cols.map((c) => (!inactive && c.index >= hireIdx ? 1 : 0));
    const monthlyCost = active.map((a) => a * loadedMonthly);
    return {
      name: e.name || "", role: e.job_title || "", department: e.department_name || "(none)",
      status: inactive ? "Inactive" : "Active",
      annualBase: annual, monthlyBase, monthlyBenefits, loadedMonthly,
      hireMonthLabel: hireIdx > 0 && hireIdx < months ? cols[hireIdx].fullLabel : (hireIdx <= 0 ? "From start" : "After window"),
      startDate: e.start_date || "",
      active, monthlyCost,
    };
  });

  // sort by department then role for a clean, grouped grid
  roster.sort((a, b) => a.department.localeCompare(b.department) || a.role.localeCompare(b.role));

  const departments = [...new Set(roster.map((r) => r.department))].sort();
  const deptMonthlyCost = {};
  for (const d of departments) deptMonthlyCost[d] = cols.map(() => 0);
  const totalMonthlyCost = cols.map(() => 0);
  const monthlyHeadcount = cols.map(() => 0);
  for (const r of roster) {
    for (let i = 0; i < cols.length; i++) {
      deptMonthlyCost[r.department][i] += r.monthlyCost[i];
      totalMonthlyCost[i] += r.monthlyCost[i];
      monthlyHeadcount[i] += r.active[i];
    }
  }

  const years = [];
  for (let y = 0; y * 12 < months; y++) {
    const startI = y * 12, endI = Math.min(startI + 12, months);
    const span = endI - startI;
    const totalCost = totalMonthlyCost.slice(startI, endI).reduce((a, b) => a + b, 0);
    const hcSeries = monthlyHeadcount.slice(startI, endI);
    const avgHc = span ? Math.round(hcSeries.reduce((a, b) => a + b, 0) / span) : 0;
    const yearEndHc = monthlyHeadcount[endI - 1] || 0;
    const avgCostPerHead = avgHc ? Math.round(totalCost / span / avgHc) : 0;
    years.push({ year: startYear + y, totalCost, avgHc, yearEndHc, avgCostPerHead });
  }

  return { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, mult, years, months, startYear };
}
