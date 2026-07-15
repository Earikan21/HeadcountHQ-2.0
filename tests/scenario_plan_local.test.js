/**
 * Plan-local department awareness for the AI hire planner.
 *
 * A plan can invent a department purely through scenario hires (e.g. a Sales team with
 * no real roster). The AI must SEE those departments — and their pay — so it doesn't
 * treat them as unknown. Crucially this is scoped per plan: a department created in
 * Plan A must not appear (or get grown) while working in Plan B.
 *
 * The LLM is stubbed via global fetch. The prompt's own rules mention "Sales" as an
 * EXAMPLE, so we key the stub and the assertions off the real "Existing departments"
 * line (the first line) and the user's request — never a raw substring of the prompt.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin, planA, planB, lastPrompt;
const realFetch = globalThis.fetch;

// The department list the model is given (first line of the user prompt).
const deptLine = () => (lastPrompt || "").split("\n")[0];
// What the user actually asked: the text after the "Turn this into hires:" marker and
// BEFORE the "Rules:" block (the rules mention "Sales" as an example, so we exclude them).
const askText = () => (((lastPrompt || "").split("Turn this into hires:")[1] || "").split("Rules:")[0]);

before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "test-key", AI_IMPORT_PROVIDER: "anthropic" });
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    lastPrompt = body.messages[body.messages.length - 1].content;
    // Commit a Sales hire only when the USER actually asked about Sales; otherwise ask.
    const text = /Sales/.test(askText())
      ? JSON.stringify({ hires: [{ department: "Sales", role: "SDR", start_month: "2027-04", annual_salary: 0, salary_basis: "dept_avg", count: 1 }] })
      : JSON.stringify({ question: "Which department and how many?" });
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await admin.post("/philosophy", { ai_import_enabled: "on", ai_provider: "anthropic" });
  // Roster has Engineering only — Sales does NOT exist as a real department.
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,180000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planA = Number((await admin.post("/model/versions", { name: "Plan A" })).headers.get("location").match(/version=(\d+)/)[1]);
  planB = Number((await admin.post("/model/versions", { name: "Plan B" })).headers.get("location").match(/version=(\d+)/)[1]);
  // Plan A invents a Sales team through a scenario hire; Plan B stays empty.
  await admin.post(`/model/versions/${planA}/hire`, { scn_department: "Sales", scn_role: "SDR", scn_start: "2027-03", scn_salary: "120000", scn_count: "1" });
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

const hires = (id) => JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(id).hires_json || "[]");

async function ask(planId, text) {
  const res = await admin.post(`/model/versions/${planId}/ai.json`, { messages: JSON.stringify([{ role: "user", text }]) });
  return res.json();
}

test("Plan A's department list includes its plan-local Sales team and its hire", async () => {
  await ask(planA, "add another SDR to Sales, April 2027, same pay as the others");
  assert.match(deptLine(), /Sales/, "Sales is offered as an existing department for this plan");
  assert.match(lastPrompt, /already includes these planned hires[^\n]*SDR in Sales/, "the plan's SDR is described to the model");
});

test("Plan A: adds to Sales and prices from the plan-local SDR (no 'unknown department')", async () => {
  const before = hires(planA).length;
  const j = await ask(planA, "add another SDR to Sales at the department average, April 2027");
  assert.equal(j.ok, true);
  assert.equal(j.added, 1, "added, not blocked as an unknown department");
  const after = hires(planA);
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].annual_salary, 120000, "dept average = the existing Sales SDR's pay");
});

test("plan isolation: Plan B's department list does NOT include Plan A's Sales", async () => {
  await ask(planB, "add someone");
  assert.ok(!/Sales/.test(deptLine()), "Sales is a Plan-A-only department; Plan B must not see it");
  assert.ok(!/already includes these planned hires/.test(lastPrompt), "Plan B has no scenario hires, so no plan-hire context");
});

test("plan isolation: growing Plan A never added anything to Plan B", () => {
  assert.equal(hires(planB).length, 0, "Plan B stays empty while Plan A grows");
});
