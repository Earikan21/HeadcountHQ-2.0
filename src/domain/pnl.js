/**
 * Benefit / P&L layer on top of a built headcount model.
 *
 * Each department has two levers: an expected benefit PER HEAD (annual $) and a RAMP —
 * how many months a person takes to reach full benefit after they start. A person's
 * benefit ramps 0 → full linearly over that window from their own start date, so
 * existing staff (who started long before the plan) are already at full benefit while a
 * future scenario hire ramps in. Net = benefit − fully-loaded cost (the cost already
 * comes from the engine). A plan-level quota, over a chosen set of departments, yields
 * an attainment %.
 *
 * Pure and deterministic — no I/O — so it's easy to test and reuse.
 */

/** Read the stored config off a plan's assumptions.benefit, with safe defaults. */
export function benefitConfig(assumptions = {}) {
  const b = (assumptions && typeof assumptions.benefit === "object" && assumptions.benefit) || {};
  const byDept = {};
  if (b.byDept && typeof b.byDept === "object") {
    for (const [d, v] of Object.entries(b.byDept)) {
      byDept[d] = {
        perHead: Math.max(0, Number(v && v.perHead) || 0),
        rampMonths: Math.max(1, Math.min(120, Math.round(Number(v && v.rampMonths) || 1))),
      };
    }
  }
  const q = (b.quota && typeof b.quota === "object") ? b.quota : {};
  return {
    byDept,
    quota: {
      amount: Math.max(0, Number(q.amount) || 0),
      departments: Array.isArray(q.departments) ? q.departments.map(String) : [],
    },
  };
}

const round = (v) => Math.round(Number(v) || 0);

/** Compute the benefit / net / attainment for a model given the benefit config. */
export function computePnl(model, config = {}) {
  const { cols = [], roster = [], departments = [], deptMonthlyCost = {} } = model;
  const N = cols.length;
  const nowIdx = Math.max(0, Math.min(Math.max(0, N - 1), Number(model.nowIndex) || 0));
  const cfg = config.byDept && typeof config.byDept === "object" ? config : benefitConfig({ benefit: config });
  const byDept = cfg.byDept || {};
  const colAbs = cols.map((c) => c.year * 12 + c.month0);

  // A person's start as an absolute month; fall back to their first present month.
  const startAbsOf = (r) => {
    const m = String(r.startDate || "").match(/^(\d{4})-(\d{2})/);
    if (m) return Number(m[1]) * 12 + (Number(m[2]) - 1);
    const fp = r.present ? r.present.findIndex((p) => p) : -1;
    return fp >= 0 ? colAbs[fp] : (colAbs[0] ?? 0);
  };

  const benefit = {};
  for (const d of departments) benefit[d] = new Array(N).fill(0);
  for (const r of roster) {
    const lever = byDept[r.department];
    const perHead = lever ? Number(lever.perHead) || 0 : 0;
    if (perHead <= 0) continue;
    const ramp = Math.max(1, Math.round(Number(lever.rampMonths) || 1));
    const sAbs = startAbsOf(r);
    const arr = benefit[r.department];
    if (!arr) continue;
    for (let i = 0; i < N; i++) {
      if (!(r.present && r.present[i])) continue;
      const since = colAbs[i] - sAbs;              // whole months since they started
      const frac = Math.max(0, Math.min(1, (since + 1) / ramp));
      arr[i] += (perHead / 12) * frac;
    }
  }

  const cost = {};
  for (const d of departments) cost[d] = (deptMonthlyCost[d] || new Array(N).fill(0)).map((v) => Number(v) || 0);
  const net = {};
  for (const d of departments) net[d] = benefit[d].map((b, i) => b - (cost[d][i] || 0));

  const totalBen = new Array(N).fill(0), totalCost = new Array(N).fill(0), totalNet = new Array(N).fill(0);
  for (const d of departments) for (let i = 0; i < N; i++) { totalBen[i] += benefit[d][i]; totalCost[i] += cost[d][i]; totalNet[i] += net[d][i]; }

  const sum12 = (arr) => { let s = 0; for (let i = nowIdx; i < Math.min(N, nowIdx + 12); i++) s += arr[i] || 0; return s; };
  const sumAll = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

  let run = 0;
  const cumNet = totalNet.map((v) => { run += v; return run; });

  const q = cfg.quota || { amount: 0, departments: [] };
  const included = Array.isArray(q.departments) ? q.departments : [];
  const includedBen12 = included.reduce((a, d) => a + (benefit[d] ? sum12(benefit[d]) : 0), 0);
  const attainment = q.amount > 0 ? includedBen12 / q.amount : null;

  const perDept = departments.map((d) => ({
    department: d,
    perHead: byDept[d] ? Number(byDept[d].perHead) || 0 : 0,
    rampMonths: byDept[d] ? Math.max(1, Math.round(Number(byDept[d].rampMonths) || 1)) : 1,
    benefit12: round(sum12(benefit[d])), cost12: round(sum12(cost[d])), net12: round(sum12(net[d])),
    benefitTotal: round(sumAll(benefit[d])), costTotal: round(sumAll(cost[d])), netTotal: round(sumAll(net[d])),
    monthlyNet: net[d].map(round),
  }));

  return {
    cols, nowIdx, departments,
    perDept,
    total: {
      benefit12: round(sum12(totalBen)), cost12: round(sum12(totalCost)), net12: round(sum12(totalNet)),
      benefitTotal: round(sumAll(totalBen)), costTotal: round(sumAll(totalCost)), netTotal: round(sumAll(totalNet)),
      monthlyNet: totalNet.map(round), cumNet: cumNet.map(round),
    },
    quota: { amount: q.amount, departments: included, includedBenefit12: round(includedBen12), attainment },
  };
}
