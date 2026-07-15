/**
 * Workspace-wide department focus lens + the "salary must be > 0" rule.
 *
 * These are unit tests over the pure/repo layer (no HTTP): the migration adds the
 * column, the setter persists on its own, and the focus helpers resolve the lock the
 * same way every view does. The salary rule is checked at the plan cell-editor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/database.js";
import { migrateToLatest } from "../src/db/migrate.js";
import { getSettings, setFocusDepartment } from "../src/repos/settings.js";
import { createDepartment, listDepartments } from "../src/repos/departments.js";
import { focusDeptName, effectiveDeptName, focusScope, focusActive } from "../src/domain/focus.js";
import { parseCellEdit } from "../src/domain/plan_edit.js";

function freshDb() {
  const db = openDb(":memory:");
  migrateToLatest(db);
  return db;
}

test("migration 030 adds focus_department, defaulting to '' (All)", () => {
  const db = freshDb();
  const s = getSettings(db);
  assert.equal(s.focus_department, "", "defaults to all departments");
});

test("setFocusDepartment persists on its own and is idempotent to read back", () => {
  const db = freshDb();
  createDepartment(db, { name: "Sales" });
  setFocusDepartment(db, "Sales", 1);
  assert.equal(getSettings(db).focus_department, "Sales");
  // clearing goes back to All
  setFocusDepartment(db, "", 1);
  assert.equal(getSettings(db).focus_department, "");
});

test("setFocusDepartment does NOT disturb the other settings", () => {
  const db = freshDb();
  const before = getSettings(db);
  createDepartment(db, { name: "Eng" });
  setFocusDepartment(db, "Eng", 1);
  const after = getSettings(db);
  assert.equal(after.loaded_cost_multiplier, before.loaded_cost_multiplier);
  assert.equal(after.budget_enforcement, before.budget_enforcement);
  assert.equal(after.ai_assistant_enabled, before.ai_assistant_enabled);
});

test("focusDeptName falls back to '' when the stored dept no longer exists", () => {
  const db = freshDb();
  const d = createDepartment(db, { name: "Sales" });
  setFocusDepartment(db, "Sales", 1);
  assert.equal(focusDeptName({ db }), "Sales");
  assert.equal(focusActive({ db }), true);
  // rename the department out from under the lock
  db.prepare("UPDATE departments SET name='Revenue' WHERE id=?").run(d.id);
  assert.equal(focusDeptName({ db }), "", "no matching dept -> All, never a blank tool");
  assert.equal(focusActive({ db }), false);
});

test("effectiveDeptName: the lock overrides any per-view ?dept selection", () => {
  const db = freshDb();
  createDepartment(db, { name: "Sales" });
  createDepartment(db, { name: "Eng" });
  const ctx = { db };
  // no lock: the selection is used (or null)
  assert.equal(effectiveDeptName(ctx, "Eng"), "Eng");
  assert.equal(effectiveDeptName(ctx, ""), null);
  assert.equal(effectiveDeptName(ctx, null), null);
  // lock on Sales: a hand-edited ?dept=Eng cannot widen past the lock
  setFocusDepartment(db, "Sales", 1);
  assert.equal(effectiveDeptName(ctx, "Eng"), "Sales");
  assert.equal(effectiveDeptName(ctx, null), "Sales");
});

test("focusScope narrows an id-scoped view, never widens it", () => {
  const db = freshDb();
  const sales = createDepartment(db, { name: "Sales" });
  const eng = createDepartment(db, { name: "Eng" });
  const ctx = { db };
  // no lock: the user's own scope is returned untouched
  assert.equal(focusScope(ctx, null), null);
  assert.deepEqual(focusScope(ctx, [eng.id]), [eng.id]);
  // lock on Sales
  setFocusDepartment(db, "Sales", 1);
  assert.deepEqual(focusScope(ctx, null), [sales.id], "admin sees exactly the focused dept");
  assert.deepEqual(focusScope(ctx, [sales.id, eng.id]), [sales.id], "intersect with user scope");
  assert.deepEqual(focusScope(ctx, [eng.id]), [], "user without Sales sees nothing, not everything");
});

test("plan cell-editor rejects salary of 0 and negatives, accepts positive", () => {
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "0" }).error, /greater than 0/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "-5" }).error, /greater than 0/);
  assert.match(parseCellEdit({ key: "emp:E-1", field: "salary", value: "" }).error, /greater than 0/);
  const ok = parseCellEdit({ key: "emp:E-1", field: "salary", value: "120000" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value, 120000);
});
