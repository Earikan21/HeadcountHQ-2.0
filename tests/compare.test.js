/** Duplicating plans, comparing any two of them (Actual included), and the full annual summary. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { alignedWindow, comparePlans } from "../src/domain/compare.js";
import { buildHeadcountModel, applyPlanOverrides, windowKey } from "../src/domain/model.js";

// ------------------------------------------------------------------ pure domain
const emp = (o) => ({ employee_ext_id: "E-1", name: "A", department_name: "Eng", annual_salary: 120000, employment_status: "active", start_date: "2024-01-01", ...o });
const NOW = new Date("2026-07-15");

test("the aligned window spans both sides: the earliest start and the longer horizon", () => {
  const short = { employees: [emp({})], hires: [], assumptions: { horizonYears: 3 } };
  const long = { employees: [emp({})], hires: [], assumptions: { horizonYears: 10 } };
  const w = alignedWindow([short, long], NOW);
  const last = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: w.start, months: w.months, now: NOW });
  assert.equal(last.cols[last.cols.length - 1].year, 2036, "the 10-year side sets the far edge");
  assert.equal(last.cols[0].year, 2024, "the roster's earliest start sets the near edge");
});

test("a hire far in the future widens the window even if nobody on the roster reaches it", () => {
  const a = { employees: [emp({})], hires: [], assumptions: { horizonYears: 1 } };
  const b = { employees: [emp({})], hires: [{ id: "h1", role: "AE", department: "Sales", annual_salary: 100000, start_month: "2030-01" }], assumptions: { horizonYears: 1 } };
  const w = alignedWindow([a, b], NOW);
  const m = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: w.start, months: w.months, now: NOW });
  assert.ok(m.cols[m.cols.length - 1].year >= 2030, "the 2030 hire has to be visible");
});

test("comparePlans diffs by year and by department, deltas reading b minus a", () => {
  const w = { start: { year: 2026, month0: 0 }, months: 24 };
  const base = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, ...w, now: NOW });
  const grown = buildHeadcountModel({
    employees: [emp({})], loadedMultiplier: 1.2, ...w, now: NOW,
    scenarioHires: [{ id: "h1", role: "AE", department: "Sales", annual_salary: 60000, start_month: "2026-01" }],
  });
  const d = comparePlans({ label: "Actual", model: base }, { label: "Plan", model: grown });

  assert.equal(d.aLabel, "Actual");
  assert.deepEqual(d.years.map((y) => y.year), [2026, 2027]);
  assert.equal(d.years[0].aHeadcount, 1);
  assert.equal(d.years[0].bHeadcount, 2);
  assert.equal(d.years[0].dHeadcount, 1);
  // 60k * 1.2 = 72k a year more, every year
  assert.equal(d.years[0].dCost, 72000);
  assert.equal(d.years[0].pctCost, 50, "72k on top of 144k");
  assert.equal(d.totals.dCost, 144000, "two years of it");
  assert.equal(d.totals.bPeakHeadcount, 2);

  // departments are unioned and sorted by the size of the swing
  assert.deepEqual(d.departments.map((x) => x.department), ["Sales", "Eng"]);
  assert.equal(d.departments[0].aCost, 0, "Sales doesn't exist in Actual");
  assert.equal(d.departments[0].pctCost, null, "no percentage change from nothing");
  assert.equal(d.departments[1].dCost, 0, "Eng is identical on both sides");
});

test("comparing a thing with itself yields all zeroes, not an error", () => {
  const w = { start: { year: 2026, month0: 0 }, months: 12 };
  const m = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, ...w, now: NOW });
  const d = comparePlans({ label: "Actual", model: m }, { label: "Actual", model: m });
  assert.equal(d.totals.dCost, 0);
  assert.ok(d.years.every((y) => y.dCost === 0 && y.dHeadcount === 0));
  assert.equal(d.years[0].pctCost, 0);
});

test("misaligned models are refused rather than silently compared", () => {
  const a = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 12, now: NOW });
  const b = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: { year: 2030, month0: 0 }, months: 12, now: NOW });
  assert.throws(() => comparePlans({ label: "a", model: a }, { label: "b", model: b }), /not aligned/);
});

test("the window fingerprint changes exactly when the grid does", () => {
  const m = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 12, now: NOW });
  const m2 = buildHeadcountModel({ employees: [emp({})], loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 24, now: NOW });
  assert.equal(windowKey(m, "month"), windowKey(m, "month"));
  assert.notEqual(windowKey(m, "month"), windowKey(m, "quarter"), "period changes the columns");
  assert.notEqual(windowKey(m, "month"), windowKey(m2, "month"), "a longer window changes the columns");
});

// ------------------------------------------------------------------ integration
let srv, admin, planA;
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
  await admin.post(`/model/versions/${planA}/hire`, { scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "2" });
  await admin.post(`/model/versions/${planA}/cell`, { key: "emp:E-1", field: "salary", value: "200000", period: "month" });
  await admin.post(`/model/versions/${planA}/assumptions`, { salary_growth: "5" });
});
after(async () => { await srv.close(); });

const plansIn = (db) => db.prepare("SELECT id, name, hires_json, assumptions_json, overrides_json FROM plan_versions ORDER BY id").all();

test("duplicating a plan copies its hires, assumptions and per-person edits", async () => {
  const res = await admin.post(`/model/versions/${planA}/duplicate`, {});
  assert.equal(res.status, 303);
  const copyId = Number(res.headers.get("location").match(/version=(\d+)/)[1]);
  assert.notEqual(copyId, planA);

  const [orig, copy] = plansIn(srv.db).filter((p) => [planA, copyId].includes(p.id)).sort((a, b) => a.id - b.id);
  assert.equal(copy.name, "Base case (copy)");
  assert.equal(copy.hires_json, orig.hires_json, "hires come along");
  assert.equal(copy.assumptions_json, orig.assumptions_json, "so do the drivers");
  assert.equal(copy.overrides_json, orig.overrides_json, "and the per-person overrides");
  assert.match(copy.overrides_json, /"annual_salary":200000/);

  // the copy is genuinely independent
  await admin.post(`/model/versions/${copyId}/cell`, { key: "emp:E-1", field: "salary", value: "999000", period: "month" });
  const after = plansIn(srv.db);
  assert.match(after.find((p) => p.id === copyId).overrides_json, /999000/);
  assert.match(after.find((p) => p.id === planA).overrides_json, /200000/);
  assert.ok(!/999000/.test(after.find((p) => p.id === planA).overrides_json), "the original is untouched");
});

test("duplicating twice produces distinct names, never a collision", async () => {
  await admin.post(`/model/versions/${planA}/duplicate`, {});
  const names = plansIn(srv.db).map((p) => p.name);
  assert.ok(names.includes("Base case (copy)"));
  assert.ok(names.includes("Base case (copy 2)"), `got ${names.join(", ")}`);
  assert.equal(new Set(names).size, names.length, "all plan names are distinct");
});

test("compare renders Actual against a plan, with a picker, a chart and both tables", async () => {
  const page = await (await admin.get(`/model/compare?a=actual&b=${planA}`)).text();
  assert.match(page, /Compare plans/);
  assert.match(page, /class="cmp-pick"/);
  assert.match(page, /<option value="actual" selected>/);
  assert.match(page, new RegExp(`<option value="${planA}" selected>Base case`));
  assert.match(page, /class="cmp-chart"/);
  assert.match(page, /<polyline class="ln a"/);
  assert.match(page, /<polyline class="ln b"/);
  assert.match(page, /id="cmp-years"/);
  assert.match(page, /id="cmp-depts"/);
  assert.match(page, /Engineering/);
  assert.match(page, /Sales/);
  // the plan is dearer than Actual: a raise plus two AEs
  assert.match(page, /td class="num up"/);
  assert.match(page, /&#8646; Swap|⇆ Swap/);
});

test("compare works plan-against-plan, and Swap really swaps", async () => {
  const copyId = plansIn(srv.db).find((p) => p.name === "Base case (copy)").id;
  const page = await (await admin.get(`/model/compare?a=${planA}&b=${copyId}`)).text();
  assert.match(page, /Base case vs Base case \(copy\)/);
  assert.match(page, new RegExp(`href="/model/compare\\?a=${copyId}&b=${planA}"`), "Swap links to the reverse");
});

test("comparing something with itself says so instead of showing a wall of zeroes", async () => {
  const page = await (await admin.get(`/model/compare?a=${planA}&b=${planA}`)).text();
  assert.match(page, /Both sides are the same thing/);
});

test("an unknown plan id falls back to Actual rather than 500ing", async () => {
  const page = await (await admin.get("/model/compare?a=actual&b=99999")).text();
  assert.equal((await admin.get("/model/compare?a=actual&b=99999")).status, 200);
  assert.match(page, /Actual vs Actual/);
});

test("compare is reachable from the sidebar and from a plan, and clients may look", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /href="\/model\/compare" class="nav-sublink cmp/);
  const plan = await (await admin.get(`/model?version=${planA}`)).text();
  assert.match(plan, new RegExp(`href="/model/compare\\?a=actual&b=${planA}"`));
  assert.match(plan, /Duplicate plan/);

  // a client is read-only but may compare; a manager may not see budgets at all
  const created = await admin.post("/accounts", { name: "C", email: "c@x.co", role: "client", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const client = makeClient(srv.base);
  await client.get("/login");
  await client.post("/login", { email: "c@x.co", password: pw });
  assert.equal((await client.get(`/model/compare?a=actual&b=${planA}`)).status, 200);
  assert.equal((await client.post(`/model/versions/${planA}/duplicate`, {})).status, 403, "a client can't create plans");
});

test("the annual summary lists every year of the model, with YoY", async () => {
  const page = await (await admin.get(`/model?version=${planA}`)).text();
  assert.match(page, /every year in the model/);
  assert.match(page, /<th class="num">YoY cost<\/th>/);
  const years = [...page.matchAll(/<tr data-year="(\d{4})">/g)].map((m) => Number(m[1]));
  assert.ok(years.length >= 6, `expected a row per year, got ${years.length}`);
  assert.deepEqual(years, [...years].sort((a, b) => a - b), "in order");
  assert.equal(new Set(years).size, years.length, "no duplicates");
  assert.ok(years.includes(new Date().getFullYear()));
  assert.ok(years.includes(new Date().getFullYear() + 5), "five years forward by default");
  // the first row can't have a YoY figure to compare against
  const firstRow = page.match(/<tr data-year="\d{4}">[\s\S]*?<\/tr>/)[0];
  assert.match(firstRow, /—<\/td>/);
  // salary growth of 5% should show up as a positive YoY somewhere
  assert.match(page, /class="num up">\+/);
});

test("autosave returns a window fingerprint so a moved window forces a reload", async () => {
  const res = await admin.post(`/model/versions/${planA}/cell`, { key: "emp:E-1", field: "salary", value: "201000", period: "month" });
  const data = await res.json();
  assert.match(data.windowKey, /^\d{4}-\d+-\d+-month$/);
  assert.ok(data.summary && typeof data.summary === "object" && !Array.isArray(data.summary));
  const thisYear = String(new Date().getFullYear());
  assert.ok(data.summary[thisYear], "the summary is keyed by year");
  assert.equal(data.summary[thisYear].length, 5);

  // moving a start date far into the past widens the window, so the fingerprint moves
  const before = data.windowKey;
  const moved = await (await admin.post(`/model/versions/${planA}/cell`, { key: "emp:E-1", field: "start", value: "2015-01", period: "month" })).json();
  assert.notEqual(moved.windowKey, before, "the client must reload rather than mispatch cells");
  await admin.post(`/model/versions/${planA}/row/reset`, { key: "emp:E-1" });
});
