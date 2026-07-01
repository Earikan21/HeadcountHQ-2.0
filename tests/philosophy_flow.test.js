import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

const CSV = [
  "Employee ID,Name,Department,Compensation Amount,Compensation Unit,Employment Status",
  "E-1,Dana Lee,Engineering,120000,Annual,Active",
  "E-2,Liam Cho,Engineering,150000,Annual,Active",
  "E-3,Mara Ito,Sales,100000,Annual,Active",
].join("\n");
const mapFields = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
  map_employment_status: "Employment Status",
};

async function freshAdmin() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  return { srv, c };
}
async function importRoster(c) {
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, mapFields);
  await c.post(`/roster/import/${id}/commit`, {});
}

test("/settings redirects to the central /philosophy hub", async () => {
  const { srv, c } = await freshAdmin();
  const r = await c.get("/settings");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/philosophy");
  await srv.close();
});

test("expanded philosophy params persist", async () => {
  const { srv, c } = await freshAdmin();
  await c.get("/philosophy");
  await c.post("/philosophy", {
    seat_mode: "seat", backfill_policy: "auto", company_phase: "growth", industry: "B2B SaaS",
    target_span_of_control: "7", max_layers: "5", loaded_cost_multiplier: "1.4",
    annual_attrition_pct: "12", contractor_target_pct: "5", budgeting_approach: "zero_based",
    require_csuite_approval: "on",
  });
  const s = srv.db.prepare("SELECT * FROM workspace_settings WHERE workspace_id=1").get();
  assert.equal(s.target_span_of_control, 7);
  assert.equal(s.loaded_cost_multiplier, 1.4);
  assert.equal(s.budgeting_approach, "zero_based");
  assert.equal(s.require_csuite_approval, 1);
  assert.equal(s.company_phase, "growth");
  await srv.close();
});

test("apply-phase seeds research-based org-shape + cost suggestions", async () => {
  const { srv, c } = await freshAdmin();
  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "scale", industry: "" });
  await c.post("/philosophy/apply-phase", {});
  const s = srv.db.prepare("SELECT target_span_of_control, max_layers FROM workspace_settings WHERE workspace_id=1").get();
  assert.equal(s.target_span_of_control, 8);
  assert.equal(s.max_layers, 7);
  await srv.close();
});

test("loaded cost is applied to seats on import (multiplier x base)", async () => {
  const { srv, c } = await freshAdmin();
  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "early", industry: "", loaded_cost_multiplier: "1.5" });
  await importRoster(c);
  const seat = srv.db.prepare("SELECT loaded_cost_estimate FROM seats s JOIN employees e ON e.id=s.occupant_employee_id WHERE e.employee_ext_id='E-1'").get();
  assert.equal(seat.loaded_cost_estimate, 180000);
  await srv.close();
});

test("management directly edits the target balance; suggestion seeds a starting point", async () => {
  const { srv, c } = await freshAdmin();
  await importRoster(c);
  await c.post("/philosophy/targets/suggest", {});
  const seeded = srv.db.prepare("SELECT key, source FROM target_ratios WHERE family='department_mix'").all();
  assert.ok(seeded.length >= 2);
  assert.ok(seeded.every((r) => r.source === "default"));

  await c.post("/philosophy/targets", {
    [`target_${encodeURIComponent("Engineering")}`]: "70",
    [`target_${encodeURIComponent("Sales")}`]: "30",
  });
  const eng = srv.db.prepare("SELECT target_pct, source FROM target_ratios WHERE key='Engineering'").get();
  assert.equal(eng.target_pct, 70);
  assert.equal(eng.source, "manual");

  const pageHtml = await (await c.get("/philosophy")).text();
  assert.match(pageHtml, /Target balance/);
  assert.match(pageHtml, /Engineering/);
  await srv.close();
});

test("only Finance Admin can reach the philosophy hub", async () => {
  const { srv, c } = await freshAdmin();
  await c.get("/accounts");
  const created = await c.post("/accounts", { name: "Cleo", email: "cleo@acme.co", role: "c_suite", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const exec = makeClient(srv.base);
  await exec.get("/login");
  await exec.post("/login", { email: "cleo@acme.co", password: pw });
  assert.equal((await exec.get("/philosophy")).status, 403);
  await srv.close();
});

test("Suggest button redirects 303 (no header crash) and seeds targets", async () => {
  const { srv, c } = await freshAdmin();
  await importRoster(c);
  const r = await c.post("/philosophy/targets/suggest", {});
  assert.equal(r.status, 303, "suggest must redirect, not 500");
  assert.match(r.headers.get("location"), /\/philosophy/);
  const n = srv.db.prepare("SELECT COUNT(*) AS n FROM target_ratios WHERE family='department_mix'").get().n;
  assert.ok(n >= 2);
  await srv.close();
});

test("Suggest with no departments yet does not crash", async () => {
  const { srv, c } = await freshAdmin();
  const r = await c.post("/philosophy/targets/suggest", {});
  assert.equal(r.status, 303);
  await srv.close();
});
