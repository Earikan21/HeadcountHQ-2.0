import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel, monthColumns, periodBuckets, periodize } from "../src/domain/model.js";

const JAN26 = { year: 2026, month0: 0 };

test("month columns span a 24-month window", () => {
  const cols = monthColumns(JAN26, 24);
  assert.equal(cols.length, 24);
  assert.equal(cols[0].fullLabel, "Jan-2026");
  assert.equal(cols[23].fullLabel, "Dec-2027");
});

test("existing employee (no start date) is active every month at fully-loaded cost", () => {
  const m = buildHeadcountModel({ employees: [{ name: "A", job_title: "CEO", department_name: "Leadership", annual_salary: 240000, employment_status: "active" }], loadedMultiplier: 1.2, start: JAN26, months: 24 });
  const r = m.roster[0];
  assert.equal(r.monthlyBase, 20000);
  assert.equal(r.loadedMonthly, 24000);
  assert.equal(r.active[0], 1);
  assert.equal(r.active[23], 1);
  assert.equal(r.monthlyCost[0], 24000); // cost cell, not a flag (item 8)
  assert.equal(m.benefitsPct, 20);
});

test("a future hire is 0 until its hire month, then active", () => {
  const m = buildHeadcountModel({ employees: [{ name: "B", job_title: "AE", department_name: "Sales", annual_salary: 120000, start_date: "2026-04-01", employment_status: "active" }], loadedMultiplier: 1.2, start: JAN26, months: 24 });
  const r = m.roster[0];
  assert.equal(r.active[0], 0);
  assert.equal(r.active[3], 1);
  assert.equal(r.monthlyCost[0], 0);
  assert.equal(r.hireMonthLabel, "Apr-2026");
});

test("window is derived from the earliest start date (item 7)", () => {
  const m = buildHeadcountModel({ employees: [{ name: "A", department_name: "Eng", annual_salary: 120000, start_date: "2025-03-01", employment_status: "active" }], loadedMultiplier: 1.2, now: new Date("2026-07-15") });
  assert.deepEqual(m.start, { year: 2025, month0: 2 });
  assert.equal(m.cols[0].fullLabel, "Mar-2025");
});

test("period buckets aggregate months into quarters and years", () => {
  const cols = monthColumns(JAN26, 24);
  const q = periodBuckets(cols, "quarter");
  const y = periodBuckets(cols, "year");
  assert.equal(q.length, 8);
  assert.equal(q[0].label, "Q1 '26");
  assert.equal(y.length, 2);
  assert.deepEqual(y.map((b) => b.label), ["2026", "2027"]);
  const monthly = cols.map(() => 1000);
  assert.equal(periodize(monthly, y, "sum")[0], 12000); // 12 months summed
  assert.equal(periodize(monthly, q, "sum")[0], 3000);  // 3 months summed
});

test("annual summary rolls up per calendar year", () => {
  const m = buildHeadcountModel({ employees: [{ name: "A", department_name: "Leadership", annual_salary: 240000, employment_status: "active" }], loadedMultiplier: 1.2, start: JAN26, months: 24 });
  assert.equal(m.years.length, 2);
  assert.equal(m.years[0].year, 2026);
  assert.equal(m.years[0].totalCost, 24000 * 12);
  assert.equal(m.years[0].yearEndHc, 1);
});
