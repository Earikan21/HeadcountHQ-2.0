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
  assert.match(page, /class="hm-line">Headcount model/);
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
  assert.ok(!/id="f-min"/.test(page), "min-salary filter removed");
  assert.ok(!/id="f-max"/.test(page), "max-salary filter removed");
});

test("the page is a thin title line, not the dark banner, and the sheet is near the top", async () => {
  const page = await (await admin.get("/model")).text();
  assert.ok(!/class="hm-band"/.test(page), "dark banner removed");
  assert.match(page, /class="hm-line"/);
  // nothing but the KPI strip and one control row stands between the line and the sheet
  const between = page.slice(page.indexOf('class="hm-line"'), page.indexOf('class="sheet-wrap"'));
  assert.match(between, /class="kpis model-kpis"/);
  assert.match(between, /class="model-controls"/);
  assert.ok(!/class="version-bar"/.test(between), "plan buttons no longer sit above the sheet");
});

test("columns default to collapsed except the current year, which is anchored on this month", async () => {
  const page = await (await admin.get("/model")).text();
  const yr = new Date().getFullYear();
  // this year expands to months and carries the scroll anchor
  assert.match(page, new RegExp(`<th class="mc" data-yb="${yr}"[^>]*data-now="1"`));
  assert.match(page, new RegExp(`<th class="mc ytot" data-year="${yr}" hidden>`), "current year shows months, hides its total");
  // a neighbouring year collapses to its year-total
  const other = page.match(/<th class="ygrp" data-year="(\d{4})" data-span="\d+" colspan="1">/);
  if (other) {
    assert.notEqual(Number(other[1]), yr, "the collapsed year is not the current one");
    assert.match(page, new RegExp(`<th class="mc ytot" data-year="${other[1]}">`), "collapsed year shows its total");
  }
});

test("quarterly view aggregates columns", async () => {
  const page = await (await admin.get("/model?period=quarter")).text();
  assert.match(page, /class="ptab on"[^>]*>Quarterly/);
  assert.match(page, /Q[1-4] '/);
});

test("admin sees duplicate controls (but no add-person button); duplicating adds headcount", async () => {
  const page = await (await admin.get("/model")).text();
  assert.ok(!/href="\/roster\/new"/.test(page), "adding a person belongs on People, not the model");
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
  assert.match(page, /Headcount model · Engineering/);
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
