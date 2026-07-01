/** Editable target ratios (the "Target balance" management controls directly). */

export function getDepartmentTargets(db) {
  const rows = db.prepare("SELECT key, target_pct, source FROM target_ratios WHERE family='department_mix'").all();
  const map = {};
  for (const r of rows) map[r.key] = { target_pct: r.target_pct, source: r.source };
  return map;
}

export function setDepartmentTarget(db, key, pct, source, userId) {
  db.prepare(
    `INSERT INTO target_ratios (family, key, target_pct, source, updated_by)
     VALUES ('department_mix', ?, ?, ?, ?)
     ON CONFLICT(workspace_id, family, key)
       DO UPDATE SET target_pct=excluded.target_pct, source=excluded.source,
                     updated_by=excluded.updated_by, updated_at=datetime('now')`
  ).run(key, pct, source, userId);
}

/** Bulk replace department targets (used by manual save + "apply suggestions"). */
export function saveDepartmentTargets(db, targets, source, userId) {
  const tx = db.prepare("SELECT 1"); // node:sqlite has no .transaction(); do explicit BEGIN
  db.exec("BEGIN");
  try {
    for (const [key, pct] of Object.entries(targets)) {
      if (pct == null || pct === "") continue;
      setDepartmentTarget(db, key, Number(pct), source, userId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
