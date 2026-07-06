import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, c, deptId, batchId;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.post("/departments", { name: "Engineering" });
  deptId = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  // upload a roster but DO NOT commit, so the draft map/review pages are reachable
  await c.get("/roster/import");
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Engineering,120000,Annual";
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  batchId = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
});
after(async () => { await srv.close(); });

/** Returns the maximum <form> nesting depth in an HTML string (1 = no nesting). */
function maxFormDepth(htmlStr) {
  let depth = 0, max = 0;
  for (const t of htmlStr.matchAll(/<\/?form\b[^>]*>/gi)) {
    if (/^<form/i.test(t[0])) { depth++; max = Math.max(max, depth); }
    else depth--;
  }
  return max;
}

const PAGES = () => [
  "/philosophy", `/departments/${deptId}`, "/roster", "/accounts",
  `/roster/import/${batchId}/map`, `/roster/import/${batchId}/review`,
];

test("no authenticated page nests <form> elements (would drop CSRF tokens)", async () => {
  for (const path of PAGES()) {
    const res = await c.get(path);
    assert.equal(res.status, 200, `${path} should render`);
    const depth = maxFormDepth(await res.text());
    assert.ok(depth <= 1, `${path} has nested forms (depth ${depth})`);
  }
});

test("the mapping page still submits cleanly to review", async () => {
  const res = await c.post(`/roster/import/${batchId}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /\/review$/);
});
