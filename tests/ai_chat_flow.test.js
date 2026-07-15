/**
 * The conversational hire planner (chat popup) — /model/versions/:id/ai.json.
 *
 * It carries a transcript, asks a clarifying question when the ask is thin, and
 * commits hires (returning a count + summary) once it has enough. The provider is
 * stubbed via global fetch so no real network is touched; the stub answers based on
 * what the transcript says.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin, planId;
const realFetch = globalThis.fetch;

before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "test-key", AI_IMPORT_PROVIDER: "anthropic" });
  // The planner's LLM client: if the user only says "add an engineer", ask for the
  // missing pieces; once a salary + month are present, return a concrete hire.
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages[body.messages.length - 1].content;
    let text = "{}";
    if (/200000|Jan 2027|2027-01/.test(user)) {
      text = JSON.stringify({ hires: [{ department: "Engineering", role: "SWE", start_month: "2027-01", annual_salary: 200000, count: 1 }] });
    } else {
      text = JSON.stringify({ question: "Which department, what start month, and what salary?" });
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };

  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await admin.post("/philosophy", { ai_import_enabled: "on", ai_provider: "anthropic" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,120000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planId = Number((await admin.post("/model/versions", { name: "Chat plan" })).headers.get("location").match(/version=(\d+)/)[1]);
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

const hireCount = () => {
  const row = srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(planId);
  return JSON.parse(row.hires_json || "[]").length;
};

test("the plan editor renders the chat widget and its launcher", async () => {
  const page = await (await admin.get("/model?version=" + planId)).text();
  assert.match(page, /id="scn-chat"/);
  assert.match(page, /data-open-chat/);
  assert.match(page, /id="scn-chat-form"/);
  assert.match(page, new RegExp(`data-version="${planId}"`));
});

test("a thin ask gets a clarifying question, and adds nothing", async () => {
  const before = hireCount();
  const messages = JSON.stringify([{ role: "user", text: "add an engineer" }]);
  const res = await admin.post(`/model/versions/${planId}/ai.json`, { messages });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.match(j.question, /department/i);
  assert.equal(j.added, undefined, "no hires committed on a question");
  assert.equal(hireCount(), before, "nothing was added");
});

test("a complete ask commits hires and returns a count + summary", async () => {
  const before = hireCount();
  const messages = JSON.stringify([
    { role: "user", text: "add an engineer" },
    { role: "assistant", text: "Which department, what start month, and what salary?" },
    { role: "user", text: "Engineering, starting Jan 2027 at 200000" },
  ]);
  const res = await admin.post(`/model/versions/${planId}/ai.json`, { messages });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.added, 1);
  assert.match(j.summary, /Added 1 hire/);
  assert.equal(hireCount(), before + 1, "the hire is persisted on the plan");
});

test("the endpoint refuses a viewer without set-budget rights", async () => {
  // A fresh, unauthenticated client has no session at all.
  const anon = makeClient(srv.base);
  await anon.get("/login");
  const res = await anon.post(`/model/versions/${planId}/ai.json`, { messages: "[]" });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.ok, false);
});
