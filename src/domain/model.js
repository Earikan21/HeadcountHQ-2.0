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

/** Days in a calendar month (month0 = 0..11). */
export const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/**
 * Parse a date to {year, month0, day, hasDay}. `hasDay` is false for a bare "YYYY-MM"
 * (a month with no specific day) so month-level dates aren't accidentally prorated.
 */
export function parseDay(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return { year: Number(m[1]), month0: Number(m[2]) - 1, day: m[3] ? Number(m[3]) : 1, hasDay: Boolean(m[3]) };
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : { year: d.getFullYear(), month0: d.getMonth(), day: d.getDate(), hasDay: true };
}

/** Shift a "YYYY-MM-DD" date by n months (for hiring slippage). Null stays null. */
function shiftMonthStr(dateStr, n) {
  const p = parseMonth(dateStr);
  if (!p) return dateStr;
  const abs = absOf(p.year, p.month0) + n;
  return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}-01`;
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
export function deriveWindow(employees, now = new Date(), horizonMonths = 60) {
  const starts = [];
  for (const e of employees) {
    // Don't stretch the window back for departed staff — with no end date they add
    // $0 and would otherwise create years of empty leading columns.
    if (String(e.employment_status || "").toLowerCase() === "inactive") continue;
    const p = parseMonth(e.start_date);
    if (p) starts.push(absOf(p.year, p.month0));
  }
  const nowAbs = absOf(now.getFullYear(), now.getMonth());
  const startAbs = starts.length ? Math.min(...starts, nowAbs) : absOf(now.getFullYear(), 0);
  // Look back to the earliest start, and forward FIVE years (60 months) from now.
  const hz = Math.max(12, Math.min(120, Number(horizonMonths) || 60));
  let endAbs = Math.max(nowAbs + hz, ...(starts.length ? starts.map((a) => a + 12) : [nowAbs + hz]));
  // Extend to December of that year so the final calendar year is whole — otherwise a
  // window ending mid-year (e.g. Jul 2031) sums only part of the year and the annual
  // total reads as roughly half of the real cost.
  endAbs = Math.floor(endAbs / 12) * 12 + 11;
  let months = endAbs - startAbs + 1;
  if (months > 180) {
    // Cap the span, but keep the last column on a December boundary.
    const lastAbs = startAbs + 180 - 1;
    months = 180 - (((lastAbs % 12) + 1) % 12);
  }
  months = Math.max(12, months);
  return { start: { year: Math.floor(startAbs / 12), month0: startAbs % 12 }, months };
}

/** Expand scenario hires into synthetic employee rows flagged _scenario. */
export function scenarioEmployees(scenarioHires = []) {
  const out = [];
  for (const h of scenarioHires || []) {
    // Post-migration a hire is exactly one person. `count` only survives for
    // un-migrated JSON; those rows are anonymous, so they get no editable identity.
    const count = Math.max(1, Math.min(200, Number(h.count) || 1));
    // Scenario windows are month-level: start on the 1st, end on the last day, so a
    // planned hire is counted for whole months (no accidental day proration).
    const start = h.start_month ? (String(h.start_month).length === 7 ? h.start_month + "-01" : String(h.start_month)) : null;
    let end = null;
    if (h.end_month) {
      const em = String(h.end_month);
      if (/^\d{4}-\d{2}$/.test(em)) { const [y, mo] = em.split("-").map(Number); end = `${em}-${String(daysInMonth(y, mo - 1)).padStart(2, "0")}`; }
      else end = em;
    }
    const role = h.role || "Scenario hire";
    for (let i = 0; i < count; i++) {
      out.push({
        name: h.name || role, job_title: role, department_name: h.department || "(scenario)",
        annual_salary: Number(h.annual_salary) || 0, start_date: start, end_date: end,
        employment_status: "active", _scenario: true,
        _hireId: count === 1 && h.id ? String(h.id) : null,
      });
    }
  }
  return out;
}

/** The only employee fields a plan may override. Anything else is roster truth. */
export const OVERRIDABLE_FIELDS = ["name", "start_date", "end_date", "annual_salary"];

/**
 * Layer a plan's sparse overrides onto the live roster, keyed by employee_ext_id.
 *
 * Pure: never mutates its input, and returns the original object when a person has
 * no override (so the common path allocates nothing). A key that is present but null
 * is a deliberate clear — "in this plan, this person never leaves" — which is why we
 * test for presence rather than truthiness. Overrides for people no longer on the
 * roster are simply ignored.
 */
export function applyPlanOverrides(employees = [], overrides = {}) {
  const map = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  if (!Object.keys(map).length) return employees;
  return employees.map((e) => {
    const o = map[e.employee_ext_id];
    if (!o || typeof o !== "object") return e;
    const patch = {}, marks = {};
    for (const f of OVERRIDABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(o, f)) { patch[f] = o[f] === "" ? null : o[f]; marks[f] = true; }
    }
    if (!Object.keys(patch).length) return e;
    return { ...e, ...patch, _overridden: marks };
  });
}

/** Resolve effective drivers for a department: per-department override, else the
 *  plan-global value, else the default. */
export function resolveAssumptions(assumptions, dept, fallbackMult) {
  const g = assumptions || {};
  const d = (g.byDept && g.byDept[dept]) || {};
  const pick = (k, dflt) => (d[k] != null && d[k] !== "" ? Number(d[k]) : (g[k] != null && g[k] !== "" ? Number(g[k]) : dflt));
  const mult = Number(d.loadedMultiplier) > 0 ? Number(d.loadedMultiplier)
    : (Number(g.loadedMultiplier) > 0 ? Number(g.loadedMultiplier) : (fallbackMult || 1));
  return {
    mult,
    growth: pick("salaryGrowthPct", 0),
    bonus: 1 + pick("bonusPct", 0) / 100,
    costPerHire: Math.max(0, pick("costPerHire", 0)),
    slip: Math.max(0, Math.min(24, pick("hiringSlipMonths", 0))),
  };
}

export function buildHeadcountModel({ employees = [], loadedMultiplier = 1.2, start, months, scenarioHires = [], now = new Date(), assumptions = {} } = {}) {
  const globalMult = Number(assumptions.loadedMultiplier) > 0 ? Number(assumptions.loadedMultiplier)
    : (Number(loadedMultiplier) > 0 ? Number(loadedMultiplier) : 1);
  const eff = (dept) => resolveAssumptions(assumptions, dept, globalMult);
  const scen = scenarioEmployees(scenarioHires).map((e) => {
    const s = eff(e.department_name).slip;
    return s && e.start_date ? { ...e, start_date: shiftMonthStr(e.start_date, s) } : e;
  });
  const all = employees.concat(scen);
  const horizonMonths = Math.max(12, Math.min(120, (Number(assumptions.horizonYears) || 5) * 12));
  if (!start || !months) { const w = deriveWindow(all, now, horizonMonths); start = start || w.start; months = months || w.months; }
  const cols = monthColumns(start, months);
  const startAbs = absOf(start.year, start.month0);
  const benefitsPct = Math.round((globalMult - 1) * 1000) / 10;
  const growthBaseYear = now.getFullYear();

  const roster = all.map((e) => {
    const ea = eff(e.department_name || "(none)");
    const annual = Number(e.annual_salary) || 0;
    const monthlyBase = annual / 12;
    const loadedMonthly = monthlyBase * ea.mult;
    const monthlyBenefits = loadedMonthly - monthlyBase;
    const inactive = String(e.employment_status || "").toLowerCase() === "inactive";
    const p = parseDay(e.start_date);
    const hireIdx = p ? absOf(p.year, p.month0) - startAbs : 0;
    const pe = parseDay(e.end_date);
    const endIdx = pe ? absOf(pe.year, pe.month0) - startAbs : Infinity;
    // A person can start and/or leave partway through a month; pay only the worked
    // fraction of those boundary months (whole months = 1). Day is honoured only when
    // the date actually carries one — see parseDay.hasDay.
    const startFrac = p && p.hasDay ? (daysInMonth(p.year, p.month0) - p.day + 1) / daysInMonth(p.year, p.month0) : 1;
    const endFrac = pe && pe.hasDay ? pe.day / daysInMonth(pe.year, pe.month0) : 1;
    const active = cols.map((c) => {
      if (inactive || c.index < hireIdx || c.index > endIdx) return 0;
      if (c.index === hireIdx && c.index === endIdx) return Math.max(0, Math.min(1, startFrac + endFrac - 1)); // start & leave same month
      if (c.index === hireIdx) return startFrac;
      if (c.index === endIdx) return endFrac;
      return 1;
    });
    const present = active.map((a) => (a > 0 ? 1 : 0)); // headcount is a person, not a fraction
    const monthlyCost = active.map((a, i) => a * loadedMonthly * ea.bonus * (ea.growth ? Math.pow(1 + ea.growth / 100, Math.max(0, cols[i].year - growthBaseYear)) : 1));
    if (ea.costPerHire && p && hireIdx >= 0 && hireIdx < months) monthlyCost[hireIdx] += ea.costPerHire;
    return {
      name: e.name || "", role: e.job_title || "", department: e.department_name || "(none)",
      status: inactive ? "Inactive" : "Active",
      annualBase: annual, monthlyBase, monthlyBenefits, loadedMonthly,
      hireMonthLabel: hireIdx > 0 && hireIdx < months ? cols[hireIdx].fullLabel : (hireIdx <= 0 ? "From start" : "After window"),
      id: e.id != null ? e.id : null, extId: e.employee_ext_id || "",
      hireId: e._hireId || null, overridden: e._overridden || null,
      loadPct: Math.round((ea.mult - 1) * 1000) / 10, bonusPct: Math.round((ea.bonus - 1) * 1000) / 10,
      growthPct: ea.growth || 0, costPerHire: ea.costPerHire || 0,
      startDate: e.start_date || "", endDate: e.end_date || "", scenario: !!e._scenario, active, present, monthlyCost,
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
    monthlyHeadcount[i] += r.present[i];
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

  return { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, mult: globalMult, years, months, start };
}

/**
 * Group the display buckets by calendar year, keeping their positions. Lives here
 * (not in the view) because the autosave endpoint recomputes the same cells.
 */
export function yearGroupsOf(cols, buckets) {
  const groups = [];
  buckets.forEach((b, i) => {
    const yr = cols[b.idxs[0]].year;
    let g = groups[groups.length - 1];
    if (!g || g.year !== yr) { g = { year: yr, pos: [] }; groups.push(g); }
    g.pos.push(i);
  });
  return groups;
}

/**
 * The mini-dashboard's raw numbers. Returned unformatted so the view and the
 * autosave endpoint format them identically from one source of truth.
 */
export function modelKpis(model, now = new Date()) {
  const { cols, totalMonthlyCost, monthlyHeadcount, departments } = model;
  let nowIdx = cols.findIndex((c) => c.year === now.getFullYear() && c.month0 === now.getMonth());
  if (nowIdx < 0) nowIdx = Math.max(0, cols.length - 1);
  const nowLabel = cols.length ? cols[nowIdx].fullLabel : "";
  const curHc = monthlyHeadcount[nowIdx] || 0;
  const thisYear = cols.length ? cols[nowIdx].year : now.getFullYear();
  const thisYearCost = cols.reduce((a, c, i) => a + (c.year === thisYear ? totalMonthlyCost[i] : 0), 0);
  const endI = Math.min(nowIdx + 11, cols.length - 1);
  const next12Cost = totalMonthlyCost.slice(nowIdx, endI + 1).reduce((a, b) => a + b, 0);
  const hc12 = monthlyHeadcount[Math.min(nowIdx + 12, cols.length - 1)] || 0;
  return {
    nowIdx, nowLabel, curHc, thisYear, thisYearCost, next12Cost,
    netNew: hc12 - curHc,
    avgHead: curHc ? Math.round((totalMonthlyCost[nowIdx] || 0) / curHc) : 0,
    deptCount: departments.length,
  };
}

/**
 * A fingerprint of the grid a page rendered. Editing a start date can move the window
 * (and so the number of columns and years); an autosave patch that assumed otherwise
 * would silently write numbers into the wrong cells. The client compares this against
 * what it rendered and reloads on a mismatch.
 */
export function windowKey(model, period = "month") {
  return `${model.start.year}-${model.start.month0}-${model.months}-${period}`;
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
