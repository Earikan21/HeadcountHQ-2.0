import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

// End-to-end AI import. We start the server WITH a key configured, then stub the
// global fetch so the server's LLM client talks to our in-memory model. No real
// network. The stub answers based on which prompt it sees.
let srv;
const realFetch = globalThis.fetch;

before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "test-key", AI_IMPORT_PROVIDER: "anthropic" });
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages[body.messages.length - 1].content;
    let text = "{}";
    if (user.includes("Target fields:")) {
      text = JSON.stringify({
        employee_id: "Employee ID", name: "Name", department: "Department",
        job_title: "Job Title", compensation_amount: "Compensation Amount",
        compensation_unit: "Compensation Unit", employment_status: "Employment Status",
      });
    } else if (user.includes("Categories:")) {
      text = JSON.stringify({ Engineering: "rnd", Sales: "sm" });
    } else if (user.includes("Titles:")) {
      text = JSON.stringify({ "Eng Manager": "Engineering Manager" });
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.post("/philosophy", { ai_import_enabled: "on", ai_provider: "anthropic" });
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

async function login() {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  return c;
}

const CSV = [
  "Employee ID,Name,Department,Job Title,Compensation Amount,Compensation Unit,Employment Status",
  "E-1,Dana Lee,Engineering,Eng Manager,120000,Annual,Active",
  "E-2,Liam Cho,Engineering,Engineer,185000,Annual,Active",
  "E-3,Mara Ito,Sales,AE,150000,Annual,Active",
].join("\n");

test("settings shows AI configured and never echoes a key", async () => {
  const c = await login();
  const page = await (await c.get("/philosophy")).text();
  assert.match(page, /Assisted import/);
  assert.match(page, /configured/);
  assert.ok(!page.includes("test-key"), "the API key must never be rendered");
});

test("AI map -> AI cleanup -> commit applies suggestions", async () => {
  const c = await login();
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "roster.csv", content: CSV });
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];

  // AI mapping
  const aiMap = await c.post(`/roster/import/${id}/ai-map`, {});
  assert.equal(aiMap.status, 303);
  assert.match(aiMap.headers.get("location"), /ai=1/);
  const mapPage = await (await c.get(aiMap.headers.get("location"))).text();
  assert.match(mapPage, /AI suggested the mappings/);
  const mapping = JSON.parse(srv.db.prepare("SELECT mapping FROM import_batches WHERE id=?").get(Number(id)).mapping);
  assert.equal(mapping.compensation_amount, "Compensation Amount");

  // AI cleanup
  const aiClean = await c.post(`/roster/import/${id}/ai-clean`, {});
  assert.equal(aiClean.status, 303);
  const assumptions = JSON.parse(srv.db.prepare("SELECT assumptions FROM import_batches WHERE id=?").get(Number(id)).assumptions);
  assert.equal(assumptions.aiTitleMap["Eng Manager"], "Engineering Manager");
  assert.equal(assumptions.aiDeptCategory.Engineering, "rnd");

  // review shows the normalized title + cleanup card
  const review = await (await c.get(`/roster/import/${id}/review`)).text();
  assert.match(review, /AI cleanup/);
  assert.match(review, /Engineering Manager/);

  // commit applies them
  const commit = await c.post(`/roster/import/${id}/commit`, {});
  assert.equal(commit.status, 303);
  const dana = srv.db.prepare("SELECT job_title FROM employees WHERE employee_ext_id='E-1'").get();
  assert.equal(dana.job_title, "Engineering Manager");
  const eng = srv.db.prepare("SELECT function_category FROM departments WHERE name='Engineering'").get();
  assert.equal(eng.function_category, "rnd");

  const runs = srv.db.prepare("SELECT * FROM import_runs WHERE import_batch_id=?").all(Number(id));
  assert.ok(runs.some((r) => r.phase === "mapping" && r.used_ai === 1));
  assert.ok(runs.some((r) => r.phase === "cleanup"));
});

test("on-device anomaly flagging surfaces a suspicious salary without AI", async () => {
  const c = await login();
  const csv = [
    "Employee ID,Name,Department,Job Title,Compensation Amount,Compensation Unit,Employment Status",
    "E-10,Ana,Engineering,Engineer,125000,Annual,Active",
    "E-11,Bo,Engineering,Engineer,130000,Annual,Active",
    "E-12,Cy,Engineering,Engineer,128000,Annual,Active",
    "E-13,Di,Engineering,Engineer,140000,Annual,Active",
    "E-14,Ed,Engineering,Engineer,50,Annual,Active",
  ].join("\n");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: csv });
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_job_title: "Job Title", map_compensation_amount: "Compensation Amount",
    map_compensation_unit: "Compensation Unit", map_employment_status: "Employment Status",
  });
  const review = await (await c.get(`/roster/import/${id}/review`)).text();
  assert.match(review, /too low/);
});

test("AI routes are inert when the toggle is off", async () => {
  const c = await login();
  await c.post("/philosophy", { ai_provider: "anthropic" });
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];
  const aiMap = await c.post(`/roster/import/${id}/ai-map`, {});
  assert.equal(aiMap.status, 303);
  assert.ok(!/ai=1/.test(aiMap.headers.get("location")));
  await c.post("/philosophy", { ai_import_enabled: "on", ai_provider: "anthropic" });
});
