/** Per-workspace export token for the Power Query live link. */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const getToken = (db) =>
  db.prepare("SELECT * FROM export_tokens WHERE workspace_id = 1").get() || null;

/** Create or rotate the token; returns the new row. */
export function rotateToken(db, userId) {
  const token = randomBytes(24).toString("base64url");
  db.prepare(`
    INSERT INTO export_tokens (workspace_id, token, created_by, created_at, last_used_at)
    VALUES (1, ?, ?, datetime('now'), NULL)
    ON CONFLICT(workspace_id) DO UPDATE SET token = excluded.token, created_by = excluded.created_by, created_at = datetime('now'), last_used_at = NULL
  `).run(token, userId || null);
  return getToken(db);
}

export const deleteToken = (db) =>
  db.prepare("DELETE FROM export_tokens WHERE workspace_id = 1").run();

/** Constant-time check that a presented token matches the stored one. */
export function tokenValid(db, presented) {
  const row = getToken(db);
  if (!row || !presented) return false;
  const a = Buffer.from(String(row.token));
  const b = Buffer.from(String(presented));
  if (a.length !== b.length) return false;
  const ok = timingSafeEqual(a, b);
  if (ok) { try { db.prepare("UPDATE export_tokens SET last_used_at = datetime('now') WHERE workspace_id = 1").run(); } catch { /* ignore */ } }
  return ok;
}
