import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/domain/requests.js";
import * as B from "../src/domain/budget.js";

test("request transitions", () => {
  assert.ok(R.canTransitionRequest("submitted", "approved"));
  assert.ok(R.canTransitionRequest("under_review", "declined"));
  assert.ok(R.canTransitionRequest("deferred", "under_review"));
  assert.ok(!R.canTransitionRequest("approved", "declined")); // terminal
  assert.ok(!R.canTransitionRequest("declined", "approved"));
});

test("estimatedCost uses band midpoint x multiplier", () => {
  assert.equal(R.estimatedCost(100000, 140000, 1.3), 156000); // mid 120k * 1.3
  assert.equal(R.estimatedCost(100000, null, 1.0), 100000);
  assert.equal(R.estimatedCost(null, null), null);
});

test("requestProblems enforces justification + both narratives", () => {
  const ok = {
    title: "Backend Engineer", department_id: 1, type: "net_new",
    justification: "We are over capacity on the platform team and missing roadmap dates.",
    current_hc_narrative: "Maintaining the API and on-call.",
    new_hc_narrative: "Ship the billing rewrite a quarter earlier.",
  };
  assert.deepEqual(R.requestProblems(ok), []);
  assert.ok(R.requestProblems({ ...ok, justification: "" }).some((p) => /justification/i.test(p)));
  assert.ok(R.requestProblems({ ...ok, current_hc_narrative: "" }).some((p) => /current headcount/i.test(p)));
  assert.ok(R.requestProblems({ ...ok, new_hc_narrative: "" }).some((p) => /new headcount/i.test(p)));
  assert.ok(R.requestProblems({ ...ok, type: "x" }).some((p) => /net-new or backfill/i.test(p)));
});

test("reconcile computes gap for positions and money", () => {
  const r = B.reconcile({ headcountBudget: 10, moneyBudget: 1400000, approvedPositions: 8, committedMoney: 1200000, pendingPositions: 3, pendingMoney: 300000 });
  assert.equal(r.positions.remaining, 2);
  assert.equal(r.positions.projected, 11);      // would exceed if all pending approved
  assert.equal(r.money.remaining, 200000);
  assert.equal(r.money.projected, 1500000);
});

test("wouldExceed + enforcement decision", () => {
  const env = { headcountBudget: 10, moneyBudget: 1400000, approvedPositions: 10, committedMoney: 1300000 };
  const exceed = B.wouldExceed(env, 1, 150000); // 11 > 10 positions, 1.45M > 1.4M money
  assert.equal(exceed.positionsOver, true);
  assert.equal(exceed.moneyOver, true);
  assert.equal(B.approvalBlocked("hard", exceed), true);
  assert.equal(B.approvalBlocked("soft", exceed), false); // soft never blocks
  // within budget
  const ok = B.wouldExceed({ headcountBudget: 10, moneyBudget: 0, approvedPositions: 5 }, 1, 0);
  assert.equal(ok.any, false);
});
