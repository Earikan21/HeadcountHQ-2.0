import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

const CSV = [
  "Employee ID,Name,Department,Job Title,Compensation Amount,Compensation Unit,Employment Status",
  "E-1,Dana Lee,Engineering,Eng Manager,120000,Annual,Active",       // band $100k-$125k
  "E-2,Liam Cho,Engineering,Engineer,$185000,Annual,Active",
  "E-3,Mara Ito,Sales,AE,9500,Monthly,Active",                       // -> 114000
  "E-4,No Comp,Sales,SDR,,Annual,Active",                            // error: missing comp
].join("\n");

async function admin() {
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner Ada", email: "ada@acme.co", password: "supersecret123" });
  return c;
}
const mapFields = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_job_title: "Job Title", map_compensation_amount: "Compensation Amount",
  map_compensation_unit: "Compensation Unit", map_employment_status: "Employment Status",
};

test("guided import: upload -> map -> review -> commit", async () => {
  const c = await admin();
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "roster.csv", content: CSV });
  assert.equal(up.status, 303);
  const id = up.headers.get("location").match(/\/roster\/import\/(\d+)\/map/)[1];

  const mapGet = await c.get(`/roster/import/${id}/map`);
  assert.match(await mapGet.text(), /Map your columns/);

  const mapPost = await c.post(`/roster/import/${id}/map`, mapFields);
  assert.equal(mapPost.status, 303);

  const review = await c.get(`/roster/import/${id}/review`);
  const rtext = await review.text();
  assert.match(rtext, /Clean &amp; ready/);
  assert.match(rtext, /Missing compensation/); // E-4 flagged

  const commit = await c.post(`/roster/import/${id}/commit`, {});
  assert.equal(commit.status, 303);
  assert.match(commit.headers.get("location"), /\/roster\?imported=3/);

  // verify persistence
  const n = srv.db.prepare("SELECT COUNT(*) AS n FROM employees").get().n;
  assert.equal(n, 3);
  const comp = srv.db.prepare("SELECT annual_salary FROM compensation c JOIN employees e ON e.id=c.employee_id WHERE e.employee_ext_id='E-3'").get();
  assert.equal(comp.annual_salary, 114000); // 9500*12
});

test("admin sees exact comp; roster lists people", async () => {
  const c = await loginAda();
  const page = await (await c.get("/roster")).text();
  assert.match(page, /Dana Lee/);
  assert.match(page, /\$120,000/);      // exact
  assert.match(page, /Total annual cost/); // totals visible
});

test("c-suite sees bands and totals but not exact salaries", async () => {
  const admin = await loginAda();
  // create a c-suite account with temp password
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Cleo CFO", email: "cleo@acme.co", role: "c_suite", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const exec = makeClient(srv.base);
  await exec.get("/login");
  await exec.post("/login", { email: "cleo@acme.co", password: pw });
  const page = await (await exec.get("/roster")).text();
  assert.match(page, /Dana Lee/);
  assert.match(page, /\$100k–\$125k/);   // band shown
  assert.ok(!page.includes("$120,000"), "exact salary must NOT appear for c-suite");
  assert.match(page, /Total annual cost/); // totals OK for c-suite
});

test("manager sees only their department, bands, and no totals", async () => {
  const admin = await loginAda();
  const engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Mo Mgr", email: "mo@acme.co", role: "manager", department_id: String(engId), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "mo@acme.co", password: pw });
  const page = await (await mgr.get("/roster")).text();
  assert.match(page, /Dana Lee/);              // eng employee visible
  assert.ok(!page.includes("Mara Ito"), "manager must NOT see Sales dept employees");
  assert.ok(!page.includes("$120,000"), "manager must NOT see exact salaries");
  assert.ok(!page.includes("Total annual cost"), "manager must NOT see cost totals");
});

test("non-admin cannot access import or export", async () => {
  const admin = await loginAda();
  const engId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Pat Mgr", email: "pat@acme.co", role: "manager", department_id: String(engId), method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  await mgr.post("/login", { email: "pat@acme.co", password: pw });
  assert.equal((await mgr.get("/roster/import")).status, 403);
  assert.equal((await mgr.get("/roster/export.csv")).status, 403);
});

async function loginAda() {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  return c;
}
