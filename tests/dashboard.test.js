import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const MAP = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
};
async function setup() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\n" +
    "E-1,Dana,Engineering,120000,Annual\nE-2,Liam,Engineering,160000,Annual\nE-3,Mara,Sales,100000,Annual";
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
  return { srv, c };
}

test("admin overview shows KPI strip, cost-by-department, and insights", async () => {
  const { srv, c } = await setup();
  const page = await (await c.get("/")).text();
  assert.match(page, /Headcount now/);
  assert.match(page, /Annual run-rate/);
  assert.match(page, /Fully-loaded cost by department/);
  assert.match(page, /Engineering/);
  assert.match(page, /Auto insights/);
  assert.ok(!/Department balance vs\. target/.test(page), "old target-balance card is gone");
  await srv.close();
});

test("overview renders the trend and plan comparison", async () => {
  const { srv, c } = await setup();
  const page = await (await c.get("/")).text();
  assert.match(page, /Headcount &amp; fully-loaded cost/);
  assert.match(page, /Actual path/);
  await srv.close();
});

test("manager dashboard is scoped to their department", async () => {
  const { srv, c } = await setup();
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const created = await c.post("/accounts", { name: "Mo", email: "mo@b.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login"); await mgr.post("/login", { email: "mo@b.co", password: pw });
  const page = await (await mgr.get("/")).text();
  assert.match(page, /Active headcount/);
  assert.ok(!/Department balance vs\. target/.test(page), "managers don't see the company-wide target table");
  assert.match(page, /Your open requests/);
  await srv.close();
});
