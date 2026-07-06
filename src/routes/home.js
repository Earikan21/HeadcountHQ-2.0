import { html, raw } from "../html.js";
import { renderPage, money } from "../views/ui.js";
import { canViewCompTotals, departmentScope, canSeeAllDepartments, canManageSettings, displayRole, canImportRoster } from "../authz.js";
import { countUsers } from "../repos/users.js";
import { listDepartments } from "../repos/departments.js";
import { headcountRollup, recentSeatAdds } from "../repos/seats.js";
import { allReconciliation, getCompanyBudget } from "../repos/budgets.js";
import { getDepartmentTargets } from "../repos/targets.js";
import { mixVsTarget } from "../domain/philosophy.js";
import { welcomePage } from "../views/welcome.js";
import { listRequests } from "../repos/requests.js";
import { OPEN_STATUSES } from "../domain/requests.js";

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
        return ctx.html(200, welcomePage(ctx, { rosterDone, budgetDone }));
      }
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
      ${canSeeAllDepartments(ctx.user) ? adminPanels(ctx) : managerPanels(ctx, scope, roll, openReq)}
    `;
    return ctx.html(200, renderPage(ctx, { title: "Dashboard", body, active: "dashboard" }));
  });
}

function adminPanels(ctx) {
  // ---- department balance vs target ----
  const roll = headcountRollup(ctx.db);
  const actualByDept = {};
  for (const d of roll.departments) actualByDept[d.department] = d.active;
  const targets = getDepartmentTargets(ctx.db);
  const targetByDept = {};
  for (const [k, v] of Object.entries(targets)) targetByDept[k] = v.target_pct;
  const mix = mixVsTarget(actualByDept, targetByDept).filter((m) => m.count > 0 || m.targetPct != null);

  const mixRows = mix.length ? mix.map((m) => html`<tr>
      <td><b>${m.name}</b></td>
      <td class="right">${m.count}</td>
      <td class="right">${m.actualPct}%</td>
      <td class="right">${m.targetPct == null ? "—" : m.targetPct + "%"}</td>
      <td>${varianceBadge(m.variance)}</td>
    </tr>`) : raw('<tr><td colspan="5" class="muted">Import a roster and set a target balance to see this.</td></tr>');

  // ---- budget summary ----
  const { allocation, company } = allReconciliation(ctx.db);
  // ---- growth ----
  const growth = recentSeatAdds(ctx.db, 90);

  return html`
    <div class="grid2">
      <section class="card">
        <h2>Department balance vs. target</h2>
        <table class="table">
          <thead><tr><th>Department</th><th class="right">HC</th><th class="right">Actual</th><th class="right">Target</th><th>Status</th></tr></thead>
          <tbody>${mixRows}</tbody>
        </table>
        ${canManageSettings(ctx.user) ? raw('<p class="muted small"><a href="/philosophy">Edit the target balance →</a></p>') : ""}
      </section>
      <div>
        <section class="card">
          <h2>Budget</h2>
          <p>Positions allocated <b>${allocation.headcount.allocated}</b> of <b>${allocation.headcount.cap || "—"}</b> ${allocation.headcount.over ? raw(`<span class="over-txt">(over by ${allocation.headcount.over})</span>`) : ""}</p>
          <p>Spend committed <b>${money(company.money.committed)}</b> of <b>${company.money.budget ? money(company.money.budget) : "—"}</b></p>
          <p class="muted small"><a href="/budgets">Manage budgets →</a></p>
        </section>
        <section class="card">
          <h2>Growth · last 90 days</h2>
          <p><b>${growth.total}</b> position${growth.total === 1 ? "" : "s"} added across the company.</p>
          ${Object.keys(growth.byDept).length ? html`<ul class="plainlist">${Object.entries(growth.byDept).sort((a,b)=>b[1]-a[1]).map(([d, n]) => html`<li>${d}: <b>+${n}</b></li>`)}</ul>` : html`<p class="muted small">No recent additions.</p>`}
        </section>
      </div>
    </div>`;
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
