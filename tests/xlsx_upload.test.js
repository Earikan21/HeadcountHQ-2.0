/** Uploading a real Excel workbook through the import wizard, end to end. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTestServer, makeClient } from "./helpers.js";

let srv, c;
before(async () => {
  srv = await startTestServer();
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("the upload page offers Excel, not a 'save as CSV first' workaround", async () => {
  const page = await (await c.get("/roster/import")).text();
  assert.match(page, /Excel workbook/);
  assert.match(page, /accept="[^"]*\.xlsx/);
  assert.ok(!/Save As . CSV/.test(page), "the CSV-only workaround copy is gone");
});

test("an .xlsx roster imports, with start and end dates intact", async () => {
  const buf = readFileSync(new URL("./fixtures/roster.xlsx", import.meta.url));
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "roster.xlsx", content: buf });
  assert.equal(up.status, 303, "the workbook is accepted");
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];

  // the stray title row is skipped and the real header found
  const mapPage = await (await c.get(`/roster/import/${id}/map`)).text();
  assert.match(mapPage, /Employee ID/);

  await c.post(`/roster/import/${id}/map`, {
    map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
    map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
    map_start_date: "Start date", map_end_date: "End date",
  });
  const done = await c.post(`/roster/import/${id}/commit`, {});
  assert.match(done.headers.get("location"), /\/roster\?imported=3/);

  const rows = srv.db.prepare("SELECT name, start_date, end_date FROM employees ORDER BY employee_ext_id").all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].start_date, "2024-01-15", "an Excel date serial became a real date");
  assert.equal(rows[1].name, "Liam O'Neill & Co");
  assert.equal(rows[2].end_date, "2026-09-30");
  const sal = srv.db.prepare(
    "SELECT c.annual_salary FROM compensation c JOIN employees e ON e.id = c.employee_id ORDER BY e.employee_ext_id"
  ).all();
  assert.equal(sal[0].annual_salary, 120000, "salaries survived as numbers, not date serials");
  assert.equal(sal[2].annual_salary, 100000);
});

test("after importing, a modal points at the financial model", async () => {
  const page = await (await c.get("/roster?imported=3")).text();
  assert.match(page, /class="modal-scrim"/);
  assert.match(page, /Imported 3 people/);
  assert.match(page, /href="\/model"[^>]*>Open the financial model/);
  assert.match(page, /role="dialog"/);
  // it only shows when it should, and never for a nonsense count
  assert.ok(!/class="modal-scrim"/.test(await (await c.get("/roster")).text()));
  assert.ok(!/class="modal-scrim"/.test(await (await c.get("/roster?imported=0")).text()));
  assert.ok(!/class="modal-scrim"/.test(await (await c.get("/roster?imported=abc")).text()));
  // and it says "person" for one
  assert.match(await (await c.get("/roster?imported=1")).text(), /Imported 1 person\b/);
});

test("AI full read is on by default", async () => {
  const s = srv.db.prepare("SELECT ai_full_read_enabled, ai_import_enabled, ai_assistant_enabled FROM workspace_settings WHERE workspace_id=1").get();
  assert.equal(s.ai_full_read_enabled, 1);
  assert.equal(s.ai_import_enabled, 1);
  assert.equal(s.ai_assistant_enabled, 1);
});

test("the model has no Add person button, and the welcome never mentions Philosophy", async () => {
  const model = await (await c.get("/model")).text();
  assert.ok(!/\+ Add person/.test(model), "adding people belongs on People, not the model");
  assert.match(model, /Export CSV/);

  const fresh = makeClient(srv.base); // a workspace with no roster shows the welcome
  const srv2 = await startTestServer();
  const c2 = makeClient(srv2.base);
  await c2.get("/setup");
  await c2.post("/setup", { name: "Bo", email: "bo@acme.co", password: "supersecret123" });
  const welcome = await (await c2.get("/")).text();
  assert.match(welcome, /Import your roster/);
  assert.ok(!/href="\/philosophy"/.test(welcome), "Philosophy is not part of setup any more");
  assert.ok(!/Budget dashboard/i.test(welcome), "the budget dashboard is not the payoff any more");
  assert.match(welcome, /Financial model/);
  assert.match(welcome, /Excel workbook/);
  await srv2.close();
  void fresh;
});
