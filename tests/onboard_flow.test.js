import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { headcountRollup } from "../src/repos/seats.js";

async function admin() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  await c.post("/departments", { name: "Engineering" });
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  return { srv, c, eng };
}

test("add a net-new person creates an employee, comp, and a filled seat", async () => {
  const { srv, c, eng } = await admin();
  await c.get("/roster/new");
  const res = await c.post("/roster/new", {
    name: "Dana Lee", department_id: String(eng), job_title: "Engineer",
    employee_type: "Full-Time", comp_amount: "150000", comp_unit: "annual",
  });
  assert.equal(res.status, 303);
  const emp = srv.db.prepare("SELECT * FROM employees WHERE name='Dana Lee'").get();
  assert.ok(emp, "employee created");
  assert.equal(emp.employee_ext_id, "E-0001", "auto-generated id");
  const comp = srv.db.prepare("SELECT annual_salary FROM compensation WHERE employee_id=?").get(emp.id);
  assert.equal(comp.annual_salary, 150000);
  const seat = srv.db.prepare("SELECT status, loaded_cost_estimate FROM seats WHERE occupant_employee_id=?").get(emp.id);
  assert.equal(seat.status, "filled");
  assert.equal(seat.loaded_cost_estimate, 195000); // 150k x1.3
  assert.equal(headcountRollup(srv.db).totals.active, 1);
  await srv.close();
});

test("compensation is normalized to annual (monthly -> x12)", async () => {
  const { srv, c, eng } = await admin();
  await c.post("/roster/new", { name: "Mara Ito", department_id: String(eng), comp_amount: "9500", comp_unit: "monthly" });
  const comp = srv.db.prepare("SELECT annual_salary FROM compensation c JOIN employees e ON e.id=c.employee_id WHERE e.name='Mara Ito'").get();
  assert.equal(comp.annual_salary, 114000); // 9500 x 12
  await srv.close();
});

test("onboarding into an open seat fills it (closes request -> open -> filled)", async () => {
  const { srv, c, eng } = await admin();
  // create + approve a request to get an open seat
  const reqRes = await c.post("/requests", {
    department_id: String(eng), title: "Backend Eng", type: "net_new",
    band_min: "120000", band_max: "160000",
    justification: "Need more platform capacity for the roadmap this quarter.",
    current_hc_narrative: "Maintaining the API.", new_hc_narrative: "Ship billing rewrite sooner.",
  });
  const reqId = Number(reqRes.headers.get("location").match(/\/requests\/(\d+)/)[1]);
  await c.post(`/requests/${reqId}/decision`, { action: "approve" });
  const seatId = srv.db.prepare("SELECT seat_id FROM hiring_requests WHERE id=?").get(reqId).seat_id;
  assert.equal(srv.db.prepare("SELECT status FROM seats WHERE id=?").get(seatId).status, "open");

  const res = await c.post("/roster/new", { seat_id: String(seatId), name: "Liam Cho", comp_amount: "150000", comp_unit: "annual" });
  assert.equal(res.status, 303);
  const seat = srv.db.prepare("SELECT status, occupant_employee_id FROM seats WHERE id=?").get(seatId);
  assert.equal(seat.status, "filled");
  const emp = srv.db.prepare("SELECT id FROM employees WHERE name='Liam Cho'").get();
  assert.equal(seat.occupant_employee_id, emp.id);
  await srv.close();
});

test("validation: name and compensation are required", async () => {
  const { srv, c, eng } = await admin();
  const noName = await c.post("/roster/new", { department_id: String(eng), comp_amount: "100000" });
  assert.equal(noName.status, 400);
  assert.match(await noName.text(), /Name is required/);
  const noComp = await c.post("/roster/new", { name: "X", department_id: String(eng) });
  assert.equal(noComp.status, 400);
  assert.match(await noComp.text(), /Compensation is required/);
  await srv.close();
});

test("only admins can onboard", async () => {
  const { srv, c, eng } = await admin();
  const created = await c.post("/accounts", { name: "Mo", email: "mo@b.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login"); await mgr.post("/login", { email: "mo@b.co", password: pw });
  assert.equal((await mgr.get("/roster/new")).status, 403);
  await srv.close();
});
