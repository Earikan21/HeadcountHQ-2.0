import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { headcountRollup, backfillSeats } from "../src/repos/seats.js";

const MAP = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
  map_employment_status: "Employment Status",
};
async function adminClient() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  return { srv, c };
}
async function importCsv(c, csv) {
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: csv });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
}
const HDR = "Employee ID,Name,Department,Compensation Amount,Compensation Unit,Employment Status";

test("backfill creates filled seats for pre-existing seatless employees", async () => {
  const { srv, c } = await adminClient();
  await c.post("/departments", { name: "Engineering" });
  const dept = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  // simulate data imported before seats existed: employees with no seat
  srv.db.prepare("INSERT INTO employees (employee_ext_id, name, department_id, job_title, employment_status) VALUES (?,?,?,?,?)").run("X-1", "Old A", dept, "Eng", "active");
  srv.db.prepare("INSERT INTO employees (employee_ext_id, name, department_id, job_title, employment_status) VALUES (?,?,?,?,?)").run("X-2", "Old B", dept, "Eng", "active");
  assert.equal(headcountRollup(srv.db).totals.active, 0, "no seats yet");

  const made = backfillSeats(srv.db);
  assert.equal(made, 2);
  const roll = headcountRollup(srv.db);
  assert.equal(roll.totals.active, 2);
  assert.equal(roll.totals.approved, 2);
  await srv.close();
});

test("re-import adding an active person raises active headcount", async () => {
  const { srv, c } = await adminClient();
  await importCsv(c, `${HDR}\nE-1,Dana,Engineering,120000,Annual,Active\nE-2,Liam,Engineering,150000,Annual,Active`);
  assert.equal(headcountRollup(srv.db).totals.active, 2);
  await importCsv(c, `${HDR}\nE-1,Dana,Engineering,120000,Annual,Active\nE-2,Liam,Engineering,150000,Annual,Active\nE-3,Mara,Engineering,110000,Annual,Active`);
  assert.equal(headcountRollup(srv.db).totals.active, 3, "new active person reflected");
  await srv.close();
});

test("re-import marking someone inactive vacates their seat", async () => {
  const { srv, c } = await adminClient();
  await importCsv(c, `${HDR}\nE-1,Dana,Engineering,120000,Annual,Active\nE-2,Liam,Engineering,150000,Annual,Active`);
  assert.equal(headcountRollup(srv.db).totals.active, 2);
  // E-2 leaves
  await importCsv(c, `${HDR}\nE-1,Dana,Engineering,120000,Annual,Active\nE-2,Liam,Engineering,150000,Annual,Terminated`);
  const roll = headcountRollup(srv.db);
  assert.equal(roll.totals.active, 1, "vacated seat no longer counts as active");
  // E-2 has no live seat occupancy
  const e2seat = srv.db.prepare("SELECT seat_id FROM employees WHERE employee_ext_id='E-2'").get().seat_id;
  assert.equal(e2seat, null);
  await srv.close();
});
