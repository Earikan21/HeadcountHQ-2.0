import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const MAP = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
};
async function setup() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\n" +
    "E-1,Dana,Engineering,120000,Annual\nE-2,Liam,Engineering,160000,Annual\nE-3,Mara,Sales,100000,Annual";
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const sales = srv.db.prepare("SELECT id FROM departments WHERE name='Sales'").get().id;
  return { srv, c, eng, sales };
}

test("company assumptions + scenario; Sales hires model derived bookings", async () => {
  const { srv, c, eng, sales } = await setup();
  // mark Sales as the revenue function
  await c.post("/departments/categories", { [`cat_${sales}`]: "sm", [`cat_${eng}`]: "rnd" });
  await c.post("/planning/financials", { cash_balance: "3000000", monthly_burn: "50000", horizon_months: "24", bookings_per_rep: "800000", sales_ramp_months: "5", attainment_conservative_pct: "60", attainment_base_pct: "70", attainment_aggressive_pct: "80" });
  const created = await c.post("/planning/scenarios", { name: "Base plan" });
  const scId = Number(created.headers.get("location").match(/scenarios\/(\d+)/)[1]);

  await c.post(`/planning/scenarios/${scId}/items`, {
    [`nh_${eng}`]: "4", [`sm_${eng}`]: "0", [`pace_${eng}`]: "all_at_once", [`cph_${eng}`]: "150000", [`out_${eng}`]: "base",
    [`nh_${sales}`]: "2", [`sm_${sales}`]: "0", [`pace_${sales}`]: "all_at_once", [`cph_${sales}`]: "130000", [`out_${sales}`]: "aggressive",
  });
  const engItem = srv.db.prepare("SELECT new_hires, pace FROM scenario_items WHERE scenario_id=? AND department_id=?").get(scId, eng);
  assert.equal(engItem.new_hires, 4);
  assert.equal(engItem.pace, "all_at_once");
  const salesItem = srv.db.prepare("SELECT outcome FROM scenario_items WHERE scenario_id=? AND department_id=?").get(scId, sales);
  assert.equal(salesItem.outcome, "aggressive");

  const page = await (await c.get(`/planning/scenarios/${scId}`)).text();
  assert.match(page, /Runway/);
  assert.match(page, /Per-department plan/);
  assert.match(page, /Incremental bookings/);
  assert.match(page, /Sales/); // the Sales tag
  await srv.close();
});

test("board export returns a monthly CSV over the horizon", async () => {
  const { srv, c } = await setup();
  await c.post("/planning/financials", { cash_balance: "1000000", monthly_burn: "80000", horizon_months: "12" });
  const created = await c.post("/planning/scenarios", { name: "Export" });
  const scId = Number(created.headers.get("location").match(/scenarios\/(\d+)/)[1]);
  const res = await c.get(`/planning/scenarios/${scId}/export.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /csv/);
  const body = await res.text();
  assert.match(body, /^month,headcount,headcount_cost,revenue,net_burn,cash/);
  assert.equal(body.trim().split("\n").length, 1 + 12); // header + 12 months
  await srv.close();
});

test("creating a scenario requires a name", async () => {
  const { srv, c } = await setup();
  const res = await c.post("/planning/scenarios", { name: "" });
  assert.equal(res.status, 400);
  await srv.close();
});

test("managers cannot access planning", async () => {
  const { srv, c, eng } = await setup();
  const made = await c.post("/accounts", { name: "Mo", email: "mo@b.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await made.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login"); await mgr.post("/login", { email: "mo@b.co", password: pw });
  assert.equal((await mgr.get("/planning")).status, 403);
  await srv.close();
});
