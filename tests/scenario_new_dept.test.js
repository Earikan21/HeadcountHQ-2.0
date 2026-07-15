/**
 * Scenario planning into NEW / hypothetical departments, plus the other what-if cases
 * the chatbot has to survive: end dates, brand-new-team pay bases, and multiple groups.
 *
 * The LLM is stubbed (client.chat), so these assert the parsing/resolution CONTRACT —
 * the deterministic half — not the model's wording. The prompt content (what the model
 * is told) is asserted separately so the guidance can't silently regress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { departmentPayStats } from "../src/domain/metrics.js";
import { parseScenarioHires } from "../src/domain/assistant.js";

const ROSTER = [
  { department_name: "Engineering", annual_salary: 300000 },
  { department_name: "Engineering", annual_salary: 480000 },
  { department_name: "Sales", annual_salary: 120000 },
];
const stub = (payload) => ({ configured: true, chat: async () => JSON.stringify(payload) });
const NOW = new Date("2026-07-15");

test("a brand-new department with an explicit salary is accepted as-is", async () => {
  const out = await parseScenarioHires({
    description: "spin up a Partnerships team: 2 partners at 200k starting Jan 2027",
    departments: ["Engineering", "Sales"], payStats: departmentPayStats(ROSTER), now: NOW,
    client: stub({ hires: [{ department: "Partnerships", role: "Partner", start_month: "2027-01", annual_salary: 200000, count: 2 }] }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].department, "Partnerships", "the new department name is kept, not remapped");
  assert.equal(out[0].annual_salary, 200000);
  assert.equal(out[0].count, 2);
});

test("a new department paid 'the department average' falls back to the company average, not dropped", async () => {
  const payStats = departmentPayStats(ROSTER);
  const out = await parseScenarioHires({
    description: "staff a new Growth pod at the department average",
    departments: ["Engineering", "Sales"], payStats, now: NOW,
    client: stub({ hires: [{ department: "Growth", role: "Growth Lead", start_month: "2027-03", annual_salary: 0, salary_basis: "dept_avg", count: 1 }] }),
  });
  assert.equal(out.length, 1, "the hire survives even with no pay history for the new team");
  assert.equal(out[0].annual_salary, payStats.company.avg);
});

test("'top of the band' for a new department also resolves (company avg), never 0", async () => {
  const payStats = departmentPayStats(ROSTER);
  const out = await parseScenarioHires({
    description: "a Legal lead at the top of the band",
    departments: ["Engineering"], payStats, now: NOW,
    client: stub({ hires: [{ department: "Legal", role: "Counsel", annual_salary: 0, salary_basis: "dept_max", count: 1 }] }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].annual_salary, payStats.company.avg, "no Legal pay yet -> company average, not a dropped hire");
});

test("a duration produces an end_month on/after the start", async () => {
  const out = await parseScenarioHires({
    description: "a 6-month contractor in Ops from 2027-01 at 120k",
    departments: [], payStats: departmentPayStats(ROSTER), now: NOW,
    client: stub({ hires: [{ department: "Ops", role: "Contractor", start_month: "2027-01", end_month: "2027-06", annual_salary: 120000, count: 1 }] }),
  });
  assert.equal(out[0].start_month, "2027-01");
  assert.equal(out[0].end_month, "2027-06");
});

test("an end_month before the start is ignored rather than trusted", async () => {
  const out = await parseScenarioHires({
    description: "x", departments: [], payStats: departmentPayStats(ROSTER), now: NOW,
    client: stub({ hires: [{ department: "Ops", role: "X", start_month: "2027-06", end_month: "2027-01", annual_salary: 120000, count: 1 }] }),
  });
  assert.equal(out[0].end_month, null, "a backwards end date is dropped");
});

test("several groups (existing + new department) come back as several hires", async () => {
  const out = await parseScenarioHires({
    description: "2 AEs in Sales and a PM in a new Product team, all at 150k next year",
    departments: ["Sales"], payStats: departmentPayStats(ROSTER), now: NOW,
    client: stub({ hires: [
      { department: "Sales", role: "AE", start_month: "2027-01", annual_salary: 150000, count: 2 },
      { department: "Product", role: "PM", start_month: "2027-01", annual_salary: 150000, count: 1 },
    ] }),
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((h) => h.department).sort(), ["Product", "Sales"]);
});

test("a clarifying question still passes through untouched", async () => {
  const out = await parseScenarioHires({
    description: "add a few people somewhere", departments: ["Sales"], payStats: null, now: NOW,
    client: stub({ question: "How many, in which team, and at what pay?" }),
  });
  assert.equal(out.length, 0);
  assert.match(out.question, /How many/);
});

test("the prompt explicitly licenses new/hypothetical departments and forbids remapping", async () => {
  let seen = "";
  await parseScenarioHires({
    description: "hire", departments: ["Engineering"], payStats: departmentPayStats(ROSTER), now: NOW,
    client: { configured: true, chat: async (sys, user) => { seen = sys + "\n" + user; return JSON.stringify({ hires: [] }); } },
  });
  assert.match(seen, /brand-new|hypothetical/i, "the model is told new departments are valid");
  assert.match(seen, /never force a new team onto an existing one/i);
  assert.match(seen, /only ADD/i, "and that the planner cannot remove people");
  assert.match(seen, /end_month/, "and how to set an end date");
});
