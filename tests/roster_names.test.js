import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

const CSV = [
  "Employee ID,First Name,Last Name,Department,Compensation Amount,Compensation Unit",
  "E-1,Dana,Okafor,Engineering,120000,Annual",
  "E-2,Liam,Chen,Engineering,150000,Annual",
].join("\n");

test("imports a roster with separate First/Last name columns", async () => {
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner", email: "o@acme.co", password: "supersecret123" });
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "names.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];

  // auto-mapping should have claimed first/last; review should be clean without re-mapping
  const review = await (await c.get(`/roster/import/${id}/review`)).text();
  assert.match(review, /Clean &amp; ready/);

  const commit = await c.post(`/roster/import/${id}/commit`, {});
  assert.match(commit.headers.get("location"), /\/roster\?imported=2/);

  // names were combined
  const row = srv.db.prepare("SELECT name FROM employees WHERE employee_ext_id='E-1'").get();
  assert.equal(row.name, "Dana Okafor");
});

test("mapping rejects a file with no name column at all", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "o@acme.co", password: "supersecret123" });
  const noName = "Employee ID,Department,Compensation Amount,Compensation Unit\nE-9,Eng,100000,Annual";
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "noname.csv", content: noName });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  // submit mapping that has no name fields -> should be rejected with the combined-name message
  const res = await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Name \(or First\/Last name\)/);
});
