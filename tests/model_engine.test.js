import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel, monthColumns } from "../src/domain/model.js";

test("month columns span a 24-month window", () => {
  const cols = monthColumns(2026, 24);
  assert.equal(cols.length, 24);
  assert.equal(cols[0].fullLabel, "Jan-2026");
  assert.equal(cols[23].fullLabel, "Dec-2027");
});

test("existing employee (no start date) is active every month at fully-loaded cost", () => {
  const m = buildHeadcountModel({ employees: [{ name: "A", job_title: "CEO", department_name: "Leadership", annual_salary: 240000, employment_status: "active" }], loadedMultiplier: 1.2, startYear: 2026 });
  const r = m.roster[0];
  assert.equal(r.monthlyBase, 20000);
  assert.equal(r.loadedMonthly, 24000);
  assert.equal(r.monthlyBenefits, 4000);
  assert.equal(r.active[0], 1);
  assert.equal(r.active[23], 1);
  assert.equal(m.benefitsPct, 20);
  assert.equal(m.totalMonthlyCost[0], 24000);
});

test("a future hire is 0 until its hire month, then 1", () => {
  const m = buildHeadcountModel({ employees: [{ name: "B", job_title: "AE", department_name: "Sales", annual_salary: 120000, start_date: "2026-04-01", employment_status: "active" }], loadedMultiplier: 1.2, startYear: 2026 });
  const r = m.roster[0];
  assert.equal(r.active[0], 0);
  assert.equal(r.active[2], 0);
  assert.equal(r.active[3], 1);
  assert.equal(m.monthlyHeadcount[3], 1);
  assert.equal(r.hireMonthLabel, "Apr-2026");
});

test("annual summary rolls up per year", () => {
  const m = buildHeadcountModel({ employees: [{ name: "A", department_name: "Leadership", annual_salary: 240000, employment_status: "active" }], loadedMultiplier: 1.2, startYear: 2026 });
  assert.equal(m.years.length, 2);
  assert.equal(m.years[0].year, 2026);
  assert.equal(m.years[0].totalCost, 24000 * 12);
  assert.equal(m.years[0].yearEndHc, 1);
  assert.equal(m.years[0].avgHc, 1);
  assert.equal(m.years[0].avgCostPerHead, 24000);
});

test("inactive employees contribute no cost or headcount", () => {
  const m = buildHeadcountModel({ employees: [{ name: "C", department_name: "G&A", annual_salary: 120000, employment_status: "inactive" }], loadedMultiplier: 1.3, startYear: 2026 });
  assert.equal(m.roster[0].active[0], 0);
  assert.equal(m.totalMonthlyCost[0], 0);
});
