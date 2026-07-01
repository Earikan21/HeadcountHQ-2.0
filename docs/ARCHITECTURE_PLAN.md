# Headcount HQ — Architecture & Implementation Plan

> **Status: DRAFT FOR REVIEW.** No implementation code has been written. This plan
> exists to be reviewed and approved before any build work begins.

> **UPDATE (2026-06-19) — stack changed to zero-dependency built-ins.**
> To make the app trivially host-deployable (push to GitHub → run on a host, no
> local tooling) *and* fully testable in the build environment, the foundation was
> rebuilt on Node's standard library only: `node:http`, `node:sqlite`, and
> `node:crypto` — no Fastify/Kysely/npm packages, no build step, no native compile.
> The architecture below still holds (layering, RBAC/comp-visibility, phase plan,
> security goals); only the implementing libraries changed. Passwords use scrypt
> (node:crypto) rather than Argon2, and persistence uses node:sqlite behind a small
> storage module so it can be swapped later.

> **UPDATE (2026-06-24) — philosophy layer added (Mike Sabes interview).**
> A discovery interview surfaced a foundational reframing: the tool must let an org
> set its **headcount philosophy before it models anything.** Modeling is no longer the
> entry point — configuration is. This update adds a new **Philosophy / Settings**
> domain that sits upstream of import, roster, requests, and roll-ups, and four new
> capability areas: a **seat model** (a seat is a thing distinct from the person in it),
> a **benchmark / target-ratio engine**, an **incremental-hiring value** module, and a
> **"Position Economy"** budget framing. See the new **§12** for the full design; the
> sections below are annotated where they change. Decisions locked in this interview:
>
> | Decision | Choice |
> |---|---|
> | Seat vs. person (what an approval grants) | **Configurable per workspace** — seats are *always* modeled; only the vacancy transition is gated by the setting (one code path, not two) |
> | Backfill on vacancy | **Configurable** — default auto-backfill, admins can switch to "return seat to budget pool, require re-approval" |
> | Benchmarks | **Framework + seeded research** — admin-editable target engine now, plus a starter benchmark dataset produced by deep research, clearly marked as overridable starter data |
> | Position Economy | **Envelopes + framing** — keep per-department budget envelopes and org-hierarchy roll-ups, present them through the "positions trickle down from Finance" lens; full cascading-allocation engine deferred |

## 0. Decisions already locked

From the planning conversation:

| Decision | Choice |
|---|---|
| Who it serves now | **Single-tenant** (one company), but **structured to extend** to multi-tenant later |
| Where sensitive data lives | **Self-hosted** — you run it; no third-party data processor |
| Feature scope | **Functionality across all three phases** of the product roadmap |
| Account creation | **Both** — admin sets passwords *and* can send email invite links |

These four answers force one non-negotiable conclusion: this is a **real server-backed
web application** with server-side authentication, role-based access control, and a
database. The existing client-only `import-tool` cannot satisfy "password-protected,
multi-user, sensitive comp data" — anything enforced in the browser is bypassable.
The good news is the existing `headcount-lib.js` engine (mapping, normalization,
validation, roll-up) is already pure and environment-agnostic, so it ports to the
server unchanged and becomes the core of the import domain.

---

## 1. System architecture

A single deployable application the company runs on its own infrastructure (a VM,
a container host, or an on-prem box). One Docker image + one database file/instance.

```
                    ┌───────────────────────────────────────────────┐
   Browser  ⇄  HTTPS │  Reverse proxy (Caddy/Nginx, TLS)             │
                    │        │                                       │
                    │   ┌────▼─────────────────────────────────┐    │
                    │   │  App server (Node + TypeScript)       │    │
                    │   │   • Auth & sessions  • CSRF  • rate-  │    │
                    │   │     limit                              │    │
                    │   │   • AuthZ layer (RBAC + comp-          │    │
                    │   │     visibility)  ← single source      │    │
                    │   │   • Routes (pages + JSON API)         │    │
                    │   │   • Domain engine (import, comp,      │    │
                    │   │     rollup, runway, scenarios)        │    │
                    │   │   • Repositories (DB access)          │    │
                    │   └────┬──────────────────────────────────┘    │
                    │        │                                       │
                    │   ┌────▼──────────┐   ┌───────────────────┐    │
                    │   │  Database      │   │  Optional SMTP    │    │
                    │   │  (SQLite→PG)   │   │  (invite emails)  │    │
                    │   └───────────────┘   └───────────────────┘    │
                    └───────────────────────────────────────────────┘
```

**Component boundaries (enforced, not just suggested):**

- **Domain** — pure business logic (import/validation/normalization, roll-up, runway,
  scenario math, comp-band logic). No DB, no HTTP. Fully unit-testable. This is where
  the existing engine lives and grows.
- **Repositories** — the *only* layer that touches the database. Parameterized queries
  only.
- **AuthZ** — a *single* module that answers "can this user see/do X, and how much comp
  detail." Every route and every repository read funnels through it. Centralizing this
  is the most important security decision in the whole system (see §4).
- **Routes/controllers** — thin; translate HTTP ⇄ domain/repo calls. No business logic.
- **Auth** — sessions, password hashing, invites, CSRF, login rate-limiting.

This layering is the antidote to the #1 risk in a sensitive-data app: comp leaking
through some forgotten endpoint. If comp visibility is decided in one place, it can't
drift.

### Extension-ready toward multi-tenant

Every tenant-scoped table carries a `workspace_id` from day one (defaulted to a single
seeded workspace now). All repository reads are scoped by it. Going multi-tenant later
becomes "populate more workspaces + add tenant resolution middleware," not a rewrite.
We do **not** build tenant management UI, signup, or billing now — that's the wasted
effort we agreed to avoid.

---

## 2. Technology stack (recommended)

Chosen for "boring, correct, well-supported, easy to self-host," not novelty.

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript (Node 20+)** | Type safety matters for financial/auth code; reuses the existing JS engine directly |
| Web framework | **Fastify** | Fast, first-class schema validation, mature plugin ecosystem |
| Database | **SQLite (better-sqlite3)** now, **Postgres-ready** | Zero-ops single file for self-host; trivial to back up (copy a file) |
| Query layer | **Kysely** (typed query builder) | Explicit SQL (no magic), and portable SQLite↔Postgres for the multi-tenant future |
| Migrations | Kysely migrations | Versioned, reviewable schema changes |
| Password hashing | **Argon2id** | Current best practice for password storage |
| Sessions | Server-side, DB-backed, httpOnly + SameSite + Secure cookies | No JWT-in-localStorage foot-guns |
| Email (optional) | Nodemailer + SMTP (config-gated) | Invites work when SMTP is set; admin-set passwords work without it |
| Testing | **Vitest** (unit/integration) + **Playwright** (e2e) | Fast unit runner; real-browser e2e for critical flows |
| Packaging | **Docker + docker-compose**, `.env` config | One-command self-host; GitHub-ready |
| CI | GitHub Actions (lint + typecheck + test) | Gate every change on a green suite |

**One open stack decision — the frontend** (see §7, Decision A). The two viable paths
are server-rendered + htmx vs. a React SPA. My recommendation is server-rendered with
htmx and small isolated chart/org-chart components, because it keeps comp logic on the
server by default (more secure) and is materially less code to test and maintain.

---

## 3. Data model (core tables)

All tenant-scoped tables include `workspace_id`. Timestamps and `created_by` on
mutable records for audit.

- **users** — id, workspace_id, email, name, role, password_hash, status
  (active/disabled), must_change_password, last_login_at
- **sessions** — id, user_id, expires_at, user_agent/ip (for audit)
- **invites** — token (hashed), email, role, expires_at, accepted_at, created_by
- **departments** — id, workspace_id, name, parent_id (org hierarchy), manager_user_id
- **levels** — id, workspace_id, name/rank, comp_band_min, comp_band_max (per level, optionally per dept)
- **employees** — canonical roster (the existing schema: employee_id, name, department,
  job_title, manager, employee_type, employment_status, comp fields, annual_salary) +
  level_id, start_date
- **compensation** — *separated* sensitive table: employee_id → exact amount/unit/annual.
  Split out so the AuthZ layer can withhold it from non-Finance roles cleanly
- **hiring_requests** — role, department_id, level_id, target_start_month, type
  (net-new/backfill), justification, comp_band, status, requester_id, timestamps
- **request_status_history** — request_id, from_status, to_status, actor_id, note, at
  (the auditable "submitted → review → approved → filled" trail)
- **budget_envelopes** — department_id, period, amount, set_by (Phase 2)
- **scenarios** + **scenario_items** — named what-if plans; items are planned hires with
  ramp timing and cost (Phase 2)
- **financials** — cash balance, baseline monthly burn (inputs for runway math; Phase 2)
- **actuals** — plan-vs-actual snapshots (Phase 2)
- **audit_log** — actor_id, action, entity, before/after summary, at (sensitive-data
  hygiene; cheap to include from day one)
- **import_batches** — provenance of each import (file name, mapping used, counts) so
  imports are re-runnable and traceable

> **Added 2026-06-24 (see §12 for detail):** `workspace_settings` (philosophy:
> seat_mode, backfill_policy, company_phase), `seats` (the persistent position,
> occupant nullable), `benchmarks` (researched reference ratios), `target_ratios`
> (admin-modulated per-phase targets, incl. level-mix), and new value/justification
> fields on `hiring_requests`. Note: `hiring_requests` becomes a *request to open or
> change a **seat***, not a request to hire a person directly.

---

## 4. Roles, permissions & comp-visibility (server-enforced)

Straight from the vision doc's matrix, enforced in the single AuthZ module:

| Role | Can do | Sees | Comp detail |
|---|---|---|---|
| **Finance Admin / Owner** | Own the model, import data, configure workspace, manage seats, run scenarios | All departments | **Exact salaries** |
| **C-Suite** | Set department budget envelopes, approve the plan | All departments | **Totals & bands only** |
| **Department Manager** | Submit & track requests for own team | **Own department only** | **Bands only** |

Enforcement rules:

- Comp visibility is applied at the **repository/serialization boundary**, so exact
  salary never enters a response payload for a role that may not see it — it isn't
  hidden by CSS, it's never sent.
- Department managers are scoped to their `department_id` at the query level; they
  cannot enumerate other departments' people or requests.
- Every authorization decision is covered by tests asserting the **negative** case
  (e.g., "manager request for another dept's comp returns 403 / empty, never data").

---

## 5. Feature → phase mapping, and what is honestly buildable

You asked for all three phases. Most of it is fully buildable in a single-tenant
self-hosted app. **Two Phase 3 items are not** — and I won't fake them. Flagged below.

**Phase 1 — source of truth + intake (fully buildable):**
Self-serve workspace setup; auth + roles + comp-visibility; guided import with
validation (ported engine); structured hiring-request intake with status tracking;
roll-up dashboards; sensible templates/defaults.

**Phase 2 — the planning engine (fully buildable):**
Per-department budget envelopes; scenario / what-if modeling; burn & runway
(needs a cash-balance + burn settings screen); time-phased cost ramps; plan-vs-actuals;
board-ready exports (PDF/CSV).

**Phase 3 — sticky + integrated (mixed):**
- Org-chart visualization — **buildable.** ✅
- Audit history — **buildable** (in from day one). ✅
- HRIS / ATS / accounting **live integrations** — **NOT buildable blind.** ⚠️ Each
  (Workday, BambooHR, Greenhouse, QuickBooks…) needs that vendor's API, OAuth
  credentials, and often an approved partner app. What I *can* build now is a clean
  **pluggable import-adapter interface** plus file-based adapters (CSV/XLSX), so live
  connectors drop in later without rework. (Decision C.)
- Anonymized **cross-company benchmarking** — **NOT buildable now.** ⚠️ By definition it
  needs *many* tenants and a central aggregation service with minimum-cohort thresholds.
  That contradicts "single-tenant, self-hosted, data never leaves." What I *can* do is
  shape the schema so an anonymized opt-in export is feasible later. (Decision C.)

---

## 6. Security design (because this is comp data)

- Argon2id password hashing; never store or log plaintext.
- Server-side sessions in httpOnly + SameSite=Lax + Secure cookies; idle + absolute
  expiry; logout invalidates server-side.
- CSRF tokens on all state-changing requests.
- Login rate-limiting + temporary lockout; generic error messages (no user enumeration).
- Parameterized queries everywhere (Kysely) — no string-built SQL.
- Security headers (CSP, HSTS, X-Content-Type-Options, etc.).
- Secrets only via environment / `.env` (gitignored); `.env.example` documents them.
- AuthZ centralized (§4); comp withheld at serialization, not the UI.
- Audit log for sensitive actions (logins, comp views/exports, role changes, approvals).
- TLS expected at the proxy; README documents a Caddy reverse-proxy for automatic HTTPS.
- Optional later: TOTP 2FA for admins (noted, not in first build unless you want it).

---

## 7. Open decisions for your call

Presented in your review format — description, why it matters, options with
effort/risk/impact/maintenance, and my recommendation.

### Decision A — Frontend approach

*Why it matters:* drives security posture, code volume, and test surface for the
entire UI.

- **Option A1 — Server-rendered (Fastify + templates) + htmx, isolated JS for charts/org-chart.** *(Recommended)*
  - Effort: **Lower.** Risk: **Lower** (comp logic stays server-side by default).
    Impact: covers all dashboards/forms; heavy viz handled by contained components.
    Maintenance: **Low** — one codebase, no API/SPA duplication.
- **Option A2 — React SPA (Vite + TS) + JSON API.**
  - Effort: **Higher** (two layers). Risk: **Higher** (must guard every API endpoint
    against comp leakage; token/CSRF handling). Impact: richest interactivity.
    Maintenance: **Higher** (client + server + shared types).
- **Option A3 — Do nothing / keep client-only.** Not viable — fails the auth & sensitive-data requirement.

**My recommendation: A1.** For an internal, sensitive-data tool a server-rendered app is
more secure by default and far less code to test thoroughly, which matters given you
want strong test coverage. The genuinely interactive bits (scenario comparison, org
chart) become small, well-bounded client islands rather than a whole SPA.

### Decision B — Database now

- **Option B1 — SQLite now, Postgres-portable via Kysely.** *(Recommended)* Effort: low;
  Risk: low; zero-ops backups (copy a file); ample for one company's roster. Migrating
  to Postgres later is a config + connection change because the query layer is portable.
- **Option B2 — Postgres now.** Effort: higher (a DB service to run/back up); Risk:
  more moving parts to self-host; Impact: only matters at multi-tenant scale we're not
  building yet.

**My recommendation: B1.**

### Decision C — The two Phase 3 limits

*Why it matters:* I won't ship fake integrations or fake benchmarking; I want your
explicit call on the realistic substitute.

- **Option C1 — Build the adapter framework + file adapters now; document live
  connectors and benchmarking as future work; shape schema to allow both later.** *(Recommended)*
  Effort: modest; Risk: low; Impact: real, extensible foundation; honest about scope.
- **Option C2 — Build one specific live integration now.** Requires you to name the
  vendor and provide API credentials / a sandbox; Effort: high per connector; Risk:
  external dependency and partner approval.
- **Option C3 — Drop Phase 3 integration/benchmarking entirely for now**, keep org-chart
  + audit only.

**My recommendation: C1**, unless there's one specific system (e.g., your HRIS) you
want connected first — then tell me which and we scope C2 for that one.

---

## 8. Testing strategy

"Better too many tests than too few." Coverage plan:

- **Unit (Vitest):** the whole domain engine — comp parsing/normalization, unit
  annualization, validation rules, roll-up, runway math, scenario math, comp-band logic.
  These are pure and get exhaustive edge-case tests (the existing engine's planted-error
  sample becomes fixtures).
- **Integration (Vitest + Fastify inject):** auth flows (login, lockout, invite accept,
  password change), **RBAC negative tests** (each role blocked from what it must not
  see/do — especially comp), import end-to-end through the API, request status
  transitions, envelope/scenario CRUD.
- **E2E (Playwright):** the critical journeys — admin creates an account, user logs in,
  import a roster, manager submits a request, admin approves it, board export renders.
- **CI gate:** lint + typecheck + full unit/integration on every push; e2e on PRs.

---

## 9. Proposed repository structure

```
headcount-hq/
  README.md  LICENSE  .gitignore  .env.example
  docker-compose.yml  Dockerfile
  package.json  tsconfig.json  vitest.config.ts  playwright.config.ts
  .github/workflows/ci.yml
  src/
    domain/        # pure engine: import, comp, validation, rollup, runway, scenarios
    db/            # schema, migrations, kysely setup, repositories
    auth/          # sessions, password (argon2), invites, csrf, rate-limit
    authz/         # single RBAC + comp-visibility module
    routes/        # page + JSON routes (thin)
    web/           # templates + chart/org-chart components  (if Decision A1)
    server.ts
  tests/
    unit/  integration/  e2e/
  docs/
    ARCHITECTURE_PLAN.md   # this file
```

---

## 10. Proposed build sequence (gated on your approval)

> **Superseded by §13 (Directive 2.0, 2026-06-24).** The list below is the original
> sequence; the current plan inserts **M2.5 (philosophy & seats)** before requests and
> adds **M4.5 (benchmark seed)**. See §12–§13 for the authoritative roadmap.

Each milestone ends green (tests passing) and is a natural review checkpoint per your
workflow (Architecture → Code → Tests → Performance).

1. **M0 — Scaffold:** repo, TS/Fastify/Kysely/SQLite, Docker, CI, `.env.example`,
   migration runner, empty schema. *(No business logic; provable it boots & tests run.)*
2. **M1 — Auth & accounts:** users, sessions, Argon2, login/logout, admin account
   management, invite links (SMTP-optional), password change, CSRF, rate-limit, audit
   log. Full auth/RBAC test suite.
3. **M2 — Roster & guided import:** port the engine into `domain/`, persistence, the
   guided import wizard against real storage, the separated comp table + comp-visibility
   enforcement.
4. **M3 — Structured hiring requests:** intake form, validation, status workflow +
   history, manager/admin/C-suite views.
5. **M4 — Roll-up dashboards:** department & company roll-ups, utilization vs. envelopes,
   role-appropriate comp display.
6. **M5 — Planning engine (Phase 2):** budget envelopes, runway/burn, scenarios, ramps,
   plan-vs-actual, board exports.
7. **M6 — Phase 3 (per Decision C):** org chart, audit history UI, adapter framework +
   file adapters; live connectors / benchmarking documented as future.

I will **pause for your review** at the end of each milestone rather than building all
of it before you see anything.

---

## 11. What I need from you to start

1. Approve or adjust **Decisions A, B, C** (§7).
2. Confirm the **stack** (§2) or name a house preference (e.g., Python/Postgres).
3. Confirm you're happy for me to **begin at M0** and pause for review between milestones.

Nothing gets built until you say go.

---

## 12. Philosophy layer (2026-06-24 — Mike Sabes interview)

The core insight from the interview: **the tool must not jump straight into modeling.**
It first establishes the *rules of the game* — what an approval means, whether seats
backfill, what "right-sized" looks like for each department, and where the company is
in its lifecycle. Everything downstream (requests, roll-ups, ROI, board views) reads
from this layer. Architecturally it is a new pure-domain area (`domain/philosophy`)
plus a `workspace_settings` record and the supporting tables below; it changes no
existing security model.

### 12.1 Seats — the unit of approval

Today the model has people (`employees`) and will have `hiring_requests`. Mike's
question — *"is approving a headcount approving a single employee or approving a
seat?"* — forces a new entity in between: a **seat** is a budgeted, approved position
that exists independently of whoever occupies it.

- **`seats`**: id, workspace_id, department_id, level_id, title, status
  (`proposed` → `approved` → `open` → `filled` → `frozen` → `closed`), occupant
  `employee_id` (nullable), `opened_at`, fully-loaded-cost estimate, source request id.
- An employee now **occupies a seat** (`employees.seat_id`), rather than standing alone.
- **Active vs. approved** — the number Mike asked for — becomes trivial and exact:
  `approved` = count of non-closed seats; `active` = count of `filled` seats; the ratio
  is per-department and company-wide, no heuristics.

**Configurable, one code path.** Seats are *always* modeled. The workspace setting
`seat_mode` only governs the **vacancy transition**:

- `seat` mode — occupant leaves → seat returns to `open` (persists, ready to backfill).
- `person` mode — occupant leaves → seat goes `closed` (the headcount dissolves;
  re-staffing needs a fresh request).

This keeps us DRY: there is a single seat lifecycle; the setting picks one branch of one
transition. It also satisfies the CLAUDE.md "explicit over clever" and "no duplication"
principles — no parallel person-vs-seat subsystems.

**Backfill policy** is a second setting, `backfill_policy`:
- `auto` (default) — a vacated seat in `seat` mode auto-moves to `open` (an open req).
- `reapprove` — a vacated seat parks in a `frozen`/budget-pool state and requires
  re-approval before it can be filled, giving leadership a budget-discipline lever.

Every transition is written to `request_status_history` / `audit_log` so the
"who approved this seat and when" trail is intact.

### 12.2 Benchmark & target-ratio engine

Mike wants departments compared to benchmarks, with leadership able to **modulate**
benchmarks into editable **targets** that shift by company **phase**.

- **`benchmarks`** (reference data): metric (`dept_share_of_headcount`,
  `manager_to_ic_ratio`, `admin_share`, `csuite_share`, …), **industry**, **phase**,
  value, sample basis, source, retrieved_at. Seeded by deep research (see §13), marked
  `is_seed`.
- **`target_ratios`** (the org's own, editable): workspace_id, metric, scope
  (department_id or level), phase, target_value, set_by, updated_at. Seeded *from*
  benchmarks but owned and overridable by Finance Admin / C-suite.
- **`workspace_settings.company_phase`** (`early`, `growth`, `mid`, `scale`) selects
  which target set is active, so the same workspace re-baselines as it matures.
- **`workspace_settings.industry`** selects which benchmark set seeds the targets.
- **Two target families**, exactly as Mike listed: (1) **department mix** — each
  department's share of total headcount vs. target; (2) **employment-level mix** —
  Admin / Manager / C-suite / IC proportions vs. target.
- **Output**: a "ratios vs. target" panel per department and company-wide, flagging
  over/under-staffed areas. This is pure roll-up math over seats + levels; no new
  security surface.

**Benchmark dataset shape (resolved 2026-06-24).** The seed dataset is fully
**modular**, indexed on two dimensions so any cell can be swapped or extended without
touching the engine:
- **Phase** — `early`, `growth`, `mid`, `scale`. Department-to-department ratios are
  researched at each phase, spanning the full range of company sizes / headcounts (not
  a single size bucket), so the same industry re-baselines as it grows.
- **Industry** — *all relevant startup industries*, surfaced as a **dropdown** the admin
  picks at setup (e.g., B2B SaaS, fintech, healthtech, marketplace, consumer/social,
  AI/ML, hardware/deeptech, biotech, e-commerce/DTC, dev tools/infra, …; final list
  finalized during the research step). A required **"Other / General"** entry holds a
  **realistic cross-industry average with extreme outliers trimmed** (a trimmed mean,
  not a raw mean), so a company with no clean industry match still gets sane defaults.

*Honest scope:* the **engine** is fully buildable now. The **seed data** is researched
public ratios — useful as a starting point, explicitly labelled, and designed to be
overwritten. It is **not** live cross-company benchmarking (still out — needs many
tenants; unchanged from §5).

### 12.3 Incremental-hiring value

Mike's "quantify the incremental benefit of a new hire." The honest, buildable version
has three layers, strongest first:

1. **Structured justification + benchmark gap** — when a seat is requested, the
   requesting manager answers the two framed questions: *"what do you do with current
   headcount?"* and *"what would you do with the new headcount?"* The request is then
   scored against the §12.2 targets (e.g., "this dept is below its target IC ratio for
   the growth phase" is a quantified, defensible signal). Fully buildable.
2. **Cost side in dollars** — fully-loaded cost of the seat and its effect on burn /
   runway. Fully buildable (it's the Phase-2 planning math applied per seat).
3. **Benefit side in dollars** — only where the department has a real output/revenue
   driver the admin supplies (e.g., revenue-per-rep for Sales). Offered as an *optional*
   input, never fabricated. **We will not invent a causal $ ROI for roles that have no
   revenue driver** — for those, layers 1–2 are the answer. This is the one place I'm
   deliberately constraining the ask to stay correct (CLAUDE.md: correctness over speed).

> **Resolved 2026-06-24:** no department revenue drivers are wired in this round —
> **ship layers 1–2 only.** Layer 3 stays in the schema as an optional, admin-supplied
> field for later, but no dollar-benefit math is built now.

New fields on `hiring_requests`: `current_hc_narrative`, `new_hc_narrative`,
`expected_value_basis` (`benchmark` | `revenue_driver` | `qualitative`),
`expected_value_amount` (nullable).

### 12.4 Position Economy — envelopes + framing

"Finance prints money; positions trickle down through management." Implemented as:
- The existing **org hierarchy** (`departments.parent_id`) + **budget envelopes**
  (§3, Phase 2) provide the structure; roll-ups already flow up the tree.
- Finance/Admin sets a **total headcount budget and money budget** at the top
  (`budget_envelopes` at the root), and decisions are framed as consuming from that
  envelope as seats trickle down the hierarchy.
- **Deferred:** a full *cascading-allocation engine* (every seat hard-debiting a
  parent's sub-envelope with enforcement) is the heaviest possible reading and is **not**
  in this round; we ship envelopes + roll-up + the framing, and can add hard cascade
  later without schema rework (the hierarchy and envelopes are already there).

### 12.5 Roles & permissions delta

No new roles. Two clarifications to §4:
- **Finance Admin / Owner** — owns `workspace_settings` (seat_mode, backfill_policy,
  phase), edits `target_ratios`, supplies revenue drivers.
- **C-Suite** — may **modulate target_ratios** and set top-level budget envelopes
  (consistent with their existing "sets budgets / approves plan" rights).
- **Department Manager** — sees their department's ratios-vs-target and answers the
  incremental-value questions on their own requests; unchanged comp visibility.

### 12.6 HR-software import (unchanged, restated)

Mike's "ideally import directly from HR software" is the same item as §5/Decision C:
live HRIS connectors need each vendor's API + credentials and aren't buildable blind.
The pluggable import-adapter interface + file adapters (CSV/XLSX, already partly built)
remain the answer; named connectors drop in later.

---

## 13. Revised phase & build-sequence delta

The philosophy layer inserts **before** modeling, so the milestone plan (§10) gains a
new early milestone and two later ones. Unchanged milestones keep their numbers.

- **M2.5 — Philosophy & settings (NEW, before requests):** `workspace_settings`,
  seat_mode + backfill_policy, company_phase; the `seats` entity and lifecycle;
  employee↔seat occupancy; active-vs-approved roll-up. Full unit tests on the seat
  lifecycle (every transition, both modes) and the active/approved math.
- **M3 — Structured requests (revised):** a request now opens/changes a **seat** and
  carries the §12.3 value/justification fields. Status workflow drives the seat
  lifecycle.
- **M4 — Roll-ups (revised):** add the ratios-vs-target panels (department mix +
  level mix) and growth-trend-per-department views on top of the existing roll-ups.
- **M4.5 — Benchmark seed (NEW, data task — runs here, not now):** run the deep
  research to populate `benchmarks` across the **phase × industry** grid (§12.2),
  including the trimmed-average **"Other / General"** set; seed `target_ratios` from it;
  mark as overridable. *Decision: produced at this milestone, not as an early standalone.*
- **M5 / M6 — unchanged** (planning engine; org chart + adapters), now also consuming
  seats and targets.

**Open questions — resolved (philosophy round, 2026-06-24):**

1. **Phase taxonomy** → `early / growth / mid / scale`, researched across **all company
   sizes / headcounts** and kept **modular** (any phase cell swappable).
2. **Benchmark scope** → **all relevant startup industries**, admin-selectable via a
   **dropdown**, plus a required **"Other / General"** = realistic cross-industry
   average with extreme outliers trimmed. Final industry list locked during M4.5 research.
3. **Revenue drivers** → none for now; **ship incremental-value layers 1–2 only**
   (§12.3). Layer-3 field retained for later.
4. **Research timing** → **wait until M4.5**; it stays explicitly in the plan as a
   data-production milestone.
