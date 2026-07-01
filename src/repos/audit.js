/** Append-only audit log writer + reader. */
export function logAudit(db, { userId = null, action, entity = null, entityId = null, detail = null }) {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, action, entity, entityId == null ? null : String(entityId),
        detail == null ? null : JSON.stringify(detail));
}

export function recentAudit(db, limit = 200) {
  return db.prepare(
    `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`
  ).all(limit);
}
