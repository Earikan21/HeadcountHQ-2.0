# M8 — AI-assisted import interpreter (plan for review)

**Date:** 2026-06-30
**Status:** Plan-level only. No code written against this yet. Pauses for approval per `CLAUDE.md`.
**Change size:** BIG — introduces the first external network boundary and the first non-deterministic component.

---

## 0. One-line summary

The roster import step gains an **optional** AI assistant that proposes column→field
mappings, normalizes titles, and classifies departments into function buckets. It is
**off by default**, **admin-keyed**, **human-confirmed**, and **privacy-bounded**: only
column headers, the distinct department-name list, and the distinct job-title list ever
leave the box. Salary values and employee names never do. The existing deterministic
mapper remains the default and the fallback.

---

## 1. Decisions locked (from this conversation)

| # | Decision | Choice |
|---|---|---|
| 1 | Data egress | **Structure only** — headers + dept names + job titles. Never comp values or employee names. |
| 2 | AI scope | Column mapping, **title** cleaning, department classification (AI); comp parsing + anomaly flagging (on-device). |
| 3 | Titles | **OK to send** to the model. |
| 4 | Default state | AI **off by default**; deterministic mapper is the default and the fallback. |
| 5 | Human-in-the-loop | Every AI suggestion is shown as a diff and confirmed before it applies. |

**Why the split (the important nuance):** "data cleaning" and "anomaly flagging" as
originally scoped operate on row *values*, including salaries — which "structure only"
forbids. Resolution: the value-touching work (parse `"$120k"`, flag `salary = $1.20`)
runs **on-device, deterministically**. It needs no LLM, and doing it locally is cheaper,
testable, and zero-egress. The AI handles only what needs judgment over structure.

---

## 2. What leaves the box (trust-critical, spelled out)

Serialized into the LLM prompt, by default:

- Column header strings (e.g. `"Full Name", "Dept", "Base $", "Start"`)
- Distinct **department names** (e.g. `["Engineering", "Eng", "Sales", "G&A"]`)
- Distinct **job titles** (e.g. `["Sr SWE", "Account Exec", "VP Eng"]`)

**Never serialized:** salary/comp values, employee names, emails, any per-row record,
the file itself. A single **redaction layer** is the only thing that can build an LLM
prompt; routes never call the LLM client directly. This is the load-bearing guarantee
and gets the heaviest test coverage (§6).

---

## 3. Architecture

### 3.1 Component boundary

```
import upload
   │
   ▼
CSV/XLSX parse (existing)  ──►  ProfileExtractor
                                   │  (headers, distinct dept names, distinct titles,
                                   │   per-column sample TYPES — not values)
                                   ▼
                              MappingSuggester  ◄── interface, two impls
                                ├─ HeuristicSuggester  (default, current logic)
                                └─ LlmSuggester        (opt-in)
                                        │
                                        ▼
                                  RedactionLayer  (only path to the LLM client)
                                        │
                                        ▼
                                  LlmClient (node fetch → external API)
   │
   ▼
Confirm screen (diff: suggested vs. current)  ◄── human approves/edits
   │
   ▼
On-device deterministic post-process:
   ├─ CompParser     ("$120k", "120,000/yr" → {amount, unit})
   └─ AnomalyFlagger (median/threshold checks on the comp column)
   │
   ▼
existing import commit (seats + employees + backfill)
```

### 3.2 Key principles

- **One interface, two impls (DRY).** `MappingSuggester` has the same return shape for
  heuristic and LLM. Callers don't branch on which is active. The LLM impl is a drop-in.
- **Suggestions, not actions.** Neither impl mutates anything. They return a proposed
  mapping + confidence + rationale. The confirm screen applies it.
- **Fallback is automatic.** AI off, no key, API error, timeout, or malformed response →
  silently fall back to `HeuristicSuggester`. Import never blocks on the AI.
- **Determinism stays where it belongs.** Comp parsing and anomaly flagging are pure
  functions over values, on-device, unit-tested exhaustively.

---

## 4. Data model & config

No new sensitive tables. Additions:

- `workspace_settings.ai_import_enabled` (bool, default `false`)
- `workspace_settings.ai_provider` (enum: `anthropic` | `openai` | `none`)
- API key: **environment variable only** (`AI_IMPORT_API_KEY`), never stored in the DB
  or rendered back to any page. Settings page shows only "configured / not configured."
- `import_runs` (audit, optional): `id, user_id, used_ai (bool), provider, suggestion_count,
  accepted_count, created_at`. No payload stored — just that AI was used and how much was
  accepted. Supports the "who/when/how" trail M6 already established.

Migration: `2026_06_30_013_ai_import`. Sequential, additive, no backfill needed.

---

## 5. Issues & options (senior-engineer review format)

### Issue A — Non-determinism enters a previously pure pipeline
**Why it matters:** the import path is currently fully testable. An LLM is not reproducible.
- **Option 1 (recommended):** confine non-determinism to `LlmSuggester` behind the interface; mock it in tests; assert on the *redaction* and *fallback*, not on model output. Effort: low. Risk: low. Impact: keeps the suite deterministic. Maintenance: low.
- **Option 2:** golden-snapshot real API responses. Effort: med. Risk: brittle, costs money in CI. Maintenance: high.
- **Option 3 (do nothing):** no AI. Effort: zero. Impact: forgoes the feature.
- **Recommendation: Option 1.**

### Issue B — The redaction guarantee is the whole privacy promise
**Why it matters:** one leak of a salary value breaks the product's core claim.
- **Option 1 (recommended):** make `RedactionLayer` the *only* code that can construct an LLM prompt; `LlmClient` refuses any input not produced by it (typed `RedactedPrompt` token). Add a test that feeds a full roster through and asserts no comp value / employee name appears in the outbound payload. Effort: med. Risk: low. Impact: high. Maintenance: low.
- **Option 2:** trust call sites to redact. Effort: low. Risk: high (easy to forget). Reject.
- **Recommendation: Option 1.**

### Issue C — Cost & latency per import
**Why it matters:** a 2,000-row sheet shouldn't mean a huge or slow prompt.
- **Mitigation:** we send *distinct* headers/dept-names/titles, not rows — payload is bounded by cardinality, not row count. A 2,000-person company still has ~10 departments and a few dozen distinct titles. One API call per import. Cheap and fast. No option needed; this is inherent to the structure-only design.

### Issue D — Provider lock-in
- **Option 1 (recommended):** thin `LlmClient` interface; ship one impl (Anthropic Messages API via built-in `fetch`); add others later. Effort: low. Keeps zero npm deps.
- **Recommendation: Option 1.**

---

## 6. Test matrix

| Layer | Tests |
|---|---|
| `ProfileExtractor` | distinct extraction; type inference; never emits row values |
| `RedactionLayer` | **full-roster leak test** (no comp/name in payload); only-path enforcement; typed-token rejection |
| `MappingSuggester` (heuristic) | unchanged current behavior preserved |
| `MappingSuggester` (LLM, mocked) | well-formed response → mapping; malformed → fallback; timeout → fallback; key missing → fallback |
| `CompParser` | `$120k`, `120,000`, `120000/yr`, `10k/mo`, blanks, garbage, negatives |
| `AnomalyFlagger` | typo lows, outlier highs, empty column, all-equal column |
| Confirm screen (flow) | suggestion shown as diff; user edit overrides; nothing applies pre-confirm |
| Settings/flow | AI off by default; toggling; "configured/not configured" never echoes the key |
| Audit | `import_runs` row written; no payload stored |

Target: keep the suite green and deterministic. No live API call in CI.

---

## 7. Rollout

1. Land deterministic pieces first (`CompParser`, `AnomalyFlagger`, `ProfileExtractor`) — value with zero egress, shippable alone.
2. Add `MappingSuggester` interface + heuristic impl refactor (no behavior change).
3. Add `RedactionLayer` + leak tests.
4. Add `LlmSuggester` + `LlmClient` + settings toggle, off by default.
5. Confirm-screen diff UI.
6. Docs: update import help + a short "what the AI sees / doesn't see" note for trust.

Each step is independently reviewable and leaves the app green. Build pauses at the end of each per `CLAUDE.md`.

---

## 8. Explicitly NOT in scope

- Sending row-level data, salaries, or employee names to any model (by design).
- Auto-applying AI suggestions without confirmation.
- A local/self-hosted model (revisit only if egress stance changes).
- AI anywhere outside the import step (this milestone is import only).

---

## 9. Open questions for you

1. **Provider** — default to the Anthropic Messages API, or do you want OpenAI as the first impl? (Either is one `fetch`-based client; no npm dep.)
2. **Sequencing** — want me to ship §7 step 1 (the deterministic comp-parser + anomaly-flagger) on its own first, since it's pure value with zero egress and needs no key? Or build the whole M8 as one piece?
3. **Audit** — keep the `import_runs` table (recommended for the trust story), or skip it for now?
