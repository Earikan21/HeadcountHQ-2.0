import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, engId;

before(async () => {
  srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner Ada", email: "ada@acme.co", password: "supersecret123" });
  // import two Engineering employees (loaded cost = salary * 1.25 early-phase mult)
  const CSV = [
    "Employee ID,Name,Department,Job Title,Compensation Amount,Compensation Unit,Employment Status",
    "E-1,Dana,Engineering,Engineer,120000,Annual,Active",
    "E-2,Liam,Engineering,Engineer,180000,Annual,Active",
  ].join("\n");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_job_title: "Job Title", map_compensation_amount: "Compensation Amount",
    map_compensation_unit: "Compensation Unit", map_employment_status: "Employment Status",
  });
  await c.post(`/roster/import/${id}/commit`, {});
  engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
});
after(async () => { await srv.close(); });

async function login() {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  return c;
}
const envMoney = () => srv.db.prepare("SELECT money_budget FROM budget_envelopes WHERE department_id=?").get(engId)?.money_budget || 0;

test("the money tab shows the fill-from-headcount button", async () => {
  const c = await login();
  const page = await (await c.get("/budgets?mode=money")).text();
  assert.match(page, /Fill money budgets from the headcount budget/);
});

test("fill sets each department's money budget from its headcount budget", async () => {
  const c = await login();
  // current committed cost = (120000+180000) * 1.25 = 375000
  const currentCost = 375000;
  // budget 2 extra (unfilled) Engineering positions
  await c.post("/budgets", { mode: "headcount", company_headcount: "4", [`hc_${engId}`]: "4" });

  const res = await c.post("/budgets/fill-from-headcount", {});
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /mode=money/);

  const after = envMoney();
  assert.ok(after > currentCost, `money budget (${after}) should exceed current cost (${currentCost}) — implied cost of unfilled positions was added`);

  // idempotent: clicking again yields the same number, not a growing one
  await c.post("/budgets/fill-from-headcount", {});
  assert.equal(envMoney(), after, "fill should be idempotent");
});
