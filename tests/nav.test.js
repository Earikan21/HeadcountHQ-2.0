import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, c;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("admin nav links to Departments (M2.75 entry point)", async () => {
  const home = await (await c.get("/")).text();
  assert.match(home, /href="\/departments"[^>]*>Departments</);
});

test("the Departments page renders the rename/merge/split tools via a managed dept", async () => {
  await c.post("/departments", { name: "Engineering" });
  const list = await (await c.get("/departments")).text();
  assert.match(list, /Manage/);
  const id = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const manage = await (await c.get(`/departments/${id}`)).text();
  assert.match(manage, /Rename/);
  assert.match(manage, /Merge into another department/);
  assert.match(manage, /move or split/);
});

test("managers do not see the Departments admin link", async () => {
  await c.post("/departments", { name: "Sales" });
  const sid = srv.db.prepare("SELECT id FROM departments WHERE name='Sales'").get().id;
  const created = await c.post("/accounts", { name: "Mo", email: "mo@acme.co", role: "manager", department_id: String(sid), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "mo@acme.co", password: pw });
  const home = await (await mgr.get("/")).text();
  assert.ok(!/href="\/departments"/.test(home), "manager nav must not link to Departments");
});
