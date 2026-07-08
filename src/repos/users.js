import { hashRecoveryCode, generateRecoveryCodes } from "../domain/totp.js";
import { hashPassword } from "../auth/passwords.js";
import { addDepartmentForUser } from "./collaborators.js";

export const countUsers = (db) =>
  db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

export const getUserByEmail = (db, email) =>
  db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase());

export const getUserById = (db, id) =>
  db.prepare("SELECT * FROM users WHERE id = ?").get(id);

export function listUsers(db) {
  return db.prepare(
    `SELECT u.*, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      ORDER BY u.role, u.name`
  ).all();
}

/** Create a user with a known password (e.g. the first owner, or admin-set temp). */
export function createUserWithPassword(db, { email, name, role, password, departmentId = null, mustChange = false, isClient = false, clientFull = false }) {
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (email, name, role, password_hash, password_salt, department_id, must_change_password, is_client, client_full)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(String(email).trim().toLowerCase(), name, role, hash, salt, departmentId, mustChange ? 1 : 0, isClient ? 1 : 0, clientFull ? 1 : 0);
  if (departmentId != null) addDepartmentForUser(db, info.lastInsertRowid, departmentId);
  return getUserById(db, info.lastInsertRowid);
}

/** Create a user without a password yet (pending invite acceptance). */
export function createPendingUser(db, { email, name, role, departmentId = null, isClient = false, clientFull = false }) {
  const info = db.prepare(
    `INSERT INTO users (email, name, role, department_id, status, is_client, client_full)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(String(email).trim().toLowerCase(), name, role, departmentId, isClient ? 1 : 0, clientFull ? 1 : 0);
  if (departmentId != null) addDepartmentForUser(db, info.lastInsertRowid, departmentId);
  return getUserById(db, info.lastInsertRowid);
}

export function setPassword(db, userId, password, { mustChange = false } = {}) {
  const { hash, salt } = hashPassword(password);
  db.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ? WHERE id = ?"
  ).run(hash, salt, mustChange ? 1 : 0, userId);
}

export const setUserStatus = (db, userId, status) =>
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);

export const touchLogin = (db, userId) =>
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);

// ---- two-factor (TOTP) -----------------------------------------------------

/** Stash a not-yet-confirmed secret (enrollment step 1). Does not enable 2FA. */
export function setTotpSecret(db, userId, secret) {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, userId);
}

/** Turn 2FA on and store freshly-generated recovery-code hashes. */
export function enableTotp(db, userId, recoveryHashes = []) {
  db.prepare("UPDATE users SET totp_enabled = 1, totp_recovery_json = ? WHERE id = ?")
    .run(JSON.stringify(recoveryHashes), userId);
}

/** Wipe 2FA entirely (admin reset for a lost device, or self re-enroll). */
export function resetTotp(db, userId) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery_json = '[]' WHERE id = ?").run(userId);
}

/** Replace the recovery codes; returns the plaintext set to show once. */
export function regenerateRecoveryCodes(db, userId) {
  const { codes, hashes } = generateRecoveryCodes();
  db.prepare("UPDATE users SET totp_recovery_json = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
  return codes;
}

/** Spend a recovery code: true if it matched (and is now consumed), false otherwise. */
export function consumeRecoveryCode(db, userId, code) {
  const user = getUserById(db, userId);
  if (!user) return false;
  let hashes;
  try { hashes = JSON.parse(user.totp_recovery_json || "[]"); } catch { hashes = []; }
  const target = hashRecoveryCode(code);
  const idx = hashes.indexOf(target);
  if (idx === -1) return false;
  hashes.splice(idx, 1); // one-time use
  db.prepare("UPDATE users SET totp_recovery_json = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
  return true;
}

export function recoveryCodesRemaining(db, userId) {
  const user = getUserById(db, userId);
  try { return JSON.parse(user.totp_recovery_json || "[]").length; } catch { return 0; }
}
