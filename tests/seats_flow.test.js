import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { headcountRollup } from "../src/repos/seats.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

const CSV = [
  "Employee ID,Name,Department,Job Title,Compensation Amount,Compensation Unit,Employment Status",
  "E-1,Dana Lee,Engineering,Eng Mgr,120000,Annual,Active",
  "E-2,Liam Cho,Engineering,Engineer,150000,Annual,Active",
  "E-3,Mara Ito,Sales,AE,100000,Annual,Active",
  "E-4,Gone Person,Sales,SDR,90000,Annual,Terminated",
].join("\n");

const mapFields = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_job_title: "Job Title", map_compensation_amount: "Compensation Amount",
  map_compensation_unit: "Compensation Unit", map_employment_status: "Employment Status",
};
const seatIdFor = (ext) => srv.db.prepare("SELECT seat_id FROM employees WHERE employee_ext_id=?").get(ext).seat_id;

async function admin() {
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  return c;
}
async function login(email, pw) {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email, password: pw });
  return c;
}

test("import creates a filled seat per active employee; inactive gets none", async () => {
  const c = await admin();
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, mapFields);
  await c.post(`/roster/import/${id}/commit`, {});

  const seats = srv.db.prepare("SELECT status FROM seats").all();
  assert.equal(seats.length, 3, "3 active employees -> 3 seats (terminated one excluded)");
  assert.ok(seats.every((s) => s.status === "filled"));
  const roll = headcountRollup(srv.db);
  assert.equal(roll.totals.approved, 3);
  assert.equal(roll.totals.active, 3);
  assert.equal(roll.totals.open, 0);

  const page = await (await c.get("/roster")).text();
  assert.match(page, /Active headcount/);
  assert.match(page, /Engineering/);
});

test("seat mode + auto: vacating reopens the seat", async () => {
  const c = await login("ada@acme.co", "supersecret123");
  const seatId = seatIdFor("E-1");
  const res = await c.post(`/seats/${seatId}/vacate`, {});
  assert.equal(res.status, 303);
  assert.equal(srv.db.prepare("SELECT status FROM seats WHERE id=?").get(seatId).status, "open");
  const roll = headcountRollup(srv.db);
  assert.equal(roll.totals.approved, 3); // still approved
  assert.equal(roll.totals.active, 2);   // one fewer filled
  assert.equal(roll.totals.open, 1);
});

test("person mode: vacating closes the seat (headcount dissolves)", async () => {
  const c = await login("ada@acme.co", "supersecret123");
  await c.get("/philosophy");
  await c.post("/philosophy", { seat_mode: "person", backfill_policy: "auto", company_phase: "early", industry: "" });
  const seatId = seatIdFor("E-2");
  await c.post(`/seats/${seatId}/vacate`, {});
  assert.equal(srv.db.prepare("SELECT status FROM seats WHERE id=?").get(seatId).status, "closed");
  const roll = headcountRollup(srv.db);
  assert.equal(roll.totals.active, 1);
  // approved now excludes the closed seat: open(E-1) + filled(E-3) = 2
  assert.equal(roll.totals.approved, 2);
});

test("seat mode + reapprove: vacating freezes, then re-approve reopens", async () => {
  const c = await login("ada@acme.co", "supersecret123");
  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "reapprove", company_phase: "early", industry: "" });
  const seatId = seatIdFor("E-3");
  await c.post(`/seats/${seatId}/vacate`, {});
  assert.equal(srv.db.prepare("SELECT status FROM seats WHERE id=?").get(seatId).status, "frozen");
  const reopen = await c.post(`/seats/${seatId}/reopen`, {});
  assert.equal(reopen.status, 303);
  assert.equal(srv.db.prepare("SELECT status FROM seats WHERE id=?").get(seatId).status, "open");
});

test("managers can view headcount but not change settings or seats", async () => {
  const admin2 = await login("ada@acme.co", "supersecret123");
  const engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  await admin2.get("/accounts");
  const created = await admin2.post("/accounts", { name: "Mo", email: "mo@acme.co", role: "manager", department_id: String(engId), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = await login("mo@acme.co", pw);
  assert.equal((await mgr.get("/roster")).status, 200);
  assert.equal((await mgr.get("/philosophy")).status, 403);
  const anySeat = srv.db.prepare("SELECT id FROM seats LIMIT 1").get().id;
  assert.equal((await mgr.post(`/seats/${anySeat}/vacate`, {})).status, 403);
});
