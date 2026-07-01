import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/domain/philosophy.js";

test("normalizeSettings clamps and defaults the researched params", () => {
  const s = P.normalizeSettings({});
  assert.equal(s.target_span_of_control, 6);
  assert.equal(s.max_layers, 6);
  assert.equal(s.loaded_cost_multiplier, 1.3);
  assert.equal(s.annual_attrition_pct, 10);
  assert.equal(s.budgeting_approach, "incremental");
  // clamping
  assert.equal(P.normalizeSettings({ target_span_of_control: 999 }).target_span_of_control, 20);
  assert.equal(P.normalizeSettings({ loaded_cost_multiplier: 0.2 }).loaded_cost_multiplier, 1);
  assert.equal(P.normalizeSettings({ max_layers: 3.7 }).max_layers, 4);
  assert.equal(P.normalizeSettings({ require_csuite_approval: "on" }).require_csuite_approval, 1);
  assert.equal(P.normalizeSettings({ budgeting_approach: "zero_based" }).budgeting_approach, "zero_based");
});

test("phaseSuggestions reflect research (span widens with scale)", () => {
  assert.ok(P.phaseSuggestions("scale").target_span_of_control > P.phaseSuggestions("early").target_span_of_control);
  assert.equal(P.phaseSuggestions("growth").annual_attrition_pct, 10);
});

test("classifyDepartment buckets common names", () => {
  assert.equal(P.classifyDepartment("Engineering"), "rnd");
  assert.equal(P.classifyDepartment("Sales"), "sm");
  assert.equal(P.classifyDepartment("Customer Success"), "cs");
  assert.equal(P.classifyDepartment("Finance"), "ga");
  assert.equal(P.classifyDepartment("Underwater Basket Weaving"), "other");
});

test("loadedCost and expectedBackfills", () => {
  assert.equal(P.loadedCost(100000, 1.3), 130000);
  assert.equal(P.loadedCost(null), null);
  assert.equal(P.expectedBackfills(200, 10), 20);
});

test("suggestDepartmentTargets returns a normalized starting balance (~100%)", () => {
  const t = P.suggestDepartmentTargets(["Engineering", "Sales", "Finance", "Customer Success"]);
  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1.5, `sum should be ~100, got ${sum}`);
  // sales (sm=39) should be suggested higher than finance (ga=16)
  assert.ok(t["Sales"] > t["Finance"]);
});

test("mixVsTarget computes actual % and variance vs target", () => {
  const rows = P.mixVsTarget({ Engineering: 6, Sales: 4 }, { Engineering: 50, Sales: 50 });
  const eng = rows.find((r) => r.name === "Engineering");
  assert.equal(eng.actualPct, 60);
  assert.equal(eng.variance, 10); // 60 actual - 50 target
});
