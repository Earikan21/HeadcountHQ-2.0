/**
 * Budget reconciliation — pure logic. The "position economy": Finance sets a
 * top-down headcount + money budget per department; bottom-up requests and the
 * seats they create consume it. This module computes the gap and the enforcement
 * decision (soft = flag, hard = block).
 */

/** Reconcile one department's budget against approved seats + pending requests. */
export function reconcile({ headcountBudget = 0, moneyBudget = 0, approvedPositions = 0, committedMoney = 0, pendingPositions = 0, pendingMoney = 0 }) {
  const positions = {
    budget: headcountBudget,
    approved: approvedPositions,
    pending: pendingPositions,
    remaining: headcountBudget - approvedPositions,
    over: Math.max(0, approvedPositions - headcountBudget),
    projected: approvedPositions + pendingPositions, // if all pending were approved
  };
  const money = {
    budget: moneyBudget,
    committed: committedMoney,
    pending: pendingMoney,
    remaining: moneyBudget - committedMoney,
    over: Math.max(0, committedMoney - moneyBudget),
    projected: committedMoney + pendingMoney,
  };
  return { positions, money };
}

/**
 * Would approving `addPositions`/`addMoney` push the department over budget?
 * Returns which dimensions would exceed.
 */
export function wouldExceed({ headcountBudget = 0, moneyBudget = 0, approvedPositions = 0, committedMoney = 0 }, addPositions = 1, addMoney = 0) {
  const positionsOver = headcountBudget > 0 && approvedPositions + addPositions > headcountBudget;
  const moneyOver = moneyBudget > 0 && committedMoney + Number(addMoney || 0) > moneyBudget;
  return { positionsOver, moneyOver, any: positionsOver || moneyOver };
}

/** Enforcement decision for an approval given the workspace setting. */
export function approvalBlocked(enforcement, exceed) {
  return enforcement === "hard" && exceed.any;
}

/** Cost-per-head band for a set of fully-loaded costs (min/max/avg). */
export function costBand(loadedCosts) {
  const vals = (loadedCosts || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return {
    low: Math.min(...vals),
    high: Math.max(...vals),
    avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
    count: vals.length,
  };
}

/** Expected added money for `addHeads` more positions, given a cost band. */
export function expectedRange(addHeads, band) {
  if (!band || !(addHeads > 0)) return null;
  return { low: Math.round(addHeads * band.low), high: Math.round(addHeads * band.high), heads: addHeads };
}
