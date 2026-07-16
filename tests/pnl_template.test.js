/**
 * The fill-in P&L template export: per-department blocks (headcount + cost filled,
 * benefit/dim% blank, benefit + net formulas), TOTAL rows via SUMIF, and a
 * per-department diminishing-returns calculator (log-linear fit of marginal output).
 *
 * We assert the CSV STRUCTURE and the FORMULA STRINGS — the formulas are evaluated by
 * Excel, which we can't run here, so we verify they're the intended formulas.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel } from "../src/domain/model.js";
import { pnlTemplateRows, pnlTemplateCsv } from "../src/domain/pnl_template.js";
import { startTestServer, makeClient } from "./helpers.js";

const model = () => buildHeadcountModel({
  employees: [
    { employee_ext_id: "E1", name: "A", department_name: "Engineering", annual_salary: 120000, start_date: "2020-01-01" },
    { employee_ext_id: "E2", name: "B", department_name: "Engineering", annual_salary: 120000, start_date: "2020-01-01" },
    { employee_ext_id: "E3", name: "C", department_name: "Sales", annual_salary: 60000, start_date: "2020-01-01" },
  ],
  loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 6, now: new Date("2026-07-15"),
});

test("header + a per-department block with headcount/cost filled and levers blank", () => {
  const rows = pnlTemplateRows(model(), ["Engineering", "Sales"]);
  assert.deepEqual(rows[0].slice(0, 4), ["Department", "Line", "Assumption", "Jan-2026"]);
  // Engineering block starts at row index 1
  assert.deepEqual(rows[1], ["Engineering", "Headcount", "", 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(rows[2], ["Engineering", "Cost", "", 24000, 24000, 24000, 24000, 24000, 24000]);
  assert.equal(rows[3][1], "Benefit per head (annual $)");
  assert.equal(rows[3][2], "", "the benefit lever is blank for the user to fill");
  assert.equal(rows[4][1], "Diminishing return % (0-1)");
});

test("benefit is the geometric diminishing-returns formula; net = benefit - cost", () => {
  const rows = pnlTemplateRows(model(), ["Engineering", "Sales"]);
  const ben = rows[5], net = rows[6];
  assert.equal(ben[1], "Benefit");
  // rate = $C$4, dim = $C$5, headcount = D2 (first month)
  assert.equal(ben[3], '=IF($C$4="","",IF($C$5=0,$C$4/12*D2,$C$4/12*(1-(1-$C$5)^D2)/$C$5))');
  assert.equal(net[1], "Net (Benefit - Cost)");
  assert.equal(net[3], '=IF(D6="","",D6-D3)');
});

test("TOTAL rows sum via SUMIF (so any number of departments works) + Profit/Loss", () => {
  const rows = pnlTemplateRows(model(), ["Engineering", "Sales"]);
  const flat = rows.map((r) => `${r[0]}|${r[1]}`);
  const tb = rows[flat.indexOf("TOTAL|Total Benefit")];
  const tc = rows[flat.indexOf("TOTAL|Total Cost")];
  const pl = rows[flat.indexOf("TOTAL|Profit / Loss")];
  assert.match(tb[3], /^=SUMIF\(\$B\$2:\$B\$\d+,"Benefit",D\$2:D\$\d+\)$/);
  assert.match(tc[3], /^=SUMIF\(\$B\$2:\$B\$\d+,"Cost",D\$2:D\$\d+\)$/);
  assert.match(pl[3], /^=D\d+-D\d+$/, "profit/loss = total benefit - total cost");
});

test("a per-department diminishing-returns calculator with a SLOPE/INTERCEPT fit", () => {
  const rows = pnlTemplateRows(model(), ["Engineering", "Sales"]);
  const labels = rows.map((r) => r[0]);
  assert.ok(labels.includes("Engineering — calculator"), "Engineering calculator present");
  assert.ok(labels.includes("Sales — calculator"), "Sales calculator present");
  const dimEst = rows[labels.indexOf("Engineering: estimated diminishing % (0-1)")];
  const rateEst = rows[labels.indexOf("Engineering: estimated benefit per head (annual $)")];
  assert.match(dimEst[3], /^=IFERROR\(1-EXP\(SLOPE\(E\d+:E\d+,B\d+:B\d+\)\),/);
  assert.match(rateEst[3], /^=IFERROR\(EXP\(INTERCEPT\(E\d+:E\d+,B\d+:B\d+\)\),/);
});

test("new departments append at the bottom of the template (creation order honoured)", () => {
  const m = buildHeadcountModel({
    employees: [
      { employee_ext_id: "E1", name: "A", department_name: "Zebra", annual_salary: 100000, start_date: "2020-01-01" },
      { employee_ext_id: "E2", name: "B", department_name: "Alpha", annual_salary: 100000, start_date: "2020-01-01" },
    ],
    start: { year: 2026, month0: 0 }, months: 3, now: new Date("2026-01-15"),
  });
  const rows = pnlTemplateRows(m, ["Zebra", "Alpha"]); // creation order, NOT alphabetical
  const firstZebra = rows.findIndex((r) => r[0] === "Zebra");
  const firstAlpha = rows.findIndex((r) => r[0] === "Alpha");
  assert.ok(firstZebra < firstAlpha, "Zebra (created first) comes before Alpha");
});

// ---- route: session-authed download ----------------------------------------
let srv, admin, planId;
before(async () => {
  srv = await startTestServer();
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
});
after(async () => { await srv.close(); });

test("the P&L template downloads as a CSV attachment with the expected sections", async () => {
  const res = await admin.get(`/budgets/pnl-template.csv?version=${planId}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="pnl-template\.csv"/);
  const csv = await res.text();
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /^Department,Line,Assumption,/);
  assert.ok(lines.some((l) => l.startsWith("Engineering,Headcount,")));
  assert.ok(lines.some((l) => l.startsWith("Engineering,Benefit,")));
  assert.ok(lines.some((l) => l.startsWith("Sales,Net (Benefit - Cost),")));
  assert.ok(lines.some((l) => l.startsWith("TOTAL,Profit / Loss,")));
  assert.ok(lines.some((l) => l.startsWith("Engineering — calculator,")));
});

test("the download requires budget-view access", async () => {
  const anon = makeClient(srv.base);
  await anon.get("/login");
  const res = await anon.get(`/budgets/pnl-template.csv`);
  assert.notEqual(res.status, 200);
});
