/** Hiring-request persistence + status history. */
import { deptCondition } from "../db/scope.js";

export function createRequest(db, f, requesterId, estimatedCost) {
  const info = db.prepare(
    `INSERT INTO hiring_requests
      (department_id, title, level_id, band_min, band_max, target_start_month, type,
       justification, current_hc_narrative, new_hc_narrative, expected_value_basis,
       expected_value_amount, estimated_cost, status, requester_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?)`
  ).run(
    f.department_id, f.title, f.level_id ?? null, f.band_min ?? null, f.band_max ?? null,
    f.target_start_month ?? null, f.type, f.justification, f.current_hc_narrative, f.new_hc_narrative,
    f.expected_value_basis ?? null, f.expected_value_amount ?? null, estimatedCost ?? null, requesterId
  );
  recordHistory(db, info.lastInsertRowid, null, "submitted", requesterId, null);
  return getRequest(db, info.lastInsertRowid);
}

export const getRequest = (db, id) => db.prepare(
  `SELECT r.*, d.name AS department_name, u.name AS requester_name
     FROM hiring_requests r
     LEFT JOIN departments d ON d.id = r.department_id
     LEFT JOIN users u ON u.id = r.requester_id
    WHERE r.id = ?`).get(id);

export function listRequests(db, { departmentId = null } = {}) {
  const cond = deptCondition("r.department_id", departmentId);
  const where = cond ? `WHERE ${cond.sql}` : "";
  const sql = `SELECT r.*, d.name AS department_name, u.name AS requester_name
                 FROM hiring_requests r
                 LEFT JOIN departments d ON d.id = r.department_id
                 LEFT JOIN users u ON u.id = r.requester_id ${where}
                ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END, r.id DESC`;
  return cond ? db.prepare(sql).all(...cond.params) : db.prepare(sql).all();
}

export const statusHistory = (db, requestId) => db.prepare(
  `SELECT h.*, u.name AS actor_name FROM request_status_history h
     LEFT JOIN users u ON u.id = h.actor_id WHERE h.request_id = ? ORDER BY h.id`).all(requestId);

export function recordHistory(db, requestId, from, to, actorId, note) {
  db.prepare("INSERT INTO request_status_history (request_id, from_status, to_status, actor_id, note) VALUES (?,?,?,?,?)")
    .run(requestId, from, to, actorId, note || null);
}

export function setStatus(db, id, from, to, actorId, note, seatId = null) {
  db.prepare("UPDATE hiring_requests SET status=?, decided_by=?, decided_at=datetime('now'), decision_note=?, seat_id=COALESCE(?, seat_id), updated_at=datetime('now') WHERE id=?")
    .run(to, actorId, note || null, seatId, id);
  recordHistory(db, id, from, to, actorId, note);
}
