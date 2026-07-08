/**
 * "Pay the new hire the department average."
 *
 * The bug: the scenario-hire parser only ever saw department *names*, so a request to
 * match the department average had no figures to work from and the model invented one.
 * The fix moves the arithmetic into code — the model may cite a basis, the server
 * resolves it from the real roster.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { departmentPayStats } from "../src/domain/metrics.js";
import { parseScenarioHires } from "../src/domain/assistant.js";

// 25k & 40k *monthly* are 300k / 480k annual — the units the model stores.
const ROSTER = [
  { department_name: "Engineering", annual_salary: 300000 },
  { department_name: "Engineering", annual_salary: 300000 },
  { department_name: "Engineering", annual_salary: 480000 },
  { department_name: "Sales", annual_salary: 120000 },
];

test("departmentPayStats computes a true mean, not a guess", () => {
  const s = departmentPayStats(ROSTER);
  const eng = s.departments.find((d) => d.name === "Engineering");
  assert.equal(eng.count, 3);
  assert.equal(eng.avg, 360000, "(300k + 300k + 480k) / 3 = 360k/yr = 30k/mo");
  assert.equal(eng.median, 300000);
  assert.equal(eng.min, 300000);
  assert.equal(eng.max, 480000);
  assert.equal(s.company.avg, Math.round((300000 + 300000 + 480000 + 120000) / 4));
});

test("zero and missing salaries don't drag the average down", () => {
  const s = departmentPayStats([
    { department_name: "Eng", annual_salary: 300000 },
    { department_name: "Eng", annual_salary: 0 },       // vacancy / unknown
    { department_name: "Eng", annual_salary: null },
  ]);
  assert.equal(s.departments[0].count, 1);
  assert.equal(s.departments[0].avg, 300000, "only real pay counts");
});

const stub = (hires) => ({ configured: true, chat: async () => JSON.stringify({ hires }) });

test("a cited department-average basis resolves to the real figure, not a hallucination", async () => {
  const payStats = departmentPayStats(ROSTER);
  const out = await parseScenarioHires({
    description: "hire an engineer at the department average",
    departments: ["Engineering", "Sales"], payStats,
    client: stub([{ department: "Engineering", role: "SWE", start_month: "2027-01", annual_salary: 0, salary_basis: "dept_avg", count: 1 }]),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].annual_salary, 360000, "30k/month, not an invented 20k");
});

test("each basis resolves to its own statistic", async () => {
  const payStats = departmentPayStats(ROSTER);
  const bases = { dept_avg: 360000, dept_median: 300000, dept_min: 300000, dept_max: 480000, company_avg: payStats.company.avg };
  for (const [basis, expected] of Object.entries(bases)) {
    const out = await parseScenarioHires({
      description: "hire", departments: ["Engineering"], payStats,
      client: stub([{ department: "Engineering", role: "X", annual_salary: 0, salary_basis: basis, count: 1 }]),
    });
    assert.equal(out[0].annual_salary, expected, `basis ${basis}`);
  }
});

test("an explicit number always wins over a basis", async () => {
  const payStats = departmentPayStats(ROSTER);
  const out = await parseScenarioHires({
    description: "hire an engineer at 200k", departments: ["Engineering"], payStats,
    client: stub([{ department: "Engineering", role: "SWE", annual_salary: 200000, salary_basis: "dept_avg", count: 1 }]),
  });
  assert.equal(out[0].annual_salary, 200000);
});

test("a basis for a brand-new department falls back to the company average", async () => {
  const payStats = departmentPayStats(ROSTER);
  const out = await parseScenarioHires({
    description: "start a Legal team at the department average", departments: ["Engineering", "Sales"], payStats,
    client: stub([{ department: "Legal", role: "Counsel", annual_salary: 0, salary_basis: "dept_avg", count: 1 }]),
  });
  assert.equal(out[0].annual_salary, payStats.company.avg, "no Legal pay yet, so use the company average rather than 0");
});

test("a basis with no stats at all drops the hire rather than inventing a salary", async () => {
  const out = await parseScenarioHires({
    description: "hire at the average", departments: [], payStats: null,
    client: stub([{ department: "Eng", role: "X", annual_salary: 0, salary_basis: "dept_avg", count: 1 }]),
  });
  assert.equal(out.length, 0, "no figures available => no fabricated salary");
});

test("the prompt actually carries the department figures to the model", async () => {
  const payStats = departmentPayStats(ROSTER);
  let seen = "";
  await parseScenarioHires({
    description: "hire", departments: ["Engineering"], payStats,
    client: { configured: true, chat: async (_sys, user) => { seen = user; return JSON.stringify({ hires: [] }); } },
  });
  assert.match(seen, /Engineering avg 360000/, "the real average is in the prompt");
  assert.match(seen, /Salaries are ANNUAL/, "and the annual/monthly instruction");
});
