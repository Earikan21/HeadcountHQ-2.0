/**
 * Audit trail for AI-assisted imports. Records THAT the AI was used (and how
 * much of its output was accepted) — never the analyzed payload.
 */

export function recordImportRun(db, { batchId, userId, phase, usedAi, provider, suggestionCount = 0, acceptedCount = 0 }) {
  db.prepare(
    `INSERT INTO import_runs (import_batch_id, user_id, phase, used_ai, provider, suggestion_count, accepted_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(batchId ?? null, userId ?? null, phase, usedAi ? 1 : 0, provider ?? null, suggestionCount, acceptedCount);
}

export const listImportRuns = (db, limit = 50) =>
  db.prepare(
    `SELECT r.*, u.name AS user_name
       FROM import_runs r LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.id DESC LIMIT ?`
  ).all(limit);

export const importRunsForBatch = (db, batchId) =>
  db.prepare("SELECT * FROM import_runs WHERE import_batch_id = ? ORDER BY id").all(batchId);
