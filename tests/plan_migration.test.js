/** Migration 026: legacy `count: N` hires explode into N individually editable records. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.js";
import { MIGRATIONS as migrations } from "../src/db/migrations.js";

const m026 = migrations.find((m) => m.name === "2026_07_08_026_scenario_hire_identity");
const m025 = migrations.find((m) => m.name === "2026_07_08_025_plan_overrides");

test("both migrations exist and are appended after 024", () => {
  const names = migrations.map((m) => m.name);
  assert.ok(m025 && m026);
  assert.ok(names.indexOf("2026_07_07_024_ai_full_read_on_by_default") < names.indexOf(m025.name));
  assert.ok(names.indexOf(m025.name) < names.indexOf(m026.name));
});

test("a legacy count:3 hire becomes three named records with stable ids, idempotently", async () => {
  const srv = await startTestServer();
  const db = srv.db;
  db.prepare("INSERT INTO plan_versions (name, hires_json) VALUES (?, ?)").run("Legacy",
    JSON.stringify([
      { department: "Sales", role: "AE", start_month: "2027-06", annual_salary: 120000, count: 3 },
      { department: "Eng", role: "SWE", annual_salary: 180000, count: 1 },
    ]));
  const id = db.prepare("SELECT id FROM plan_versions WHERE name='Legacy'").get().id;

  m026.up(db);
  let hires = JSON.parse(db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(id).hires_json);
  assert.equal(hires.length, 4);
  assert.deepEqual(hires.map((h) => h.id), ["h1", "h2", "h3", "h4"]);
  assert.deepEqual(hires.slice(0, 3).map((h) => h.name), ["AE 1", "AE 2", "AE 3"]);
  assert.equal(hires[3].name, "SWE", "a single hire keeps its plain role name");
  assert.ok(hires.every((h) => !("count" in h)), "count is gone");
  assert.equal(hires[0].annual_salary, 120000);
  assert.equal(hires[0].start_month, "2027-06");
  assert.equal(hires[0].end_month, null);

  // running it again must not rename, renumber, or duplicate anything
  const first = JSON.stringify(hires);
  m026.up(db);
  hires = JSON.parse(db.prepare("SELECT hires_json FROM plan_versions WHERE id=?").get(id).hires_json);
  assert.equal(JSON.stringify(hires), first, "idempotent");
  await srv.close();
});

test("corrupt hires_json degrades to an empty plan rather than throwing", async () => {
  const srv = await startTestServer();
  srv.db.prepare("INSERT INTO plan_versions (name, hires_json) VALUES (?, ?)").run("Broken", "{not json");
  srv.db.prepare("INSERT INTO plan_versions (name, hires_json) VALUES (?, ?)").run("NotArray", '{"a":1}');
  assert.doesNotThrow(() => m026.up(srv.db));
  const rows = srv.db.prepare("SELECT hires_json FROM plan_versions WHERE name IN ('Broken','NotArray')").all();
  for (const r of rows) assert.equal(r.hires_json, "[]");
  await srv.close();
});

test("overrides_json exists and defaults to an empty object", async () => {
  const srv = await startTestServer();
  srv.db.prepare("INSERT INTO plan_versions (name) VALUES ('P')").run();
  assert.equal(srv.db.prepare("SELECT overrides_json FROM plan_versions WHERE name='P'").get().overrides_json, "{}");
  await srv.close();
});
