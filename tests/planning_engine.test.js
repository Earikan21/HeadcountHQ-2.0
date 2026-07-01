import { test } from "node:test";
import assert from "node:assert/strict";
import { hiresByMonth, projectScenario } from "../src/domain/planning.js";

test("hiresByMonth: all-at-once lands fully at the start month", () => {
  assert.equal(hiresByMonth(6, 3, "all_at_once", 12, 2), 0);
  assert.equal(hiresByMonth(6, 3, "all_at_once", 12, 3), 6);
  assert.equal(hiresByMonth(6, 3, "all_at_once", 12, 11), 6);
});

test("hiresByMonth: even ramp builds linearly to the total", () => {
  // 6 hires from month 0 across 12 months
  assert.equal(hiresByMonth(6, 0, "even", 12, 0), 1); // ~0.5 -> rounds to 1 by end of m0
  const end = hiresByMonth(6, 0, "even", 12, 11);
  assert.equal(end, 6);
});

test("hiresByMonth: quarterly adds in chunks", () => {
  assert.equal(hiresByMonth(8, 0, "quarterly", 12, 0), 2); // 4 quarters -> 2/quarter
  assert.equal(hiresByMonth(8, 0, "quarterly", 12, 3), 4);
  assert.equal(hiresByMonth(8, 0, "quarterly", 12, 11), 8);
});

test("projectScenario: runway is the month cash goes negative", () => {
  const r = projectScenario({
    financials: { cash_balance: 1000000, monthly_burn: 100000, monthly_revenue: 0, horizon_months: 24 },
    departments: [{ id: 1, name: "Eng", currentHeadcount: 0, currentMonthlyCost: 0 }],
    items: [],
  });
  // pure 100k/mo burn on 1M cash -> negative at month 10 (cash after m9 = 0, m10 < 0)
  assert.equal(r.summary.runwayMonths, 10);
});

test("projectScenario: hiring adds time-phased cost and shortens runway", () => {
  const base = projectScenario({
    financials: { cash_balance: 1200000, monthly_burn: 0, horizon_months: 24 },
    departments: [{ id: 1, name: "Eng", currentHeadcount: 0, currentMonthlyCost: 0 }],
    items: [{ department_id: 1, new_hires: 12, start_month: 0, pace: "all_at_once", cost_per_hire: 120000 }],
  });
  // 12 hires x 120k = 1.44M/yr = 120k/mo -> 1.2M cash lasts 10 months
  assert.equal(base.summary.runwayMonths, 10);
  assert.equal(base.summary.addedAnnualCost, 1440000);
  assert.equal(base.summary.endHeadcount, 12);
});

test("sales hires ramp into incremental bookings; the case sets attainment", () => {
  const r = projectScenario({
    financials: { cash_balance: 10000000, horizon_months: 12, monthly_revenue: 0,
      bookings_per_rep: 1200000, sales_ramp_months: 1,
      attainment_conservative_pct: 50, attainment_base_pct: 100, attainment_aggressive_pct: 150 },
    departments: [{ id: 1, name: "Sales", category: "sm", currentHeadcount: 0, currentMonthlyCost: 0 }],
    items: [{ department_id: 1, new_hires: 2, start_month: 0, pace: "all_at_once", cost_per_hire: 0, outcome: "base" }],
  });
  assert.equal(r.summary.revenue.base, 2400000);        // 2 reps x 1.2M x 100%
  assert.equal(r.summary.revenue.conservative, 1200000); // x50%
  assert.equal(r.summary.revenue.aggressive, 3600000);   // x150%
  assert.equal(r.summary.revenue.selected, 2400000);     // chosen case = base
  assert.ok(r.summary.revenue.hasSales);
});

test("non-sales departments generate no modeled revenue (cost centers)", () => {
  const r = projectScenario({
    financials: { cash_balance: 1, horizon_months: 6, bookings_per_rep: 1000000 },
    departments: [{ id: 1, name: "Eng", category: "rnd", currentHeadcount: 0, currentMonthlyCost: 0 }],
    items: [{ department_id: 1, new_hires: 5, start_month: 0, pace: "all_at_once", outcome: "aggressive" }],
  });
  assert.equal(r.summary.revenue.base, 0);
  assert.equal(r.byDept[0].revenueImpact, null);
});

test("each Sales department's case drives the selected revenue", () => {
  const r = projectScenario({
    financials: { cash_balance: 1, horizon_months: 12, bookings_per_rep: 1000000, sales_ramp_months: 1,
      attainment_conservative_pct: 50, attainment_base_pct: 100, attainment_aggressive_pct: 200 },
    departments: [
      { id: 1, name: "SMB", category: "sm", currentHeadcount: 0, currentMonthlyCost: 0 },
      { id: 2, name: "Ent", category: "sm", currentHeadcount: 0, currentMonthlyCost: 0 },
    ],
    items: [
      { department_id: 1, new_hires: 1, start_month: 0, pace: "all_at_once", outcome: "conservative" }, // 500k
      { department_id: 2, new_hires: 1, start_month: 0, pace: "all_at_once", outcome: "aggressive" },     // 2M
    ],
  });
  assert.equal(r.summary.revenue.selected, 2500000);
});

test("sales ramp delays bookings (revenue builds over months)", () => {
  const r = projectScenario({
    financials: { cash_balance: 10000000, horizon_months: 6, monthly_revenue: 0,
      bookings_per_rep: 1200000, sales_ramp_months: 3, attainment_base_pct: 100 },
    departments: [{ id: 1, name: "Sales", category: "sm", currentHeadcount: 0, currentMonthlyCost: 0 }],
    items: [{ department_id: 1, new_hires: 1, start_month: 0, pace: "all_at_once", outcome: "base" }],
  });
  assert.ok(r.months[0].revenue < r.months[2].revenue, "ramps up");
  assert.equal(r.months[2].revenue, 100000); // fully ramped monthly = 1.2M/12
});
