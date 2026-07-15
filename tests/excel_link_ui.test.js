/**
 * "Link to Excel" popup on the model view — per Actual AND per scenario plan.
 * The button opens a modal; the URL is scoped to the view; the export honours ?version.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin, planId;
before(async () => {
  srv = await startTestServer({ PUBLIC_URL: "https://hq.example.com" });
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,120000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
  planId = Number((await admin.post("/model/versions", { name: "VC plan" })).headers.get("location").match(/version=(\d+)/)[1]);
  await admin.post(`/model/versions/${planId}/hire`, { scn_department: "Sales", scn_role: "AE", scn_start: "2027-06", scn_salary: "120000", scn_count: "1" });
});
after(async () => { await srv.close(); });
const token = () => srv.db.prepare("SELECT token FROM export_tokens WHERE workspace_id=1").get()?.token;

test("the model view has a 'Link to Excel' button that opens a popup", async () => {
  const page = await (await admin.get("/model")).text();
  assert.match(page, /data-open-modal="excel-link"[^>]*>Link to Excel/);
  assert.match(page, /id="excel-link-modal"/);
  assert.match(page, /From Web/, "the popup carries the Power Query steps");
});

test("with no token yet, the popup offers to create the link", async () => {
  assert.ok(!token(), "no token before");
  const page = await (await admin.get("/model")).text();
  assert.match(page, /action="\/integrations\/excel\/token\/ensure"/);
});

test("Create link makes a token once and reopens the popup (?excel=1)", async () => {
  const res = await admin.post("/integrations/excel/token/ensure", { return: "/model" });
  assert.equal(res.headers.get("location"), "/model?excel=1");
  const t1 = token();
  assert.ok(t1, "token created");
  // idempotent — creating again does NOT rotate an existing token (old URLs keep working)
  await admin.post("/integrations/excel/token/ensure", { return: "/model" });
  assert.equal(token(), t1, "existing token preserved");
});

test("each plan shows its own scoped URL (&version=…)", async () => {
  const t = token();
  const page = await (await admin.get("/model?version=" + planId)).text();
  // the URL is in an attribute, so & is rendered as &amp;
  assert.match(page, new RegExp(`/export/model\\.csv\\?token=${t}&amp;version=${planId}`));
  // Actual's popup has no version
  const actual = await (await admin.get("/model")).text();
  assert.match(actual, new RegExp(`/export/model\\.csv\\?token=${t}"`));
});

test("the export honours ?version — a plan pulls the plan's model", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  const planCsv = await (await anon.get(`/export/model.csv?token=${t}&version=${planId}`)).text();
  const actualCsv = await (await anon.get(`/export/model.csv?token=${t}`)).text();
  assert.match(planCsv, /,AE,/, "plan export includes the scenario AE hire");
  assert.ok(!/,AE,/.test(actualCsv), "Actual export excludes plan-only hires");
  assert.match(planCsv, /Dana/);
  // a bad version just returns Actual (no crash)
  assert.equal((await anon.get(`/export/model.csv?token=${t}&version=99999`)).status, 200);
});

test("with a department selected, the popup offers a scoped URL AND an all-departments URL", async () => {
  const t = token();
  const page = await (await admin.get(`/model?version=${planId}&dept=Engineering`)).text();
  // scoped URL carries &dept=Engineering (& is &amp; in the attribute)
  assert.match(page, new RegExp(`/export/model\\.csv\\?token=${t}&amp;version=${planId}&amp;dept=Engineering`));
  // and the all-departments URL (no &dept) is offered too
  assert.match(page, new RegExp(`/export/model\\.csv\\?token=${t}&amp;version=${planId}"`));
  assert.match(page, /just this department/i);
  // a stable per-department summary feed is offered too
  assert.match(page, new RegExp(`/export/summary\\.csv\\?token=${t}&amp;version=${planId}`));
  assert.match(page, /Monthly summary/);
});

test("the export honours ?dept — a scoped URL returns only that department", async () => {
  const t = token();
  const anon = makeClient(srv.base);
  const engOnly = await (await anon.get(`/export/model.csv?token=${t}&dept=Engineering`)).text();
  assert.match(engOnly, /Dana/, "Engineering person present");
  // Header row + Dana only (no other department rows)
  assert.ok(!/,Sales,/.test(engOnly), "no Sales rows in an Engineering-scoped export");
});

test("the URL falls back to the Render address when PUBLIC_URL is unset", async () => {
  // This suite sets PUBLIC_URL, so assert the fallback constant exists in the code path
  // indirectly: a server with no PUBLIC_URL uses headcounthq.onrender.com.
  const bare = await import("../src/routes/excel.js");
  assert.equal(bare.publicBase({ PUBLIC_URL: "", PORT: 3000 }), "https://headcounthq.onrender.com");
  assert.equal(bare.publicBase({ PUBLIC_URL: "https://x.example.com" }), "https://x.example.com");
});
