import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, money } from "../views/ui.js";
import { requirePermission, requireFeature } from "../middleware.js";
import { featureEnabled } from "../features.js";
import { canManageSettings } from "../authz.js";
import { getSettings, updateSettings, setFocusDepartment } from "../repos/settings.js";
import { getDepartmentTargets, saveDepartmentTargets } from "../repos/targets.js";
import { listDepartments } from "../repos/departments.js";
import { headcountRollup } from "../repos/seats.js";
import * as P from "../domain/philosophy.js";
import { INDUSTRIES } from "../data/benchmarks.js";
import { logAudit } from "../repos/audit.js";

const PHASE_LABELS = {
  early: "Early — pre-PMF, small team", growth: "Growth — scaling go-to-market",
  mid: "Mid — multiple departments", scale: "Scale — large, optimizing",
};

const PROVIDER_LABELS = {
  anthropic: "Anthropic (Claude)", openai: "OpenAI", gemini: "Google Gemini", groq: "Groq",
};

export function registerPhilosophyRoutes(router) {
  router.get("/settings", (ctx) => ctx.redirect("/philosophy"));

  router.get("/philosophy", (ctx) => {
    if (!requirePermission(ctx, canManageSettings)) return;
    ctx.html(200, page(ctx));
  });

  // Core parameters
  router.post("/philosophy", (ctx) => {
    if (!requirePermission(ctx, canManageSettings)) return;
    // Some philosophy controls are hidden in the service-tool build — preserve their
    // stored values so a save through the trimmed form does not reset them.
    const cur = getSettings(ctx.db);
    const preserved = { seat_mode: cur.seat_mode, backfill_policy: cur.backfill_policy, require_csuite_approval: cur.require_csuite_approval, target_span_of_control: cur.target_span_of_control, max_layers: cur.max_layers, company_phase: cur.company_phase, industry: cur.industry };
    updateSettings(ctx.db, { ...preserved, ...ctx.body }, ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "philosophy.updated", entity: "workspace_settings", entityId: 1 });
    ctx.redirect("/philosophy?msg=Philosophy+saved");
  });

  // Workspace-wide department focus lens. Set it to one department to make the whole
  // tool show only that department (e.g. on a client call with a department head), or
  // clear it back to All. Saved on its own so it never collides with the main form.
  router.post("/philosophy/focus", (ctx) => {
    if (!requirePermission(ctx, canManageSettings)) return;
    const name = String(ctx.body.focus_department || "").trim();
    // Only accept a real department name (or "" for All); ignore anything else.
    const valid = name === "" || listDepartments(ctx.db).some((d) => d.name === name);
    setFocusDepartment(ctx.db, valid ? name : "", ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "philosophy.focus_set", entity: "workspace_settings", entityId: 1, detail: { focus: valid ? name : "" } });
    ctx.redirect(`/philosophy?msg=${name ? "Focused+on+" + encodeURIComponent(name) : "Showing+all+departments"}`);
  });

  // Apply phase suggestions to the scalar params (benchmark-derived — flagged)
  router.post("/philosophy/apply-phase", (ctx) => {
    if (!requireFeature(ctx, "benchmarks")) return;
    if (!requirePermission(ctx, canManageSettings)) return;
    const s = getSettings(ctx.db);
    const sug = P.phaseSuggestions(s.company_phase);
    updateSettings(ctx.db, { ...s, ...sug }, ctx.user.id);
    ctx.redirect("/philosophy?msg=Applied+phase+suggestions");
  });

  // Department target balance — direct manual edit
  router.post("/philosophy/targets", (ctx) => {
    if (!requirePermission(ctx, canManageSettings)) return;
    const targets = {};
    for (const [k, v] of Object.entries(ctx.body)) {
      if (k.startsWith("target_") && k !== "target_span_of_control") {
        targets[decodeURIComponent(k.slice("target_".length))] = v;
      }
    }
    saveDepartmentTargets(ctx.db, targets, "manual", ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "targets.updated", entity: "target_ratios", detail: { keys: Object.keys(targets) } });
    ctx.redirect("/philosophy?msg=Target+balance+saved");
  });

  // Seed a suggested starting balance from the function benchmarks (flagged)
  router.post("/philosophy/targets/suggest", (ctx) => {
    if (!requireFeature(ctx, "benchmarks")) return;
    if (!requirePermission(ctx, canManageSettings)) return;
    const s = getSettings(ctx.db);
    const depts = listDepartments(ctx.db).map((d) => ({ name: d.name, category: d.function_category }));
    const sug = P.suggestDepartmentTargets(depts, s.company_phase, s.industry);
    saveDepartmentTargets(ctx.db, sug, "default", ctx.user.id);
    ctx.redirect("/philosophy?msg=Suggested+balance+applied+-+now+edit+freely");
  });
}

function num(name, label, value, attrs = "", hint = "") {
  return html`<label>${label} ${hint ? html`<span class="hint">${hint}</span>` : ""}
    <input type="number" name="${name}" value="${value}" ${raw(attrs)}></label>`;
}
function radio(name, value, current, label) {
  return html`<label class="radio"><input type="radio" name="${name}" value="${value}" ${String(current) === value ? raw("checked") : ""}> ${raw(label)}</label>`;
}

function page(ctx) {
  const s = getSettings(ctx.db);
  const depts = listDepartments(ctx.db);
  const targets = getDepartmentTargets(ctx.db);

  // actual department distribution from filled seats
  const roll = headcountRollup(ctx.db);
  const actualByDept = {};
  for (const d of roll.departments) actualByDept[d.department] = d.active;
  const targetByDept = {};
  for (const [k, v] of Object.entries(targets)) targetByDept[k] = v.target_pct;
  const mix = P.mixVsTarget(actualByDept, targetByDept);
  const targetSum = Object.values(targetByDept).reduce((a, b) => a + b, 0);

  const targetRows = depts.length ? depts.map((d) => {
    const row = mix.find((m) => m.name === d.name) || { actualPct: 0, variance: null };
    const tv = targets[d.name]?.target_pct ?? "";
    return html`<tr>
      <td><b>${d.name}</b></td>
      <td class="right muted">${row.actualPct}%</td>
      <td class="right"><input class="tcell" type="number" step="0.1" min="0" max="100" name="target_${encodeURIComponent(d.name)}" value="${tv}"></td>
      <td class="right">${row.variance == null ? "—" : varianceBadge(row.variance)}</td>
    </tr>`;
  }) : raw('<tr><td colspan="4" class="muted">Add departments (via the roster import) to set a target balance.</td></tr>');

  const providerLabel = PROVIDER_LABELS[ctx.config.AI_IMPORT_PROVIDER] || ctx.config.AI_IMPORT_PROVIDER;
  const showBench = featureEnabled(ctx.config, "benchmarks");

  const body = html`
    <div class="pagehead">
      <h1>Headcount philosophy</h1>
      <p class="muted">The rules of the game — set these <b>before</b> modeling. Everything downstream
      (seats, requests, dashboards) read from here. Phase &amp; industry only suggest
      starting points; you have direct control over every value.</p>
    </div>

    <form method="post" action="/philosophy/focus" class="focus-form">
      ${csrfField(ctx)}
      <section class="card ${s.focus_department ? "focus-on" : ""}">
        <h2>Department focus <span class="hint">show one department across the whole tool</span></h2>
        <p class="muted small">Lock the entire tool — dashboard, roster, every model and plan, compare, and the Excel export — to a single department. Handy on a call with one department's head. It's a display filter for everyone, not a security setting; switch back to <b>All departments</b> anytime.</p>
        <div class="focus-row">
          <label>Focus on
            <select name="focus_department" aria-label="Department focus">
              ${raw(`<option value="" ${s.focus_department ? "" : "selected"}>All departments</option>`)}
              ${depts.map((d) => raw(`<option value="${esc(d.name)}" ${s.focus_department === d.name ? "selected" : ""}>${esc(d.name)}</option>`))}
            </select>
          </label>
          <button class="btn" type="submit">Apply focus</button>
          ${s.focus_department ? html`<span class="focus-note">Currently showing <b>${s.focus_department}</b> only.</span>` : ""}
        </div>
      </section>
    </form>

    <form method="post" action="/philosophy">
      ${csrfField(ctx)}
      <section class="card">
        <h2>Budget enforcement</h2>
        <p class="muted small" style="margin:0 0 4px">When a hiring plan would exceed a department's budget:</p>
        <fieldset class="radios">
          ${radio("budget_enforcement", "soft", s.budget_enforcement, "<b>Soft</b> — allow it, but flag the gap for the approver.")}
          ${radio("budget_enforcement", "hard", s.budget_enforcement, "<b>Hard</b> — block plans that push a department over budget; raise the cap first.")}
        </fieldset>
      </section>

      <section class="card">
        <h2>Cost &amp; planning assumptions</h2>
        <p class="muted small">Fully-loaded cost is typically 1.25–1.4× base (higher for execs). Attrition drives backfills before any growth.</p>
        <div class="formgrid">
          ${num("loaded_cost_multiplier", "Fully-loaded cost multiplier", s.loaded_cost_multiplier, 'min="1" max="3" step="0.01"', "× base salary")}
          ${num("annual_attrition_pct", "Assumed annual attrition", s.annual_attrition_pct, 'min="0" max="100" step="0.5"', "% / year")}
          ${num("contractor_target_pct", "Target contractor mix", s.contractor_target_pct, 'min="0" max="100" step="1"', "% contingent")}
        </div>
        <fieldset class="radios" style="margin-top:10px">
          ${radio("budgeting_approach", "incremental", s.budgeting_approach, "<b>Incremental</b> — build on last cycle's plan.")}
          ${radio("budgeting_approach", "zero_based", s.budgeting_approach, "<b>Zero-based</b> — re-justify every seat each cycle.")}
        </fieldset>
      </section>

      ${showBench ? html`<section class="card">
        <h2>Company phase &amp; industry</h2>
        <div class="formgrid">
          <label>Company phase
            <select name="company_phase">
              ${P.PHASES.map((v) => html`<option value="${v}" ${s.company_phase === v ? raw("selected") : ""}>${PHASE_LABELS[v]}</option>`)}
            </select>
          </label>
          <label>Industry <span class="hint">tilts the suggested balance toward your sector</span>
            <select name="industry">
              ${INDUSTRIES.map(([k, lbl]) => html`<option value="${k}" ${s.industry === k ? raw("selected") : ""}>${lbl}</option>`)}
            </select>
          </label>
        </div>
      </section>` : ""}

      <section class="card">
        <h2>AI features <span class="hint">optional</span></h2>
        <p class="small" style="margin:0 0 10px">Provider: <b>${providerLabel}</b> · Key on this server:
          ${ctx.config.aiImportConfigured
            ? raw('<b class="ok">configured</b>')
            : raw('<b class="off">not configured</b> — set <code>AI_IMPORT_API_KEY</code> in the environment to enable')}.</p>

        <p class="muted small"><b>Assisted import.</b> Suggests column mappings, standardizes job titles, and categorizes
        departments. Sends <b>only</b> column headers, department names, and job titles — never salaries, names, or any row.</p>
        <label class="radio"><input type="checkbox" name="ai_import_enabled" ${s.ai_import_enabled ? raw("checked") : ""} ${ctx.config.aiImportConfigured ? "" : raw("disabled")}> Enable AI assistance during import</label>

        <p class="muted small" style="margin-top:14px"><b>Headcount assistant.</b> Drafts hiring-request justifications, estimates a
        role's cost &amp; salary band, and answers questions about your plan with recommendations. Sends the relevant role /
        <b>aggregate</b> plan context (never individual salaries or names).</p>
        <p class="muted small">${ctx.config.aiImportConfigured ? raw('The assistant is <b class="ok">on</b> automatically — a provider key is configured. Available to admins and clients.') : raw('The assistant turns <b class="off">on automatically</b> once a provider key is set on the server.')}</p>

        <div class="warnbox" style="margin-top:14px">
          <p class="small" style="margin:0 0 8px"><b>Advanced — AI full read.</b> For messy or non-tabular import files, this lets the AI read the
          <b>entire file, including names and salaries</b>, to reconstruct a clean table. Unlike the options above, this
          <b>sends sensitive employee data to your provider</b>. Leave off unless you need it.</p>
          <label class="radio"><input type="checkbox" name="ai_full_read_enabled" ${s.ai_full_read_enabled ? raw("checked") : ""} ${ctx.config.aiImportConfigured ? "" : raw("disabled")}> Enable "AI full read" for messy files (sends full contents)</label>
        </div>
        <p class="muted small" style="margin-top:8px">Provider, model, and key are configured on the server (environment
        variables), not here. Google Gemini has a free tier — set <code>AI_IMPORT_PROVIDER=gemini</code> with a
        free key from Google AI Studio.</p>
      </section>

      <button class="btn" type="submit">Save philosophy</button>
    </form>

    ${showBench ? html`<form method="post" action="/philosophy/apply-phase" class="inline" style="margin-left:8px">
      ${csrfField(ctx)}<button class="btn ghost" type="submit">Apply ${s.company_phase}-phase suggestions to org shape &amp; cost</button>
    </form>` : ""}

    <section class="card" style="margin-top:18px">
      <div class="row-between">
        <div><h2>Target balance (you control this directly)</h2>
          <p class="muted small">Each department's intended share of headcount. Edit any value directly.${showBench ? raw(' &ldquo;Suggest a starting balance&rdquo; seeds research-based defaults for your <b>phase &amp; industry</b> that you can then override.') : ""} Targets sum: <b>${Math.round(targetSum * 10) / 10}%</b>.</p>
        </div>
        ${showBench && depts.length ? html`<form method="post" action="/philosophy/targets/suggest" class="inline">
          ${csrfField(ctx)}<button class="btn ghost sm" type="submit">Suggest a starting balance</button>
        </form>` : ""}
      </div>
      <form method="post" action="/philosophy/targets">
        ${csrfField(ctx)}
        <table class="table">
          <thead><tr><th>Department</th><th class="right">Actual</th><th class="right">Target %</th><th class="right">Variance</th></tr></thead>
          <tbody>${targetRows}</tbody>
        </table>
        ${depts.length ? html`<button class="btn" type="submit" style="margin-top:12px">Save target balance</button>` : ""}
      </form>
    </section>`;
  return renderPage(ctx, { title: "Philosophy", body, active: "philosophy" });
}

function varianceBadge(v) {
  if (Math.abs(v) < 2) return html`<span class="pill ok2">on target</span>`;
  return v > 0
    ? html`<span class="pill warn2">+${v}% over</span>`
    : html`<span class="pill off">${v}% under</span>`;
}
