import { randomBytes, createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Create an invite for a (pending) user; returns the raw token for the link. */
export function createInvite(db, { email, role, departmentId = null, createdBy = null }) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO invites (token_hash, email, role, department_id, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sha256(token), String(email).trim().toLowerCase(), role, departmentId, expiresAt, createdBy);
  return token;
}

export function getInviteByToken(db, token) {
  if (!token) return null;
  const inv = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(token));
  if (!inv) return null;
  if (inv.accepted_at) return { ...inv, _state: "used" };
  if (new Date(inv.expires_at).getTime() < Date.now()) return { ...inv, _state: "expired" };
  return { ...inv, _state: "valid" };
}

export function markInviteAccepted(db, id) {
  db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ?").run(id);
}
