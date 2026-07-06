import { html, raw } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canSetBudgets, canViewBudgets } from "../authz.js";
import {
  allReconciliation, getCompanyBudget,
  setCompanyHeadcount, setCompanyMoney, setEnvelopeHeadcount, setEnvelopeMoney,
} from "../repos/budgets.js";
import { expectedRange } from "../domain/budget.js";
import { listDepartments } from "../repos/departments.js";
import { getSettings } from "../repos/settings.js";
import { toCsv } from "../domain/csv.js";
import { financialModelPage } from "../views/model.js";
import { buildHeadcountModel } from "../domain/model.js";
import { listEmployees } from "../repos/roster.js";
import { clientFromConfig, parseScenarioHires } from "../domain/assistant.js";
import { logAudit } from "../repos/audit.js";

/** Money a department's headcount budget implies: current cost + midpoint of the
 *  expected cost of its still-unfilled budgeted positions. Idempotent. */
function impliedMoneyForDept(r) {
  const unfilled = Math.max(0, r.effHeadcount - r.currentEmployees);
  const range = expectedRange(unfilled, r.costBand);
  const mid = range ? Math.round((range.low + range.high) / 2) : 0;
  return Math.round((r.currentCost || 0) + mid);
}

export function registerBudgetRoutes(router) {
  // Live, in-app spreadsheet view of the financial model (read-only; admins + clients).
  const renderModel = (ctx, scenarioHires = [], extra = {}) => {
    const employees = listEmployees(ctx.db, {});
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const startYear = new Date().getFullYear();
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, startYear, months: 24, scenarioHires });
    ctx.html(200, financialModelPage(ctx, model, { scenarioHires, aiReady: Boolean(ctx.config.aiImportConfigured), ...extra }));
  };

  router.get("/model", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    renderModel(ctx, []);
  });

  // Manual what-if: one scenario hire group from the form.
  router.post("/model", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const b = ctx.body;
    const department = String(b.scn_department || "").trim();
    const hires = [];
    if (department && Number(b.scn_salary) > 0) {
      hires.push({
        department, role: String(b.scn_role || "Scenario hire").trim(),
        start_month: /^\d{4}-\d{2}$/.test(String(b.scn_start || "")) ? b.scn_start : null,
        annual_salary: Number(b.scn_salary) || 0, count: Math.max(1, Number(b.scn_count) || 1),
      });
    }
    renderModel(ctx, hires);
  });

  // AI what-if: parse a plain-English scenario into hires and model them.
  router.post("/model/ai-scenario", async (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const description = String(ctx.body.description || "").trim();
    if (!description) return renderModel(ctx, []);
    if (!ctx.config.aiImportConfigured) return renderModel(ctx, [], { aiError: "Configure a provider key to use AI scenarios." });
    try {
      const client = clientFromConfig(ctx.config);
      const departments = listDepartments(ctx.db).map((d) => d.name);
      const hires = await parseScenarioHires({ description, departments, client });
      if (!hires.length) return renderModel(ctx, [], { aiError: "Couldn't turn that into a hire — name a department, count, start month, and salary." });
      renderModel(ctx, hires, { aiNote: "AI modeled: " + hires.map((h) => `${h.count}× ${h.role} in ${h.department}`).join("; ") });
    } catch (e) {
      console.error(`[model] ai-scenario failed: ${e && e.message ? e.message : e}`);
      renderModel(ctx, [], { aiError: "The assistant couldn't model that just now — try again." });
    }
  });

  router.get("/budgets", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const mode = ctx.query.get("mode") === "money" ? "money" : "headcount";
    ctx.html(200, page(ctx, mode));
  });
  router.post("/budgets", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const mode = ctx.body.mode === "money" ? "money" : "headcount";
    const depts = listDepartments(ctx.db);
    if (mode === "money") {
      setCompanyMoney(ctx.db, ctx.body.company_money, ctx.user.id);
      for (const d of depts) if (ctx.body[`money_${d.id}`] !== undefined) setEnvelopeMoney(ctx.db, d.id, ctx.body[`money_${d.id}`], ctx.user.id);
    } else {
      setCompanyHeadcount(ctx.db, ctx.body.company_headcount, ctx.user.id);
      for (const d of depts) if (ctx.body[`hc_${d.id}`] !== undefined) setEnvelopeHeadcount(ctx.db, d.id, ctx.body[`hc_${d.id}`], ctx.user.id);
    }
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.updated", entity: "budget_envelope", detail: { mode } });
    ctx.redirect(`/budgets?mode=${mode}&msg=Saved`);
  });

  // Fill every department's money budget from what its headcount budget implies.
  router.post("/budgets/fill-from-headcount", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const { rows } = allReconciliation(ctx.db);
    let applied = 0;
    for (const r of rows) { setEnvelopeMoney(ctx.db, r.id, impliedMoneyForDept(r), ctx.user.id); applied++; }
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.filled_from_headcount", entity: "budget_envelope", detail: { departments: applied } });
    ctx.redirect(`/budgets?mode=money&msg=Money+budgets+set+from+the+headcount+budget`);
  });

  // Export the financial model as CSV — opens in Excel or Google Sheets (Directive 4.0 M25).
  router.get("/budgets/export.csv", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const { rows, company, currentEmployees } = allReconciliation(ctx.db);
    const cap = getCompanyBudget(ctx.db);
    const COLS = ["department", "current_employees", "approved_positions", "headcount_budget", "open_budgeted", "committed_cost", "money_budget"];
    const data = rows.map((r) => ({
      department: r.name,
      current_employees: r.currentEmployees,
      approved_positions: r.positions.approved,
      headcount_budget: r.effHeadcount,
      open_budgeted: Math.max(0, r.effHeadcount - r.currentEmployees),
      committed_cost: Math.round(r.money.committed || 0),
      money_budget: Math.round(r.effMoney || 0),
    }));
    data.push({
      department: "TOTAL (company)",
      current_employees: currentEmployees,
      approved_positions: company.positions.approved,
      headcount_budget: cap.headcount,
      open_budgeted: Math.max(0, (cap.headcount || 0) - currentEmployees),
      committed_cost: Math.round(company.money.committed || 0),
      money_budget: Math.round(cap.money || 0),
    });
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.exported", entity: "budget_envelope", detail: { rows: data.length } });
    ctx.attachment("financial-model.csv", "text/csv; charset=utf-8", toCsv(COLS, data));
  });
}

const bar = (used, budget, over) => {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  return raw(`<div class="ubar"><i class="${over ? "over" : pct >= 90 ? "warn" : "ok"}" style="width:${pct}%"></i></div>`);
};
function allocNote(a, kind) {
  if (!a.cap) return html`<span class="muted">set a company budget first</span>`;
  if (a.over > 0) return html`<span class="over-txt">over by ${kind === "money" ? money(a.over) : a.over}</span>`;
  return html`<span class="ok-txt">${kind === "money" ? money(a.remaining) : a.remaining} left</span>`;
}
function tabs(mode) {
  const tab = (m, label) => `<a class="wtab ${m === mode ? "on" : ""}" href="/budgets?mode=${m}">${label}</a>`;
  return raw(`<div class="wtabs">${tab("headcount", "Headcount budget")}${tab("money", "Money budget")}</div>`);
}
function expectedText(addHeads, band) {
  const r = expectedRange(addHeads, band);
  return r ? `+ expected ${moneyShort(r.low)}–${moneyShort(r.high)}` : "";
}

function page(ctx, mode) {
  const editable = canSetBudgets(ctx.user);
  const settings = getSettings(ctx.db);
  const cap = getCompanyBudget(ctx.db);
  const { rows, allocation, company, currentEmployees } = allReconciliation(ctx.db);
  const noDepts = rows.length === 0;

  const head = html`
    <div class="pagehead"><h1>Budgets</h1>
      <p class="muted">Top-down: set one company budget, then allocate it across departments — one number at a time. Current headcount and its cost already count toward what's allocated. Enforcement is <b>${settings.budget_enforcement}</b>.${editable ? raw(' (<a href="/philosophy">change</a>)') : ""}</p>
    </div>
    ${tabs(mode)}
    <p style="margin:8px 0 0"><a class="btn ghost sm" href="/budgets/export.csv">Export financial model (CSV)</a> <span class="muted small">Opens in Excel or Google Sheets.</span></p>`;

  let body;
  if (mode === "headcount") {
    const a = allocation.headcount;
    const deptRows = noDepts ? raw('<tr><td colspan="5" class="muted">No departments yet.</td></tr>')
      : rows.map((r) => {
          const band = r.costBand;
          const add = Math.max(0, r.effHeadcount - r.currentEmployees);
          return html`<tr>
            <td><b>${r.name}</b></td>
            <td class="right">${r.currentEmployees}</td>
            <td class="right">${r.positions.approved}${r.positions.pending ? html` <span class="muted">+${r.positions.pending}</span>` : ""}</td>
            <td>
              <input class="tcell" type="number" min="${r.currentEmployees}" step="1" name="hc_${r.id}" value="${r.effHeadcount}"
                     data-current="${r.currentEmployees}" data-band-low="${band?.low || 0}" data-band-high="${band?.high || 0}" data-expected-target="exp_${r.id}" ${editable ? "" : "readonly"}>
              <div class="exp ${add > 0 ? "on" : ""}" id="exp_${r.id}">${expectedText(add, band)}</div>
            </td>
            <td>${bar(r.positions.approved, r.effHeadcount, r.positions.over > 0)}</td>
          </tr>`;
        });
    body = html`${head}
      <form method="post" action="/budgets">
        ${csrfField(ctx)}<input type="hidden" name="mode" value="headcount">
        <section class="card">
          <h2>Company headcount budget</h2>
          <label>Total positions, company-wide<input type="number" min="0" step="1" name="company_headcount" value="${cap.headcount}" style="max-width:200px" ${editable ? "" : "readonly"}></label>
        </section>
        <div class="kpis">
          <div class="kpi"><div class="lbl">Current employees</div><div class="val">${currentEmployees}</div></div>
          <div class="kpi"><div class="lbl">Approved positions</div><div class="val">${company.positions.approved}</div></div>
          <div class="kpi"><div class="lbl">Allocated / cap</div><div class="val ${a.over ? "bad" : ""}">${a.allocated} / ${cap.headcount}</div><div class="lbl">${allocNote(a, "hc")}</div></div>
        </div>
        <section class="card">
          <h2>Allocate positions to departments</h2>
          <p class="muted small">Allocations start at each team's current headcount. Adding positions shows the expected money impact from that team's salary band.</p>
          <table class="table">
            <thead><tr><th>Department</th><th class="right">Current</th><th class="right">Approved</th><th>Allocated &amp; cost impact</th><th>Fill</th></tr></thead>
            <tbody>${deptRows}</tbody>
          </table>
          ${noDepts ? html`<p class="muted">Add departments first.</p>` : editable ? html`<button class="btn" type="submit" style="margin-top:12px">Save headcount budget</button>` : ""}
        </section>
      </form>
      <script src="/static/budgets.js" defer></script>`;
  } else {
    const a = allocation.money;
    const deptRows = noDepts ? raw('<tr><td colspan="4" class="muted">No departments yet.</td></tr>')
      : rows.map((r) => {
          const unfilled = Math.max(0, r.effHeadcount - r.currentEmployees);
          const implied = expectedRange(unfilled, r.costBand);
          return html`<tr>
            <td><b>${r.name}</b></td>
            <td class="right">${money(r.money.committed)}${r.money.pending ? html` <span class="muted">+${money(r.money.pending)}</span>` : ""}</td>
            <td>
              <input class="tcell wide" type="number" min="0" step="any" name="money_${r.id}" value="${r.effMoney}" ${editable ? "" : "readonly"}>
              ${implied ? html`<div class="exp on">headcount budget implies +${moneyShort(implied.low)}–${moneyShort(implied.high)}</div>` : ""}
            </td>
            <td>${bar(r.money.committed, r.effMoney, r.money.over > 0)}</td>
          </tr>`;
        });
    body = html`${head}
      ${noDepts || !editable ? "" : html`<form method="post" action="/budgets/fill-from-headcount" class="inline" style="margin:0 0 14px">
        ${csrfField(ctx)}<button class="btn ghost" type="submit">↳ Fill money budgets from the headcount budget</button>
        <span class="muted small" style="margin-left:8px">Sets each department's money budget to cover its budgeted positions (current cost + the implied cost of unfilled ones).</span>
      </form>`}
      <form method="post" action="/budgets">
        ${csrfField(ctx)}<input type="hidden" name="mode" value="money">
        <section class="card">
          <h2>Company money budget</h2>
          <label>Total annual, fully-loaded, company-wide<input type="number" min="0" step="any" name="company_money" value="${cap.money}" style="max-width:240px" ${editable ? "" : "readonly"}></label>
        </section>
        <div class="kpis">
          <div class="kpi"><div class="lbl">Committed spend</div><div class="val">${money(company.money.committed)}</div></div>
          <div class="kpi"><div class="lbl">Allocated / cap</div><div class="val ${a.over ? "bad" : ""}">${money(a.allocated)} / ${money(cap.money)}</div><div class="lbl">${allocNote(a, "money")}</div></div>
        </div>
        <section class="card">
          <h2>Allocate money to departments</h2>
          <p class="muted small">Allocations start at each team's current committed cost. The hint shows what the headcount budget implies for still-unfilled positions — or use the button above to fill them all at once.</p>
          <table class="table">
            <thead><tr><th>Department</th><th class="right">Committed</th><th>Allocated</th><th>Spend</th></tr></thead>
            <tbody>${deptRows}</tbody>
          </table>
          ${noDepts ? html`<p class="muted">Add departments first.</p>` : editable ? html`<button class="btn" type="submit" style="margin-top:12px">Save money budget</button>` : ""}
        </section>
      </form>`;
  }
  return renderPage(ctx, { title: "Budgets", body, active: "budgets" });
}
