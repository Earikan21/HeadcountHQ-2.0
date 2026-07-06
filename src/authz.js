/**
 * THE authorization module. Every permission and compensation-visibility
 * decision lives here so rules cannot drift across the app. Routes and views
 * ask these functions; they never re-implement the logic.
 *
 * Roles (from the product vision):
 *   finance_admin — owns the model; sees ALL departments and EXACT salaries.
 *   c_suite       — sees ALL departments; comp as TOTALS & BANDS only.
 *   manager       — sees OWN department only; comp as BANDS only.
 */
export const ROLES = ["finance_admin", "c_suite", "manager"];

// NOTE: `finance_admin` is the internal role KEY and stays as-is (it's baked into a
// SQL CHECK constraint and 20+ references). Only the human-facing LABEL changed to
// "Finance Manager" per Directive 3.0 -- renaming the key would be a risky table
// rebuild for zero user-visible benefit.
export const ROLE_LABELS = {
  finance_admin: "AZ Finance",
  c_suite: "C-Suite",
  manager: "Department Manager",
};

export function isRole(user, ...roles) {
  return !!user && roles.includes(user.role);
}

/** Account/workspace administration is the Finance Admin's alone. */
export const canManageAccounts = (u) => isRole(u, "finance_admin");
export const canManageDepartments = (u) => isRole(u, "finance_admin");
export const canManageSettings = (u) => isRole(u, "finance_admin");
export const canManageSeats = (u) => isRole(u, "finance_admin");
export const canImportRoster = (u) => isRole(u, "finance_admin");
export const canSetBudgets = (u) => isRole(u, "finance_admin", "c_suite") && !isClient(u);
/** Who may VIEW budgets (clients are read-only viewers). */
export const canViewBudgets = (u) => isRole(u, "finance_admin", "c_suite");
export const canApproveRequests = (u) => isRole(u, "finance_admin", "c_suite") && !isClient(u);
export const canCreateRequest = (u) => isRole(u, "finance_admin", "manager");
export const canRunScenarios = (u) => isRole(u, "finance_admin", "c_suite") && !isClient(u);
export const canViewAudit = (u) => isRole(u, "finance_admin");
/** Who may see aggregate compensation totals (managers see headcount only). */
export const canViewCompTotals = (u) => isRole(u, "finance_admin", "c_suite");

/** 'exact' | 'bands' — how much compensation detail this user may see. */
export function compVisibility(user) {
  if (isRole(user, "finance_admin")) return "exact";
  // A client flagged for the "full view" sees exact compensation for their own company.
  if (isClient(user) && user.client_full) return "exact";
  return "bands";
}

/** Can the user see every department, or only their own? */
export const canSeeAllDepartments = (u) => isRole(u, "finance_admin", "c_suite");

/**
 * The set of department ids this user is limited to, or `null` for "all".
 * A collaborator can own MANY departments, so scope is an array. The owned set is
 * loaded onto `user.department_ids` when the session is resolved; we fall back to
 * the legacy single `user.department_id` for callers that build a bare user object
 * (e.g. unit tests). An empty array means "scoped but owns nothing" -> matches none.
 */
export function departmentScope(user) {
  if (canSeeAllDepartments(user)) return null;
  if (Array.isArray(user?.department_ids)) return user.department_ids;
  return user?.department_id != null ? [user.department_id] : [];
}

/** Whether a user may view a given department's data. */
export function canViewDepartment(user, departmentId) {
  const scope = departmentScope(user);
  if (scope === null) return true;
  return scope.map(Number).includes(Number(departmentId));
}

// ---- Directive 4.0 (M21): external client accounts ----
/** An external client of the firm: a c_suite-level account flagged for a clean,
 *  backend-free view. Sees their (single-instance) company data and edits budgets. */
export const isClient = (u) => !!(u && u.is_client);

/** Human label for a user's role, showing "Client" for flagged client accounts. */
export function displayRole(user) {
  if (isClient(user)) return "Client";
  return (user && (ROLE_LABELS[user.role] || user.role)) || "";
}

/** The AI assistant is hidden from client accounts to keep their view clean. */
export const canUseAssistant = (u) => canViewCompTotals(u);
