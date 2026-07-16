/**
 * The P&L layer: ramped benefit per department, net vs cost, and quota attainment —
 * plus the "P&L" tab route (render + save levers, scoped per plan/scenario).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel } from "../src/domain/model.js";
import { computePnl, benefitConfig } from "../src/domain/pnl.js";
import { startTestServer, makeClient } from "./helpers.js";

// ---- engine ----------------------------------------------------------------
const NOW = new Date("2026-07-15");
const modelWith = (hires = []) => buildHeadcountModel({
  employees: [{ employee_ext_id: "E1", department_name: "Sales", annual_salary: 120000, start_date: "2020-01-01" }],
  scenarioHires: hires, loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 12, now: NOW,
});

test("an existing head is fully ramped; benefit = perHead - cost each month", () => {
  const pnl = computePnl(modelWith(), { byDept: { Sales: { perHead: 600000, rampMonths: 6 } } });
  const sales = pnl.perDept.find((d) => d.department === "Sales");
  // 600k/yr = 50k/mo benefit; cost 120k/12*1.2 = 12k/mo; net 38k/mo.
  assert.equal(sales.monthlyNet[0], 38000);
  assert.equal(sales.monthlyNet[5], 38000, "no ramp for someone who started in 2020");
});

test("a new hire ramps 0 -> full over the ramp window", () => {
  // hire starts 2026-08 (index 7); ramp 6 months.
  const pnl = computePnl(modelWith([{ id: "h1", department: "Sales", role: "AE", start_month: "2026-08", annual_salary: 120000 }]), {
    byDept: { Sales: { perHead: 600000, rampMonths: 6 } },
  });
  const sales = pnl.perDept.find((d) => d.department === "Sales");
  // month 7 (first month, since=0): existing 38000 + new (50k*1/6 - 12k) = 38000 + (8333-12000) = 34333
  assert.equal(sales.monthlyNet[7], 34333);
  // month 11 (since=4): new head at 5/6 benefit = 41667 - 12000 = +29667 -> 38000+29667
  assert.equal(sales.monthlyNet[11], 67667);
});

test("net = 0 when no benefit lever is set (cost only, so negative)", () => {
  const pnl = computePnl(modelWith(), {});
  const sales = pnl.perDept.find((d) => d.department === "Sales");
  assert.equal(sales.benefit12, 0);
  assert.ok(sales.net12 < 0, "no benefit set -> net is just the cost, negative");
});

test("quota attainment = included-department benefit (next 12 mo) / quota", () => {
  const pnl = computePnl(modelWith(), { byDept: { Sales: { perHead: 600000, rampMonths: 1 } }, quota: { amount: 1000000, departments: ["Sales"] } });
  // next-12 benefit from nowIdx (6): 6 months * 50k = 300k; attainment 0.3
  assert.equal(pnl.quota.includedBenefit12, 300000);
  assert.equal(Math.round(pnl.quota.attainment * 100) / 100, 0.3);
});

test("a department not checked into the quota doesn't count toward attainment", () => {
  const pnl = computePnl(modelWith(), { byDept: { Sales: { perHead: 600000, rampMonths: 1 } }, quota: { amount: 1000000, departments: [] } });
  assert.equal(pnl.quota.includedBenefit12, 0);
});

test("benefitConfig normalises stored assumptions safely", () => {
  const c = benefitConfig({ benefit: { byDept: { Sales: { perHead: "600000", rampMonths: "6" } }, quota: { amount: "1000000", departments: ["Sales"] } } });
  assert.deepEqual(c.byDept.Sales, { perHead: 600000, rampMonths: 6 });
  assert.equal(c.quota.amount, 1000000);
  assert.deepEqual(c.quota.departments, ["Sales"]);
  // ramp is clamped to >= 1
  assert.equal(benefitConfig({ benefit: { byDept: { X: { perHead: 1, rampMonths: 0 } } } }).byDept.X.rampMonths, 1);
});

// ---- route ------------------------------------------------------------------
let srv, admin, planId;
before(async () => {
  srv = await startTestServer();
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Sales,120000,Annual\nE-2,Liam,Engineering,180000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planId = Number((await admin.post("/model/versions", { name: "Plan A" })).headers.get("location").match(/version=(\d+)/)[1]);
});
after(async () => { await srv.close(); });

test("the P&L tab renders with the plan and its departments", async () => {
  const page = await (await admin.get(`/model/pnl?version=${planId}`)).text();
  assert.match(page, /class="nav-link[^"]*"[^>]*>P&amp;L</, "P&L nav item is present");
  assert.match(page, /Benefit \/ head/);
  assert.match(page, /Quota/);
  assert.match(page, /Sales/);
  assert.match(page, /Engineering/);
});

test("saving levers persists them and they drive the outputs", async () => {
  const res = await admin.post(`/model/pnl/${planId}`, {
    perhead_Sales: "600000", ramp_Sales: "6",
    quota_amount: "1000000", quota_dept: "Sales",
  });
  assert.equal(res.status, 303);
  // stored on the plan's assumptions
  const a = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(planId).assumptions_json);
  assert.equal(a.benefit.byDept.Sales.perHead, 600000);
  assert.equal(a.benefit.byDept.Sales.rampMonths, 6);
  assert.deepEqual(a.benefit.quota.departments, ["Sales"]);
  // and the page now shows a non-zero attainment + net
  const page = await (await admin.get(`/model/pnl?version=${planId}`)).text();
  assert.match(page, /Quota attainment/);
  assert.ok(/%/.test(page));
});

test("the tab requires budget-view access", async () => {
  const anon = makeClient(srv.base);
  await anon.get("/login");
  const res = await anon.get(`/model/pnl?version=${planId}`);
  assert.notEqual(res.status, 200);
});
