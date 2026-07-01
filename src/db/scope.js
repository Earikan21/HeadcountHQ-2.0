/**
 * Build a parameterized department-scope condition for repository queries.
 *
 * A user's department scope (see authz.departmentScope) is one of:
 *   null      → no restriction (sees ALL departments); this helper returns null.
 *   number    → a single department.
 *   number[]  → several departments (an owner responsible for more than one).
 *   []        → a scoped user who owns NO department; matches nothing.
 *
 * Returns `null` (meaning "add no condition") or `{ sql, params }` where `sql`
 * is a fragment like `department_id IN (?,?)`. Callers compose it into their own
 * WHERE / AND clause and spread `params` into the prepared statement. Keeping the
 * placeholder-building in one place means every scoped read is parameterized the
 * same way — no ad-hoc string interpolation of ids.
 */
export function deptCondition(column, ids) {
  if (ids == null) return null;
  const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (arr.length === 0) return { sql: "0 = 1", params: [] }; // scoped, but owns nothing
  return { sql: `${column} IN (${arr.map(() => "?").join(",")})`, params: arr };
}
