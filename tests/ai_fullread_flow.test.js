import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

// End-to-end opt-in AI full-read: a messy file -> AI returns a normalized table
// -> the normal review/commit pipeline imports it. Network is stubbed.
let srv;
const realFetch = globalThis.fetch;

before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "test-key", AI_IMPORT_PROVIDER: "anthropic" });
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const user = body.messages[body.messages.length - 1].content;
    let text = "{}";
    if (user.includes("GRID:")) {
      text = JSON.stringify({ rows: [
        { employee_id: "E-1", name: "Dana Lee", department: "Engineering", job_title: "Senior Engineer", compensation_amount: 185000, compensation_unit: "annual", employment_status: "active" },
        { name: "Liam Cho", department: "Sales", job_title: "Account Executive", compensation_amount: 150000, compensation_unit: "annual", employment_status: "active" },
      ] });
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.post("/philosophy", { ai_import_enabled: "on", ai_full_read_enabled: "on", ai_provider: "anthropic" });
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

async function login() {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  return c;
}

// Deliberately messy: title/metadata preamble, blank/odd columns.
const MESSY = [
  "SiPhox Inc - Employees Summary",
  "Confidential",
  "Printed on,6/19/2026",
  "Person,,Group,,Comp",
  "Dana Lee,,Engineering,,185000",
  "Liam Cho,,Sales,,150000",
].join("\n");

test("philosophy exposes the full-read toggle behind a warning", async () => {
  const c = await login();
  const page = await (await c.get("/philosophy")).text();
  assert.match(page, /AI full read/);
  assert.match(page, /sends sensitive employee data/i);
  assert.match(page, /ai_full_read_enabled/);
});

test("full read: messy file -> normalized table -> review -> commit", async () => {
  const c = await login();
  // Full read is on by default and the file is messy, so upload goes straight to
  // review — no opt-in card, no manual click.
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "messy.csv", content: MESSY });
  assert.equal(up.status, 303);
  assert.match(up.headers.get("location"), /\/roster\/import\/\d+\/review\?fr=ok/, "auto full-read on upload");
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/review/)[1];

  // the batch matrix was replaced with a clean normalized table
  const mapping = JSON.parse(srv.db.prepare("SELECT mapping FROM import_batches WHERE id=?").get(Number(id)).mapping);
  assert.equal(mapping.employee_id, "employee_id"); // identity mapping

  const review = await (await c.get(`/roster/import/${id}/review?fr=ok`)).text();
  assert.match(review, /rebuilt a clean table/);
  assert.match(review, /Dana Lee/);
  assert.match(review, /Liam Cho/);

  const commit = await c.post(`/roster/import/${id}/commit`, {});
  assert.equal(commit.status, 303);
  assert.match(commit.headers.get("location"), /\/roster\?imported=2/);

  const dana = srv.db.prepare("SELECT job_title FROM employees WHERE name='Dana Lee'").get();
  assert.equal(dana.job_title, "Senior Engineer");
  const liam = srv.db.prepare("SELECT employee_ext_id FROM employees WHERE name='Liam Cho'").get();
  assert.ok(/^E-\d+$/.test(liam.employee_ext_id), "missing id auto-generated");

  const runs = srv.db.prepare("SELECT * FROM import_runs WHERE import_batch_id=? AND used_ai=1").all(Number(id));
  assert.ok(runs.length >= 1);
});

test("full-read route is inert when the toggle is off", async () => {
  const c = await login();
  await c.post("/philosophy", { ai_import_enabled: "on", ai_provider: "anthropic" }); // full read OFF
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "m.csv", content: MESSY });
  assert.match(up.headers.get("location"), /\/roster\/import\/\d+\/map/, "no auto full-read when the toggle is off");
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];
  const fr = await c.post(`/roster/import/${id}/fullread`, {});
  assert.equal(fr.status, 303);
  assert.match(fr.headers.get("location"), /\/map$/); // bounced back to map, no work done
  // restore for any later ordering
  await c.post("/philosophy", { ai_import_enabled: "on", ai_full_read_enabled: "on", ai_provider: "anthropic" });
});
