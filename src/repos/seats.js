/** Seat persistence + lifecycle writes. Pure decisions live in domain/seats.js. */
import { nextStatusOnVacate, countSeats } from "../domain/seats.js";
import { logAudit } from "./audit.js";
import { deptCondition } from "../db/scope.js";

export function createSeat(db, { departmentId = null, levelId = null, title = "", status = "proposed", occupantEmployeeId = null, loadedCost = null, sourceRequestId = null }) {
  const openedAt = status === "open" || status === "filled" ? "datetime('now')" : null;
  const info = db.prepare(
    `INSERT INTO seats (department_id, level_id, title, status, occupant_employee_id, loaded_cost_estimate, source_request_id, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${openedAt ? "datetime('now')" : "NULL"})`
  ).run(departmentId, levelId, title, status, occupantEmployeeId, loadedCost, sourceRequestId);
  return getSeat(db, info.lastInsertRowid);
}

export const getSeat = (db, id) => db.prepare("SELECT * FROM seats WHERE id = ?").get(id);

export function listSeats(db, { departmentId = null } = {}) {
  const cond = deptCondition("s.department_id", departmentId);
  const where = "WHERE s.status != 'closed'" + (cond ? ` AND ${cond.sql}` : "");
  const sql = `
    SELECT s.*, d.name AS department_name, e.name AS occupant_name
      FROM seats s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN employees e ON e.id = s.occupant_employee_id
      ${where}
     ORDER BY d.name, s.status, s.title`;
  return cond ? db.prepare(sql).all(...cond.params) : db.prepare(sql).all();
}

/** All seats (incl. closed) for roll-up math, optionally dept-scoped. */
export function seatsForRollup(db, { departmentId = null } = {}) {
  const cond = deptCondition("s.department_id", departmentId);
  const where = cond ? `WHERE ${cond.sql}` : "";
  const sql = `SELECT s.status, s.department_id, d.name AS department_name
                 FROM seats s LEFT JOIN departments d ON d.id = s.department_id ${where}`;
  return cond ? db.prepare(sql).all(...cond.params) : db.prepare(sql).all();
}

/** Ensure an imported employee occupies a FILLED seat (create or update). */
export function ensureSeatForEmployee(db, { employeeId, departmentId, title, loadedCost = null }) {
  const emp = db.prepare("SELECT seat_id FROM employees WHERE id = ?").get(employeeId);
  if (emp && emp.seat_id) {
    db.prepare("UPDATE seats SET department_id = ?, title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(departmentId, title, emp.seat_id);
    return emp.seat_id;
  }
  const seat = createSeat(db, { departmentId, title, status: "filled", occupantEmployeeId: employeeId, loadedCost });
  db.prepare("UPDATE employees SET seat_id = ? WHERE id = ?").run(seat.id, employeeId);
  return seat.id;
}

/** Fill a seat with an employee (open -> filled), capturing actual loaded cost. */
export function fillSeat(db, seatId, employeeId, loadedCost = null) {
  db.prepare("UPDATE seats SET status='filled', occupant_employee_id=?, loaded_cost_estimate=COALESCE(?, loaded_cost_estimate), opened_at=COALESCE(opened_at, datetime('now')), updated_at=datetime('now') WHERE id=?")
    .run(employeeId, loadedCost, seatId);
  db.prepare("UPDATE employees SET seat_id=? WHERE id=?").run(seatId, employeeId);
}

/** Apply the vacancy transition dictated by settings; clears occupancy. */
export function vacateSeat(db, id, settings, actorId) {
  const seat = getSeat(db, id);
  if (!seat || seat.status !== "filled") return seat;
  const next = nextStatusOnVacate({ seatMode: settings.seat_mode, backfillPolicy: settings.backfill_policy });
  db.prepare("UPDATE seats SET status = ?, occupant_employee_id = NULL, updated_at = datetime('now') WHERE id = ?").run(next, id);
  if (seat.occupant_employee_id) db.prepare("UPDATE employees SET seat_id = NULL WHERE id = ?").run(seat.occupant_employee_id);
  logAudit(db, { userId: actorId, action: "seat.vacated", entity: "seat", entityId: id, detail: { from: "filled", to: next } });
  return getSeat(db, id);
}

export function setSeatStatus(db, id, next, actorId) {
  const seat = getSeat(db, id);
  if (!seat) return null;
  db.prepare("UPDATE seats SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
  if (next === "closed" && seat.occupant_employee_id) {
    db.prepare("UPDATE employees SET seat_id = NULL WHERE id = ?").run(seat.occupant_employee_id);
    db.prepare("UPDATE seats SET occupant_employee_id = NULL WHERE id = ?").run(id);
  }
  logAudit(db, { userId: actorId, action: "seat.status", entity: "seat", entityId: id, detail: { from: seat.status, to: next } });
  return getSeat(db, id);
}

/** Roll up active-vs-approved per department + company. */
export function headcountRollup(db, scope = {}) {
  const rows = seatsForRollup(db, scope);
  const byDept = new Map();
  for (const r of rows) {
    const key = r.department_name || "(none)";
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(r);
  }
  const departments = [...byDept.entries()].map(([department, seats]) => ({ department, ...countSeats(seats) }))
    .sort((a, b) => b.approved - a.approved);
  return { departments, totals: countSeats(rows) };
}

/** Create a filled seat for every active employee that lacks one (sync/backfill). */
export function backfillSeats(db) {
  const mult = db.prepare("SELECT loaded_cost_multiplier FROM workspace_settings WHERE workspace_id=1").get()?.loaded_cost_multiplier ?? 1.3;
  const rows = db.prepare(`SELECT e.id, e.department_id, e.job_title, e.employment_status, c.annual_salary
                             FROM employees e LEFT JOIN compensation c ON c.employee_id = e.id
                            WHERE e.seat_id IS NULL`).all();
  const ins = db.prepare("INSERT INTO seats (department_id, title, status, occupant_employee_id, loaded_cost_estimate, opened_at) VALUES (?,?, 'filled', ?, ?, datetime('now'))");
  const link = db.prepare("UPDATE employees SET seat_id = ? WHERE id = ?");
  let made = 0;
  for (const e of rows) {
    if (String(e.employment_status || "").toLowerCase() === "inactive") continue;
    const loaded = e.annual_salary != null ? Math.round(e.annual_salary * mult) : null;
    const info = ins.run(e.department_id, e.job_title, e.id, loaded);
    link.run(info.lastInsertRowid, e.id);
    made++;
  }
  return made;
}

/** Seats added in the last N days, per department (a simple growth signal). */
export function recentSeatAdds(db, days = 90, departmentId = null) {
  const cond = deptCondition("s.department_id", departmentId);
  const where = cond ? `AND ${cond.sql}` : "";
  const sql = `SELECT d.name AS department, COUNT(*) AS adds
                 FROM seats s LEFT JOIN departments d ON d.id = s.department_id
                WHERE s.created_at >= datetime('now', ?) AND s.status != 'closed' ${where}
                GROUP BY s.department_id`;
  const rows = db.prepare(sql).all(`-${days} days`, ...(cond ? cond.params : []));
  const byDept = {}; let total = 0;
  for (const r of rows) { byDept[r.department || "(none)"] = r.adds; total += r.adds; }
  return { byDept, total };
}
