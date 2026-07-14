/**
 * Excel live link via Power Query (pull). The tool exposes a token-authed CSV the
 * workbook refreshes from — no OAuth, no push. Verifies token lifecycle, the export
 * endpoint's auth + contents (values, not formulas), and admin-only management.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin;
before(async () => {
  srv = await startTestServer({ PUBLIC_URL: "https://hq.example.com" });
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,120000,Annual\nE-2,Liam,Sales,90000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
});
after(async () => { await srv.close(); });

const tokenRow = () => srv.db.prepare("SELECT * FROM export_tokens WHERE workspace_id=1").get();

test("the page offers to generate a link when none exists", async () => {
  const page = await (await admin.get("/integrations/excel")).text();
  assert.match(page, /Power Query/);
  assert.match(page, /Generate link/);
  assert.ok(!tokenRow(), "no token yet");
});

test("generating a link creates a token and shows the full URL", async () => {
  const res = await admin.post("/integrations/excel/token", {});
  assert.equal(res.status, 200);
  const page = await res.text();
  const row = tokenRow();
  assert.ok(row && row.token, "token stored");
  assert.match(page, new RegExp(`https://hq\\.example\\.com/export/model\\.csv\\?token=${row.token.replace(/[-_]/g, ".")}`));
  assert.match(page, /Data . From Web|From Web/);
});

test("the export endpoint needs the token and returns the model as VALUES", async () => {
  const token = tokenRow().token;
  const anon = makeClient(srv.base); // no session at all — like Power Query

  assert.equal((await anon.get("/export/model.csv")).status, 401, "no token");
  assert.equal((await anon.get("/export/model.csv?token=wrong")).status, 401, "bad token");

  const ok = await anon.get(`/export/model.csv?token=${token}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /text\/csv/);
  const body = await ok.text();
  const rows = body.trim().split("\r\n");
  assert.match(rows[0], /^Department,Name,Role,Status,Start,End,Annual Base,Load %,Bonus %,Salary Growth %,Cost per Hire,Loaded Monthly,/);
  assert.match(body, /Dana/);
  assert.match(body, /Liam/);
  assert.ok(!/=[A-Z]\d/.test(body), "values, not formulas");
  // Dana loaded monthly = 120000/12*1.3 = 13000 (default load 1.3)
  assert.match(body, /,13000,/);
  assert.ok(tokenRow().last_used_at, "records that it was fetched");
});

test("rotating the token invalidates the old URL", async () => {
  const old = tokenRow().token;
  await admin.post("/integrations/excel/token", {});
  const fresh = tokenRow().token;
  assert.notEqual(fresh, old);
  const anon = makeClient(srv.base);
  assert.equal((await anon.get(`/export/model.csv?token=${old}`)).status, 401, "old token dead");
  assert.equal((await anon.get(`/export/model.csv?token=${fresh}`)).status, 200, "new token works");
});

test("disabling removes the token and the endpoint stops working", async () => {
  const token = tokenRow().token;
  await admin.post("/integrations/excel/token/delete", {});
  assert.ok(!tokenRow(), "token gone");
  const anon = makeClient(srv.base);
  assert.equal((await anon.get(`/export/model.csv?token=${token}`)).status, 401);
});

test("only an admin can manage the link", async () => {
  const created = await admin.post("/accounts", { name: "Cli", email: `c${Math.random().toString(16).slice(2,6)}@x.co`, role: "client", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const email = srv.db.prepare("SELECT email FROM users WHERE name='Cli' ORDER BY id DESC LIMIT 1").get().email;
  const client = makeClient(srv.base);
  await client.get("/login"); await client.post("/login", { email, password: pw });
  assert.equal((await client.get("/integrations/excel")).status, 403);
  assert.equal((await client.post("/integrations/excel/token", {})).status, 403);
});
