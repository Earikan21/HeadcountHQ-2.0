import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

// First line is a title, real headers on line 2.
const CSV = [
  "Q3 2026 Headcount Plan",
  "Employee ID,Name,Department,Compensation Amount,Compensation Unit",
  "E-1,Dana Lee,Engineering,120000,Annual",
  "E-2,Liam Cho,Engineering,150000,Annual",
].join("\n");

test("import auto-detects the header row beneath a title row", async () => {
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Owner", email: "o@acme.co", password: "supersecret123" });
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "titled.csv", content: CSV });
  assert.equal(up.status, 303);
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];

  const mapText = await (await c.get(`/roster/import/${id}/map`)).text();
  // The picker should default to Row 2, and the real columns should be mappable.
  assert.match(mapText, /Which row has your column headers/);
  assert.match(mapText, /Employee ID/);
  // the picker should default to row 2 (the real headers), not the title row
  assert.match(mapText, /<option value="1"[^>]*selected[^>]*>Row 2: Employee ID/);
  assert.ok(!/<option value="0"[^>]*selected/.test(mapText), "title row must not be the selected header");

  // mapping should already be auto-set to the real headers; go straight to review
  const review = await (await c.get(`/roster/import/${id}/review`)).text();
  assert.match(review, /Clean &amp; ready/);

  const commit = await c.post(`/roster/import/${id}/commit`, {});
  assert.match(commit.headers.get("location"), /Imported\+2\+employees/);
});

test("user can override the header row when auto-detect is wrong", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "o@acme.co", password: "supersecret123" });
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "t2.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  // force header row to 0 (the title) then back to 1
  const r0 = await c.post(`/roster/import/${id}/header`, { header_row: "0" });
  assert.equal(r0.status, 303);
  const r1 = await c.post(`/roster/import/${id}/header`, { header_row: "1" });
  assert.equal(r1.status, 303);
  const review = await (await c.get(`/roster/import/${id}/review`)).text();
  assert.match(review, /Clean &amp; ready/);
});
