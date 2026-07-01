import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const REQ = {
  title: "Backend Engineer", type: "net_new", band_min: "120000", band_max: "160000",
  justification: "We are behind on the platform roadmap and over capacity for the quarter.",
  current_hc_narrative: "Maintaining the API and the on-call rotation.",
  new_hc_narrative: "Ship the billing rewrite a quarter earlier.",
};

async function setup() {
  const srv = await startTestServer();
  const admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await admin.post("/departments", { name: "Engineering" });
  await admin.post("/departments", { name: "Sales" });
  const engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const created = await admin.post("/accounts", { name: "Mo", email: "mo@acme.co", role: "manager", department_id: String(engId), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login"); await mgr.post("/login", { email: "mo@acme.co", password: pw });
  return { srv, admin, mgr, engId };
}
const reqIdFrom = (res) => Number(res.headers.get("location").match(/\/requests\/(\d+)/)[1]);

test("a request must be justified (both narratives required)", async () => {
  const { srv, mgr } = await setup();
  await mgr.get("/requests/new");
  const bad = await mgr.post("/requests", { ...REQ, new_hc_narrative: "" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /what would you do with the new headcount/i);
  await srv.close();
});

test("manager submits; estimated fully-loaded cost is computed from the band", async () => {
  const { srv, mgr } = await setup();
  await mgr.get("/requests/new");
  const res = await mgr.post("/requests", REQ);
  assert.equal(res.status, 303);
  const id = reqIdFrom(res);
  const r = srv.db.prepare("SELECT department_id, estimated_cost, status FROM hiring_requests WHERE id=?").get(id);
  assert.equal(r.status, "submitted");
  assert.equal(r.estimated_cost, 182000); // mid 140k * 1.3 default multiplier
  await srv.close();
});

test("managers are scoped to their own department's requests", async () => {
  const { srv, admin, mgr } = await setup();
  const salesId = srv.db.prepare("SELECT id FROM departments WHERE name='Sales'").get().id;
  const made = await admin.post("/requests", { ...REQ, department_id: String(salesId), title: "AE" });
  const salesReqId = reqIdFrom(made);
  assert.equal((await mgr.get(`/requests/${salesReqId}`)).status, 403);
  await srv.close();
});

test("approval creates an OPEN seat consuming budget", async () => {
  const { srv, admin, mgr, engId } = await setup();
  const id = reqIdFrom(await mgr.post("/requests", REQ));
  const res = await admin.post(`/requests/${id}/decision`, { action: "approve" });
  assert.equal(res.status, 303);
  const r = srv.db.prepare("SELECT status, seat_id FROM hiring_requests WHERE id=?").get(id);
  assert.equal(r.status, "approved");
  assert.ok(r.seat_id, "a seat was created");
  const seat = srv.db.prepare("SELECT status, department_id, loaded_cost_estimate, source_request_id FROM seats WHERE id=?").get(r.seat_id);
  assert.equal(seat.status, "open");
  assert.equal(seat.department_id, engId);
  assert.equal(seat.loaded_cost_estimate, 182000);
  assert.equal(seat.source_request_id, id);
  await srv.close();
});

test("soft enforcement flags but allows over-budget; hard blocks it", async () => {
  // ---- soft (default): budget of 1 position, approve two ----
  let { srv, admin, mgr, engId } = await setup();
  await admin.post("/budgets", { [`hc_${engId}`]: "1", [`money_${engId}`]: "0" });
  const a = reqIdFrom(await mgr.post("/requests", REQ));
  const b = reqIdFrom(await mgr.post("/requests", { ...REQ, title: "Eng 2" }));
  assert.equal((await admin.post(`/requests/${a}/decision`, { action: "approve" })).status, 303);
  assert.equal((await admin.post(`/requests/${b}/decision`, { action: "approve" })).status, 303); // soft allows the 2nd
  await srv.close();

  // ---- hard: same setup, second approval blocked ----
  ({ srv, admin, mgr, engId } = await setup());
  await admin.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "early", budget_enforcement: "hard" });
  await admin.post("/budgets", { [`hc_${engId}`]: "1", [`money_${engId}`]: "0" });
  const c = reqIdFrom(await mgr.post("/requests", REQ));
  const d = reqIdFrom(await mgr.post("/requests", { ...REQ, title: "Eng 2" }));
  assert.equal((await admin.post(`/requests/${c}/decision`, { action: "approve" })).status, 303);
  const blocked = await admin.post(`/requests/${d}/decision`, { action: "approve" });
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /exceed.*headcount budget/i);
  assert.equal(srv.db.prepare("SELECT status FROM hiring_requests WHERE id=?").get(d).status, "submitted"); // not approved
  await srv.close();
});

test("budgets page is for budget-setters; managers can't open it", async () => {
  const { srv, admin, mgr } = await setup();
  assert.equal((await admin.get("/budgets")).status, 200);
  assert.equal((await mgr.get("/budgets")).status, 403);
  assert.equal((await mgr.get("/requests/new")).status, 200); // managers CAN request
  await srv.close();
});
