import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const CSV = "Employee ID,Name,Department,Job Title,Compensation,Unit,Status\nE-1,Dana Lee,Engineering,Engineer,120000,annual,active\n";
const MAP = { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_job_title: "Job Title", map_compensation_amount: "Compensation", map_compensation_unit: "Unit", map_employment_status: "Status" };

let srv, c;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada Admin", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("empty workspace shows the welcome/setup screen instead of the zeros dashboard", async () => {
  const home = await (await c.get("/")).text();
  assert.match(home, /Welcome, Ada/);
  assert.match(home, /Import your roster/);
  assert.match(home, /Set your budget/);
});

test("welcome can be dismissed to the dashboard with ?home=1", async () => {
  const home = await (await c.get("/?home=1")).text();
  assert.ok(!/Import your roster/.test(home), "dismissed welcome should show the dashboard");
});

test("after a roster import the dashboard replaces the welcome screen", async () => {
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
  const home = await (await c.get("/")).text();
  assert.ok(!/Import your roster/.test(home), "welcome should be gone once a roster exists");
  assert.match(home, /Headcount now|Annual run-rate/);
});
