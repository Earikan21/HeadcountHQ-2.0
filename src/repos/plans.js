/** Plan versions (Directive 4.0 item 11): named what-if plans, each a set of
 *  planned hires stored as JSON, layered on the live roster in the model. */
export const listPlans = (db) =>
  db.prepare("SELECT * FROM plan_versions WHERE workspace_id = 1 ORDER BY created_at, id").all();

export const getPlan = (db, id) =>
  db.prepare("SELECT * FROM plan_versions WHERE id = ?").get(Number(id));

export function createPlan(db, name) {
  const info = db.prepare("INSERT INTO plan_versions (name, hires_json) VALUES (?, '[]')")
    .run(String(name || "New plan").trim().slice(0, 80) || "New plan");
  return getPlan(db, info.lastInsertRowid);
}

export function planHires(plan) {
  if (!plan) return [];
  try { const a = JSON.parse(plan.hires_json); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function setPlanHires(db, id, hires) {
  db.prepare("UPDATE plan_versions SET hires_json = ? WHERE id = ?").run(JSON.stringify(hires || []), Number(id));
}

export const deletePlan = (db, id) =>
  db.prepare("DELETE FROM plan_versions WHERE id = ?").run(Number(id));

export function planAssumptions(plan) {
  if (!plan) return {};
  try { const a = JSON.parse(plan.assumptions_json || "{}"); return a && typeof a === "object" ? a : {}; } catch { return {}; }
}

export function setPlanAssumptions(db, id, obj) {
  db.prepare("UPDATE plan_versions SET assumptions_json = ? WHERE id = ?").run(JSON.stringify(obj || {}), Number(id));
}
