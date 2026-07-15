/**
 * The monthly per-department summary export (/export/summary.csv): a "mini model" with
 * the same month columns as the detail export, aggregated to two rows per department —
 * Headcount (count) and Cost (sum) — plus TOTAL rows. Separate + stable so links to it
 * survive adding headcount, and new departments append at the bottom.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel } from "../src/domain/model.js";
import { modelSummaryMatrix, modelSummaryCsv } from "../src/domain/model_export.js";
import { startTestServer, makeClient } from "./helpers.js";

const model36 = () => buildHeadcountModel({
  employees: [
    { employee_ext_id: "E1", name: "A", department_name: "Engineering", annual_salary: 120000, start_date: "2020-01-01" },
    { employee_ext_id: "E2", name: "B", department_name: "Engineering", annual_salary: 120000, start_date: "2020-01-01" },
    { employee_ext_id: "E3", name: "C", department_name: "Sales", annual_salary: 60000, start_date: "2020-01-01" },
  ],
  loadedMultiplier: 1.2,
  start: { year: 2026, month0: 0 }, months: 36,
  now: new Date("2026-07-15"),
});

test("the matrix has month columns, two rows per department, and TOTAL rows", () => {
  const { headers, rows, totals } = modelSummaryMatrix(model36());
  assert.deepEqual(headers.slice(0, 2), ["Department", "Metric"]);
  assert.equal(headers.length, 2 + 36, "Department, Metric, then one column per month");
  assert.equal(headers[2], "Jan-2026");
  // two rows per department (Engineering, Sales), sorted by name here
  assert.deepEqual(rows.map((r) => [r[0], r[1]]), [
    ["Engineering", "Headcount"], ["Engineering", "Cost"],
    ["Sales", "Headcount"], ["Sales", "Cost"],
  ]);
  // Engineering headcount is 2 every month; cost is 2×$120k×1.2/12 = $24k every month.
  assert.ok(rows[0].slice(2).every((v) => v === 2), "Engineering headcount = 2 each month");
  assert.ok(rows[1].slice(2).every((v) => v === 24000), "Engineering cost = $24k each month");
  // TOTAL rows: headcount 3, cost $30k every month.
  assert.deepEqual(totals.map((r) => [r[0], r[1]]), [["TOTAL", "Headcount"], ["TOTAL", "Cost"]]);
  assert.ok(totals[0].slice(2).every((v) => v === 3));
  assert.ok(totals[1].slice(2).every((v) => v === 30000));
});

test("each month's TOTAL equals the sum of the department rows that month", () => {
  const { rows, totals } = modelSummaryMatrix(model36());
  const hcRows = rows.filter((r) => r[1] === "Headcount");
  const costRows = rows.filter((r) => r[1] === "Cost");
  for (let m = 2; m < totals[0].length; m++) {
    assert.equal(totals[0][m], hcRows.reduce((a, r) => a + r[m], 0), `headcount total, col ${m}`);
    assert.equal(totals[1][m], costRows.reduce((a, r) => a + r[m], 0), `cost total, col ${m}`);
  }
});

test("deptOrder controls row order; a new department appends at the bottom", () => {
  const model = buildHeadcountModel({
    employees: [
      { employee_ext_id: "E1", name: "A", department_name: "Zebra", annual_salary: 100000, start_date: "2020-01-01" },
      { employee_ext_id: "E2", name: "B", department_name: "Alpha", annual_salary: 100000, start_date: "2020-01-01" },
    ],
    start: { year: 2026, month0: 0 }, months: 12, now: new Date("2026-01-15"),
  });
  // Creation order says Zebra first, Alpha second — NOT alphabetical.
  const { rows } = modelSummaryMatrix(model, ["Zebra", "Alpha"]);
  assert.deepEqual(rows.map((r) => r[0]), ["Zebra", "Zebra", "Alpha", "Alpha"]);
  // A department absent from deptOrder is treated as new and appended after the known ones.
  const { rows: rows2 } = modelSummaryMatrix(model, ["Zebra"]);
  assert.deepEqual(rows2.map((r) => r[0]), ["Zebra", "Zebra", "Alpha", "Alpha"]);
});

// ---- route: token-authed, plan/dept aware, stable --------------------------
let srv, admin, planId;
before(async () => {
  srv = await startTestServer({ PUBLIC_URL: "https://hq.example.com" });
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,120000,Annual\nE-2,Liam,Sales,60000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planId = Number((await admin.post("/model/versions", { name: "Plan" })).headers.get("location").match(/version=(\d+)/)[1]);
  await admin.post("/integrations/excel/token/ensure", { return: "/model" });
});
after(async () => { await srv.close(); });
const token = () => srv.db.prepare("SELECT token FROM export_tokens WHERE workspace_id=1").get().token;

test("summary.csv needs a valid token", async () => {
  const anon = makeClient(srv.base);
  assert.equal((await anon.get("/export/summary.csv?token=nope")).status, 401);
});

test("summary.csv returns a monthly matrix with per-department + TOTAL rows", async () => {
  const anon = makeClient(srv.base);
  const csv = await (await anon.get(`/export/summary.csv?token=${token()}`)).text();
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /^Department,Metric,/);
  assert.ok(lines.some((l) => l.startsWith("Engineering,Headcount,")), "Engineering headcount row");
  assert.ok(lines.some((l) => l.startsWith("Engineering,Cost,")), "Engineering cost row");
  assert.ok(lines.some((l) => l.startsWith("TOTAL,Headcount,")), "TOTAL headcount row");
  assert.ok(lines.some((l) => l.startsWith("TOTAL,Cost,")), "TOTAL cost row");
});

test("adding headcount to an existing department does NOT change the summary's row count", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  const before = (await (await anon.get(`/export/summary.csv?token=${t}&version=${planId}`)).text()).trim().split("\r\n").length;
  await admin.post(`/model/versions/${planId}/hire`, { scn_department: "Engineering", scn_role: "SWE", scn_start: "2027-06", scn_salary: "150000", scn_count: "3" });
  const after = (await (await anon.get(`/export/summary.csv?token=${t}&version=${planId}`)).text()).trim().split("\r\n").length;
  assert.equal(after, before, "same departments => same rows => links stay put");
});

test("a brand-new department in the plan adds its rows at the BOTTOM (above TOTAL)", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  await admin.post(`/model/versions/${planId}/hire`, { scn_department: "Partnerships", scn_role: "BD", scn_start: "2027-06", scn_salary: "140000", scn_count: "1" });
  const lines = (await (await anon.get(`/export/summary.csv?token=${t}&version=${planId}`)).text()).trim().split("\r\n");
  const deptRowsIdx = lines.map((l, i) => ({ l, i })).filter((x) => /^Partnerships,/.test(x.l)).map((x) => x.i);
  const firstTotalIdx = lines.findIndex((l) => l.startsWith("TOTAL,"));
  assert.equal(deptRowsIdx.length, 2, "Partnerships gets a Headcount and a Cost row");
  assert.ok(deptRowsIdx.every((i) => i < firstTotalIdx), "the new department sits above the TOTAL rows");
  const engIdx = lines.findIndex((l) => l.startsWith("Engineering,"));
  assert.ok(engIdx < deptRowsIdx[0], "new department is below the existing ones");
});

test("summary honours ?dept — one department only", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  const lines = (await (await anon.get(`/export/summary.csv?token=${t}&dept=Sales`)).text()).trim().split("\r\n");
  assert.ok(lines.some((l) => l.startsWith("Sales,Headcount,")));
  assert.ok(!lines.some((l) => l.startsWith("Engineering,")), "Engineering excluded when scoped to Sales");
});
