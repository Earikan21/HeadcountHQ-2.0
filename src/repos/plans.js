/** Plan versions (Directive 4.0 item 11): named what-if plans, each a set of
 *  planned hires stored as JSON, layered on the live roster in the model. */
export const listPlans = (db) =>
  db.prepare("SELECT * FROM plan_versions WHERE workspace_id = 1 ORDER BY created_at, id").all();

export const getPlan = (db, id) =>
  db.prepare("SELECT * FROM plan_versions WHERE id = ?").get(Number(id));

/** The one place a plan name is cleaned: trimmed, single-spaced, capped, never empty. */
export function cleanPlanName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 80) || "New plan";
}

export function createPlan(db, name) {
  const info = db.prepare("INSERT INTO plan_versions (name, hires_json) VALUES (?, '[]')").run(cleanPlanName(name));
  return getPlan(db, info.lastInsertRowid);
}

export function renamePlan(db, id, name) {
  const clean = cleanPlanName(name);
  db.prepare("UPDATE plan_versions SET name = ? WHERE id = ?").run(clean, Number(id));
  return clean;
}

export function planHires(plan) {
  if (!plan) return [];
  try { const a = JSON.parse(plan.hires_json); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function setPlanHires(db, id, hires) {
  db.prepare("UPDATE plan_versions SET hires_json = ? WHERE id = ?").run(JSON.stringify(hires || []), Number(id));
}

/**
 * Copy a plan whole: its hires, its assumptions, and its per-employee overrides.
 * The copy gets a free name ("Base case (copy)", then "(copy 2)", ...) so duplicating
 * twice doesn't produce two identically-named plans in the sidebar.
 */
export function duplicatePlan(db, plan) {
  const taken = new Set(listPlans(db).map((p) => p.name));
  let name = `${plan.name} (copy)`;
  for (let i = 2; taken.has(name); i++) name = `${plan.name} (copy ${i})`;
  const info = db.prepare(
    "INSERT INTO plan_versions (name, hires_json, assumptions_json, overrides_json) VALUES (?, ?, ?, ?)"
  ).run(name.slice(0, 80), plan.hires_json || "[]", plan.assumptions_json || "{}", plan.overrides_json || "{}");
  return getPlan(db, info.lastInsertRowid);
}

export const deletePlan = (db, id) =>
  db.prepare("DELETE FROM plan_versions WHERE id = ?").run(Number(id));

/** A plan's sparse per-employee overrides: { [employee_ext_id]: {field: value} }. */
export function planOverrides(plan) {
  if (!plan) return {};
  try {
    const o = JSON.parse(plan.overrides_json || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

export function setPlanOverrides(db, id, obj) {
  db.prepare("UPDATE plan_versions SET overrides_json = ? WHERE id = ?").run(JSON.stringify(obj || {}), Number(id));
}

/** The next free "hN" id for a plan's hires. */
export function nextHireId(hires) {
  let max = 0;
  for (const h of hires || []) {
    const m = /^h(\d+)$/.exec(String(h.id || ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "h" + (max + 1);
}

export function planAssumptions(plan) {
  if (!plan) return {};
  try { const a = JSON.parse(plan.assumptions_json || "{}"); return a && typeof a === "object" ? a : {}; } catch { return {}; }
}

export function setPlanAssumptions(db, id, obj) {
  db.prepare("UPDATE plan_versions SET assumptions_json = ? WHERE id = ?").run(JSON.stringify(obj || {}), Number(id));
}
