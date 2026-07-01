/**
 * Migration runner. Applies every pending migration in order, each inside a
 * transaction, recording applied names in schema_migrations so re-runs are
 * idempotent. Used on server boot and via `npm run migrate`.
 */
import { MIGRATIONS } from "./migrations.js";

/** @param {import("node:sqlite").DatabaseSync} db */
export function migrateToLatest(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const has = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
  const record = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");

  const applied = [];
  for (const migration of MIGRATIONS) {
    if (has.get(migration.name)) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      record.run(migration.name);
      db.exec("COMMIT");
      applied.push(migration.name);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration failed: ${migration.name}\n${err.stack || err}`);
    }
  }
  return applied;
}

// Allow running directly: `node --experimental-sqlite src/db/migrate.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig, loadDotEnv } = await import("../config.js");
  const { openDb } = await import("./database.js");
  loadDotEnv();
  const config = loadConfig();
  const db = openDb(config.DATABASE_PATH);
  const applied = migrateToLatest(db);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
  db.close();
}
