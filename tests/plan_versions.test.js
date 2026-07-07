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
  assert.match(page, /class="version-bar"/);
  assert.match(page, /Board plan/);
  assert.match(page, /Plan: Board plan/);
  await admin.post(`/model/versions/${id}/hire`, { scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "2" });
  page = await (await admin.get("/model?version=" + id)).text();
  assert.match(page, /class="prow scn"/);
  assert.match(page, /2× AE/);
  const plan = srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(Number(id));
  assert.match(plan.hires_json, /"department":"Sales"/);
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

test("multiple named versions coexist as subtabs", async () => {
  await admin.post("/model/versions", { name: "Base case" });
  const page = await (await admin.get("/model")).text();
  for (const nm of ["Base case", "Board plan"]) assert.ok(page.includes(nm), `subtab ${nm} present`);
  assert.match(page, /href="\/model"[^>]*class="vtab on"|class="vtab on"[^>]*>Actual/);
});
