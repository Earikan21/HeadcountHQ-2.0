/**
 * The editable plan sheet.
 *
 * The load-bearing property is ISOLATION: editing a plan must never change the
 * roster, the Actual view, another plan, or the assistant's aggregates. Everything
 * else here is validation and bookkeeping.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { parseCellEdit, applyCellEdit, monthEnd } from "../src/domain/plan_edit.js";
import { applyPlanOverrides, scenarioEmployees, OVERRIDABLE_FIELDS } from "../src/domain/model.js";
import { nextHireId } from "../src/repos/plans.js";

// ---------------------------------------------------------------- pure domain
const ROSTER = [{ employee_ext_id: "E-1", name: "Dana Lee", annual_salary: 120000, start_date: "2024-01-15", end_date: null }];
const edit = (body, overrides = {}, hires = []) => {
  const e = parseCellEdit(body);
  if (e.error) return { error: e.error };
  return applyCellEdit({ edit: e, roster: ROSTER, hires, overrides });
};

test("applyPlanOverrides is pure and sparse", () => {
  const emps = [{ employee_ext_id: "E-1", name: "Dana", annual_salary: 120000 }, { employee_ext_id: "E-2", name: "Liam" }];
  const out = applyPlanOverrides(emps, { "E-1": { annual_salary: 140000 } });
  assert.equal(out[0].annual_salary, 140000);
  assert.equal(emps[0].annual_salary, 120000, "the input array is never mutated");
  assert.equal(out[1], emps[1], "an un-overridden person isn't even copied");
  assert.deepEqual(out[0].overridden ?? out[0]._overridden, { annual_salary: true });
});

test("applyPlanOverrides ignores orphans and non-overridable fields", () => {
  const emps = [{ employee_ext_id: "E-1", name: "Dana", department_name: "Eng" }];
  const out = applyPlanOverrides(emps, { "E-9": { name: "ghost" }, "E-1": { department_name: "Sales", job_title: "CEO" } });
  assert.equal(out.length, 1);
  assert.equal(out[0].department_name, "Eng", "department is roster truth, not plan-editable");
  assert.equal(out[0].job_title, undefined);
  assert.deepEqual(OVERRIDABLE_FIELDS, ["name", "start_date", "end_date", "annual_salary"]);
});

test("a present-but-null override means 'in this plan they never leave'", () => {
  const emps = [{ employee_ext_id: "E-1", end_date: "2026-09-30" }];
  assert.equal(applyPlanOverrides(emps, { "E-1": { end_date: null } })[0].end_date, null);
  assert.equal(applyPlanOverrides(emps, {})[0].end_date, "2026-09-30", "absent key = roster value");
});

test("writing a person's real value deletes the override rather than storing it", () => {
  assert.deepEqual(edit({ key: "emp:E-1", field: "salary", value: "140000" }).overrides, { "E-1": { annual_salary: 140000 } });
  assert.deepEqual(edit({ key: "emp:E-1", field: "salary", value: "120000" }, { "E-1": { annual_salary: 140000 } }).overrides, {});
  // an imported start of 2024-01-15 shows as 2024-01; re-picking that month is a no-op
  assert.deepEqual(edit({ key: "emp:E-1", field: "start", value: "2024-01" }).overrides, {});
  assert.deepEqual(edit({ key: "emp:E-1", field: "name", value: "Dana Lee" }).overrides, {});
  assert.deepEqual(edit({ key: "emp:E-1", field: "name", value: "   " }, { "E-1": { name: "X" } }).overrides, {}, "blank name inherits");
});

test("dates normalise to month boundaries, including leap years", () => {
  assert.equal(edit({ key: "emp:E-1", field: "start", value: "2024-06" }).overrides["E-1"].start_date, "2024-06-01");
  assert.equal(edit({ key: "emp:E-1", field: "end", value: "2026-09" }).overrides["E-1"].end_date, "2026-09-30");
  assert.equal(monthEnd("2028-02"), "2028-02-29");
  assert.equal(monthEnd("2027-02"), "2027-02-28");
});

test("clearing an end date that exists on the roster records a deliberate null", () => {
  const roster = [{ employee_ext_id: "E-1", name: "Dana", annual_salary: 1, start_date: "2024-01-15", end_date: "2026-09-30" }];
  const r = applyCellEdit({ edit: parseCellEdit({ key: "emp:E-1", field: "end", value: "" }), roster, hires: [], overrides: {} });
  assert.deepEqual(r.overrides, { "E-1": { end_date: null } });
  assert.equal(r.value, "");
  // clearing an end date that never existed stores nothing at all
  assert.deepEqual(edit({ key: "emp:E-1", field: "end", value: "" }).overrides, {});
});

test("an end before the start is refused, for hires and for real people", () => {
  assert.match(edit({ key: "emp:E-1", field: "end", value: "2023-01" }).error, /can't come before/);
  const hires = [{ id: "h1", role: "AE", start_month: "2027-06", annual_salary: 100 }];
  assert.match(edit({ key: "hire:h1", field: "end", value: "2027-05" }, {}, hires).error, /can't come before/);
  // and moving the start past an existing end is refused the same way
  const withEnd = [{ id: "h1", role: "AE", start_month: "2027-01", end_month: "2027-03", annual_salary: 100 }];
  assert.match(edit({ key: "hire:h1", field: "start", value: "2027-09" }, {}, withEnd).error, /can't come before/);
});

test("bad input is rejected with a message, before anything is written", () => {
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "-5" }).error, /negative/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "abc" }).error, /must be a number/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "" }).error, /Enter a salary/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "999999999999" }).error, /typo/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "start", value: "June" }).error, /month like/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "department", value: "x" }).error, /isn't editable/);
  assert.match(parseCellEdit({ key: "nonsense", field: "name", value: "x" }).error, /Unknown row/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "name", value: "x".repeat(81) }).error, /under 80/);
  assert.equal(parseCellEdit({ key: "emp:E-1", field: "salary", value: "0" }).value, 0, "zero is a legal salary");
});

test("editing an unknown row or a vanished hire fails loudly", () => {
  assert.match(edit({ key: "emp:E-404", field: "name", value: "x" }).error, /no longer on the roster/);
  assert.match(edit({ key: "hire:nope", field: "name", value: "x" }).error, /planned hire is gone/);
});

test("hire ids are stable and each hire is one editable person", () => {
  assert.equal(nextHireId([]), "h1");
  assert.equal(nextHireId([{ id: "h1" }, { id: "h7" }]), "h8");
  assert.equal(nextHireId([{ id: "weird" }]), "h1");
  const rows = scenarioEmployees([{ id: "h1", role: "AE", name: "Nadia", department: "Sales", annual_salary: 120000, start_month: "2027-06" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._hireId, "h1");
  assert.equal(rows[0].name, "Nadia");
  assert.equal(rows[0].job_title, "AE", "the title stays the role even when renamed");
  // un-migrated `count` rows are anonymous, so they get no editable identity
  const legacy = scenarioEmployees([{ id: "h1", role: "AE", count: 3, annual_salary: 1 }]);
  assert.equal(legacy.length, 3);
  assert.ok(legacy.every((r) => r._hireId === null));
});

// ---------------------------------------------------------------- integration
let srv, admin, planA, planB;
const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit,Start date\n" +
  "E-1,Dana Lee,Engineering,120000,Annual,2024-01-15\nE-2,Mara Ito,Sales,100000,Annual,2024-03-01";

before(async () => {
  srv = await startTestServer();
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit", map_start_date: "Start date",
  });
  await admin.post(`/roster/import/${id}/commit`, {});
  planA = Number((await admin.post("/model/versions", { name: "Base case" })).headers.get("location").match(/version=(\d+)/)[1]);
  planB = Number((await admin.post("/model/versions", { name: "Board plan" })).headers.get("location").match(/version=(\d+)/)[1]);
});
after(async () => { await srv.close(); });

const cell = (plan, key, field, value, extra = {}) =>
  admin.post(`/model/versions/${plan}/cell`, { key, field, value, period: "month", ...extra });
const overridesOf = (plan) => JSON.parse(srv.db.prepare("SELECT overrides_json FROM plan_versions WHERE id=?").get(plan).overrides_json);
const hiresOf = (plan) => JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(plan).hires_json);

test("THE INVARIANT: editing a plan never touches the roster, Actual, or another plan", async () => {
  const res = await cell(planA, "emp:E-1", "salary", "200000");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  // the plan holds the delta...
  assert.deepEqual(overridesOf(planA), { "E-1": { annual_salary: 200000 } });
  // ...the employee record is untouched...
  const real = srv.db.prepare("SELECT c.annual_salary FROM compensation c JOIN employees e ON e.id=c.employee_id WHERE e.employee_ext_id='E-1'").get();
  assert.equal(real.annual_salary, 120000, "the roster is not rewritten by a what-if");
  // ...the other plan knows nothing about it...
  assert.deepEqual(overridesOf(planB), {});
  // ...Actual still shows the real salary, and the plan shows the override
  assert.match(await (await admin.get("/model")).text(), /value="120000"|>120,000</);
  assert.match(await (await admin.get(`/model?version=${planA}`)).text(), /value="200000"/);
  assert.ok(!/value="200000"/.test(await (await admin.get(`/model?version=${planB}`)).text()));
});

test("the assistant's aggregates come from the roster, not from any plan", async () => {
  // planA doubles E-1's pay; the company average must not move
  const { computeMetrics } = await import("../src/domain/metrics.js");
  const { listEmployees } = await import("../src/repos/roster.js");
  const m = computeMetrics({ employees: listEmployees(srv.db, {}), settings: { loaded_cost_multiplier: 1.2 }, now: new Date() });
  assert.equal(m.company.avgBase, 110000, "(120k + 100k) / 2 — the plan's 200k is invisible here");
});

test("a salary edit moves the row, its department subtotal, the grand total and the KPIs together", async () => {
  const data = await (await cell(planA, "emp:E-1", "salary", "240000")).json();
  const mult = srv.db.prepare("SELECT loaded_cost_multiplier m FROM workspace_settings WHERE workspace_id=1").get().m;
  assert.equal(mult, 1.3, "the workspace default load is 1.3");
  assert.equal(data.row.loaded, "26,000", "240k / 12 * 1.3 — fully loaded, from the server");
  assert.ok(data.row.cells.length > 0 && data.row.cells.some((c) => c.t));
  assert.equal(data.dept.name, "Engineering");
  assert.ok(data.total.cells.length === data.row.cells.length);
  assert.match(data.kpis.avghead, /^\$/);
  assert.equal(data.kpis.headcount, "2");
  // the summary is keyed by year — one entry per year of the model, not first-vs-last
  assert.ok(data.summary && !Array.isArray(data.summary));
  const yrs = Object.keys(data.summary);
  assert.ok(yrs.length >= 6, `a row per year, got ${yrs.length}`);
  assert.equal(data.summary[String(new Date().getFullYear())].length, 5);
  assert.match(data.windowKey, /-month$/);
  // the grand total is the sum of the people, at every bucket
  const i = data.row.cells.findIndex((c) => c.v > 0);
  assert.ok(data.total.cells[i].v >= data.row.cells[i].v);
});

test("resetting a row returns the person to roster truth", async () => {
  assert.ok(Object.keys(overridesOf(planA)).length);
  const res = await admin.post(`/model/versions/${planA}/row/reset`, { key: "emp:E-1" });
  assert.equal(res.status, 303);
  assert.deepEqual(overridesOf(planA), {});
  const page = await (await admin.get(`/model?version=${planA}`)).text();
  assert.match(page, /value="120000"/);
});

test("scenario hires are individually editable, and count creates real records", async () => {
  await admin.post(`/model/versions/${planB}/hire`, {
    scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "3",
  });
  let hires = hiresOf(planB);
  assert.equal(hires.length, 3, "count: 3 makes three editable people, not one row of three");
  assert.deepEqual(hires.map((h) => h.id), ["h1", "h2", "h3"]);
  assert.deepEqual(hires.map((h) => h.name), ["AE 1", "AE 2", "AE 3"]);

  // rename and repay only the second one
  await cell(planB, "hire:h2", "name", "AE — Nadia");
  await cell(planB, "hire:h2", "salary", "150000");
  await cell(planB, "hire:h2", "end", "2028-12");
  hires = hiresOf(planB);
  assert.deepEqual(hires.find((h) => h.id === "h2"), { id: "h2", department: "Sales", role: "AE", name: "AE — Nadia", start_month: "2027-06", end_month: "2028-12", annual_salary: 150000 });
  assert.equal(hires.find((h) => h.id === "h1").annual_salary, 120000, "her neighbours are untouched");
  assert.equal(hires.find((h) => h.id === "h1").name, "AE 1");

  const page = await (await admin.get(`/model?version=${planB}`)).text();
  assert.match(page, /value="AE — Nadia"/);
  assert.match(page, /data-key="hire:h2"/);
});

test("removing a hire deletes it by id, not by position", async () => {
  await admin.post(`/model/versions/${planB}/row/reset`, { key: "hire:h1" });
  const ids = hiresOf(planB).map((h) => h.id);
  assert.deepEqual(ids, ["h2", "h3"], "h1 is gone; h2 and h3 keep their identities");
  // editing h3 still lands on h3
  await cell(planB, "hire:h3", "salary", "111000");
  assert.equal(hiresOf(planB).find((h) => h.id === "h3").annual_salary, 111000);
});

test("the endpoint rejects bad values and writes nothing", async () => {
  const before = JSON.stringify(overridesOf(planA));
  for (const [field, value, re] of [["salary", "-1", /negative/], ["salary", "abc", /number/], ["start", "nope", /month like/], ["end", "1999-01", /can't come before/]]) {
    if (field === "end") await cell(planA, "emp:E-1", "start", "2024-06"); // give them a start to violate
    const res = await cell(planA, "emp:E-1", field, value);
    assert.equal(res.status, 400, `${field}=${value} must be refused`);
    assert.match((await res.json()).error, re);
  }
  await admin.post(`/model/versions/${planA}/row/reset`, { key: "emp:E-1" });
  assert.equal(JSON.stringify(overridesOf(planA)), before, "no partial writes");
});

test("a missing plan 404s rather than throwing", async () => {
  const res = await cell(99999, "emp:E-1", "salary", "1");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no longer exists/);
});

test("Actual is read-only: no inputs, and the roster-mutating actions live there instead", async () => {
  const actual = await (await admin.get("/model")).text();
  assert.ok(!/class="cell-input"/.test(actual), "Actual never renders an editable cell");
  assert.ok(!/id="model-csrf"/.test(actual));
  assert.match(actual, /\/roster\/duplicate\//);
  assert.match(actual, /class="linklike danger-link"/, "End lives on Actual");

  const plan = await (await admin.get(`/model?version=${planA}`)).text();
  assert.match(plan, /class="cell-input"/);
  assert.match(plan, /id="model-csrf"/);
  assert.ok(!/\/roster\/duplicate\//.test(plan), "no roster-mutating Duplicate inside a plan");
  assert.ok(!new RegExp(`/roster/\\d+/end`).test(plan), "no roster-mutating End inside a plan");
  assert.match(plan, /row\/reset/);
});

test("clients and managers can never edit a plan", async () => {
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const mk = async (role, extra = {}) => {
    const email = `${role}${Math.random().toString(16).slice(2, 6)}@acme.co`;
    const created = await admin.post("/accounts", { name: role, email, role, method: "password", ...extra });
    const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
    const c = makeClient(srv.base);
    await c.get("/login");
    await c.post("/login", { email, password: pw });
    return c;
  };
  const mgr = await mk("manager", { department_id: String(eng) });
  assert.equal(srv.db.prepare("SELECT role FROM users WHERE name='manager'").get().role, "manager");
  assert.equal((await mgr.post(`/model/versions/${planA}/cell`, { key: "emp:E-1", field: "salary", value: "1" })).status, 403);

  const client = await mk("client"); // the route stores this as c_suite + is_client
  assert.equal((await client.post(`/model/versions/${planA}/cell`, { key: "emp:E-1", field: "salary", value: "1" })).status, 403);
  assert.equal((await client.post(`/model/versions/${planA}/row/reset`, { key: "emp:E-1" })).status, 403);
  const page = await (await client.get(`/model?version=${planA}`)).text();
  assert.ok(!/class="cell-input"/.test(page), "a client sees numbers, never inputs");
  assert.deepEqual(overridesOf(planA), {}, "nothing was written by anyone");
});

test("the CSV export reflects the plan you're looking at", async () => {
  await cell(planA, "emp:E-1", "salary", "300000");
  const plan = await (await admin.get(`/budgets/export.csv?version=${planA}`)).text();
  assert.match(plan, /Dana Lee,SWE?[^,]*,300000|,300000,/, "the plan's salary is exported");
  const actual = await (await admin.get("/budgets/export.csv")).text();
  assert.match(actual, /,120000,/, "Actual exports the roster's salary");
  assert.ok(!/,300000,/.test(actual));
  await admin.post(`/model/versions/${planA}/row/reset`, { key: "emp:E-1" });
});

test("load is entered as a percentage and stored as a multiplier", async () => {
  await admin.post(`/model/versions/${planA}/assumptions`, { loaded_pct: "35" });
  const a = overridesOf; void a;
  const asm = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(planA).assumptions_json);
  assert.equal(asm.loadedMultiplier, 1.35, "35% -> x1.35");
  // 0% is a real value (no load), blank inherits the default
  await admin.post(`/model/versions/${planA}/assumptions`, { loaded_pct: "0" });
  assert.equal(JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(planA).assumptions_json).loadedMultiplier, 1);
});

test("a scenario hire can be duplicated (copy inserted after it)", async () => {
  await admin.post(`/model/versions/${planB}/hire`, { scn_department: "Sales", scn_role: "SDR", scn_start: "2027-06", scn_salary: "90000", scn_count: "1" });
  let hires = hiresOf(planB);
  const sdr = hires.find((h) => h.role === "SDR");
  const res = await admin.post(`/model/versions/${planB}/hire/${sdr.id}/duplicate`, {});
  assert.equal(res.status, 303);
  hires = hiresOf(planB);
  const copies = hires.filter((h) => h.role === "SDR");
  assert.equal(copies.length, 2, "now two SDRs");
  assert.ok(copies.some((h) => /\(copy\)$/.test(h.name)), "the copy is named (copy)");
  assert.notEqual(copies[0].id, copies[1].id, "distinct ids");
});

test("a real person can be duplicated into a new scenario headcount", async () => {
  const before = hiresOf(planB).length;
  const res = await admin.post(`/model/versions/${planB}/emp/E-1/duplicate`, {});
  assert.equal(res.status, 303);
  const hires = hiresOf(planB);
  assert.equal(hires.length, before + 1);
  const copy = hires[hires.length - 1];
  assert.match(copy.name, /\(copy\)$/);
  assert.equal(copy.department, "Engineering", "same department as the source person");
  assert.ok(copy.start_month, "starts as a new hire (has a start month)");
});
