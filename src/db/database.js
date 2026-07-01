/**
 * Opens a SQLite database via Node's built-in node:sqlite (DatabaseSync) and
 * returns it. Kept tiny and isolated so the rest of the app depends on this
 * one module rather than the experimental API directly — making it easy to
 * swap the storage engine later.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {string} databasePath  A file path, or ":memory:" for an ephemeral DB.
 * @returns {DatabaseSync}
 */
export function openDb(databasePath) {
  if (databasePath !== ":memory:") {
    const dir = dirname(databasePath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (databasePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return db;
}
