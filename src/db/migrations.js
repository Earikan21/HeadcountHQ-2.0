import { backfillSeats } from "../repos/seats.js";
/**
 * Ordered list of schema migrations. Each has a unique, sortable `name` and an
 * `up(db)` that applies it. Never edit an already-applied migration — add a new
 * one.
 */

/** @typedef {{ name: string, up: (db: import("node:sqlite").DatabaseSync) => void }} Migration */

/** @type {Migration[]} */
export const MIGRATIONS = [
  {
    name: "2026_06_19_000_init",
    up(db) {
      db.exec(`
        CREATE TABLE workspaces (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare("INSERT INTO workspaces (name) VALUES (?)").run("Default Workspace");
    },
  },
  {
    name: "2026_06_19_001_auth",
    up(db) {
      db.exec(`
        CREATE TABLE departments (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id    INTEGER NOT NULL DEFAULT 1,
          name            TEXT NOT NULL,
          parent_id       INTEGER,
          manager_user_id INTEGER,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE users (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id          INTEGER NOT NULL DEFAULT 1,
          email                 TEXT NOT NULL UNIQUE,
          name                  TEXT NOT NULL,
          role                  TEXT NOT NULL CHECK (role IN ('finance_admin','c_suite','manager')),
          password_hash         TEXT,
          password_salt         TEXT,
          status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
          must_change_password  INTEGER NOT NULL DEFAULT 0,
          department_id         INTEGER REFERENCES departments(id),
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          last_login_at         TEXT
        );

        CREATE TABLE sessions (
          id         TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          ip         TEXT,
          user_agent TEXT
        );

        CREATE TABLE invites (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash    TEXT NOT NULL UNIQUE,
          email         TEXT NOT NULL,
          role          TEXT NOT NULL,
          department_id INTEGER,
          expires_at    TEXT NOT NULL,
          accepted_at   TEXT,
          created_by    INTEGER,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE audit_log (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          user_id      INTEGER,
          action       TEXT NOT NULL,
          entity       TEXT,
          entity_id    TEXT,
          detail       TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_audit_created ON audit_log(id DESC);
      `);
    },
  },
  {
    name: "2026_06_19_002_roster",
    up(db) {
      db.exec(`
        CREATE TABLE levels (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name         TEXT NOT NULL,
          rank         INTEGER,
          band_min     REAL,
          band_max     REAL
        );

        CREATE TABLE employees (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id      INTEGER NOT NULL DEFAULT 1,
          employee_ext_id   TEXT NOT NULL,
          name              TEXT NOT NULL,
          department_id     INTEGER REFERENCES departments(id),
          job_title         TEXT,
          manager           TEXT,
          employee_type     TEXT,
          employment_status TEXT,
          level_id          INTEGER REFERENCES levels(id),
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX idx_emp_ext ON employees(workspace_id, employee_ext_id);

        -- Sensitive compensation is split into its own table so the authz layer
        -- can withhold it cleanly from roles that may not see exact figures.
        CREATE TABLE compensation (
          employee_id   INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
          amount        REAL,
          unit          TEXT,
          annual_salary REAL
        );

        CREATE TABLE import_batches (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          filename     TEXT,
          status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','discarded')),
          headers      TEXT,
          raw_rows     TEXT,
          mapping      TEXT,
          assumptions  TEXT,
          row_count    INTEGER DEFAULT 0,
          clean_count  INTEGER DEFAULT 0,
          created_by   INTEGER,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          committed_at TEXT
        );
        CREATE INDEX idx_emp_dept ON employees(department_id);
      `);
    },
  },
  {
    name: "2026_06_19_003_import_header_row",
    up(db) {
      db.exec(`ALTER TABLE import_batches ADD COLUMN header_row INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_06_24_004_seats",
    up(db) {
      db.exec(`
        CREATE TABLE workspace_settings (
          workspace_id    INTEGER PRIMARY KEY DEFAULT 1,
          seat_mode       TEXT NOT NULL DEFAULT 'seat'   CHECK (seat_mode IN ('seat','person')),
          backfill_policy TEXT NOT NULL DEFAULT 'auto'   CHECK (backfill_policy IN ('auto','reapprove')),
          company_phase   TEXT NOT NULL DEFAULT 'early'  CHECK (company_phase IN ('early','growth','mid','scale')),
          industry        TEXT NOT NULL DEFAULT '',
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_by      INTEGER
        );
        INSERT INTO workspace_settings (workspace_id) VALUES (1);

        CREATE TABLE seats (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id         INTEGER NOT NULL DEFAULT 1,
          department_id        INTEGER REFERENCES departments(id),
          level_id             INTEGER REFERENCES levels(id),
          title                TEXT,
          status               TEXT NOT NULL DEFAULT 'proposed'
                                 CHECK (status IN ('proposed','approved','open','filled','frozen','closed')),
          occupant_employee_id INTEGER REFERENCES employees(id),
          loaded_cost_estimate REAL,
          source_request_id    INTEGER,
          opened_at            TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_seats_dept ON seats(department_id);
        CREATE INDEX idx_seats_status ON seats(status);

        ALTER TABLE employees ADD COLUMN seat_id INTEGER REFERENCES seats(id);
      `);
    },
  },
  {
    name: "2026_06_24_005_philosophy",
    up(db) {
      db.exec(`
        ALTER TABLE workspace_settings ADD COLUMN target_span_of_control  REAL    NOT NULL DEFAULT 6;
        ALTER TABLE workspace_settings ADD COLUMN max_layers              INTEGER NOT NULL DEFAULT 6;
        ALTER TABLE workspace_settings ADD COLUMN loaded_cost_multiplier  REAL    NOT NULL DEFAULT 1.3;
        ALTER TABLE workspace_settings ADD COLUMN annual_attrition_pct    REAL    NOT NULL DEFAULT 10;
        ALTER TABLE workspace_settings ADD COLUMN contractor_target_pct   REAL    NOT NULL DEFAULT 0;
        ALTER TABLE workspace_settings ADD COLUMN budgeting_approach      TEXT    NOT NULL DEFAULT 'incremental';
        ALTER TABLE workspace_settings ADD COLUMN require_csuite_approval INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE target_ratios (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          family       TEXT NOT NULL,        -- 'department_mix'
          key          TEXT NOT NULL,        -- department name
          target_pct   REAL NOT NULL,
          source       TEXT NOT NULL DEFAULT 'manual',  -- 'default' | 'manual'
          updated_by   INTEGER,
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (workspace_id, family, key)
        );
      `);
    },
  },
  {
    name: "2026_06_24_006_requests",
    up(db) {
      db.exec(`
        ALTER TABLE workspace_settings ADD COLUMN budget_enforcement TEXT NOT NULL DEFAULT 'soft'
          CHECK (budget_enforcement IN ('soft','hard'));

        CREATE TABLE budget_envelopes (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id     INTEGER NOT NULL DEFAULT 1,
          department_id    INTEGER REFERENCES departments(id),
          period           TEXT NOT NULL DEFAULT 'current',
          headcount_budget INTEGER NOT NULL DEFAULT 0,
          money_budget     REAL NOT NULL DEFAULT 0,
          set_by           INTEGER,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (workspace_id, department_id, period)
        );

        CREATE TABLE hiring_requests (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id          INTEGER NOT NULL DEFAULT 1,
          department_id         INTEGER REFERENCES departments(id),
          title                 TEXT NOT NULL,
          level_id              INTEGER REFERENCES levels(id),
          band_min              REAL,
          band_max              REAL,
          target_start_month    TEXT,
          type                  TEXT NOT NULL CHECK (type IN ('net_new','backfill')),
          justification         TEXT,
          current_hc_narrative  TEXT,
          new_hc_narrative      TEXT,
          expected_value_basis  TEXT,
          expected_value_amount REAL,
          estimated_cost        REAL,
          status                TEXT NOT NULL DEFAULT 'submitted'
                                 CHECK (status IN ('submitted','under_review','approved','deferred','declined')),
          requester_id          INTEGER,
          decided_by            INTEGER,
          decided_at            TEXT,
          decision_note         TEXT,
          seat_id               INTEGER REFERENCES seats(id),
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE request_status_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id  INTEGER NOT NULL REFERENCES hiring_requests(id) ON DELETE CASCADE,
          from_status TEXT,
          to_status   TEXT NOT NULL,
          actor_id    INTEGER,
          note        TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_req_dept ON hiring_requests(department_id);
        CREATE INDEX idx_req_status ON hiring_requests(status);
      `);
    },
  },
  {
    name: "2026_06_24_007_company_budget",
    up(db) {
      db.exec(`
        ALTER TABLE workspace_settings ADD COLUMN company_headcount_budget INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_settings ADD COLUMN company_money_budget     REAL    NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    name: "2026_06_24_008_backfill_seats",
    up(db) {
      // Existing rosters imported before the seat model get filled seats now,
      // so active/approved headcount reflects them everywhere.
      backfillSeats(db);
    },
  },
  {
    name: "2026_06_24_009_dept_category",
    up(db) {
      db.exec(`ALTER TABLE departments ADD COLUMN function_category TEXT;`);
    },
  },
  {
    name: "2026_06_24_010_employee_start_date",
    up(db) {
      db.exec(`ALTER TABLE employees ADD COLUMN start_date TEXT;`);
    },
  },
  {
    name: "2026_06_24_011_planning",
    up(db) {
      db.exec(`
        CREATE TABLE financials (
          workspace_id                  INTEGER PRIMARY KEY DEFAULT 1,
          cash_balance                  REAL NOT NULL DEFAULT 0,
          monthly_burn                  REAL NOT NULL DEFAULT 0,
          monthly_revenue               REAL NOT NULL DEFAULT 0,
          revenue_growth_pct            REAL NOT NULL DEFAULT 0,
          comp_inflation_pct            REAL NOT NULL DEFAULT 0,
          horizon_months                INTEGER NOT NULL DEFAULT 24,
          productivity_conservative_pct REAL NOT NULL DEFAULT 70,
          productivity_aggressive_pct   REAL NOT NULL DEFAULT 135,
          updated_by                    INTEGER,
          updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO financials (workspace_id) VALUES (1);

        CREATE TABLE scenarios (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name         TEXT NOT NULL,
          description  TEXT,
          created_by   INTEGER,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE scenario_items (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          scenario_id           INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
          department_id         INTEGER REFERENCES departments(id),
          new_hires             INTEGER NOT NULL DEFAULT 0,
          start_month           INTEGER NOT NULL DEFAULT 0,
          pace                  TEXT NOT NULL DEFAULT 'even',
          cost_per_hire         REAL,
          productivity_per_head REAL,
          outcome               TEXT NOT NULL DEFAULT 'base',
          UNIQUE (scenario_id, department_id)
        );
      `);
    },
  },
  {
    name: "2026_06_24_012_sales_capacity",
    up(db) {
      db.exec(`
        ALTER TABLE financials ADD COLUMN bookings_per_rep         REAL    NOT NULL DEFAULT 800000;
        ALTER TABLE financials ADD COLUMN sales_ramp_months        INTEGER NOT NULL DEFAULT 5;
        ALTER TABLE financials ADD COLUMN attainment_conservative_pct REAL NOT NULL DEFAULT 60;
        ALTER TABLE financials ADD COLUMN attainment_base_pct         REAL NOT NULL DEFAULT 70;
        ALTER TABLE financials ADD COLUMN attainment_aggressive_pct   REAL NOT NULL DEFAULT 80;
      `);
    },
  },
  {
    name: "2026_06_30_013_ai_import",
    up(db) {
      db.exec(`
        ALTER TABLE workspace_settings ADD COLUMN ai_import_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_settings ADD COLUMN ai_provider       TEXT    NOT NULL DEFAULT 'anthropic'
          CHECK (ai_provider IN ('anthropic','openai'));

        -- Audit trail for AI-assisted imports. Records THAT the AI was used and how
        -- much was accepted — never the payload that was analyzed.
        CREATE TABLE import_runs (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id     INTEGER NOT NULL DEFAULT 1,
          import_batch_id  INTEGER REFERENCES import_batches(id),
          user_id          INTEGER,
          phase            TEXT NOT NULL CHECK (phase IN ('mapping','cleanup')),
          used_ai          INTEGER NOT NULL DEFAULT 0,
          provider         TEXT,
          suggestion_count INTEGER NOT NULL DEFAULT 0,
          accepted_count   INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_import_runs_batch ON import_runs(import_batch_id);
      `);
    },
  },
  {
    name: "2026_07_01_014_ai_full_read",
    up(db) {
      // Opt-in mode: send the full file contents (incl. names/salaries) to the AI
      // to interpret messy / non-tabular layouts. OFF by default; separate from the
      // privacy-safe structure-only import.
      db.exec(`ALTER TABLE workspace_settings ADD COLUMN ai_full_read_enabled INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_07_01_015_ai_assistant",
    up(db) {
      // Opt-in headcount assistant (request justifications, cost/band estimates,
      // ask-your-data chat). OFF by default. Uses the same provider/key as import.
      db.exec(`ALTER TABLE workspace_settings ADD COLUMN ai_assistant_enabled INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_07_01_016_collaborators",
    up(db) {
      // Directive 3.0 (M10): collaborators own DEPARTMENTS (many-to-many), and the
      // company budget is handed down to each owner as a single delegated pool the
      // owner then splits across their departments.
      db.exec(`
        CREATE TABLE collaborator_departments (
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, department_id)
        );
        CREATE INDEX idx_collab_dept ON collaborator_departments(department_id);

        CREATE TABLE delegated_budgets (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id     INTEGER NOT NULL DEFAULT 1,
          user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          period           TEXT NOT NULL DEFAULT 'current',
          headcount_budget INTEGER NOT NULL DEFAULT 0,
          money_budget     REAL NOT NULL DEFAULT 0,
          set_by           INTEGER,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (workspace_id, user_id, period)
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO collaborator_departments (user_id, department_id)
          SELECT id, department_id FROM users WHERE department_id IS NOT NULL;
        INSERT OR IGNORE INTO collaborator_departments (user_id, department_id)
          SELECT manager_user_id, id FROM departments WHERE manager_user_id IS NOT NULL;
      `);
    },
  },
  {
    name: "2026_07_01_017_areas",
    up(db) {
      // Directive 3.0 (revised, 2026-07-01): a three-tier budget hierarchy.
      //   company budget -> AREA envelopes (set by the Finance Manager)
      //                   -> department envelopes (split by the area's manager).
      // An AREA groups several departments and has exactly ONE manager; a person
      // may manage several areas. This supersedes the M10 per-collaborator single
      // pool: ownership + delegation now bind to the AREA, not to the user. The
      // legacy collaborator_departments / delegated_budgets tables are left in
      // place (migrations are append-only) but are no longer read.
      db.exec(`
        CREATE TABLE areas (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id    INTEGER NOT NULL DEFAULT 1,
          name            TEXT NOT NULL,
          manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_areas_manager ON areas(manager_user_id);

        ALTER TABLE departments ADD COLUMN area_id INTEGER REFERENCES areas(id);
        CREATE INDEX idx_dept_area ON departments(area_id);

        CREATE TABLE area_budgets (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id     INTEGER NOT NULL DEFAULT 1,
          area_id          INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
          period           TEXT NOT NULL DEFAULT 'current',
          headcount_budget INTEGER NOT NULL DEFAULT 0,
          money_budget     REAL NOT NULL DEFAULT 0,
          set_by           INTEGER,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (workspace_id, area_id, period)
        );

        -- Whether an area manager's approval is FINAL (1) or the Finance Manager
        -- must co-approve (0 = dual approval). Default: Finance co-approves.
        ALTER TABLE workspace_settings ADD COLUMN area_manager_final INTEGER NOT NULL DEFAULT 0;
      `);

      // Backfill: carry any M10 collaborator ownership forward into areas so no
      // data is lost. For each user that owned >=1 department, create an area they
      // manage, move those departments under it, and copy their delegated pool to
      // the area budget. (Fresh installs have nothing to migrate.)
      const owners = db.prepare(
        `SELECT DISTINCT cd.user_id AS uid, u.name AS uname
           FROM collaborator_departments cd JOIN users u ON u.id = cd.user_id`
      ).all();
      const insArea = db.prepare("INSERT INTO areas (name, manager_user_id) VALUES (?, ?)");
      const setDeptArea = db.prepare("UPDATE departments SET area_id = ? WHERE id = ?");
      const getPool = db.prepare("SELECT headcount_budget, money_budget FROM delegated_budgets WHERE user_id = ? AND period='current'");
      const insBudget = db.prepare("INSERT INTO area_budgets (area_id, period, headcount_budget, money_budget) VALUES (?, 'current', ?, ?)");
      for (const o of owners) {
        const areaId = insArea.run(`${o.uname}'s area`, o.uid).lastInsertRowid;
        for (const d of db.prepare("SELECT department_id FROM collaborator_departments WHERE user_id = ?").all(o.uid)) {
          setDeptArea.run(areaId, d.department_id);
        }
        const pool = getPool.get(o.uid);
        if (pool) insBudget.run(areaId, pool.headcount_budget || 0, pool.money_budget || 0);
      }
    },
  },
  {
    name: "2026_07_02_018_client_flag",
    up(db) {
      // Directive 4.0 (M21): mark a user as an external CLIENT of the firm. Stored
      // as a flag on a c_suite-level account: the client sees their (single-instance)
      // company data and can edit budgets, but backend/admin surfaces (settings,
      // accounts, audit, import, departments) stay finance_admin-only and the AI
      // assistant is hidden, giving a clean view. Additive column — no table rebuild.
      db.exec(`ALTER TABLE users ADD COLUMN is_client INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_07_02_019_client_full_view",
    up(db) {
      // Directive 4.0 (M21 revision): per-client "full view" flag. When set, the
      // client sees exact compensation (not just bands); otherwise bands. Additive.
      db.exec(`ALTER TABLE users ADD COLUMN client_full INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_07_02_020_ai_on_by_default",
    up(db) {
      // Directive 4.0: AI assist fully enabled by default on first login.
      db.exec(`UPDATE workspace_settings SET ai_import_enabled = 1, ai_assistant_enabled = 1 WHERE workspace_id = 1;`);
    },
  },
  {
    name: "2026_07_02_021_plan_versions",
    up(db) {
      // Directive 4.0 (item 11): named plan versions ("base case", "board plan", ...).
      // Each stores a set of planned (scenario) hires as JSON, layered on the live roster.
      db.exec(`
        CREATE TABLE plan_versions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL DEFAULT 1,
          name         TEXT NOT NULL,
          hires_json   TEXT NOT NULL DEFAULT '[]',
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    name: "2026_07_02_022_plan_assumptions",
    up(db) {
      // Directive 4.0: per-plan assumptions/drivers (YoY salary growth, benefits load, ...).
      db.exec(`ALTER TABLE plan_versions ADD COLUMN assumptions_json TEXT NOT NULL DEFAULT '{}';`);
    },
  },
  {
    name: "2026_07_07_023_employee_end_date",
    up(db) {
      // Removing headcount: after this date a person stops contributing cost to the
      // model. NULL means "still here". Paired with scenario hires' end_month, which
      // lets a plan add headcount for a limited time.
      db.exec(`ALTER TABLE employees ADD COLUMN end_date TEXT;`);
    },
  },
  {
    name: "2026_07_07_024_ai_full_read_on_by_default",
    up(db) {
      // Directive 4.0: full-read AI import is on out of the box, like the rest of AI assist.
      db.exec(`UPDATE workspace_settings SET ai_full_read_enabled = 1 WHERE workspace_id = 1;`);
    },
  },
  {
    name: "2026_07_08_025_plan_overrides",
    up(db) {
      // An editable plan sheet must never rewrite the roster, or "base case" and
      // "board plan" would fight over the same employee rows and Actual would become
      // fiction. A plan instead stores SPARSE overrides keyed by employee_ext_id:
      //   {"E-1": {"annual_salary": 140000}}
      // Only the fields you actually changed are stored, so a later roster import
      // still flows through for everything you didn't touch, and "reset this row"
      // means exactly "delete this key".
      db.exec(`ALTER TABLE plan_versions ADD COLUMN overrides_json TEXT NOT NULL DEFAULT '{}';`);
    },
  },
  {
    name: "2026_07_08_026_scenario_hire_identity",
    up(db) {
      // Scenario hires used to carry `count: 3` and were expanded into three
      // indistinguishable rows at render time — you couldn't name or edit "the second
      // AE" because it didn't exist as a record. Explode them into one record per
      // person, each with a stable id. Idempotent: already-exploded hires (id set,
      // no count) pass through unchanged.
      const rows = db.prepare("SELECT id, hires_json FROM plan_versions").all();
      const upd = db.prepare("UPDATE plan_versions SET hires_json = ? WHERE id = ?");
      for (const r of rows) {
        let hires;
        try { hires = JSON.parse(r.hires_json); } catch { hires = []; }
        if (!Array.isArray(hires)) hires = [];
        const out = [];
        let n = 0;
        for (const h of hires) {
          const count = Math.max(1, Math.min(200, Number(h.count) || 1));
          const role = h.role || "Hire";
          for (let i = 0; i < count; i++) {
            n++;
            out.push({
              id: h.id && count === 1 ? String(h.id) : "h" + n,
              department: h.department || "(scenario)",
              role,
              name: h.name || (count > 1 ? `${role} ${i + 1}` : role),
              start_month: h.start_month || null,
              end_month: h.end_month || null,
              annual_salary: Number(h.annual_salary) || 0,
            });
          }
        }
        upd.run(JSON.stringify(out), r.id);
      }
    },
  },
  {
    name: "2026_07_08_027_two_factor_auth",
    up(db) {
      // Two-factor auth (TOTP). The secret is base32; recovery codes are stored as
      // SHA-256 hashes (a leaked DB reveals no usable code). `mfa_pending` marks a
      // session that has passed the password but not yet the second factor.
      db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT;`);
      db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;`);
      db.exec(`ALTER TABLE users ADD COLUMN totp_recovery_json TEXT NOT NULL DEFAULT '[]';`);
      db.exec(`ALTER TABLE sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    name: "2026_07_09_028_excel_connection",
    up(db) {
      // One-way live link to a Microsoft 365 workbook. One connection per workspace.
      // The refresh token is stored ENCRYPTED (see auth/secretbox.js); never plaintext.
      db.exec(`
        CREATE TABLE excel_connections (
          workspace_id      INTEGER PRIMARY KEY DEFAULT 1,
          account_email     TEXT,
          refresh_token_enc TEXT,
          drive_id          TEXT,
          item_id           TEXT,
          workbook_name     TEXT,
          worksheet         TEXT NOT NULL DEFAULT 'HeadcountModel',
          status            TEXT NOT NULL DEFAULT 'connected',
          last_pushed_at    TEXT,
          last_error        TEXT,
          created_by        INTEGER,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    name: "2026_07_09_029_power_query_export",
    up(db) {
      // Switched from a Graph push to a Power Query PULL: Excel refreshes from a
      // token-authed export URL. The old excel_connections table is LEFT in place so the
      // Graph-push path (routes/excel_graph.js, dormant) can be re-enabled if wanted.
      db.exec(`
        CREATE TABLE export_tokens (
          workspace_id INTEGER PRIMARY KEY DEFAULT 1,
          token        TEXT NOT NULL,
          created_by   INTEGER,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );
      `);
    },
  },
  {
    name: "2026_07_14_030_focus_department",
    up(db) {
      // A workspace-wide "focus" lens: when set to a department name, the whole tool
      // shows only that department (dashboard, roster, every model/plan, compare,
      // budgets, and the Excel export). Empty string = All departments (default).
      // This is a presentation filter, not a security boundary.
      db.exec(`ALTER TABLE workspace_settings ADD COLUMN focus_department TEXT NOT NULL DEFAULT '';`);
    },
  },
  {
    name: "2026_07_16_031_google_sheets_connection",
    up(db) {
      // One-way live link to a Google Sheet (values + formatting) via the Sheets API.
      // Delegated OAuth; the refresh token is stored ENCRYPTED (auth/secretbox.js).
      db.exec(`
        CREATE TABLE google_connections (
          workspace_id      INTEGER PRIMARY KEY DEFAULT 1,
          account_email     TEXT,
          refresh_token_enc TEXT,
          spreadsheet_id    TEXT,
          spreadsheet_name  TEXT,
          sheet_title       TEXT NOT NULL DEFAULT 'Headcount',
          status            TEXT NOT NULL DEFAULT 'connected',
          last_pushed_at    TEXT,
          last_error        TEXT,
          created_by        INTEGER,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
];
