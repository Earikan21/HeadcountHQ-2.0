/**
 * Comparing two versions of the future.
 *
 * Any two of {Actual, plan A, plan B, ...} can be put side by side. The only subtlety
 * is that each plan derives its own window — a plan with a 10-year horizon and a plan
 * with a 3-year horizon do not describe the same years — so the caller must build both
 * models over an *identical* window before handing them here. `alignedWindow()` works
 * out what that window has to be; `comparePlans()` then assumes the years line up and
 * says so loudly if they don't.
 */
import { deriveWindow, scenarioEmployees, applyPlanOverrides } from "./model.js";

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * The window that can hold both sides: the earliest start either one implies, run out
 * to the longer of the two horizons. Everyone a plan invents counts, because a hire in
 * 2031 has to be visible even if nobody on the roster reaches that far.
 */
export function alignedWindow(sides, now = new Date()) {
  const people = [];
  let horizonYears = 1;
  for (const s of sides) {
    people.push(...applyPlanOverrides(s.employees || [], s.overrides || {}));
    people.push(...scenarioEmployees(s.hires || []));
    horizonYears = Math.max(horizonYears, Number((s.assumptions || {}).horizonYears) || 5);
  }
  const w = deriveWindow(people, now, Math.max(12, Math.min(120, horizonYears * 12)));
  return { start: w.start, months: w.months };
}

/**
 * Diff two already-built models. `a` is the baseline; deltas read "b minus a".
 * Returns per-year rows, whole-window totals, and a per-department cost diff.
 */
export function comparePlans(a, b) {
  const years = a.model.years.map((ya) => {
    const yb = b.model.years.find((y) => y.year === ya.year);
    if (!yb) throw new Error(`compare: models are not aligned (year ${ya.year} missing)`);
    return {
      year: ya.year,
      months: ya.months,
      aHeadcount: ya.yearEndHc,
      bHeadcount: yb.yearEndHc,
      dHeadcount: yb.yearEndHc - ya.yearEndHc,
      aCost: Math.round(ya.totalCost),
      bCost: Math.round(yb.totalCost),
      dCost: Math.round(yb.totalCost - ya.totalCost),
      pctCost: pct(yb.totalCost, ya.totalCost),
    };
  });

  const aTotal = Math.round(sum(a.model.totalMonthlyCost));
  const bTotal = Math.round(sum(b.model.totalMonthlyCost));

  const names = [...new Set([...a.model.departments, ...b.model.departments])].sort();
  const deptCost = (m, d) => Math.round(sum(m.deptMonthlyCost[d] || []));
  const departments = names.map((d) => {
    const av = deptCost(a.model, d), bv = deptCost(b.model, d);
    return { department: d, aCost: av, bCost: bv, dCost: bv - av, pctCost: pct(bv, av) };
  }).sort((x, y) => Math.abs(y.dCost) - Math.abs(x.dCost));

  const peak = (m) => (m.monthlyHeadcount.length ? Math.max(...m.monthlyHeadcount) : 0);
  const endHc = (m) => (m.monthlyHeadcount.length ? m.monthlyHeadcount[m.monthlyHeadcount.length - 1] : 0);

  return {
    aLabel: a.label,
    bLabel: b.label,
    years,
    departments,
    totals: {
      aCost: aTotal, bCost: bTotal, dCost: bTotal - aTotal, pctCost: pct(bTotal, aTotal),
      aPeakHeadcount: peak(a.model), bPeakHeadcount: peak(b.model),
      aEndHeadcount: endHc(a.model), bEndHeadcount: endHc(b.model),
      dEndHeadcount: endHc(b.model) - endHc(a.model),
    },
  };
}
