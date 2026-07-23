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

test("the CSV export includes every driver, not just fully-loaded cost", async () => {
  const res = await c.get("/budgets/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /financial-model\.csv/);
  const body = await res.text();
  const rows = body.trim().split("\r\n");
  // header carries the input variables: base, load %, bonus %, growth %, cost per hire
  assert.match(rows[0], /^Department,Name,Role,Status,Start,End,Annual Base,Load %,Bonus %,Salary Growth %,Cost per Hire,Loaded Monthly,/);
  assert.match(body, /Engineering/);
  assert.match(body, /Sales/);

  // loaded monthly stays a live formula over base, load and bonus cells
  assert.match(body, /=G2\/12\*\(1\+H2\/100\)\*\(1\+I2\/100\)/, "loaded monthly is a formula");

  // totals are =SUM() over the person rows for base, cost-per-hire and every month
  const total = rows[rows.length - 1];
  assert.match(total, /^TOTAL,,,,,,=SUM\(G2:G\d+\),,,,=SUM\(K2:K\d+\),=SUM\(L2:L\d+\),=SUM\(M2:M\d+\)/);

  // formulas must not be quoted, or Excel treats them as text
  assert.ok(!/"=/.test(body), "formulas are unquoted");
})

test("the budgets page links to the CSV export", async () => {
  const page = await (await c.get("/budgets")).text();
  assert.match(page, /href="\/budgets\/export\.csv"/);
});

test("?period=quarter exports quarterly columns instead of monthly", async () => {
  const monthly = (await (await c.get("/budgets/export.csv")).text()).trim().split("\r\n")[0];
  const quarterly = (await (await c.get("/budgets/export.csv?period=quarter")).text()).trim().split("\r\n")[0];
  assert.match(monthly, /,Jan-\d{4}/, "monthly export has month columns");
  assert.match(quarterly, /,Q1 '\d{2}/, "quarterly export has quarter columns");
  assert.ok(!/,Jan-\d{4}/.test(quarterly), "and no month columns");
  // fewer columns than monthly
  assert.ok(quarterly.split(",").length < monthly.split(",").length);
});

test("?period=year exports yearly columns", async () => {
  const yearly = (await (await c.get("/budgets/export.csv?period=year")).text()).trim().split("\r\n")[0];
  assert.match(yearly, /,20\d{2}(,|$)/, "yearly export has year columns");
  assert.ok(!/,Q1 '/.test(yearly) && !/,Jan-/.test(yearly));
});
