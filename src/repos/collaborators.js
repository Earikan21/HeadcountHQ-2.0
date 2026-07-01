/**
 * The canonical owner↔department relationship (many-to-many) plus each owner's
 * delegated budget pool lives conceptually here. This join table — not the legacy
 * `users.department_id` / `departments.manager_user_id` columns — is the single
 * source of truth for "which departments does this collaborator own." Those legacy
 * columns are kept loosely in sync for backward-compatible display only and are no
 * longer read for authorization scope.
 */

/** Array of department ids this collaborator owns (empty if none). */
export function departmentIdsForUser(db, userId) {
  return db
    .prepare("SELECT department_id FROM collaborator_departments WHERE user_id = ? ORDER BY department_id")
    .all(userId)
    .map((r) => r.department_id);
}

/** Full department rows this collaborator owns, alphabetical. */
export function departmentsForUser(db, userId) {
  return db
    .prepare(
      `SELECT d.* FROM collaborator_departments cd
         JOIN departments d ON d.id = cd.department_id
        WHERE cd.user_id = ? ORDER BY d.name`
    )
    .all(userId);
}

/** Collaborators who own a given department. */
export function ownersForDepartment(db, departmentId) {
  return db
    .prepare(
      `SELECT u.* FROM collaborator_departments cd
         JOIN users u ON u.id = cd.user_id
        WHERE cd.department_id = ? ORDER BY u.name`
    )
    .all(departmentId);
}

/**
 * Replace the set of departments a collaborator owns. De-dupes, ignores invalid
 * ids, and keeps the legacy `users.department_id` pointed at the first owned
 * department so older display code still renders a sensible value.
 */
export function setDepartmentsForUser(db, userId, departmentIds) {
  const ids = [...new Set((departmentIds || []).map(Number).filter(Number.isFinite))];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM collaborator_departments WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO collaborator_departments (user_id, department_id) VALUES (?, ?)"
    );
    for (const id of ids) ins.run(userId, id);
    db.prepare("UPDATE users SET department_id = ? WHERE id = ?").run(ids[0] ?? null, userId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return ids;
}

/** Add a single department to a collaborator (used when creating an account). */
export function addDepartmentForUser(db, userId, departmentId) {
  if (departmentId == null) return;
  db.prepare(
    "INSERT OR IGNORE INTO collaborator_departments (user_id, department_id) VALUES (?, ?)"
  ).run(userId, Number(departmentId));
  db.prepare("UPDATE users SET department_id = COALESCE(department_id, ?) WHERE id = ?").run(
    Number(departmentId),
    userId
  );
}
