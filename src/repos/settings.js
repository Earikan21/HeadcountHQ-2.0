/** Workspace philosophy settings (one row, workspace 1). */
import { normalizeSettings } from "../domain/philosophy.js";

export function getSettings(db) {
  const row = db.prepare("SELECT * FROM workspace_settings WHERE workspace_id = 1").get();
  return row || { workspace_id: 1, ...normalizeSettings({}) };
}

export function updateSettings(db, fields, userId) {
  const n = normalizeSettings(fields);
  db.prepare(
    `UPDATE workspace_settings SET
       seat_mode=?, backfill_policy=?, company_phase=?, industry=?,
       target_span_of_control=?, max_layers=?, loaded_cost_multiplier=?,
       annual_attrition_pct=?, contractor_target_pct=?, budgeting_approach=?,
       require_csuite_approval=?, budget_enforcement=?,
       ai_import_enabled=?, ai_provider=?, ai_full_read_enabled=?, ai_assistant_enabled=?,
       updated_at=datetime('now'), updated_by=?
     WHERE workspace_id = 1`
  ).run(
    n.seat_mode, n.backfill_policy, n.company_phase, n.industry,
    n.target_span_of_control, n.max_layers, n.loaded_cost_multiplier,
    n.annual_attrition_pct, n.contractor_target_pct, n.budgeting_approach,
    n.require_csuite_approval, n.budget_enforcement,
    n.ai_import_enabled, n.ai_provider, n.ai_full_read_enabled, n.ai_assistant_enabled, userId
  );
  return getSettings(db);
}

/** Set the workspace-wide department focus lens on its own, so saving the main
 *  settings form never clobbers it (and vice-versa). '' clears it (All departments). */
export function setFocusDepartment(db, name, userId) {
  const value = typeof name === "string" ? name.trim() : "";
  db.prepare(
    `UPDATE workspace_settings SET focus_department=?, updated_at=datetime('now'), updated_by=? WHERE workspace_id = 1`
  ).run(value, userId);
  return getSettings(db);
}
