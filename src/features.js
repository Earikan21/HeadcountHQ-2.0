/**
 * Feature flags — the single place that decides which feature areas are visible.
 *
 * Directive 4.0 turns Headcount HQ into an internal consulting tool, so several
 * enterprise-oriented areas are HIDDEN by default (not deleted). Each flag gates
 * BOTH route registration (a hidden area's routes are never mounted, so they 404)
 * AND the navigation, so there is exactly one source of truth per area.
 *
 * Defaults are OFF for the internal tool. Re-enable any area for an enterprise
 * build with an environment variable, e.g. FEATURE_ORG=true.
 *
 *   org        — the org-chart page
 *   planning   — the standalone planning tab (its model moves into the spreadsheet view)
 *   requests   — the hiring-request / approval workflow
 *   benchmarks — the phase/industry benchmark seeding inside Philosophy
 */
export const FEATURE_KEYS = ["org", "planning", "requests", "benchmarks"];

const DEFAULTS = Object.freeze({
  org: false,
  planning: false,
  requests: false,
  benchmarks: false,
});

/** Resolve the feature set from environment overrides, falling back to DEFAULTS. */
export function resolveFeatures(env = process.env) {
  const out = { ...DEFAULTS };
  for (const key of FEATURE_KEYS) {
    const raw = env[`FEATURE_${key.toUpperCase()}`];
    if (raw !== undefined) out[key] = raw === "true" || raw === "1";
  }
  return Object.freeze(out);
}

/** True if `key` is an enabled feature on this config. Unknown keys are false. */
export function featureEnabled(config, key) {
  return Boolean(config && config.features && config.features[key]);
}
