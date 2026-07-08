import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, metricsText } from "../src/domain/metrics.js";

const emps = [
  { department_name: "Engineering", annual_salary: 100000, employment_status: "active", start_date: "2024-01-01" },
  { department_name: "Engineering", annual_salary: 200000, employment_status: "active", start_date: "2025-01-01" },
  { department_name: "Sales", annual_salary: 100000, employment_status: "active", start_date: "2026-01-01" },
];
const rollup = { totals: { active: 3, approved: 3, open: 0 }, departments: [{ department: "Engineering", active: 2 }, { department: "Sales", active: 1 }] };
const m = computeMetrics({ employees: emps, settings: { loaded_cost_multiplier: 1.2 }, rollup, now: new Date("2026-07-15") });

test("company-level metrics", () => {
  assert.equal(m.company.headcount, 3);
  assert.equal(m.company.avgBase, 133333);
  assert.equal(m.company.totalBase, 400000);
  assert.equal(m.company.totalLoaded, 480000);
});

test("per-department averages, medians, ranges and shares", () => {
  const eng = m.departments.find((d) => d.department === "Engineering");
  assert.equal(eng.avgBase, 150000);
  assert.equal(eng.medianBase, 200000);
  assert.equal(eng.minBase, 100000);
  assert.equal(eng.maxBase, 200000);
  assert.equal(eng.headcount, 2);
  assert.equal(eng.pctHeadcount, 66.7);
  assert.equal(eng.costPerHeadLoaded, 180000); // (300000*1.2)/2
});

test("ratios / multiples", () => {
  assert.equal(m.ratios.loadedToBaseMultiple, 1.2);
  assert.equal(m.ratios.avgSalaryRangeMultiple, 1.5); // 150k avg vs 100k avg
});

test("metricsText renders per-department average pay", () => {
  const txt = metricsText(m);
  assert.match(txt, /Engineering: 2 \(66\.7% HC\), avg \$150,000/);
  assert.match(txt, /Ratios & multiples/);
});

test("average salary — company-wide and per department — is stated plainly for the assistant", () => {
  const employees = [
    { name: "A", department_name: "Engineering", annual_salary: 100000, employment_status: "active" },
    { name: "B", department_name: "Engineering", annual_salary: 140000, employment_status: "active" },
    { name: "C", department_name: "Sales", annual_salary: 60000, employment_status: "active" },
  ];
  const m = computeMetrics({ employees, settings: { loaded_cost_multiplier: 1.2 }, now: new Date() });

  // computed, not guessed: (100+140+60)/3 = 100k
  assert.equal(m.company.avgBase, 100000);
  assert.equal(m.company.avgLoadedPerHead, 120000);
  const eng = m.departments.find((d) => d.department === "Engineering");
  const sales = m.departments.find((d) => d.department === "Sales");
  assert.equal(eng.avgBase, 120000);
  assert.equal(sales.avgBase, 60000);

  // and it reaches the assistant verbatim
  const text = metricsText(m);
  assert.match(text, /AVERAGE SALARY \(company-wide\): \$100,000 base per person, \$120,000 fully loaded, across 3 people\./);
  assert.match(text, /AVERAGE SALARY BY DEPARTMENT \(base per person\): Engineering \$120,000 \(2\); Sales \$60,000 \(1\)\./);
});

test("averages degrade gracefully with an empty roster", () => {
  const m = computeMetrics({ employees: [], settings: { loaded_cost_multiplier: 1.2 }, now: new Date() });
  assert.equal(m.company.avgBase, 0);
  assert.equal(m.company.avgLoadedPerHead, 0);
  assert.doesNotThrow(() => metricsText(m));
  assert.ok(!/AVERAGE SALARY BY DEPARTMENT/.test(metricsText(m)), "no per-dept line when there are no departments");
});
