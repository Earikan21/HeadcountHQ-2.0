import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const CSV = [
  "Employee ID,Name,Department,Compensation Amount,Compensation Unit",
  "E-1,Dana Lee,Engineering,120000,Annual",
  "E-2,Liam Cho,Engineering,150000,Annual",
  "E-3,Mara Ito,Sales,100000,Annual",
].join("\n");
const mapFields = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
};
async function fresh() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, mapFields);
  await c.post(`/roster/import/${id}/commit`, {});
  return { srv, c };
}
const deptId = (db, name) => db.prepare("SELECT id FROM departments WHERE name=?").get(name)?.id;
const empDept = (db, ext) => db.prepare("SELECT d.name FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.employee_ext_id=?").get(ext)?.name;
const seatDept = (db, ext) => db.prepare("SELECT d.name FROM employees e JOIN seats s ON s.id=e.seat_id JOIN departments d ON d.id=s.department_id WHERE e.employee_ext_id=?").get(ext)?.name;

test("rename carries the target-balance key", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  // set a target on Engineering, then rename
  await c.post("/philosophy/targets", { [`target_${encodeURIComponent("Engineering")}`]: "60" });
  await c.post(`/departments/${eng}/rename`, { name: "Platform Eng" });
  assert.equal(srv.db.prepare("SELECT name FROM departments WHERE id=?").get(eng).name, "Platform Eng");
  const t = srv.db.prepare("SELECT target_pct FROM target_ratios WHERE key='Platform Eng'").get();
  assert.equal(t.target_pct, 60); // key migrated with the rename
  await srv.close();
});

test("merge moves people + seats and removes the source dept", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  const sales = deptId(srv.db, "Sales");
  await c.post(`/departments/${sales}/merge`, { target_id: String(eng) });
  assert.equal(deptId(srv.db, "Sales"), undefined, "Sales removed");
  assert.equal(empDept(srv.db, "E-3"), "Engineering");
  assert.equal(seatDept(srv.db, "E-3"), "Engineering"); // seat followed the person
  await srv.close();
});

test("split creates a new dept and moves selected people (seats follow)", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  const e1 = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get().id;
  await c.post(`/departments/${eng}/split`, { new_name: "Platform", emp: [String(e1)] });
  assert.ok(deptId(srv.db, "Platform"));
  assert.equal(empDept(srv.db, "E-1"), "Platform");
  assert.equal(seatDept(srv.db, "E-1"), "Platform");
  assert.equal(empDept(srv.db, "E-2"), "Engineering"); // unselected stays
  await srv.close();
});

test("move multiple people at once to another department", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  const sales = deptId(srv.db, "Sales");
  const e1 = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-1'").get().id;
  const e2 = srv.db.prepare("SELECT id FROM employees WHERE employee_ext_id='E-2'").get().id;
  await c.post(`/departments/${eng}/move`, { emp: [String(e1), String(e2)], target_id: String(sales) });
  assert.equal(empDept(srv.db, "E-1"), "Sales");
  assert.equal(empDept(srv.db, "E-2"), "Sales");
  await srv.close();
});

test("delete works only on an empty department", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  const reject = await c.post(`/departments/${eng}/delete`, {});
  assert.equal(reject.status, 400); // not empty
  await c.post("/departments", { name: "Temp" });
  const temp = deptId(srv.db, "Temp");
  const ok = await c.post(`/departments/${temp}/delete`, {});
  assert.equal(ok.status, 303);
  assert.equal(deptId(srv.db, "Temp"), undefined);
  await srv.close();
});

test("creating a duplicate department name is rejected", async () => {
  const { srv, c } = await fresh();
  const res = await c.post("/departments", { name: "Engineering" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already exists/);
  await srv.close();
});

test("non-admins cannot manage departments", async () => {
  const { srv, c } = await fresh();
  const eng = deptId(srv.db, "Engineering");
  const created = await c.post("/accounts", { name: "Mo", email: "mo@acme.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "mo@acme.co", password: pw });
  assert.equal((await mgr.get("/departments")).status, 403);
  assert.equal((await mgr.post(`/departments/${eng}/rename`, { name: "X" })).status, 403);
  await srv.close();
});
