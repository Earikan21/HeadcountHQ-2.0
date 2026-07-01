import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, errorList, money, moneyShort } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canRunScenarios } from "../authz.js";
import { getFinancials, setFinancials, createScenario, getScenario, listScenarios, deleteScenario, getItems, upsertItem, deptStates } from "../repos/planning.js";
import { projectScenario, PACES, PACE_LABELS, OUTCOMES } from "../domain/planning.js";
import { toCsv } from "../domain/csv.js";
import { listDepartments } from "../repos/departments.js";
import { logAudit } from "../repos/audit.js";

function buildProjection(db, scenarioId) {
  const financials = getFinancials(db);
  const states = deptStates(db);
  const itemsMap = getItems(db, scenarioId);
  const items = states.map((d) => {
    const it = itemsMap[d.id] || {};
    return {
      department_id: d.id,
      new_hires: it.new_hires || 0,
      start_month: it.start_month || 0,
      pace: it.pace || "even",
      cost_per_hire: (it.cost_per_hire != null ? it.cost_per_hire : d.defaultCostPerHire) || 0,
      outcome: it.outcome || "base",
    };
  });
  const proj = projectScenario({ financials, departments: states, items, horizon: financials.horizon_months });
  return { financials, states, itemsMap, proj };
}

export function registerPlanningRoutes(router) {
  router.get("/planning", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    ctx.html(200, indexPage(ctx));
  });

  router.post("/planning/financials", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    setFinancials(ctx.db, ctx.body, ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "financials.updated", entity: "financials" });
    ctx.redirect("/planning?msg=Saved");
  });

  router.post("/planning/scenarios", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    const name = String(ctx.body.name || "").trim();
    if (!name) return ctx.html(400, indexPage(ctx, ["Name the scenario."]));
    const sc = createScenario(ctx.db, { name, description: ctx.body.description || "", createdBy: ctx.user.id });
    logAudit(ctx.db, { userId: ctx.user.id, action: "scenario.created", entity: "scenario", entityId: sc.id });
    ctx.redirect(`/planning/scenarios/${sc.id}`);
  });

  router.get("/planning/scenarios/:id", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    const sc = getScenario(ctx.db, Number(ctx.params.id));
    if (!sc) return ctx.redirect("/planning");
    ctx.html(200, scenarioPage(ctx, sc));
  });

  router.post("/planning/scenarios/:id/items", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    const sc = getScenario(ctx.db, Number(ctx.params.id));
    if (!sc) return ctx.redirect("/planning");
    for (const d of listDepartments(ctx.db)) {
      const id = d.id;
      upsertItem(ctx.db, sc.id, id, {
        new_hires: ctx.body[`nh_${id}`], start_month: ctx.body[`sm_${id}`], pace: ctx.body[`pace_${id}`],
        cost_per_hire: ctx.body[`cph_${id}`] === "" ? null : ctx.body[`cph_${id}`],
        outcome: ctx.body[`out_${id}`],
      });
    }
    logAudit(ctx.db, { userId: ctx.user.id, action: "scenario.items", entity: "scenario", entityId: sc.id });
    ctx.redirect(`/planning/scenarios/${sc.id}?msg=Saved`);
  });

  router.post("/planning/scenarios/:id/delete", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    deleteScenario(ctx.db, Number(ctx.params.id));
    ctx.redirect("/planning?msg=Scenario+deleted");
  });

  router.get("/planning/scenarios/:id/export.csv", (ctx) => {
    if (!requirePermission(ctx, canRunScenarios)) return;
    const sc = getScenario(ctx.db, Number(ctx.params.id));
    if (!sc) return ctx.redirect("/planning");
    const { proj } = buildProjection(ctx.db, sc.id);
    const cols = ["month", "headcount", "headcount_cost", "revenue", "net_burn", "cash"];
    const rows = proj.months.map((m) => ({ month: m.month + 1, headcount: m.headcount, headcount_cost: m.headcountCost, revenue: m.revenue, net_burn: m.netBurn, cash: m.cash }));
    ctx.attachment(`scenario-${sc.id}.csv`, "text/csv; charset=utf-8", toCsv(cols, rows));
  });
}

// ============ views ============
function numField(name, label, value, attrs = "", hint = "") {
  return html`<label>${label} ${hint ? html`<span class="hint">${hint}</span>` : ""}<input type="number" name="${name}" value="${value}" ${raw(attrs)}></label>`;
}

function indexPage(ctx, errors) {
  const f = getFinancials(ctx.db);
  const scenarios = listScenarios(ctx.db).map((sc) => {
    const { proj } = buildProjection(ctx.db, sc.id);
    return { sc, s: proj.summary };
  });
  const scRows = scenarios.length ? scenarios.map(({ sc, s }) => html`<tr>
      <td><a href="/planning/scenarios/${sc.id}"><b>${sc.name}</b></a></td>
      <td class="right">${s.totalNewHires}</td>
      <td class="right">${money(s.addedAnnualCost)}</td>
      <td class="right">${s.runwayMonths == null ? raw(`<span class="ok-txt">> ${s.horizon}mo</span>`) : s.runwayMonths + " mo"}</td>
      <td class="right">${s.revenue.base ? money(s.revenue.base) : "—"}</td>
    </tr>`) : raw('<tr><td colspan="5" class="muted">No scenarios yet.</td></tr>');

  const body = html`
    <div class="pagehead"><h1>Planning</h1><p class="muted">Model hiring against cash and runway, with productivity sensitivity. Set the company-wide assumptions, then build scenarios.</p></div>
    ${errorList(errors)}
    <section class="card">
      <h2>Company-wide assumptions</h2>
      <form method="post" action="/planning/financials">
        ${csrfField(ctx)}
        <div class="formgrid">
          ${numField("cash_balance", "Cash balance", f.cash_balance, 'min="0" step="any"', "$")}
          ${numField("monthly_burn", "Monthly burn (non-people)", f.monthly_burn, 'min="0" step="any"', "$ / mo")}
          ${numField("monthly_revenue", "Monthly revenue", f.monthly_revenue, 'min="0" step="any"', "$ / mo")}
          ${numField("revenue_growth_pct", "Revenue growth", f.revenue_growth_pct, 'step="any"', "% / yr")}
          ${numField("comp_inflation_pct", "Comp inflation", f.comp_inflation_pct, 'step="any"', "% / yr")}
          ${numField("horizon_months", "Planning horizon", f.horizon_months, 'min="1" step="1"', "months")}
          ${numField("bookings_per_rep", "Bookings / ramped rep", f.bookings_per_rep, 'min="0" step="any"', "$ / yr")}
          ${numField("sales_ramp_months", "Sales ramp", f.sales_ramp_months, 'min="1" step="1"', "months")}
          ${numField("attainment_conservative_pct", "Attainment conservative", f.attainment_conservative_pct, 'min="0" step="any"', "%")}
          ${numField("attainment_base_pct", "Attainment base", f.attainment_base_pct, 'min="0" step="any"', "%")}
          ${numField("attainment_aggressive_pct", "Attainment aggressive", f.attainment_aggressive_pct, 'min="0" step="any"', "%")}
        </div>
        <button class="btn" type="submit">Save assumptions</button>
      </form>
    </section>
    <section class="card">
      <div class="row-between"><h2>Scenarios</h2></div>
      <table class="table"><thead><tr><th>Scenario</th><th class="right">New hires</th><th class="right">Added cost</th><th class="right">Runway</th><th class="right">Bookings (base)</th></tr></thead><tbody>${scRows}</tbody></table>
      <form method="post" action="/planning/scenarios" class="inline" style="margin-top:12px">
        ${csrfField(ctx)}
        <input name="name" placeholder="New scenario name" required style="max-width:240px;display:inline-block">
        <button class="btn" type="submit">Create scenario</button>
      </form>
    </section>`;
  return renderPage(ctx, { title: "Planning", body, active: "planning" });
}

function scenarioPage(ctx, sc) {
  const { financials, states, itemsMap, proj } = buildProjection(ctx.db, sc.id);
  const s = proj.summary;
  const currentHeads = states.reduce((a, d) => a + d.currentHeadcount, 0);

  const itemRows = states.length ? states.map((d) => {
    const it = itemsMap[d.id] || {};
    const sel = (v, cur) => v === (cur || (v === "even" || v === "base" ? cur || v : cur)) ? "" : "";
    return html`<tr>
      <td><b>${d.name}</b>${d.category === "sm" ? raw(' <span class="pill ok2">Sales</span>') : ""}<div class="sub">${d.currentHeadcount} now</div></td>
      <td><input class="tcell" type="number" min="0" step="1" name="nh_${d.id}" value="${it.new_hires || 0}"></td>
      <td><input class="tcell" type="number" min="0" step="1" name="sm_${d.id}" value="${it.start_month || 0}"></td>
      <td><select name="pace_${d.id}">${PACES.map((p) => html`<option value="${p}" ${(it.pace || "even") === p ? raw("selected") : ""}>${PACE_LABELS[p]}</option>`)}</select></td>
      <td><input class="tcell wide" type="number" min="0" step="any" name="cph_${d.id}" value="${it.cost_per_hire ?? ""}" placeholder="${d.defaultCostPerHire ?? ""}"></td>
      <td><select name="out_${d.id}">${OUTCOMES.map((o) => html`<option value="${o}" ${(it.outcome || "base") === o ? raw("selected") : ""}>${o}</option>`)}</select></td>
    </tr>`;
  }) : raw('<tr><td colspan="6" class="muted">Add departments first.</td></tr>');

  // condensed monthly view: every 3rd month
  const sampled = proj.months.filter((m) => m.month % 3 === 0 || m.month === proj.months.length - 1);
  const monthRows = sampled.map((m) => html`<tr>
      <td>M${m.month + 1}</td><td class="right">${m.headcount}</td><td class="right">${moneyShort(m.headcountCost)}</td>
      <td class="right">${moneyShort(m.netBurn)}</td><td class="right ${m.cash < 0 ? "over-txt" : ""}">${moneyShort(m.cash)}</td>
    </tr>`);

  const body = html`
    <div class="pagehead row-between">
      <div><a class="muted small" href="/planning">← Planning</a><h1>${sc.name}</h1></div>
      <div class="actions">
        <a class="btn ghost" href="/planning/scenarios/${sc.id}/export.csv">Export CSV</a>
        <form method="post" action="/planning/scenarios/${sc.id}/delete" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">Delete</button></form>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="lbl">Runway</div><div class="val ${s.runwayMonths != null && s.runwayMonths < 12 ? "bad" : ""}">${s.runwayMonths == null ? "> " + s.horizon + " mo" : s.runwayMonths + " mo"}</div></div>
      <div class="kpi"><div class="lbl">End headcount</div><div class="val">${s.endHeadcount}<span class="lbl"> from ${currentHeads}</span></div></div>
      <div class="kpi"><div class="lbl">Added annual cost</div><div class="val">${money(s.addedAnnualCost)}</div></div>
      <div class="kpi"><div class="lbl">Incremental bookings / yr</div><div class="val">${s.revenue.selected ? money(s.revenue.selected) : "—"}</div><div class="lbl">${s.revenue.hasSales ? "range " + moneyShort(s.revenue.conservative) + "–" + moneyShort(s.revenue.aggressive) : "add Sales hires"}</div></div>
    </div>
    <form method="post" action="/planning/scenarios/${sc.id}/items">
      ${csrfField(ctx)}
      <section class="card">
        <h2>Per-department plan</h2>
        <p class="muted small">Set a hiring schedule and a case per department. The tool derives revenue: Sales departments ramp new reps into bookings (case = quota attainment); other functions are cost centers. Cost/hire defaults to the team band.</p>
        <table class="table">
          <thead><tr><th>Department</th><th>New hires</th><th>Start month</th><th>Schedule</th><th>Cost / hire</th><th>Case</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
        ${states.length ? html`<button class="btn" type="submit" style="margin-top:12px">Save plan</button>` : ""}
      </section>
    </form>
    <div class="grid2">
      <section class="card">
        <h2>Projection</h2>
        <table class="table"><thead><tr><th>Month</th><th class="right">HC</th><th class="right">People cost</th><th class="right">Net burn</th><th class="right">Cash</th></tr></thead><tbody>${monthRows}</tbody></table>
      </section>
      <section class="card">
        <h2>Plan vs. actual</h2>
        <p>Headcount: <b>${currentHeads}</b> today → <b>${s.endHeadcount}</b> planned (<b>+${s.totalNewHires}</b> hires).</p>
        <p>Monthly net burn ends at <b>${money(s.endMonthlyNetBurn)}</b>; cash at horizon <b>${money(s.endCash)}</b>.</p>
        ${s.revenue.hasSales ? html`<p>Incremental bookings sensitivity: conservative <b>${money(s.revenue.conservative)}</b> · base <b>${money(s.revenue.base)}</b> · aggressive <b>${money(s.revenue.aggressive)}</b>.</p>` : html`<p class="muted small">Plan hires on a Sales &amp; Marketing department (set its function on Departments) to model revenue. Other functions are cost centers.</p>`}
      </section>
    </div>`;
  return renderPage(ctx, { title: sc.name, body, active: "planning" });
}
