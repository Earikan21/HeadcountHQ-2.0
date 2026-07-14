/**
 * Headcount philosophy — pure logic, no DB. Captures the *rules of the game* a
 * company sets before modeling. Parameters and their sensible ranges are grounded
 * in workforce-planning / org-design research (span & layers, fully-loaded cost,
 * attrition-driven backfill, zero-based vs incremental budgeting, function mix).
 *
 * Phase/industry only *suggest* starting values; management has direct control and
 * can override every target (see normalizeSettings + suggestDepartmentTargets).
 */

import { functionBenchmarks, INDUSTRY_KEYS } from "../data/benchmarks.js";

export const PHASES = ["early", "growth", "mid", "scale"];
export const BUDGETING = ["incremental", "zero_based"];

/** Research-informed phase defaults (suggestions, fully overridable). */
export const PHASE_DEFAULTS = {
  // span widens and layers deepen as work standardizes and the org scales;
  // attrition tends to rise with size. (Org-design + workforce-planning research.)
  early:  { target_span_of_control: 5, max_layers: 3, annual_attrition_pct: 8,  loaded_cost_multiplier: 1.25 },
  growth: { target_span_of_control: 6, max_layers: 4, annual_attrition_pct: 10, loaded_cost_multiplier: 1.30 },
  mid:    { target_span_of_control: 7, max_layers: 6, annual_attrition_pct: 12, loaded_cost_multiplier: 1.30 },
  scale:  { target_span_of_control: 8, max_layers: 7, annual_attrition_pct: 13, loaded_cost_multiplier: 1.35 },
};

/** Function buckets and their benchmark share of headcount (SaaS medians). */
export const FUNCTION_BENCHMARKS = { rnd: 30, sm: 39, ga: 16, cs: 15 };
const UNKNOWN_WEIGHT = 12;

/** Classify a department name into a function bucket. */
export function classifyDepartment(name) {
  const n = String(name || "").toLowerCase();
  const has = (...ws) => ws.some((w) => n.includes(w));
  if (has("eng", "r&d", "research", "product", "design", "data", "devops", "platform", "infra", "qa", "tech")) return "rnd";
  if (has("sales", "marketing", "growth", "revenue", "bizdev", "business dev", "sdr", "account exec", "demand")) return "sm";
  if (has("customer success", "support", "success", "customer", "services", "onboarding", "cx")) return "cs";
  if (has("finance", "account", "hr", "people", "legal", "admin", "operation", "ops", "it ", "recruit", "talent", "g&a", "facilities")) return "ga";
  return "other";
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const bool = (v) => v === true || v === "1" || v === "on" || v === 1;

/** Validate/normalize the full settings object, applying defaults + safe ranges. */
export function normalizeSettings(s = {}) {
  return {
    seat_mode: oneOf(s.seat_mode, ["seat", "person"], "seat"),
    backfill_policy: oneOf(s.backfill_policy, ["auto", "reapprove"], "auto"),
    company_phase: oneOf(s.company_phase, PHASES, "early"),
    industry: oneOf(s.industry, INDUSTRY_KEYS, "general"),
    target_span_of_control: clamp(s.target_span_of_control, 1, 20, 6),
    max_layers: Math.round(clamp(s.max_layers, 1, 12, 6)),
    loaded_cost_multiplier: clamp(s.loaded_cost_multiplier, 1, 3, 1.3),
    annual_attrition_pct: clamp(s.annual_attrition_pct, 0, 100, 10),
    contractor_target_pct: clamp(s.contractor_target_pct, 0, 100, 0),
    budgeting_approach: oneOf(s.budgeting_approach, BUDGETING, "incremental"),
    require_csuite_approval: bool(s.require_csuite_approval) ? 1 : 0,
    budget_enforcement: oneOf(s.budget_enforcement, ["soft", "hard"], "soft"),
    ai_import_enabled: bool(s.ai_import_enabled) ? 1 : 0,
    ai_provider: oneOf(s.ai_provider, ["anthropic", "openai"], "anthropic"),
    ai_full_read_enabled: bool(s.ai_full_read_enabled) ? 1 : 0,
    ai_assistant_enabled: bool(s.ai_assistant_enabled) ? 1 : 0,
    // Workspace-wide department focus lens. '' = All. Free text (a department name);
    // if it names a department that no longer exists, views fall back to All.
    focus_department: typeof s.focus_department === "string" ? s.focus_department.trim() : "",
  };
}

/** The phase's suggested scalar values (for an "apply suggestion" affordance). */
export function phaseSuggestions(phase) {
  return PHASE_DEFAULTS[phase] || PHASE_DEFAULTS.early;
}

/** Fully-loaded annual cost of a base salary. */
export function loadedCost(base, multiplier = 1.3) {
  if (base == null || !Number.isFinite(Number(base))) return null;
  return Math.round(Number(base) * Number(multiplier));
}

/** Expected annual backfills to hold headcount flat, given attrition. */
export function expectedBackfills(headcount, attritionPct) {
  return Math.round((Number(headcount) || 0) * (Number(attritionPct) || 0) / 100);
}

/**
 * Suggested department-mix targets (a starting balance management then edits).
 * Splits each function's benchmark across the departments in that bucket, then
 * normalizes the whole set to sum to 100%.
 */
const ASSIGNABLE = new Set(["rnd", "sm", "ga", "cs", "other"]);
export function suggestDepartmentTargets(departments, phase = "early", industry = "general") {
  // accepts ["Name", ...] or [{ name, category }, ...]
  const list = (departments || [])
    .map((d) => (typeof d === "string" ? { name: d, category: null } : d))
    .filter((d) => d && d.name);
  const seen = new Set();
  const deduped = list.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
  if (!deduped.length) return {};
  const fb = functionBenchmarks(phase, industry); // phase x industry mix
  const buckets = {};
  for (const d of deduped) {
    // admin-assigned category wins; otherwise fall back to name heuristic
    const b = d.category && ASSIGNABLE.has(d.category) ? d.category : classifyDepartment(d.name);
    (buckets[b] = buckets[b] || []).push(d.name);
  }
  const raw = {};
  for (const [bucket, list] of Object.entries(buckets)) {
    const benchmark = fb[bucket] ?? UNKNOWN_WEIGHT;
    for (const name of list) raw[name] = benchmark / list.length;
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const name of deduped.map((d) => d.name)) out[name] = Math.round((raw[name] / sum) * 1000) / 10; // 1 decimal
  return out;
}

/** Compare actual headcount distribution to targets. Returns rows with variance. */
export function mixVsTarget(actualByDept, targetByDept) {
  const total = Object.values(actualByDept).reduce((a, b) => a + b, 0);
  const names = [...new Set([...Object.keys(actualByDept), ...Object.keys(targetByDept)])].sort();
  return names.map((name) => {
    const count = actualByDept[name] || 0;
    const actualPct = total ? Math.round((count / total) * 1000) / 10 : 0;
    const targetPct = targetByDept[name] ?? null;
    const variance = targetPct == null ? null : Math.round((actualPct - targetPct) * 10) / 10;
    return { name, count, actualPct, targetPct, variance };
  });
}
