/**
 * Workspace-wide "department focus" lens. When an admin sets a focus department in
 * Settings, the WHOLE tool shows only that department — dashboard, roster, every model
 * and plan, compare, budgets, and the Excel export. Empty = All departments.
 *
 * This is the single source of truth for the lock: name-filtered views (model, compare,
 * budgets, export) call effectiveDeptName(); id-scoped views (roster, dashboard) call
 * focusDeptId() and intersect it with the user's own department scope. Enforcing it in
 * one place means a hand-edited ?dept= URL can never widen the view past the lock.
 *
 * It is a presentation filter, not a security boundary (by design).
 */
import { getSettings } from "../repos/settings.js";
import { listDepartments } from "../repos/departments.js";

/** The focus department NAME, or "" for All. Falls back to "" if the stored name no
 *  longer matches a real department (renamed/deleted) so views never go blank. */
export function focusDeptName(ctx) {
  const name = (getSettings(ctx.db).focus_department || "").trim();
  if (!name) return "";
  return listDepartments(ctx.db).some((d) => d.name === name) ? name : "";
}

/** Is the lens active? (drives the banner + disabled pickers) */
export function focusActive(ctx) {
  return focusDeptName(ctx) !== "";
}

/** Effective department-NAME scope for a name-filtered view. The focus lock wins over
 *  any per-view ?dept selection; otherwise the caller's selection is used (or null). */
export function effectiveDeptName(ctx, selected) {
  const focus = focusDeptName(ctx);
  if (focus) return focus;
  const s = selected == null ? "" : String(selected).trim();
  return s || null;
}

/** The department_id for the focus name (for id-scoped repos), or null if no focus. */
export function focusDeptId(ctx) {
  const name = focusDeptName(ctx);
  if (!name) return null;
  const d = listDepartments(ctx.db).find((x) => x.name === name);
  return d ? d.id : null;
}

/**
 * Combine the user's own department scope (from authz.departmentScope) with the focus
 * lock, for id-scoped repos. Returns null for "all", or an array of department_ids.
 * If the focus dept isn't in the user's scope, returns [] (they see nothing) — the
 * lock only ever narrows, never widens.
 */
export function focusScope(ctx, userScope) {
  const fid = focusDeptId(ctx);
  if (fid == null) return userScope;              // no lock: whatever the user could see
  if (userScope == null) return [fid];            // admin: exactly the focused dept
  return userScope.includes(fid) ? [fid] : [];    // restricted user: intersect
}
