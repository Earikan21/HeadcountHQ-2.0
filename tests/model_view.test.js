import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const CSV = "Employee ID,Name,Department,Job Title,Compensation,Unit,Status\nE-1,Dana Lee,Engineering,Engineer,120000,annual,active\nE-2,Mara Ito,Sales,AE,90000,annual,active\n";
const MAP = { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_job_title: "Job Title", map_compensation_amount: "Compensation", map_compensation_unit: "Unit", map_employment_status: "Status" };

let srv, admin, client;
before(async () => {
  srv = await startTestServer();
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, MAP);
  await admin.post(`/roster/import/${id}/commit`, {});
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Client", email: "ceo@client.co", role: "client", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  client = makeClient(srv.base);
  await client.get("/login");
  await client.post("/login", { email: "ceo@client.co", password: pw });
});
after(async () => { await srv.close(); });

test("live model renders the month-by-month headcount build from current data", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /HEADCOUNT MODEL/);
  assert.match(page, /class="sheet model"/);
  assert.match(page, /Employee roster/);
  assert.match(page, /Engineering/);
  assert.match(page, /Sales/);
  assert.match(page, /Total fully-loaded cost/i);
  assert.match(page, /Annual summary/i);
  assert.match(page, /class="mc on"/);          // active-month flag
  assert.match(page, /Year-End Headcount/);
});

test("nav links to the live financial model", async () => {
  const home = await (await admin.get("/")).text();
  assert.match(home, /href="\/model"[^>]*>Financial model</);
});

test("zoom controls + scenario planning render on the model", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /id="zoom-in"/);
  assert.match(page, /\/static\/model\.js/);
  assert.match(page, /Scenario planning/);
});

test("a manual scenario hire appears in a what-if band", async () => {
  const res = await admin.post("/model", { scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "2" });
  const page = await res.text();
  assert.match(page, /Scenario hires/);
  assert.match(page, /AE/);
});

test("a client can view the live model too (read-only)", async () => {
  const res = await client.get("/model");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /class="sheet model"/);
});
