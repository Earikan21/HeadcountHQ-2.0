import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin;
before(async () => {
  srv = await startTestServer();
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("create a named plan, add a hire, and see it layered on the model", async () => {
  const created = await admin.post("/model/versions", { name: "Board plan" });
  assert.equal(created.status, 303);
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  let page = await (await admin.get("/model?version=" + id)).text();
  assert.ok(!/class="version-bar"/.test(page), "the old top plan bar is gone");
  assert.match(page, /class="nav-sublink on"[^>]*>Board plan|Board plan/);
  assert.match(page, /Plan: <b>Board plan<\/b>/);
  await admin.post(`/model/versions/${id}/hire`, { scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "2" });
  page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, /class="prow scn"/);
  // count:2 now creates two individually editable people, each with its own chip
  assert.match(page, /AE 1/);
  assert.match(page, /AE 2/);
  const plan = srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(Number(id));
  assert.match(plan.hires_json, /"department":"Sales"/);
  assert.deepEqual(JSON.parse(plan.hires_json).map((h) => h.id), ["h1", "h2"]);
});

test("Actual view has no scenario rows; deleting a plan removes it", async () => {
  const actual = await (await admin.get("/model")).text();
  assert.ok(!actual.includes('class="prow scn"'), "actual view has no scenario rows");
  const created = await admin.post("/model/versions", { name: "VC plan" });
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  const del = await admin.post(`/model/versions/${id}/delete`, {});
  assert.equal(del.status, 303);
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE id=?").get(Number(id)).n, 0);
});

test("a plan carries assumptions (salary growth + load) that persist and render", async () => {
  const created = await admin.post("/model/versions", { name: "Growth plan" });
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  await admin.post(`/model/versions/${id}/assumptions`, { salary_growth: "10", loaded_mult: "1.3" });
  const stored = srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(Number(id));
  assert.match(stored.assumptions_json, /"salaryGrowthPct":10/);
  const page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, /Assumptions &amp; drivers/);
  assert.match(page, /YoY salary growth/);
  assert.match(page, /Target bonus/);
  assert.match(page, /Hiring slippage/);
  assert.match(page, /Cost per hire/);
});

test("assumptions can be set per department + editor is collapsible with relocated search", async () => {
  const created = await admin.post("/model/versions", { name: "Dept plan" });
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  // company default vs department override
  await admin.post(`/model/versions/${id}/assumptions`, { dept: "Engineering", bonus_pct: "20" });
  const stored = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(Number(id)).assumptions_json);
  assert.equal(stored.byDept.Engineering.bonusPct, 20);
  // scoped editor shows the override UI + collapsible sections + relocated search
  const page = await (await admin.get(`/model?version=${id}&dept=Engineering`)).text();
  assert.match(page, /Overrides for Engineering/);
  assert.match(page, /class="plan-sect"/);
  assert.match(page, /<summary>Hires/);
  // both sections are collapsed by default (no `open` attribute anywhere)
  assert.ok(!/<details class="plan-sect" open>/.test(page), "hires + assumptions start collapsed");
  // search now lives in the single control row, not its own strip
  assert.ok(!/class="model-search"/.test(page), "the separate search row is gone");
  assert.match(page, /class="model-controls"[\s\S]*?id="f-search"/);
});

test("plans are indented sub-tabs of Financial model in the left nav, with a + to add", async () => {
  await admin.post("/model/versions", { name: "Base case" });
  const page = await (await admin.get("/model")).text();
  assert.match(page, /class="nav-children"/);
  assert.match(page, /class="nav-sublink on"[^>]*>Actual/, "Actual is the live model and is selected");
  for (const nm of ["Base case", "Board plan"]) assert.match(page, new RegExp(`class="nav-sublink[^"]*"[^>]*>${nm}`));
  assert.match(page, /class="nav-newplan"[\s\S]*?class="np-add"/, "a + button adds a plan");
  // and the sub-tab lights up for the plan you're on
  const id = srv.db.prepare("SELECT id FROM plan_versions WHERE name='Base case'").get().id;
  const on = await (await admin.get("/model?version=" + id)).text();
  assert.match(on, new RegExp(`href="/model\\?version=${id}" class="nav-sublink on"`));
});

test("Delete plan is a red button guarded by a confirmation", async () => {
  const id = srv.db.prepare("SELECT id FROM plan_versions WHERE name='Base case'").get().id;
  const page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, /class="inline confirm-delete"[^>]*data-confirm="[^"]*Base case/);
  assert.match(page, /class="btn sm danger"[^>]*>Delete plan/);
});

test("model length is a plan-wide 1-10 year setting that drives the window", async () => {
  const id = srv.db.prepare("SELECT id FROM plan_versions WHERE name='Base case'").get().id;
  await admin.post(`/model/versions/${id}/horizon`, { horizon_years: "10" });
  let a = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(id).assumptions_json);
  assert.equal(a.horizonYears, 10);
  const page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, new RegExp(`<option value="10" selected>`));
  assert.match(page, new RegExp(`data-year="${new Date().getFullYear() + 9}"`), "the sheet really runs 10 years out");
  // out-of-range values clamp rather than blowing up the window
  await admin.post(`/model/versions/${id}/horizon`, { horizon_years: "99" });
  a = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(id).assumptions_json);
  assert.equal(a.horizonYears, 10);
  await admin.post(`/model/versions/${id}/horizon`, { horizon_years: "0" });
  a = JSON.parse(srv.db.prepare("SELECT assumptions_json FROM plan_versions WHERE id=?").get(id).assumptions_json);
  assert.equal(a.horizonYears, 1);
});

test("a scenario hire with an end month adds headcount for a limited time only", async () => {
  const created = await admin.post("/model/versions", { name: "Temp plan" });
  const id = created.headers.get("location").match(/version=(\d+)/)[1];
  const y = new Date().getFullYear();
  await admin.post(`/model/versions/${id}/hire`, { scn_department: "Ops", scn_role: "Contractor", scn_start: `${y}-02`, scn_end: `${y}-04`, scn_salary: "120000", scn_count: "1" });
  const stored = JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(Number(id)).hires_json);
  assert.equal(stored[0].end_month, `${y}-04`);
  const page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, new RegExp(`${y}-02 → ${y}-04`), "the chip shows the window");
  assert.match(page, /class="chip temp"/);
});
