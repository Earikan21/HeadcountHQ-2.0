/** Budget envelopes + per-department reconciliation (positions & money). */
import { reconcile, costBand } from "../domain/budget.js";
import { departmentIdsForUser } from "./collaborators.js";

const loadedMultiplier = (db) => db.prepare("SELECT loaded_cost_multiplier FROM workspace_settings WHERE workspace_id=1").get()?.loaded_cost_multiplier ?? 1.3;

/** Per-head fully-loaded cost band for a department (falls back to company-wide). */
export function deptCostBand(db, deptId) {
  const mult = loadedMultiplier(db);
  const here = db.prepare("SELECT c.annual_salary AS s FROM employees e JOIN compensation c ON c.employee_id=e.id WHERE e.department_id=? AND c.annual_salary IS NOT NULL").all(deptId);
  let band = costBand(here.map((r) => r.s * mult));
  if (!band) {
    const all = db.prepare("SELECT annual_salary AS s FROM compensation WHERE annual_salary IS NOT NULL").all().map((r) => r.s * mult);
    band = costBand(all);
  }
  return band;
}
const currentCost = (db, deptId) => db.prepare("SELECT COALESCE(SUM(loaded_cost_estimate),0) AS s FROM seats WHERE department_id=? AND status='filled'").get(deptId).s;
const currentHeadcount = (db, deptId) => db.prepare("SELECT COUNT(*) AS n FROM employees WHERE department_id=?").get(deptId).n;

const APPROVED = "('approved','open','filled','frozen')";
const OPEN_REQ = "('submitted','under_review','deferred')";

export function getEnvelopes(db) {
  const rows = db.prepare("SELECT department_id, headcount_budget, money_budget FROM budget_envelopes WHERE period='current'").all();
  const map = {};
  for (const r of rows) map[r.department_id] = r;
  return map;
}
export function getCompanyBudget(db) {
  const r = db.prepare("SELECT company_headcount_budget AS headcount, company_money_budget AS money FROM workspace_settings WHERE workspace_id=1").get();
  return r || { headcount: 0, money: 0 };
}
export function setCompanyBudget(db, headcount, money, userId) {
  db.prepare("UPDATE workspace_settings SET company_headcount_budget=?, company_money_budget=?, updated_by=?, updated_at=datetime('now') WHERE workspace_id=1")
    .run(Math.max(0, Math.round(Number(headcount) || 0)), Math.max(0, Number(money) || 0), userId);
}
export function setCompanyHeadcount(db, headcount, userId) {
  db.prepare("UPDATE workspace_settings SET company_headcount_budget=?, updated_by=?, updated_at=datetime('now') WHERE workspace_id=1")
    .run(Math.max(0, Math.round(Number(headcount) || 0)), userId);
}
export function setCompanyMoney(db, money, userId) {
  db.prepare("UPDATE workspace_settings SET company_money_budget=?, updated_by=?, updated_at=datetime('now') WHERE workspace_id=1")
    .run(Math.max(0, Number(money) || 0), userId);
}

export const getEnvelope = (db, deptId) =>
  db.prepare("SELECT * FROM budget_envelopes WHERE department_id=? AND period='current'").get(deptId)
  || { department_id: deptId, headcount_budget: 0, money_budget: 0 };

export function setEnvelopeHeadcount(db, deptId, headcount, userId) {
  db.prepare(
    `INSERT INTO budget_envelopes (department_id, period, headcount_budget, money_budget, set_by)
     VALUES (?, 'current', ?, 0, ?)
     ON CONFLICT(workspace_id, department_id, period)
       DO UPDATE SET headcount_budget=excluded.headcount_budget, set_by=excluded.set_by, updated_at=datetime('now')`
  ).run(deptId, Math.max(0, Math.round(Number(headcount) || 0)), userId);
}
export function setEnvelopeMoney(db, deptId, money, userId) {
  db.prepare(
    `INSERT INTO budget_envelopes (department_id, period, headcount_budget, money_budget, set_by)
     VALUES (?, 'current', 0, ?, ?)
     ON CONFLICT(workspace_id, department_id, period)
       DO UPDATE SET money_budget=excluded.money_budget, set_by=excluded.set_by, updated_at=datetime('now')`
  ).run(deptId, Math.max(0, Number(money) || 0), userId);
}
export function setEnvelope(db, deptId, headcount, money, userId) {
  db.prepare(
    `INSERT INTO budget_envelopes (department_id, period, headcount_budget, money_budget, set_by)
     VALUES (?, 'current', ?, ?, ?)
     ON CONFLICT(workspace_id, department_id, period)
       DO UPDATE SET headcount_budget=excluded.headcount_budget, money_budget=excluded.money_budget,
                     set_by=excluded.set_by, updated_at=datetime('now')`
  ).run(deptId, Math.max(0, Math.round(Number(headcount) || 0)), Math.max(0, Number(money) || 0), userId);
}

/** Live usage numbers for one department. */
export function departmentUsage(db, deptId) {
  const approvedPositions = db.prepare(`SELECT COUNT(*) AS n FROM seats WHERE department_id=? AND status IN ${APPROVED}`).get(deptId).n;
  const committedMoney = db.prepare(`SELECT COALESCE(SUM(loaded_cost_estimate),0) AS s FROM seats WHERE department_id=? AND status != 'closed'`).get(deptId).s;
  const pendingPositions = db.prepare(`SELECT COUNT(*) AS n FROM hiring_requests WHERE department_id=? AND status IN ${OPEN_REQ}`).get(deptId).n;
  const pendingMoney = db.prepare(`SELECT COALESCE(SUM(estimated_cost),0) AS s FROM hiring_requests WHERE department_id=? AND status IN ${OPEN_REQ}`).get(deptId).s;
  return { approvedPositions, committedMoney, pendingPositions, pendingMoney };
}

export function departmentReconciliation(db, deptId) {
  const env = getEnvelope(db, deptId);
  const u = departmentUsage(db, deptId);
  return reconcile({ headcountBudget: env.headcount_budget, moneyBudget: env.money_budget, ...u });
}

/**
 * Top-down reconciliation. The COMPANY budget (set at the top) is the cap; each
 * department's envelope is an ALLOCATION of it. Returns per-department rows, the
 * allocation status (how much of the company cap is handed out), and the company
 * reconciliation (cap vs. actual approved/committed).
 */
export function allReconciliation(db) {
  const depts = db.prepare("SELECT id, name FROM departments ORDER BY name").all();
  const rows = depts.map((d) => {
    const rec = departmentReconciliation(db, d.id);
    const cur = currentHeadcount(db, d.id);
    const curCost = currentCost(db, d.id);
    // Current headcount + its cost are a floor on the allocation (never start at 0).
    const effHeadcount = Math.max(rec.positions.budget, cur);
    const effMoney = Math.max(rec.money.budget, curCost);
    return { id: d.id, name: d.name, currentEmployees: cur, currentCost: curCost, costBand: deptCostBand(db, d.id), effHeadcount, effMoney, ...rec };
  });
  const sum = (sel) => rows.reduce((a, r) => a + sel(r), 0);
  const cap = getCompanyBudget(db);

  const allocated = {
    headcount: sum((r) => r.effHeadcount),
    money: sum((r) => r.effMoney),
  };
  const allocation = {
    headcount: { cap: cap.headcount, allocated: allocated.headcount, remaining: cap.headcount - allocated.headcount, over: Math.max(0, allocated.headcount - cap.headcount) },
    money: { cap: cap.money, allocated: allocated.money, remaining: cap.money - allocated.money, over: Math.max(0, allocated.money - cap.money) },
  };

  const company = reconcile({
    headcountBudget: cap.headcount,
    moneyBudget: cap.money,
    approvedPositions: sum((r) => r.positions.approved),
    committedMoney: sum((r) => r.money.committed),
    pendingPositions: sum((r) => r.positions.pending),
    pendingMoney: sum((r) => r.money.pending),
  });

  const currentEmployees = db.prepare("SELECT COUNT(*) AS n FROM employees").get().n;
  return { rows, allocation, company, currentEmployees };
}

// ===========================================================================
// Delegated budgets (Directive 3.0, M10). The company budget is handed down to
// each collaborator as ONE pool; the owner splits it across their departments'
// envelopes. Enforcement is two-level:
//   level 1: sum(a department's envelopes owned by X) <= X's pool
//   level 2: sum(all owners' pools)                   <= company budget
// Both reuse the same soft/hard budget_enforcement setting used per-department.
// ===========================================================================

/** The single delegated pool for one collaborator (zeros if none set). */
export function getDelegatedBudget(db, userId) {
  return (
    db.prepare(
      "SELECT user_id, headcount_budget, money_budget FROM delegated_budgets WHERE user_id = ? AND period = 'current'"
    ).get(userId) || { user_id: userId, headcount_budget: 0, money_budget: 0 }
  );
}

/** Set (upsert) a collaborator's delegated pool. */
export function setDelegatedBudget(db, userId, headcount, money, setBy) {
  db.prepare(
    `INSERT INTO delegated_budgets (user_id, period, headcount_budget, money_budget, set_by)
     VALUES (?, 'current', ?, ?, ?)
     ON CONFLICT(workspace_id, user_id, period)
       DO UPDATE SET headcount_budget=excluded.headcount_budget, money_budget=excluded.money_budget,
                     set_by=excluded.set_by, updated_at=datetime('now')`
  ).run(userId, Math.max(0, Math.round(Number(headcount) || 0)), Math.max(0, Number(money) || 0), setBy);
}

export const listDelegatedBudgets = (db) =>
  db.prepare("SELECT * FROM delegated_budgets WHERE period = 'current'").all();

/**
 * Reconcile one owner's delegated pool: how much they've allocated to their
 * departments' envelopes, and how much is actually committed/pending underneath.
 */
export function ownerReconciliation(db, userId) {
  const deptIds = departmentIdsForUser(db, userId);
  const pool = getDelegatedBudget(db, userId);
  let allocHead = 0, allocMoney = 0;
  const usage = { approvedPositions: 0, committedMoney: 0, pendingPositions: 0, pendingMoney: 0 };
  for (const id of deptIds) {
    const env = getEnvelope(db, id);
    allocHead += env.headcount_budget;
    allocMoney += env.money_budget;
    const u = departmentUsage(db, id);
    usage.approvedPositions += u.approvedPositions;
    usage.committedMoney += u.committedMoney;
    usage.pendingPositions += u.pendingPositions;
    usage.pendingMoney += u.pendingMoney;
  }
  const rec = reconcile({ headcountBudget: pool.headcount_budget, moneyBudget: pool.money_budget, ...usage });
  const allocation = {
    headcount: {
      pool: pool.headcount_budget, allocated: allocHead,
      remaining: pool.headcount_budget - allocHead, over: Math.max(0, allocHead - pool.headcount_budget),
    },
    money: {
      pool: pool.money_budget, allocated: allocMoney,
      remaining: pool.money_budget - allocMoney, over: Math.max(0, allocMoney - pool.money_budget),
    },
  };
  return { userId, deptIds, pool, allocation, ...rec };
}

/**
 * Company-level delegation roll-up: how much of the company budget has been handed
 * out across all owner pools, and whether that over-commits the company cap.
 */
export function companyDelegation(db) {
  const cap = getCompanyBudget(db);
  const pools = listDelegatedBudgets(db);
  const head = pools.reduce((a, p) => a + (p.headcount_budget || 0), 0);
  const money = pools.reduce((a, p) => a + (p.money_budget || 0), 0);
  return {
    cap,
    delegated: { headcount: head, money },
    remaining: { headcount: cap.headcount - head, money: cap.money - money },
    over: { headcount: Math.max(0, head - cap.headcount), money: Math.max(0, money - cap.money) },
  };
}
