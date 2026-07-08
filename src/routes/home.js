import { html, raw } from "../html.js";
import { renderPage, money } from "../views/ui.js";
import { canViewCompTotals, departmentScope, canSeeAllDepartments, canManageSettings, displayRole, canImportRoster } from "../authz.js";
import { countUsers } from "../repos/users.js";
import { listDepartments } from "../repos/departments.js";
import { headcountRollup, recentSeatAdds } from "../repos/seats.js";
import { getCompanyBudget } from "../repos/budgets.js";
import { welcomePage } from "../views/welcome.js";
import { listRequests } from "../repos/requests.js";
import { OPEN_STATUSES } from "../domain/requests.js";
import { listEmployees } from "../repos/roster.js";
import { getSettings } from "../repos/settings.js";
import { getFinancials } from "../repos/planning.js";
import { computeMetrics } from "../domain/metrics.js";
import { buildHeadcountModel } from "../domain/model.js";
import { listPlans, planHires } from "../repos/plans.js";
import { overviewDashboard } from "../views/overview.js";

export function registerHomeRoutes(router) {
  router.get("/", (ctx) => {
    if (!ctx.user) return ctx.redirect(countUsers(ctx.db) === 0 ? "/setup" : "/login");
    // First-run welcome (Directive 4.0): replace the empty "zeros" dashboard with a
    // guided setup until the admin has imported a roster. Dismissable with ?home=1.
    if (canImportRoster(ctx.user) && ctx.query.get("home") !== "1") {
      const rosterDone = ctx.db.prepare("SELECT COUNT(*) AS n FROM seats").get().n > 0;
      if (!rosterDone) {
        const cap = getCompanyBudget(ctx.db);
        const budgetDone = (cap.headcount || 0) > 0 || (cap.money || 0) > 0;
        return ctx.html(200, welcomePage(ctx, { rosterDone }));
      }
    }
    // Company-wide viewers (AZ Finance + clients) get the reimagined overview.
    if (canSeeAllDepartments(ctx.user)) {
      return ctx.html(200, renderPage(ctx, { title: "Overview", body: buildOverview(ctx), active: "dashboard" }));
    }
    const scope = departmentScope(ctx.user);
    const roll = headcountRollup(ctx.db, { departmentId: scope });
    const t = roll.totals;
    const showCost = canViewCompTotals(ctx.user);
    const openReq = listRequests(ctx.db, { departmentId: scope }).filter((r) => OPEN_STATUSES.includes(r.status));

    const kpis = [
      kpi("Active headcount", t.active),
      kpi("Approved positions", t.approved),
      kpi("Open seats", t.open, t.open ? "warn" : ""),
    ];
    if (showCost) {
      kpis.push(kpi("Pending requests", openReq.length, openReq.length ? "warn" : ""));
    } else {
      kpis.push(kpi("My open requests", openReq.length, openReq.length ? "warn" : ""));
    }

    const body = html`
      <div class="pagehead">
        <h1>${greeting(ctx.user)}</h1>
        <p class="muted">${displayRole(ctx.user)} · ${roleNote(ctx.user.role)}</p>
      </div>
      <div class="kpis">${kpis}</div>
      ${managerPanels(ctx, scope, roll, openReq)}
    `;
    return ctx.html(200, renderPage(ctx, { title: "Dashboard", body, active: "dashboard" }));
  });
}

function buildOverview(ctx) {
  const employees = listEmployees(ctx.db, {});
  const settings = getSettings(ctx.db);
  const mult = Number(settings.loaded_cost_multiplier) || 1.2;
  const rollup = headcountRollup(ctx.db);
  const fin = getFinancials(ctx.db);
  const now = new Date();
  const metrics = computeMetrics({ employees, settings, rollup, financials: fin, now });
  const model = buildHeadcountModel({ employees, loadedMultiplier: mult, now });
  const nowYear = now.getFullYear();
  const mm = metrics.model || {};

  const trendYears = model.years.map((y) => ({ year: y.year, headcount: y.yearEndHc, cost: y.totalCost }));
  const growth90 = recentSeatAdds(ctx.db, 90).total;
  const thisYear = (mm.costByYear || []).find((y) => y.year === nowYear);
  const avgLoadedMo = metrics.company.avgBase ? Math.round((metrics.company.avgBase * mult) / 12) : 0;
  const runway = metrics.financials ? metrics.financials.runwayMonths : null;

  const kpis = [
    { label: "Headcount now", value: String(mm.headcountNow != null ? mm.headcountNow : metrics.company.headcount), sub: growth90 ? `+${growth90} last 90 days` : "" },
    { label: "Annual run-rate", value: money(mm.annualRunRate || 0), sub: "fully loaded" },
    { label: `${nowYear} spend`, value: money(thisYear ? thisYear.totalLoaded : 0), sub: mm.yoyCostGrowthPct != null ? `${mm.yoyCostGrowthPct >= 0 ? "+" : ""}${mm.yoyCostGrowthPct}% YoY` : "" },
    { label: "Avg loaded / head", value: money(avgLoadedMo), sub: "per month" },
  ];
  if (runway != null) kpis.push({ label: "Cash runway", value: runway + " mo", sub: "at current burn" });
  kpis.push({ label: "Net new (12 mo)", value: `${(mm.netNew12mo || 0) >= 0 ? "+" : ""}${mm.netNew12mo || 0}`, sub: "planned" });

  const deptBars = metrics.departments.slice(0, 6).map((d) => ({ name: d.department, pct: d.pctBaseCost, cost: d.totalLoaded }));

  const targetYear = nowYear + 1;
  const yearOf = (m) => m.years.find((y) => y.year === targetYear) || m.years[m.years.length - 1];
  const ay = yearOf(model);
  const planRows = [{ name: "Actual path", hc: ay ? ay.yearEndHc : (mm.headcountNow || 0), cost: ay ? ay.totalCost : 0 }];
  for (const pl of listPlans(ctx.db).slice(0, 3)) {
    const pm = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: planHires(pl), now });
    const y = yearOf(pm);
    planRows.push({ name: pl.name, hc: y ? y.yearEndHc : 0, cost: y ? y.totalCost : 0 });
  }

  const insights = [];
  const topCost = metrics.departments.slice().sort((a, b) => b.pctBaseCost - a.pctBaseCost)[0];
  if (topCost && topCost.headcount) insights.push(`${topCost.department} is ${topCost.pctBaseCost}% of loaded cost — the biggest driver.`);
  if (mm.yoyCostGrowthPct != null) insights.push(`Fully-loaded run-rate is ${mm.yoyCostGrowthPct >= 0 ? "up" : "down"} ${Math.abs(mm.yoyCostGrowthPct)}% year over year.`);
  if (runway != null) insights.push(`At current burn, runway is about ${runway} months.`);
  const rich = metrics.departments.filter((d) => d.headcount > 1).sort((a, b) => b.avgVsCompanyIndex - a.avgVsCompanyIndex)[0];
  if (rich && rich.avgVsCompanyIndex > 105) insights.push(`${rich.department} pays ${rich.avgVsCompanyIndex - 100}% above the company average salary.`);
  if ((mm.netNew12mo || 0) > 0) insights.push(`Plans add ${mm.netNew12mo} net new hires over the next 12 months.`);

  return overviewDashboard(ctx, {
    greeting: greeting(ctx.user), roleLine: `${displayRole(ctx.user)} · company overview`,
    kpis, trendYears, nowYear, deptBars, planRows, targetYear, insights: insights.slice(0, 4),
  });
}

function managerPanels(ctx, scope, roll, openReq) {
  const ids = Array.isArray(scope) ? scope : (scope == null ? [] : [scope]);
  const mine = listDepartments(ctx.db).filter((d) => ids.includes(d.id));
  const deptName = mine.length ? mine.map((d) => d.name).join(", ") : "your team";
  const reqRows = openReq.slice(0, 6).map((r) => html`<tr><td><a href="/requests/${r.id}">${r.title}</a></td><td>${(r.status || "").replace("_", " ")}</td></tr>`);
  return html`
    <div class="grid2">
      <section class="card">
        <h2>${deptName}</h2>
        <p>Active headcount <b>${roll.totals.active}</b> · Open seats <b>${roll.totals.open}</b> · Approved <b>${roll.totals.approved}</b></p>
        <p class="muted small"><a href="/roster">View people →</a></p>
      </section>
      <section class="card">
        <h2>Your open requests</h2>
        ${openReq.length ? html`<table class="table"><tbody>${reqRows}</tbody></table>` : html`<p class="muted">None open. <a href="/requests/new">File a request →</a></p>`}
      </section>
    </div>`;
}

const greeting = (u) => "Welcome, " + String(u.name || "").split(" ")[0];
const roleNote = (role) =>
  role === "finance_admin" ? "Full visibility, exact compensation, and workspace control."
  : role === "c_suite" ? "All departments; compensation as totals and bands."
  : "Your department, with compensation shown as bands.";
const kpi = (label, val, tone = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val ${tone}">${val}</div></div>`;
function varianceBadge(v) {
  if (v == null) return html`<span class="muted">—</span>`;
  if (Math.abs(v) < 2) return html`<span class="pill ok2">on target</span>`;
  return v > 0 ? html`<span class="pill warn2">+${v}% over</span>` : html`<span class="pill off">${v}% under</span>`;
}
