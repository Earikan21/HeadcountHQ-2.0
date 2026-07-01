/**
 * Production/dev entry point: load config, open the DB, run migrations, build
 * the app, and listen. Migrations run on boot so a fresh deploy is one step.
 */
import { loadConfig, loadDotEnv } from "./config.js";
import { openDb } from "./db/database.js";
import { migrateToLatest } from "./db/migrate.js";
import { buildApp } from "./app.js";

loadDotEnv();
const config = loadConfig();
const db = openDb(config.DATABASE_PATH);
const applied = migrateToLatest(db);
if (applied.length) console.log(`migrated: ${applied.join(", ")}`);

const server = buildApp({ config, db });
server.listen(config.PORT, config.HOST, () => {
  console.log(`Headcount HQ listening on http://${config.HOST}:${config.PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
