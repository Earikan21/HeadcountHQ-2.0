import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { compVisibility, canSetBudgets, canUseAssistant } from "../src/authz.js";

// M21 (Directive 4.0): an external CLIENT is a c_suite-level user flagged is_client —
// VIEW-ONLY, gets the "ask your data" assistant, and optionally a full (exact-comp) view.
let srv, owner, full, limited;
async function makeAccount(role, email, extra = {}) {
  const created = await owner.post("/accounts", { name: email, email, role, method: "password", ...extra });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const cl = makeClient(srv.base);
  await cl.get("/login");
  await cl.post("/login", { email, password: pw });
  return cl;
}
before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "k", AI_IMPORT_PROVIDER: "groq" });
  owner = makeClient(srv.base);
  await owner.get("/setup");
  await owner.post("/setup", { name: "Firm Admin", email: "cfo@firm.co", password: "supersecret123" });
  await owner.get("/accounts");
  full = await makeAccount("client", "ceo@client.co", { client_full: "on" });
  limited = await makeAccount("client", "cfo@client.co");
});
after(async () => { await srv.close(); });

test("client accounts are c_suite users flagged is_client; full-view flag persists", () => {
  const f = srv.db.prepare("SELECT role, is_client, client_full FROM users WHERE email='ceo@client.co'").get();
  assert.deepEqual({ ...f }, { role: "c_suite", is_client: 1, client_full: 1 });
  const l = srv.db.prepare("SELECT is_client, client_full FROM users WHERE email='cfo@client.co'").get();
  assert.equal(l.is_client, 1);
  assert.equal(l.client_full, 0);
});

test("compVisibility: full client + admin = exact; limited client + plain c_suite + manager = bands", () => {
  assert.equal(compVisibility({ role: "finance_admin" }), "exact");
  assert.equal(compVisibility({ role: "c_suite", is_client: 1, client_full: 1 }), "exact");
  assert.equal(compVisibility({ role: "c_suite", is_client: 1, client_full: 0 }), "bands");
  assert.equal(compVisibility({ role: "c_suite", is_client: 0 }), "bands");
  assert.equal(compVisibility({ role: "manager" }), "bands");
});

test("clients are view-only + get the assistant (authz)", () => {
  const clientUser = { role: "c_suite", is_client: 1 };
  assert.equal(canSetBudgets(clientUser), false, "clients cannot edit budgets");
  assert.equal(canSetBudgets({ role: "c_suite", is_client: 0 }), true, "plain c_suite still edits");
  assert.equal(canUseAssistant(clientUser), true, "clients get ask-your-data");
});

test("client nav: People + Financial model + Assistant, labeled Client, no backend chrome", async () => {
  const home = await (await full.get("/")).text();
  assert.match(home, /href="\/roster"/);
  assert.match(home, /href="\/model"/);
  assert.match(home, /id="ai-fab"/);   // floating ask-your-data widget
  assert.match(home, />Client</);
  for (const re of [/href="\/philosophy"/, /href="\/accounts"/, /href="\/audit"/]) {
    assert.ok(!re.test(home), `client nav must not include ${re}`);
  }
});

test("client can VIEW budgets + assistant but cannot mutate", async () => {
  assert.equal((await full.get("/budgets")).status, 200);
  assert.equal((await full.get("/assistant")).status, 200);
  const post = await full.post("/budgets", { mode: "headcount", company_headcount: "10" });
  assert.equal(post.status, 403, "view-only client must not edit budgets");
});

test("client budgets page is read-only (no Save button)", async () => {
  const page = await (await full.get("/budgets")).text();
  assert.ok(!page.includes("Save headcount budget"), "no save control for a view-only client");
});

test("client cannot reach backend routes (403)", async () => {
  for (const path of ["/philosophy", "/accounts", "/audit", "/roster/import"]) {
    assert.equal((await full.get(path)).status, 403, `${path} must be forbidden`);
  }
});
