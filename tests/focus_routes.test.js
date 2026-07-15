/**
 * End-to-end: the workspace department focus lock, applied through the routes.
 * Setting it in Settings scopes the Excel export and the model view, shows the
 * tool-wide banner, and a hand-edited ?dept= can't widen past it. Also: the
 * scenario-hire form rejects a non-positive salary with a message.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin, planId;
const token = () => srv.db.prepare("SELECT token FROM export_tokens WHERE workspace_id=1").get()?.token;

before(async () => {
  srv = await startTestServer();
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  const CSV = [
    "Employee ID,Name,Department,Compensation Amount,Compensation Unit",
    "E-1,Dana,Sales,120000,Annual",
    "E-2,Liam,Engineering,180000,Annual",
  ].join("\n");
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planId = Number((await admin.post("/model/versions", { name: "Plan X" })).headers.get("location").match(/version=(\d+)/)[1]);
  await admin.post("/integrations/excel/token/ensure", { return: "/model" });
});
after(async () => { await srv.close(); });

const focus = () => srv.db.prepare("SELECT focus_department FROM workspace_settings WHERE workspace_id=1").get().focus_department;

test("Settings shows the Department focus control", async () => {
  const page = await (await admin.get("/philosophy")).text();
  assert.match(page, /Department focus/);
  assert.match(page, /action="\/philosophy\/focus"/);
  assert.match(page, /All departments/);
});

test("applying a focus persists it and only accepts a real department", async () => {
  await admin.post("/philosophy/focus", { focus_department: "Sales" });
  assert.equal(focus(), "Sales");
  // a bogus department is ignored (treated as All)
  await admin.post("/philosophy/focus", { focus_department: "Nope" });
  assert.equal(focus(), "");
  await admin.post("/philosophy/focus", { focus_department: "Sales" });
  assert.equal(focus(), "Sales");
});

test("the tool-wide banner appears while focused", async () => {
  const page = await (await admin.get("/")).text();
  assert.match(page, /focus-banner/);
  assert.match(page, /Showing <b>Sales<\/b> only/);
});

test("the model view is scoped to the focus and its picker is locked", async () => {
  const page = await (await admin.get(`/model?version=${planId}`)).text();
  assert.match(page, /Dana/, "Sales person shown");
  assert.ok(!/Liam/.test(page), "Engineering person hidden by the lock");
  assert.match(page, /id="f-dept"[^>]*disabled/, "the department picker is disabled");
});

test("the Excel export honors the lock, and ?dept can't widen past it", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  const locked = await (await anon.get(`/export/model.csv?token=${t}`)).text();
  assert.match(locked, /Dana/);
  assert.ok(!/Liam/.test(locked), "export excludes Engineering while focused on Sales");
  // trying to force another department via the URL is ignored
  const forced = await (await anon.get(`/export/model.csv?token=${t}&dept=Engineering`)).text();
  assert.ok(!/Liam/.test(forced), "?dept=Engineering cannot escape the Sales lock");
});

test("clearing the focus restores the full tool", async () => {
  await admin.post("/philosophy/focus", { focus_department: "" });
  assert.equal(focus(), "");
  const page = await (await admin.get(`/model?version=${planId}`)).text();
  assert.match(page, /Liam/, "Engineering visible again");
  assert.ok(!/focus-banner/.test(await (await admin.get("/")).text()), "banner gone");
});

test("the scenario-hire form rejects a salary of 0 with a message", async () => {
  const before = JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(planId).hires_json || "[]").length;
  const res = await admin.post(`/model/versions/${planId}/hire`, { scn_department: "Sales", scn_role: "AE", scn_salary: "0", scn_count: "1" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /Salary\+must\+be\+greater\+than\+0/);
  const after = JSON.parse(srv.db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(planId).hires_json || "[]").length;
  assert.equal(after, before, "nothing was written");
});
