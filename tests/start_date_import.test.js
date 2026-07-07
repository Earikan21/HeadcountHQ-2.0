import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { normalizeDate } from "../src/domain/roster.js";

const CSV = [
  "Employee ID,Name,Department,Job Title,Compensation,Unit,Status,Start Date",
  "E-1,Dana Lee,Engineering,Engineer,120000,annual,active,2024-03-15",
  "E-2,Mara Ito,Sales,AE,90000,annual,active,03/01/2026",
].join("\n");
const MAP = { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_job_title: "Job Title", map_compensation_amount: "Compensation", map_compensation_unit: "Unit", map_employment_status: "Status", map_start_date: "Start Date" };

test("normalizeDate handles ISO and US formats", () => {
  assert.equal(normalizeDate("2024-03-15"), "2024-03-15");
  assert.equal(normalizeDate("03/01/2026"), "2026-03-01");
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate("not a date"), null);
});

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

test("import captures each employee's start date", () => {
  const e1 = srv.db.prepare("SELECT start_date FROM employees WHERE employee_ext_id='E-1'").get();
  const e2 = srv.db.prepare("SELECT start_date FROM employees WHERE employee_ext_id='E-2'").get();
  assert.equal(e1.start_date, "2024-03-15");
  assert.equal(e2.start_date, "2026-03-01");
});

test("model window looks back to the earliest start date", async () => {
  const page = await (await c.get("/model")).text();
  assert.match(page, /Mar-2024|Jan-2024/);  // window begins around the earliest hire
});
