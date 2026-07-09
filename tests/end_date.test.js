/**
 * Removing headcount, and adding it for a limited time.
 *
 * A person's `end_date` is the month after which they stop costing anything. It is
 * imported alongside the start date, and the same mechanism backs a scenario hire's
 * `end_month` (a contractor, a backfill, a seasonal team).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { buildHeadcountModel, deriveWindow } from "../src/domain/model.js";

// ---- engine ----------------------------------------------------------------
const emp = (over) => ({ department_name: "Eng", annual_salary: 120000, employment_status: "active", ...over });

test("a whole-month end date (last day) keeps that month full, then stops", () => {
  const m = buildHeadcountModel({
    employees: [emp({ name: "Temp", start_date: "2026-03-01", end_date: "2026-05-31" })],
    loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 8, now: new Date("2026-03-15"),
  });
  const r = m.roster[0];
  assert.deepEqual(r.active, [0, 0, 1, 1, 1, 0, 0, 0], "Mar-May full months");
  assert.equal(m.monthlyHeadcount[4], 1, "May is their last month");
  assert.equal(m.monthlyHeadcount[5], 0, "June: gone");
  assert.equal(Math.round(m.totalMonthlyCost[4]), 12000); // 120k/12*1.2, full May
  assert.equal(Math.round(m.totalMonthlyCost[5]), 0);
});

test("a mid-month end date pays only the worked fraction of that month", () => {
  const m = buildHeadcountModel({
    employees: [emp({ name: "Temp", start_date: "2026-03-01", end_date: "2026-05-15" })],
    loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 6, now: new Date("2026-03-15"),
  });
  const r = m.roster[0];
  assert.equal(r.active[4].toFixed(4), (15 / 31).toFixed(4), "May: 15 of 31 days");
  assert.equal(Math.round(m.totalMonthlyCost[4]), Math.round(12000 * 15 / 31));
  assert.equal(m.monthlyHeadcount[4], 1, "still counts as a person that month");
});

test("an end date before the window means the person never appears", () => {
  const m = buildHeadcountModel({
    employees: [emp({ name: "Gone", start_date: "2020-01-01", end_date: "2020-06-01" })],
    loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 3, now: new Date("2026-01-15"),
  });
  assert.deepEqual(m.roster[0].active, [0, 0, 0]);
  assert.equal(m.totalMonthlyCost.reduce((a, b) => a + b, 0), 0);
});

test("no end date means the person runs to the end of the window", () => {
  const m = buildHeadcountModel({
    employees: [emp({ name: "Staying", start_date: "2026-01-01" })],
    loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 6, now: new Date("2026-01-15"),
  });
  assert.deepEqual(m.roster[0].active, [1, 1, 1, 1, 1, 1]);
});

test("a scenario hire with an end month is temporary headcount", () => {
  const m = buildHeadcountModel({
    employees: [], loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 6, now: new Date("2026-01-15"),
    scenarioHires: [{ department: "Ops", role: "Contractor", start_month: "2026-02", end_month: "2026-03", annual_salary: 120000, count: 2 }],
  });
  assert.equal(m.roster.length, 2, "count: 2 produces two rows");
  assert.deepEqual(m.monthlyHeadcount, [0, 2, 2, 0, 0, 0]);
  assert.ok(m.roster.every((r) => r.scenario));
});

// ---- model length (1-10 years) ----------------------------------------------
test("the plan's horizon drives how far the window runs, and clamps to 1-10 years", () => {
  const staff = [emp({ name: "A", start_date: "2026-01-01" })];
  const now = new Date("2026-07-15");
  const endYear = (h) => {
    const m = buildHeadcountModel({ employees: staff, loadedMultiplier: 1.2, now, assumptions: h == null ? {} : { horizonYears: h } });
    return m.cols[m.cols.length - 1].year;
  };
  assert.equal(endYear(null), 2031, "default is 5 years out");
  assert.equal(endYear(1), 2027);
  assert.equal(endYear(10), 2036);
  assert.equal(endYear(99), 2036, "clamped at 10 years");
});

test("deriveWindow honours an explicit horizon and stays within its month cap", () => {
  const w = deriveWindow([emp({ start_date: "2016-01-01" })], new Date("2026-07-15"), 120);
  assert.ok(w.months <= 180, "the window never grows without bound");
  assert.ok(w.months >= 120, "at least the requested horizon");
});

// ---- import ------------------------------------------------------------------
let srv, c;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("an End date column imports, and that person drops out of the model", async () => {
  const y = new Date().getFullYear();
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit,Start date,End date\n" +
    `E-1,Dana Lee,Engineering,120000,Annual,${y - 2}-01-01,\n` +
    `E-2,Leaver Lou,Engineering,90000,Annual,${y - 2}-01-01,${y - 1}-06-30`;
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];

  // the mapper recognises the column by name
  const mapPage = await (await c.get(`/roster/import/${id}/map`)).text();
  assert.match(mapPage, /End date/);

  await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
    map_start_date: "Start date", map_end_date: "End date",
  });
  await c.post(`/roster/import/${id}/commit`, {});

  const rows = srv.db.prepare("SELECT name, start_date, end_date FROM employees ORDER BY name").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Dana Lee");
  assert.equal(rows[0].end_date, null, "no end date means still here");
  assert.equal(rows[1].end_date, `${y - 1}-06-30`);

  // the leaver is on the sheet historically but contributes nothing now
  const page = await (await c.get("/model")).text();
  assert.match(page, /Leaver Lou/);
  assert.match(page, /class="prow ends"/, "the row is flagged as ending");
  const model = srv.db.prepare("SELECT COUNT(*) n FROM employees WHERE end_date IS NOT NULL").get();
  assert.equal(model.n, 1);
});

test("a blank end-date cell on re-import never wipes an existing one", async () => {
  const y = new Date().getFullYear();
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\n" +
    "E-2,Leaver Lou,Engineering,95000,Annual";
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r2.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
  });
  await c.post(`/roster/import/${id}/commit`, {});
  const row = srv.db.prepare("SELECT end_date FROM employees WHERE employee_ext_id='E-2'").get();
  assert.equal(row.end_date, `${y - 1}-06-30`, "COALESCE preserves the departure date");
});

test("End removes a person's headcount from this month on; Restore brings them back", async () => {
  const emp = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // the row offers a month picker + "End", guarded by a confirmation
  let page = await (await c.get("/model")).text();
  assert.match(page, new RegExp(`action="/roster/${emp.id}/end"[^>]*class="inline endform confirm-delete"`));
  assert.match(page, /class="linklike danger-link"[^>]*>End</);
  assert.match(page, /<input type="month" name="end_month" class="endmo"/, "the departure can be scheduled");

  const res = await c.post(`/roster/${emp.id}/end`, {});
  assert.equal(res.status, 303);
  const row = srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id);
  assert.match(row.end_date, new RegExp(`^${thisMonth}-\\d{2}$`), "defaults to the end of this month");

  // the row now reads as ending, and offers Restore instead
  page = await (await c.get("/model")).text();
  assert.match(page, new RegExp(`action="/roster/${emp.id}/restore"`));
  assert.ok(!new RegExp(`action="/roster/${emp.id}/end"`).test(page), "End is replaced by Restore");
  assert.match(page, new RegExp(`action="/roster/${emp.id}/restore"[\\s\\S]*?>Restore<`));

  await c.post(`/roster/${emp.id}/restore`, {});
  assert.equal(srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id).end_date, null);
});

test("End accepts an explicit month and lands on that month's last day", async () => {
  const emp = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get();
  await c.post(`/roster/${emp.id}/end`, { end_month: "2027-02" });
  assert.equal(srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id).end_date, "2027-02-28");
  await c.post(`/roster/${emp.id}/end`, { end_month: "2028-02" }); // leap year
  assert.equal(srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id).end_date, "2028-02-29");
  await c.post(`/roster/${emp.id}/restore`, {});
});

test("a manager cannot end someone's headcount", async () => {
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const created = await c.post("/accounts", { name: "Mo", email: "mo@acme.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "mo@acme.co", password: pw });
  const emp = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get();
  const res = await mgr.post(`/roster/${emp.id}/end`, {});
  assert.equal(res.status, 403);
  assert.equal(srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id).end_date, null);
});

test("a departure can be scheduled for a future month and takes effect only then", async () => {
  const emp = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get();
  const y = new Date().getFullYear() + 1;
  await c.post(`/roster/${emp.id}/end`, { end_month: `${y}-09` });
  assert.equal(srv.db.prepare("SELECT end_date FROM employees WHERE id=?").get(emp.id).end_date, `${y}-09-30`);

  // still on the books today, gone the month after the scheduled end
  const { buildHeadcountModel } = await import("../src/domain/model.js");
  const rows = srv.db.prepare("SELECT e.*, d.name AS department_name, c.annual_salary FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN compensation c ON c.employee_id=e.id WHERE e.id=?").all(emp.id);
  const m = buildHeadcountModel({ employees: rows, loadedMultiplier: 1.2, start: { year: y, month0: 7 }, months: 4, now: new Date() });
  assert.deepEqual(m.monthlyHeadcount, [1, 1, 0, 0], "Aug + Sep on, Oct off");

  // the sheet shows the scheduled month in its own Ends column, and swaps End for Restore
  const page = await (await c.get("/model")).text();
  assert.match(page, /<th class="sortable " rowspan="2" data-sort="end"[^>]*>Ends<\/th>/);
  assert.match(page, new RegExp(`<td class="num">${y}-09</td>`), "the Ends cell shows when they leave");
  assert.match(page, new RegExp(`action="/roster/${emp.id}/restore"`));
  await c.post(`/roster/${emp.id}/restore`, {});
});
