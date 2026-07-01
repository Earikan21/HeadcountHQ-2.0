/** Planning persistence: financials, scenarios, scenario items, dept state. */
import { deptCostBand } from "./budgets.js";

const FIN_COLS = ["cash_balance","monthly_burn","monthly_revenue","revenue_growth_pct","comp_inflation_pct","horizon_months","productivity_conservative_pct","productivity_aggressive_pct"];

export const getFinancials = (db) =>
  db.prepare("SELECT * FROM financials WHERE workspace_id=1").get() || { workspace_id: 1, horizon_months: 24, productivity_conservative_pct: 70, productivity_aggressive_pct: 135 };

export function setFinancials(db, f, userId) {
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  db.prepare(
    `UPDATE financials SET cash_balance=?, monthly_burn=?, monthly_revenue=?, revenue_growth_pct=?,
       comp_inflation_pct=?, horizon_months=?, bookings_per_rep=?, sales_ramp_months=?,
       attainment_conservative_pct=?, attainment_base_pct=?, attainment_aggressive_pct=?,
       updated_by=?, updated_at=datetime('now') WHERE workspace_id=1`
  ).run(num(f.cash_balance), num(f.monthly_burn), num(f.monthly_revenue), num(f.revenue_growth_pct),
        num(f.comp_inflation_pct), Math.max(1, Math.round(num(f.horizon_months, 24))),
        num(f.bookings_per_rep, 800000), Math.max(1, Math.round(num(f.sales_ramp_months, 5))),
        num(f.attainment_conservative_pct, 60), num(f.attainment_base_pct, 70), num(f.attainment_aggressive_pct, 80), userId);
}

export function createScenario(db, { name, description = "", createdBy }) {
  const info = db.prepare("INSERT INTO scenarios (name, description, created_by) VALUES (?,?,?)").run(name, description, createdBy);
  return getScenario(db, info.lastInsertRowid);
}
export const getScenario = (db, id) => db.prepare("SELECT * FROM scenarios WHERE id=?").get(id);
export const listScenarios = (db) => db.prepare("SELECT * FROM scenarios ORDER BY id DESC").all();
export const deleteScenario = (db, id) => db.prepare("DELETE FROM scenarios WHERE id=?").run(id);

export function getItems(db, scenarioId) {
  const rows = db.prepare("SELECT * FROM scenario_items WHERE scenario_id=?").all(scenarioId);
  const map = {};
  for (const r of rows) map[r.department_id] = r;
  return map;
}
export function upsertItem(db, scenarioId, deptId, it) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  db.prepare(
    `INSERT INTO scenario_items (scenario_id, department_id, new_hires, start_month, pace, cost_per_hire, productivity_per_head, outcome)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(scenario_id, department_id) DO UPDATE SET
       new_hires=excluded.new_hires, start_month=excluded.start_month, pace=excluded.pace,
       cost_per_hire=excluded.cost_per_hire, productivity_per_head=excluded.productivity_per_head, outcome=excluded.outcome`
  ).run(scenarioId, deptId, Math.max(0, Math.round(n(it.new_hires) || 0)), Math.max(0, Math.round(n(it.start_month) || 0)),
        ["all_at_once","even","quarterly"].includes(it.pace) ? it.pace : "even",
        n(it.cost_per_hire), n(it.productivity_per_head),
        ["conservative","base","aggressive"].includes(it.outcome) ? it.outcome : "base");
}

/** Current state per department for the engine + a default cost-per-hire. */
export function deptStates(db) {
  const rows = db.prepare(`
    SELECT d.id, d.name, d.function_category AS category,
      (SELECT COUNT(*) FROM seats s WHERE s.department_id=d.id AND s.status='filled') AS currentHeadcount,
      (SELECT COALESCE(SUM(loaded_cost_estimate),0) FROM seats s WHERE s.department_id=d.id AND s.status='filled') AS currentAnnualCost
    FROM departments d ORDER BY d.name`).all();
  return rows.map((r) => {
    const band = deptCostBand(db, r.id);
    const defaultCostPerHire = band ? Math.round((band.low + band.high) / 2) : null;
    return { id: r.id, name: r.name, category: r.category, currentHeadcount: r.currentHeadcount, currentMonthlyCost: r.currentAnnualCost / 12, defaultCostPerHire };
  });
}
