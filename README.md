# Headcount HQ

Self-hosted, single-tenant (extension-ready) tool for building a living headcount
model across departments and the C-suite. It connects current roster and
compensation to structured hiring requests, reconciled against budget and runway,
with role-based access and compensation confidentiality enforced on the server.

>  **Status: M3 complete (105 tests passing).** Directive 2.0 (philosophy-first)
> is underway. Built so far: auth/accounts/roles + audit (M1); guided CSV roster
> import with role-based compensation visibility (M2); a central **Philosophy hub**
> and the **seat** model with active-vs-approved headcount and a directly-editable
> target balance (M2.5); and full **department flexibility** — rename / merge / split
> / move people (M2.75); and seat-based **hiring requests** reconciled against top-down **budget envelopes**, with a soft/hard **budget-enforcement** philosophy setting (M3). See [`docs/ARCHITECTURE_PLAN.md`](docs/ARCHITECTURE_PLAN.md)
> §12–§13 and `../DIRECTIVE-2.0.md`.

## Roadmap

| Milestone | Scope | State |
|---|---|---|
| M0 | Scaffold (Docker, CI, migrations, config) | Done |
| M1 | Auth & accounts (scrypt, sessions, invites, RBAC, audit) | Done |
| M2 | Roster & guided import (engine, separated comp, comp-visibility) | Done |
| M2.5 | Central philosophy hub + seat model + active-vs-approved + editable target balance | Done |
| M2.75 | Department flexibility — rename / merge / split / move people | Done |
| M3 | Structured requests (revised) — a request opens/changes a seat; justification + value fields | Done |
| M4 | Roll-ups — ratios-vs-target panels + growth trends | Next |
| M4.5 | Benchmark seed — phase × industry research; phase-aware target suggestions | Planned |
| M5 | Planning engine — envelopes, runway/burn, scenarios, plan-vs-actual, exports | Planned |
| M6 | Org chart, audit-history UI, import-adapter framework | Planned |
| M10 | Collaborators (owner owns many departments), delegated single-pool budget, "Finance Manager" rename | Done (2.0 line) |

## First run

After deploying, open the app's URL. Because there are no users yet, it sends you
to **/setup** to create the **owner account** (the Finance Admin). From then on
that page is closed and everyone signs in at **/login**. The owner adds other
people from the **Accounts** page — either by setting a temporary password or by
generating an invite link they use to set their own password.

## What makes this easy to host

**Zero runtime dependencies.** The app uses only Node.js built-in modules
(`node:http`, `node:sqlite`, `node:crypto`). There is **no `npm install`, no build
step, and no native compilation** — a host only needs Node 22.5+ to run it.

## Deploy from GitHub (no local setup required)

1. **Push this folder to a GitHub repository.**
2. **Pick a host and connect the repo.** Any host that runs a Dockerfile works
   (Render, Railway, Fly.io, etc.). The included `Dockerfile` is all they need.
3. **Set one required environment variable:** `SESSION_SECRET` — a long random
   string. Some hosts can generate it for you (the included `render.yaml` does).
4. **Give it a persistent disk** mounted where `DATABASE_PATH` points
   (default `/data/headcount.sqlite`) so data survives redeploys.

### One-click path: Render

This repo includes `render.yaml`. In Render choose **New → Blueprint**, connect the
repo, and Render provisions the web service, generates `SESSION_SECRET`, and mounts
a persistent disk at `/data` automatically. (The persistent disk requires a paid
Render plan.)

### Generic path: any Docker host

The host builds the `Dockerfile` and runs it. Provide these environment variables:

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | **yes** | Long random string; signs session cookies |
| `DATABASE_PATH` | recommended | Point at a persistent volume, e.g. `/data/headcount.sqlite` |
| `COOKIE_SECURE` | recommended | `true` when served over HTTPS (it should be) |
| `PORT` | no | Defaults to 3000; many hosts set this for you |

A health check endpoint is available at `/health`.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the
full list with explanations. Generate a secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running the tests

If you ever want to run the suite (optional — not needed to deploy):

```
npm test
```

This uses Node's built-in test runner; no dependencies are installed.

## Project layout

```
src/
  config.js        # validated environment configuration (single source)
  app.js           # builds the HTTP server (security headers, static, routes)
  server.js        # boot: config -> db -> migrate -> listen
  router.js        # tiny explicit router
  html.js          # safe server-side HTML rendering (auto-escaping)
  routes.js        # thin HTTP handlers
  db/              # database open, migrations, runner
public/            # static assets (CSS)
tests/             # node:test unit + integration tests
docs/              # ARCHITECTURE_PLAN.md
```

## Security notes

Compensation is sensitive. Visibility will be enforced server-side in a single
authorization module (M1), so exact salaries are never serialized to a role that
may not see them. Passwords are hashed with scrypt. Never commit a real `.env`; set
`SESSION_SECRET` to a long random value in production and serve over HTTPS.

## A note on the storage engine

Persistence uses Node's built-in `node:sqlite`, which is currently marked
*experimental* (hence the `--experimental-sqlite` flag in the start command). It is
isolated behind `src/db/database.js` so it can be swapped without touching the rest
of the app if needed.
