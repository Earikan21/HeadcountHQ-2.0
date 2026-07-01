/**
 * Hiring-request lifecycle — pure logic, no DB. A request is a bottom-up claim to
 * open or change a SEAT; approval creates a seat (Directive 2.0 §2.3). Requesters
 * must justify the ask, including the incremental-benefit narratives ("what you do
 * with current headcount" vs. "what you would do with the new headcount").
 */

export const REQUEST_STATUSES = ["submitted", "under_review", "approved", "deferred", "declined"];
export const OPEN_STATUSES = ["submitted", "under_review", "deferred"]; // still pending a decision
export const REQUEST_TYPES = ["net_new", "backfill"];
export const VALUE_BASES = ["benchmark", "revenue_driver", "qualitative"];

const TRANSITIONS = {
  submitted:    ["under_review", "approved", "deferred", "declined"],
  under_review: ["approved", "deferred", "declined"],
  deferred:     ["under_review", "approved", "declined"],
  approved:     [],   // terminal (a seat now exists)
  declined:     [],   // terminal
};

export function canTransitionRequest(from, to) {
  return REQUEST_STATUSES.includes(to) && (TRANSITIONS[from] || []).includes(to);
}

/** Fully-loaded estimated annual cost of a request from its band midpoint. */
export function estimatedCost(bandMin, bandMax, multiplier = 1.3) {
  const norm = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const lo = norm(bandMin), hi = norm(bandMax);
  const haveLo = Number.isFinite(lo), haveHi = Number.isFinite(hi);
  if (!haveLo && !haveHi) return null;
  const mid = haveLo && haveHi ? (lo + hi) / 2 : (haveLo ? lo : hi);
  return Math.round(mid * Number(multiplier || 1));
}

/**
 * Validate a submitted request. Requesters MUST justify the ask and complete the
 * incremental-benefit narratives. Returns a list of human-readable problems.
 */
export function requestProblems(r) {
  const problems = [];
  const req = (v) => typeof v === "string" && v.trim().length > 0;
  if (!req(r.title)) problems.push("Role / title is required.");
  if (!r.department_id) problems.push("Department is required.");
  if (!REQUEST_TYPES.includes(r.type)) problems.push("Choose net-new or backfill.");
  if (!req(r.justification) || r.justification.trim().length < 20)
    problems.push("A business justification (at least a sentence) is required.");
  if (!req(r.current_hc_narrative))
    problems.push("Answer: what do you do with your current headcount?");
  if (!req(r.new_hc_narrative))
    problems.push("Answer: what would you do with the new headcount?");
  // band is optional but if one bound is given, both should be sane
  const bandNorm = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const lo = bandNorm(r.band_min), hi = bandNorm(r.band_max);
  if ((r.band_min || r.band_max) && Number.isFinite(lo) && Number.isFinite(hi) && lo > hi)
    problems.push("Compensation band minimum can't exceed the maximum.");
  return problems;
}
