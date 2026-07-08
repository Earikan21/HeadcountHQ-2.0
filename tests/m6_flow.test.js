import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

async function admin() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  return { srv, c };
}

test("audit log UI shows recorded actions; managers can't view it", async () => {
  const { srv, c } = await admin();
  await c.post("/departments", { name: "Engineering" });
  const page = await (await c.get("/audit")).text();
  assert.match(page, /Audit log/);
  assert.match(page, /owner created|department created/i);

  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const made = await c.post("/accounts", { name: "Mo", email: "mo@b.co", role: "manager", department_id: String(eng), method: "password" });
  const pw = (await made.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login"); await mgr.post("/login", { email: "mo@b.co", password: pw });
  assert.equal((await mgr.get("/audit")).status, 403);
  await srv.close();
});

test("org chart renders the department hierarchy", async () => {
  const { srv, c } = await admin();
  await c.post("/departments", { name: "Engineering" });
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  await c.post("/departments", { name: "Platform", parent_id: String(eng) });
  const page = await (await c.get("/org")).text();
  assert.match(page, /Org chart/);
  assert.match(page, /Engineering/);
  assert.match(page, /Platform/);
  assert.match(page, /active/);
  await srv.close();
});

test("a corrupt Excel file is rejected with a helpful message (real ones import)", async () => {
  const { srv, c } = await admin();
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "roster.xlsx", content: "PKxx" });
  assert.equal(up.status, 400);
  const body = await up.text();
  assert.match(body, /Not a readable \.xlsx/);
  assert.ok(!/Save As/i.test(body), "Excel is supported now — no re-save-as-CSV workaround");
  await srv.close();
});
