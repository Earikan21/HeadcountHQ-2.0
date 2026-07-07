import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { buildAssistantContext } from "../src/routes/assistant.js";

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

test("assistant context exposes per-department average pay (aggregate)", () => {
  const c = buildAssistantContext(srv.db);
  assert.match(c, /Engineering:.*avg \$/);
  assert.match(c, /Base salary avg/);
  assert.match(c, /Fully-loaded cost by year/);
  assert.match(c, /Ratios & multiples/);
});

test("model shows names, a mini dashboard, and cost cells", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /HEADCOUNT MODEL/);
  assert.match(page, /class="sheet model outline"/);
  assert.match(page, /Headcount now/);   // mini dashboard (item 10)
  assert.match(page, /Dana Lee/);             // names (item 3)
  assert.match(page, /Engineering/);
  assert.match(page, /Annual summary/);
});

test("period toggle, filters, and zoom controls render", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /id="zoom-in"/);
  assert.match(page, /\/static\/model\.js/);
  assert.match(page, /class="ptab[^"]*"[^>]*>Monthly/);
  assert.match(page, />Quarterly</);
  assert.match(page, /id="f-search"/);
  assert.match(page, /id="f-dept"/);
  assert.match(page, /id="f-min"/);
});

test("quarterly view aggregates columns", async () => {
  const page = await (await admin.get("/model?period=quarter")).text();
  assert.match(page, /class="ptab on"[^>]*>Quarterly/);
  assert.match(page, /Q[1-4] '/);
});

test("admin sees add-person + duplicate controls; duplicating adds headcount", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /href="\/roster\/new"/);
  assert.match(page, /\/roster\/duplicate\//);
  const before = srv.db.prepare("SELECT COUNT(*) AS n FROM employees").get().n;
  const empId = srv.db.prepare("SELECT id FROM employees LIMIT 1").get().id;
  const res = await admin.post("/roster/duplicate/" + empId, {});
  assert.equal(res.status, 303);
  const after = srv.db.prepare("SELECT COUNT(*) AS n FROM employees").get().n;
  assert.equal(after, before + 1);
});

test("collapsible department rows and year columns render", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /class="grptoggle"/);
  assert.match(page, /class="ytoggle"/);
  assert.match(page, /class="ygrp"/);
});

test("model scopes to a single department (rows + summary)", async () => {
  const page = await (await admin.get("/model?dept=Engineering")).text();
  assert.match(page, /HEADCOUNT MODEL · Engineering/);
  assert.match(page, /Dana Lee/);
  assert.ok(!page.includes("Mara Ito"), "Sales employee excluded when scoped to Engineering");
  assert.match(page, /Total fully-loaded cost/);
  assert.match(page, /Annual summary/);
});

test("a client can view the model (read-only, no admin controls)", async () => {
  const page = await (await client.get("/model")).text();
  assert.match(page, /class="sheet model outline"/);
  assert.ok(!page.includes("/roster/duplicate/"), "client sees no duplicate controls");
  assert.ok(!page.includes('href="/roster/new"'), "client sees no add-person control");
});
