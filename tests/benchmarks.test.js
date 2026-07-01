import { test } from "node:test";
import assert from "node:assert/strict";
import { functionBenchmarks, GENERAL_BY_PHASE } from "../src/data/benchmarks.js";
import { suggestDepartmentTargets } from "../src/domain/philosophy.js";

test("engineering share declines from early to scale; S&M and G&A rise", () => {
  const early = functionBenchmarks("early", "general");
  const scale = functionBenchmarks("scale", "general");
  assert.ok(early.rnd > scale.rnd, `eng early ${early.rnd} should exceed scale ${scale.rnd}`);
  assert.ok(scale.sm > early.sm, "S&M share rises with scale");
  assert.ok(scale.ga > early.ga, "G&A share rises with scale");
});

test("each phase mix sums to ~100", () => {
  for (const phase of ["early", "growth", "mid", "scale"]) {
    const m = functionBenchmarks(phase, "general");
    const sum = m.rnd + m.sm + m.ga + m.cs;
    assert.ok(Math.abs(sum - 100) < 0.6, `${phase} sums to ${sum}`);
  }
});

test("industry tilts the mix (fintech has heavier G&A than general)", () => {
  assert.ok(functionBenchmarks("mid", "fintech").ga > functionBenchmarks("mid", "general").ga);
  assert.ok(functionBenchmarks("early", "ai_ml").rnd > functionBenchmarks("early", "general").rnd);
});

test("suggested department targets shift by company phase", () => {
  const early = suggestDepartmentTargets(["Engineering", "Sales"], "early", "general");
  const scale = suggestDepartmentTargets(["Engineering", "Sales"], "scale", "general");
  assert.ok(early["Engineering"] > scale["Engineering"], "Engineering suggested higher when early-stage");
  assert.ok(scale["Sales"] > early["Sales"], "Sales suggested higher at scale");
});

test("an assigned function category overrides name-guessing", () => {
  const guessed = suggestDepartmentTargets([{ name: "Studio" }, { name: "Sales" }], "mid", "general");
  const assigned = suggestDepartmentTargets([{ name: "Studio", category: "rnd" }, { name: "Sales" }], "mid", "general");
  assert.ok(assigned["Studio"] > guessed["Studio"], "assigning R&D raises an unrecognised dept's share");
});
