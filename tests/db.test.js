import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/database.js";
import { migrateToLatest } from "../src/db/migrate.js";

test("migration creates workspaces and seeds a default workspace", () => {
  const db = openDb(":memory:");
  const applied = migrateToLatest(db);
  assert.ok(applied.includes("2026_06_19_000_init"));
  const rows = db.prepare("SELECT name FROM workspaces").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Default Workspace");
  db.close();
});

test("migrations are idempotent (no re-apply on second run)", () => {
  const db = openDb(":memory:");
  migrateToLatest(db);
  const appliedAgain = migrateToLatest(db);
  assert.equal(appliedAgain.length, 0);
  const count = db.prepare("SELECT COUNT(*) AS n FROM workspaces").get();
  assert.equal(count.n, 1); // not duplicated
  db.close();
});
