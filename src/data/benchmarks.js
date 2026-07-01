/**
 * Function-mix benchmark grid — phase × industry. These are research-informed
 * STARTING SUGGESTIONS (share of headcount by function), fully overridable by
 * management. Sources: startup headcount-by-stage analyses showing engineering
 * ~50–70% early, ~30–50% in growth, ~20–30% at scale; S&M ramping then leveling
 * (~20%+); G&A rising with size; support settling ~8–10%.
 *
 *   functionBenchmarks(phase, industry) -> { rnd, sm, ga, cs }  (sums to 100)
 */

const round1 = (n) => Math.round(n * 10) / 10;

/** Cross-industry "general" baseline by phase (each sums to 100). */
export const GENERAL_BY_PHASE = {
  early:  { rnd: 55, sm: 22, ga: 13, cs: 10 }, // build the product; lean GTM
  growth: { rnd: 42, sm: 32, ga: 14, cs: 12 }, // GTM ramps, eng share falls
  mid:    { rnd: 33, sm: 37, ga: 17, cs: 13 }, // ~30/39/16 SaaS median, G&A rising
  scale:  { rnd: 28, sm: 38, ga: 20, cs: 14 }, // eng 20–30%, G&A heavier
};

/** Industry tilts (multipliers off the general baseline; normalized after). */
export const INDUSTRY_TILT = {
  general:     { rnd: 1.00, sm: 1.00, ga: 1.00, cs: 1.00 },
  b2b_saas:    { rnd: 1.00, sm: 1.05, ga: 0.95, cs: 1.00 },
  fintech:     { rnd: 1.05, sm: 0.85, ga: 1.40, cs: 1.00 }, // compliance/risk heavy
  healthtech:  { rnd: 1.15, sm: 0.80, ga: 1.35, cs: 1.00 }, // regulated
  biotech:     { rnd: 1.45, sm: 0.50, ga: 1.40, cs: 0.55 }, // R&D + regulatory
  ai_ml:       { rnd: 1.40, sm: 0.75, ga: 0.90, cs: 0.80 }, // research/compute heavy
  marketplace: { rnd: 0.80, sm: 1.20, ga: 1.10, cs: 1.20 }, // ops + supply/demand
  consumer:    { rnd: 0.85, sm: 1.25, ga: 1.00, cs: 1.15 }, // growth/marketing led
  ecommerce:   { rnd: 0.70, sm: 1.30, ga: 1.15, cs: 1.20 }, // merchandising + ops
  hardware:    { rnd: 1.25, sm: 0.85, ga: 1.20, cs: 0.90 }, // supply chain/ops
  devtools:    { rnd: 1.25, sm: 0.95, ga: 0.85, cs: 0.95 }, // eng + devrel
};

/** Industries surfaced in the setup dropdown (key + label). "general" first. */
export const INDUSTRIES = [
  ["general", "Other / General"],
  ["b2b_saas", "B2B SaaS"],
  ["fintech", "Fintech"],
  ["healthtech", "Healthtech"],
  ["biotech", "Biotech / Pharma"],
  ["ai_ml", "AI / ML"],
  ["marketplace", "Marketplace"],
  ["consumer", "Consumer / Social"],
  ["ecommerce", "E-commerce / DTC"],
  ["hardware", "Hardware / Deep tech"],
  ["devtools", "Dev tools / Infra"],
];
export const INDUSTRY_KEYS = INDUSTRIES.map(([k]) => k);

/** Phase/industry function mix, normalized to 100. */
export function functionBenchmarks(phase, industry) {
  const base = GENERAL_BY_PHASE[phase] || GENERAL_BY_PHASE.early;
  const tilt = INDUSTRY_TILT[industry] || INDUSTRY_TILT.general;
  const raw = { rnd: base.rnd * tilt.rnd, sm: base.sm * tilt.sm, ga: base.ga * tilt.ga, cs: base.cs * tilt.cs };
  const sum = raw.rnd + raw.sm + raw.ga + raw.cs || 1;
  return { rnd: round1((raw.rnd / sum) * 100), sm: round1((raw.sm / sum) * 100), ga: round1((raw.ga / sum) * 100), cs: round1((raw.cs / sum) * 100) };
}

/** Function categories an admin can assign to a department (drives the suggestion). */
export const FUNCTION_CATEGORIES = [
  ["rnd", "R&D / Engineering"],
  ["sm", "Sales & Marketing"],
  ["ga", "G&A / Operations"],
  ["cs", "Customer Support"],
  ["other", "Other"],
];
export const FUNCTION_CATEGORY_KEYS = FUNCTION_CATEGORIES.map(([k]) => k);
