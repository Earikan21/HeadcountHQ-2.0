import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, engId;
const realFetch = globalThis.fetch;

before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "test-key", AI_IMPORT_PROVIDER: "anthropic" });
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages[body.messages.length - 1].content;
    let text = "{}";
    if (user.includes("band_min")) {
      text = JSON.stringify({ band_min: 150000, band_max: 190000, rationale: "Growth-stage SaaS engineering." });
    } else if (user.includes("current_hc_narrative")) {
      text = JSON.stringify({
        justification: "Drafted: engineering is under target and delivery is constrained.",
        current_hc_narrative: "The team ships one feature per quarter.",
        new_hc_narrative: "A second squad doubles throughput.",
        expected_value_basis: "benchmark",
      });
    } else if (user.includes("QUESTION:")) {
      text = "You have people across your departments.\nRecommendations:\n- Set a company budget to track runway.";
    } else if (user.includes("Turn this into hires")) {
      if (/PAST-TEST/.test(user)) text = JSON.stringify({ hires: [{ department: "Sales", role: "AE", start_month: "2019-01", annual_salary: 120000, count: 1 }] });
      else if (/ASK-TEST/.test(user)) text = JSON.stringify({ question: "Which department should they go in, and what salary?" });
      else text = JSON.stringify({ hires: [{ department: "Sales", role: "AE", start_month: "2027-06", annual_salary: 120000, count: 2 }] });
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.post("/philosophy", { ai_import_enabled: "on", ai_assistant_enabled: "on", ai_provider: "anthropic" });
  srv.db.prepare("INSERT INTO departments (name) VALUES ('Engineering')").run();
  engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

async function loginAda() {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  return c;
}

test("request form: AI estimate fills the comp band", async () => {
  const c = await loginAda();
  const res = await c.post("/requests", { action: "ai_estimate", title: "Senior Engineer", department_id: String(engId) });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /value="150000"/);
  assert.match(body, /value="190000"/);
  assert.match(body, /Estimated band/);
});

test("request form: AI draft fills the justification narratives", async () => {
  const c = await loginAda();
  const res = await c.post("/requests", {
    action: "ai_justify", title: "Senior Engineer", type: "net_new", department_id: String(engId),
    justification: "need help", current_hc_narrative: "", new_hc_narrative: "",
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Drafted: engineering is under target/);
  assert.match(body, /Drafted with AI/);
});

test("assistant tab answers and recommends", async () => {
  const c = await loginAda();
  const page = await (await c.get("/assistant")).text();
  assert.match(page, /Assistant/);
  const res = await c.post("/assistant", { question: "How are we doing on headcount?" });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Recommendations/);
  assert.match(body, /Set a company budget/);
});

test("floating assistant widget shows for finance admin", async () => {
  const c = await loginAda();
  const roster = await (await c.get("/roster")).text();
  assert.match(roster, /id="ai-fab"/);
});

test("floating widget endpoint /assistant/ask returns a JSON answer", async () => {
  const c = await loginAda();
  const res = await c.post("/assistant/ask", { question: "How are we doing on headcount?" });
  assert.match(res.headers.get("content-type"), /application\/json/);
  const data = JSON.parse(await res.text());
  assert.ok(data.answer && data.answer.length > 0, "should return an answer");
});

test("AI adds planned hires to a plan version", async () => {
  const c = await loginAda();
  const created = await c.post("/model/versions", { name: "Board plan" });
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  await c.post(`/model/versions/${id}/ai`, { description: "hire 2 AEs in Sales starting June 2027 at $120k" });
  const page = await (await c.get("/model?version=" + id)).text();
  assert.match(page, /class="prow scn"/);
  assert.match(page, /AE/);
});

test("AI never adds a hire in the past — a past start is pulled forward to now", async () => {
  const c = await loginAda();
  const id = (await c.post("/model/versions", { name: "No past" })).headers.get("location").match(/version=(\d+)/)[1];
  await c.post(`/model/versions/${id}/ai`, { description: "hire an AE in Sales PAST-TEST at 120k" });
  const hires = JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(Number(id)).hires_json);
  assert.equal(hires.length, 1, "the hire is still added");
  const now = new Date();
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  assert.ok(hires[0].start_month >= nowMonth, `start ${hires[0].start_month} is not before ${nowMonth}`);
  assert.ok(!/^(19|20[0-2])/.test(hires[0].start_month) || hires[0].start_month >= nowMonth, "no 2019 start");
});

test("AI asks a clarifying question and adds nothing when the request is unclear", async () => {
  const c = await loginAda();
  const id = (await c.post("/model/versions", { name: "Ask first" })).headers.get("location").match(/version=(\d+)/)[1];
  const res = await c.post(`/model/versions/${id}/ai`, { description: "hire some people ASK-TEST" });
  const page = await res.text();
  assert.match(page, /Which department should they go in/, "the question is shown");
  const hires = JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(Number(id)).hires_json);
  assert.equal(hires.length, 0, "nothing was added while it waits for an answer");
});

test("managers cannot reach the assistant", async () => {
  const admin = await loginAda();
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Mo Mgr", email: "mo@acme.co", role: "manager", department_id: String(engId), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "mo@acme.co", password: pw });
  assert.equal((await mgr.get("/assistant")).status, 403);
  const roster = await (await mgr.get("/roster")).text();
  assert.ok(!roster.includes('id="ai-fab"'), "manager must not see the assistant widget");
});
