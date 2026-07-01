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
export function createUserWithPassword(db, { email, name, role, password, departmentId = null, mustChange = false }) {
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (email, name, role, password_hash, password_salt, department_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(String(email).trim().toLowerCase(), name, role, hash, salt, departmentId, mustChange ? 1 : 0);
  if (departmentId != null) addDepartmentForUser(db, info.lastInsertRowid, departmentId);
  return getUserById(db, info.lastInsertRowid);
}

/** Create a user without a password yet (pending invite acceptance). */
export function createPendingUser(db, { email, name, role, departmentId = null }) {
  const info = db.prepare(
    `INSERT INTO users (email, name, role, department_id, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).run(String(email).trim().toLowerCase(), name, role, departmentId);
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
