/**
 * Planning engine — pure, no DB. Projects a hiring scenario month by month to
 * show time-phased headcount, fully-loaded cost, revenue, net burn, cash, and
 * RUNWAY. Revenue from new hires is DERIVED, not typed: only Sales-function
 * departments generate revenue, via a sales-capacity model (new reps ramp into
 * bookings). The "case" (conservative/base/aggressive) maps to quota attainment.
 * Researched defaults: ~$800k bookings per ramped rep, ~5-month ramp, attainment
 * ~60/70/80%. Non-sales functions are cost centers (no fabricated revenue).
 */

export const PACES = ["all_at_once", "even", "quarterly"];
export const PACE_LABELS = { all_at_once: "All at once", even: "Even ramp", quarterly: "Quarterly" };
export const OUTCOMES = ["conservative", "base", "aggressive"];
export const OUTCOME_LABELS = { conservative: "Conservative", base: "Base", aggressive: "Aggressive" };

/** Cumulative new hires by the END of month index m (0-based). */
export function hiresByMonth(total, startMonth, pace, horizon, m) {
  total = Math.max(0, Math.round(Number(total) || 0));
  startMonth = Math.max(0, Math.round(Number(startMonth) || 0));
  if (total === 0 || m < startMonth) return 0;
  if (pace === "all_at_once") return total;
  const span = Math.max(1, horizon - startMonth);
  if (pace === "quarterly") {
    const perQuarter = Math.ceil(total / Math.ceil(span / 3));
    return Math.min(total, (Math.floor((m - startMonth) / 3) + 1) * perQuarter);
  }
  return Math.min(total, Math.round((total * (m - startMonth + 1)) / span)); // even
}

const hiresInMonth = (total, start, pace, H, j) =>
  hiresByMonth(total, start, pace, H, j) - (j > 0 ? hiresByMonth(total, start, pace, H, j - 1) : 0);

/** Linear ramp: 0 before start; reaches full (1.0) after `ramp` months. */
const rampFactor = (monthsSinceStart, ramp) =>
  monthsSinceStart < 0 ? 0 : Math.min(1, (monthsSinceStart + 1) / Math.max(1, ramp));

const attainmentOf = (fin, outcome) => {
  const pct = outcome === "conservative" ? fin.attainment_conservative_pct
    : outcome === "aggressive" ? fin.attainment_aggressive_pct
    : fin.attainment_base_pct;
  return (Number(pct) || 0) / 100;
};

const isSales = (cat) => cat === "sm";

/**
 * @param {object} p.financials  cash_balance, monthly_burn, monthly_revenue,
 *   revenue_growth_pct, comp_inflation_pct, horizon_months, bookings_per_rep,
 *   sales_ramp_months, attainment_{conservative,base,aggressive}_pct
 * @param {Array} p.departments  [{ id, name, category, currentHeadcount, currentMonthlyCost }]
 * @param {Array} p.items        [{ department_id, new_hires, start_month, pace, cost_per_hire, outcome }]
 */
export function projectScenario({ financials = {}, departments = [], items = [], horizon }) {
  const H = Math.max(1, Math.round(Number(horizon) || Number(financials.horizon_months) || 24));
  const inflation = (Number(financials.comp_inflation_pct) || 0) / 100;
  const revGrowth = (Number(financials.revenue_growth_pct) || 0) / 100;
  const ramp = Math.max(1, Number(financials.sales_ramp_months) || 5);
  const bookingsPerRep = Number(financials.bookings_per_rep) || 0;
  const byDeptItem = new Map(items.map((i) => [i.department_id, i]));

  let cash = Number(financials.cash_balance) || 0;
  let runwayMonths = null;
  const months = [];

  for (let m = 0; m < H; m++) {
    let headcount = 0, hcCost = 0, incrementalBookings = 0;
    for (const d of departments) {
      const it = byDeptItem.get(d.id);
      const addedCum = it ? hiresByMonth(it.new_hires, it.start_month, it.pace, H, m) : 0;
      headcount += (d.currentHeadcount || 0) + addedCum;
      const monthlyBase = (d.currentMonthlyCost || 0) + addedCum * ((Number(it?.cost_per_hire) || 0) / 12);
      hcCost += monthlyBase * (1 + inflation * (m / 12));

      // Sales departments: new reps ramp into bookings (derived, not typed).
      if (it && isSales(d.category) && bookingsPerRep > 0) {
        const monthlyFull = (bookingsPerRep / 12) * attainmentOf(financials, it.outcome);
        let rampedReps = 0;
        for (let j = 0; j <= m; j++) rampedReps += hiresInMonth(it.new_hires, it.start_month, it.pace, H, j) * rampFactor(m - j, ramp);
        incrementalBookings += rampedReps * monthlyFull;
      }
    }
    const revenue = (Number(financials.monthly_revenue) || 0) * (1 + revGrowth * (m / 12)) + incrementalBookings;
    const netBurn = hcCost + (Number(financials.monthly_burn) || 0) - revenue;
    cash -= netBurn;
    if (runwayMonths === null && cash < 0) runwayMonths = m;
    months.push({ month: m, headcount, headcountCost: Math.round(hcCost), revenue: Math.round(revenue), netBurn: Math.round(netBurn), cash: Math.round(cash) });
  }

  // End-state incremental annual bookings (full ramp) per sales dept + a band.
  const band = { conservative: 0, base: 0, aggressive: 0 };
  const byDept = departments.map((d) => {
    const it = byDeptItem.get(d.id);
    const newHires = Math.max(0, Math.round(Number(it?.new_hires) || 0));
    const sales = it && isSales(d.category) && bookingsPerRep > 0;
    const annualAt = (oc) => newHires * bookingsPerRep * attainmentOf(financials, oc);
    if (sales) {
      band.conservative += annualAt("conservative");
      band.base += annualAt("base");
      band.aggressive += annualAt("aggressive");
    }
    const outcome = OUTCOMES.includes(it?.outcome) ? it.outcome : "base";
    return {
      id: d.id, name: d.name, category: d.category, newHires,
      addedAnnualCost: Math.round(newHires * (Number(it?.cost_per_hire) || 0)),
      endHeads: (d.currentHeadcount || 0) + newHires, outcome,
      revenueImpact: sales ? Math.round(annualAt(outcome)) : null,
    };
  });
  const selectedRevenue = byDept.reduce((a, d) => a + (d.revenueImpact || 0), 0);

  const last = months[months.length - 1];
  const summary = {
    horizon: H,
    totalNewHires: byDept.reduce((a, d) => a + d.newHires, 0),
    endHeadcount: last ? last.headcount : departments.reduce((a, d) => a + (d.currentHeadcount || 0), 0),
    endMonthlyNetBurn: last ? last.netBurn : 0,
    addedAnnualCost: byDept.reduce((a, d) => a + d.addedAnnualCost, 0),
    runwayMonths,
    endCash: last ? last.cash : Math.round(cash),
    revenue: { selected: Math.round(selectedRevenue), conservative: Math.round(band.conservative), base: Math.round(band.base), aggressive: Math.round(band.aggressive), hasSales: band.base > 0 },
  };
  return { months, byDept, summary };
}
