/** Department data access + structural operations (rename/merge/split/move). */

export const listDepartments = (db) =>
  db.prepare("SELECT * FROM departments ORDER BY name").all();

/** Departments in creation order (by id). Used where a STABLE order matters — e.g. the
 *  Excel summary, so a newly-added department appends at the bottom instead of shuffling
 *  the existing rows the way an alphabetical sort would. */
export const listDepartmentsByCreation = (db) =>
  db.prepare("SELECT * FROM departments ORDER BY id").all();

export const getDepartment = (db, id) =>
  db.prepare("SELECT * FROM departments WHERE id = ?").get(id);

export const getDepartmentByName = (db, name) =>
  db.prepare("SELECT * FROM departments WHERE name = ? COLLATE NOCASE").get(String(name || "").trim());

export function setDepartmentCategory(db, id, category) {
  const valid = ["rnd", "sm", "ga", "cs", "other"].includes(category) ? category : null;
  db.prepare("UPDATE departments SET function_category = ? WHERE id = ?").run(valid, id);
}

export function createDepartment(db, { name, parentId = null, managerUserId = null }) {
  const info = db.prepare(
    "INSERT INTO departments (name, parent_id, manager_user_id) VALUES (?, ?, ?)"
  ).run(String(name).trim(), parentId, managerUserId);
  return getDepartment(db, info.lastInsertRowid);
}

/** Departments with people + (non-closed) seat counts, for the management view. */
export function listDepartmentsWithCounts(db) {
  return db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS emp_count,
      (SELECT COUNT(*) FROM seats s WHERE s.department_id = d.id AND s.status != 'closed') AS seat_count
      FROM departments d ORDER BY d.name`).all();
}

export function listEmployeesInDepartment(db, deptId) {
  return db.prepare(
    "SELECT id, employee_ext_id, name, job_title, employment_status, seat_id FROM employees WHERE department_id = ? ORDER BY name"
  ).all(deptId);
}

/** Rename a department, carrying its department-mix target key along. */
export function renameDepartment(db, id, newName) {
  const dept = getDepartment(db, id);
  if (!dept) return null;
  const clean = String(newName).trim();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE departments SET name = ? WHERE id = ?").run(clean, id);
    // keep target_ratios key in sync (drop any stale row already on the new name)
    db.prepare("DELETE FROM target_ratios WHERE family='department_mix' AND key = ? AND key != ?").run(clean, dept.name);
    db.prepare("UPDATE target_ratios SET key = ? WHERE family='department_mix' AND key = ?").run(clean, dept.name);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return getDepartment(db, id);
}

/** Move employees (and their seats) to another department. */
export function moveEmployees(db, employeeIds, toDeptId) {
  const setEmp = db.prepare("UPDATE employees SET department_id = ?, updated_at = datetime('now') WHERE id = ?");
  const getEmp = db.prepare("SELECT seat_id FROM employees WHERE id = ?");
  const setSeat = db.prepare("UPDATE seats SET department_id = ?, updated_at = datetime('now') WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const id of employeeIds) {
      const emp = getEmp.get(id);
      if (!emp) continue;
      setEmp.run(toDeptId, id);
      if (emp.seat_id) setSeat.run(toDeptId, emp.seat_id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Merge `fromId` into `toId`: reassign people, seats, and child departments. */
export function mergeDepartments(db, fromId, toId) {
  if (fromId === toId) return;
  const from = getDepartment(db, fromId);
  const to = getDepartment(db, toId);
  if (!from || !to) return;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE employees SET department_id = ? WHERE department_id = ?").run(toId, fromId);
    db.prepare("UPDATE seats SET department_id = ? WHERE department_id = ?").run(toId, fromId);
    db.prepare("UPDATE departments SET parent_id = ? WHERE parent_id = ?").run(toId, fromId);
    db.prepare("DELETE FROM target_ratios WHERE family='department_mix' AND key = ?").run(from.name);
    db.prepare("DELETE FROM departments WHERE id = ?").run(fromId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Delete an empty department (no employees, no non-closed seats). */
export function deleteDepartmentIfEmpty(db, id) {
  const dept = getDepartment(db, id);
  if (!dept) return false;
  const emp = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE department_id = ?").get(id).n;
  const seat = db.prepare("SELECT COUNT(*) AS n FROM seats WHERE department_id = ? AND status != 'closed'").get(id).n;
  if (emp > 0 || seat > 0) return false;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM target_ratios WHERE family='department_mix' AND key = ?").run(dept.name);
    db.prepare("DELETE FROM departments WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return true;
}
