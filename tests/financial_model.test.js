import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const CSV = "Employee ID,Name,Department,Job Title,Compensation,Unit,Status\nE-1,Dana Lee,Engineering,Engineer,120000,annual,active\nE-2,Mara Ito,Sales,AE,90000,annual,active\n";
const MAP = { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_job_title: "Job Title", map_compensation_amount: "Compensation", map_compensation_unit: "Unit", map_employment_status: "Status" };

let srv, c;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
});
after(async () => { await srv.close(); });

test("the CSV export is a live model: formulas, not hardcoded numbers", async () => {
  const res = await c.get("/budgets/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /financial-model\.csv/);
  const body = await res.text();
  const rows = body.trim().split("\r\n");
  assert.match(rows[0], /^Department,Name,Role,Annual Base,Loaded Monthly,/);
  assert.match(body, /Engineering/);
  assert.match(body, /Sales/);

  // loaded monthly derives from the annual-base cell; month cells reference it
  assert.match(body, /=D2\/12\*[\d.]+/, "loaded monthly is a formula over the base cell");
  assert.match(body, /=\$E2/, "month cells reference loaded monthly");

  // every total is a SUM over the person rows, not a precomputed number
  const total = rows[rows.length - 1];
  assert.match(total, /^TOTAL,,,=SUM\(D2:D\d+\),=SUM\(E2:E\d+\),=SUM\(F2:F\d+\)/);
  assert.ok(!/,\d{4,},/.test(total.replace(/^TOTAL,,,/, "")), "no hardcoded totals");

  // formulas must not be quoted, or Excel treats them as text
  assert.ok(!/"=/.test(body), "formulas are unquoted");
});

test("the budgets page links to the CSV export", async () => {
  const page = await (await c.get("/budgets")).text();
  assert.match(page, /href="\/budgets\/export\.csv"/);
});
