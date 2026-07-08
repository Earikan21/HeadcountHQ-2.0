/**
 * Server-side sessions. The cookie holds a high-entropy opaque token; only its
 * SHA-256 hash is stored in the DB, so a leaked database does not reveal usable
 * session tokens. Each session carries a CSRF token.
 */
import { randomBytes, createHash } from "node:crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Create a session; returns the raw cookie token + csrf token. */
export function createSession(db, userId, { ip = "", userAgent = "", mfaPending = false } = {}) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const id = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent, mfa_pending)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, csrf, expiresAt, ip, userAgent, mfaPending ? 1 : 0);
  return { token, csrf, expiresAt };
}

/** Mark a session as having cleared the second factor. */
export function markSessionMfaPassed(db, token) {
  if (!token) return;
  db.prepare("UPDATE sessions SET mfa_pending = 0 WHERE id = ?").run(sha256(token));
}

/** Resolve a cookie token to { session, user } or null if missing/expired. */
export function getSession(db, token) {
  if (!token) return null;
  const id = sha256(token);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user || user.status !== "active") return null;
  // Attach the canonical set of departments this collaborator owns. Authorization
  // scope reads this array, never the legacy single-valued users.department_id.
  user.department_ids = db
    .prepare("SELECT department_id FROM collaborator_departments WHERE user_id = ? ORDER BY department_id")
    .all(user.id)
    .map((r) => r.department_id);
  return { session, user };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
}

export function destroyAllForUser(db, userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
