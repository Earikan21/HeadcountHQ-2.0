# Benchmark basis — how the suggested target balance is derived

This documents the numbers behind the "Suggest a starting balance" feature
(`src/data/benchmarks.js`). **These are starting suggestions, not gospel** — the
moment you edit a target it becomes yours, and the suggestions never override your
saved numbers. This file exists so the assumptions are transparent and tunable.

## What it produces

A suggested **share of headcount by function** (R&D/Engineering, Sales & Marketing,
G&A, Customer Support) for your company's **phase** and **industry**, which is then
mapped onto your actual department names and normalized to 100%.

## 1. The cross-industry baseline (by phase)

Each row sums to 100%. This is the "Other / General" default.

| Phase | R&D / Eng | Sales & Mktg | G&A | Support |
|---|---|---|---|---|
| **Early** (pre-PMF) | 55% | 22% | 13% | 10% |
| **Growth** | 42% | 32% | 14% | 12% |
| **Mid** | 33% | 37% | 17% | 13% |
| **Scale** | 28% | 38% | 20% | 14% |

**Why these shapes (this part is well-sourced):**

- **Engineering falls as you scale.** Multiple stage analyses put engineering at
  ~50–70% of headcount early, ~30–50% in growth, and ~20–30% at scale. Our row
  values (55 → 42 → 33 → 28) sit inside those published ranges.
- **Sales & Marketing ramps, then levels off** once revenue appears (the
  engineer-to-salesperson ratio drifts from ~2:1 toward ~1:1 at $50–100M ARR); S&M
  as a share of headcount stabilizes around the low-to-high 30s%.
- **G&A rises with size** (finance, HR, legal, recruiting, IT) — its share grows as
  the company matures, especially $5–20M revenue onward.
- **Customer Support** settles at a "terminal" ~8–10%+ of the org; we let it drift
  up modestly with scale.

**Honest caveat:** the *direction and ranges* above are taken from published
benchmarks. The *exact* per-phase split (e.g. 42/32/14/12) is our interpolation to
fit those ranges and sum to 100 — there is no single public table with these precise
cells, so treat them as a defensible starting point, not a measured constant.

## 2. Industry tilts

The baseline is multiplied by per-industry factors, then re-normalized to 100%. A
factor >1 means "more of this function than the cross-industry norm."

| Industry | R&D | S&M | G&A | Support | Rationale |
|---|---|---|---|---|---|
| General | 1.00 | 1.00 | 1.00 | 1.00 | the baseline |
| B2B SaaS | 1.00 | 1.05 | 0.95 | 1.00 | canonical, slightly GTM-heavy |
| Fintech | 1.05 | 0.85 | 1.40 | 1.00 | compliance / risk / legal heavy |
| Healthtech | 1.15 | 0.80 | 1.35 | 1.00 | regulated |
| Biotech / Pharma | 1.45 | 0.50 | 1.40 | 0.55 | R&D + regulatory dominated |
| AI / ML | 1.40 | 0.75 | 0.90 | 0.80 | research / compute heavy |
| Marketplace | 0.80 | 1.20 | 1.10 | 1.20 | supply/demand ops + support |
| Consumer / Social | 0.85 | 1.25 | 1.00 | 1.15 | growth/marketing led |
| E-commerce / DTC | 0.70 | 1.30 | 1.15 | 1.20 | merchandising + ops + support |
| Hardware / Deep tech | 1.25 | 0.85 | 1.20 | 0.90 | supply chain / operations |
| Dev tools / Infra | 1.25 | 0.95 | 0.85 | 0.95 | engineering + developer relations |

**Honest caveat:** unlike the phase shape, the industry tilts are **reasoned
archetypes**, not measured per-industry-per-stage data (which largely isn't
published). They're directionally sensible and easy to adjust in
`src/data/benchmarks.js` — if you have real data for your sector, we should replace
the tilt with it.

## 3. How a suggestion is built

1. Pick the function mix for your **phase × industry** (sections 1–2), normalized to 100%.
2. Classify each of your departments into a function bucket by name (e.g.
   "Engineering/Product/Data" → R&D; "Sales/Marketing/Growth" → S&M;
   "Finance/HR/Legal/Ops" → G&A; "Customer Success/Support" → Support; anything
   unrecognized gets a small neutral weight).
3. Split each bucket's percentage across the departments in it, then normalize the
   whole set back to 100%.

## Sources

- Index Ventures — *People challenges by headcount stage* (engineering share by stage): https://www.indexventures.com/scaling-through-chaos/people-challenges-by-headcount-stage
- Tomasz Tunguz — *The structure of a typical SaaS company as it scales* (eng:sales ratio, support terminal share): https://tomtunguz.com/structure-typical-saas-startup/
- Tomasz Tunguz — *How should you staff your startup* (R&D share dropping as GTM/G&A ramp): https://tomtunguz.com/et30-headcount-analysis/
- The F Suite — *Benchmarking headcount & operating expenses* (2026): https://www.fsuite.co/blog/benchmarking-headcount-and-operating-expenses
- Blossom Street Ventures — *The makeup of SaaS headcount* (R&D ~30% / S&M ~39% / G&A ~16% medians): https://blossomstreetventures.medium.com/saas-headcount-makeup-186185438015

## Replacing this with harder data (future: M4.5+)

Per Directive 2.0, the intended end state is a researched `benchmarks` table indexed
on phase × industry, with a trimmed-mean "Other/General" cohort. The current code
module is the first version of that. If you want, I can do a deeper research pass to
firm up specific cells (especially the industry tilts) and cite each one.
