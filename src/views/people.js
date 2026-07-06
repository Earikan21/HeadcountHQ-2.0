/**
 * The consolidated People surface (Directive 4.0). Roster and Headcount showed
 * the same thing from two angles, so they are merged into one view, grouped by
 * department as collapsible dropdowns: filled seats appear as people (with
 * role-appropriate compensation), open seats are listed per team, and admins get
 * inline department controls. Heavy department ops (merge / split / move) still
 * live on the per-department manage page, linked from each dropdown.
 */
import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, money } from "./ui.js";
import { canImportRoster, canViewCompTotals, compVisibility, departmentScope } from "../authz.js";
import * as R from "../domain/roster.js";
import { listDepartments } from "../repos/departments.js";

const compCell = (user, annual) => {
  if (annual == null) return "—";
  return compVisibility(user) === "exact" ? money(annual) : (R.band(annual) || "—");
};

const statusPill = (st) => {
  const s = String(st || "").toLowerCase();
  if (s === "active") return raw('<span class="pill ok2">Active</span>');
  if (s === "inactive") return raw('<span class="pill off">Inactive</span>');
  if (s === "leave") return raw('<span class="pill warn2">On leave</span>');
  return st || "—";
};

const kpi = (label, val, tone = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val ${tone}">${val}</div></div>`;

/** Group employees + open seats + roll-up counts by department, richest first. */
function groupByDept(ctx, employees, roll, seats) {
  const idByName = new Map(listDepartments(ctx.db).map((d) => [d.name, d.id]));
  const map = new Map();
  const ensure = (name) => {
    const key = name || "(no department)";
    if (!map.has(key)) map.set(key, { name: key, id: idByName.get(key) || null, people: [], openSeats: [], active: 0, open: 0, approved: 0, cost: 0 });
    return map.get(key);
  };
  for (const e of employees) {
    const g = ensure(e.department_name);
    g.people.push(e);
    g.cost += e.annual_salary || 0;
  }
  for (const s of seats) {
    if (s.status === "open") ensure(s.department_name).openSeats.push(s);
  }
  for (const d of roll.departments) {
    const g = ensure(d.department);
    g.active = d.active; g.open = d.open; g.approved = d.approved;
  }
  return [...map.values()].sort((a, b) => (b.cost - a.cost) || (b.people.length - a.people.length));
}

function deptDropdown(ctx, d, opts) {
  const { isAdmin, showTotals, exact } = opts;
  const peopleRows = d.people.length ? d.people.map((e) => html`<tr>
      <td><b>${e.name}</b><div class="sub">${e.employee_ext_id}</div></td>
      <td>${e.job_title || "—"}</td>
      <td>${statusPill(e.employment_status)}</td>
      <td class="right">${compCell(ctx.user, e.annual_salary)}</td>
    </tr>`) : raw('<tr><td colspan="4" class="muted">No filled seats in this department.</td></tr>');

  const openRows = d.openSeats.map((s) => html`<tr>
      <td><b>${s.title || "Open seat"}</b></td>
      <td>${raw('<span class="pill warn2">Open</span>')}</td>
      <td class="right">${isAdmin ? html`<a class="btn sm" href="/roster/new?seat=${s.id}">Fill seat</a>` : "—"}</td>
    </tr>`);

  const stat = (label, val, tone = "") => html`<span class="dd-stat ${tone}"><b>${val}</b> ${label}</span>`;

  return html`<details class="deptcard">
    <summary>
      <span class="dd-name">${d.name}</span>
      <span class="dd-stats">
        ${stat("active", d.active)}
        ${stat("open", d.open, d.open ? "warn" : "")}
        ${showTotals ? stat("/yr", money(d.cost)) : ""}
      </span>
    </summary>
    <div class="dd-body">
      <table class="table">
        <thead><tr><th>Name</th><th>Title</th><th>Status</th><th class="right">${exact ? "Annual" : "Band"}</th></tr></thead>
        <tbody>${peopleRows}</tbody>
      </table>
      ${d.openSeats.length ? html`<h3 class="mini">Open seats (${d.openSeats.length})</h3>
        <table class="table"><thead><tr><th>Title</th><th>Status</th><th class="right"></th></tr></thead><tbody>${openRows}</tbody></table>` : ""}
      ${isAdmin && d.id ? html`<div class="dd-actions">
        <form method="post" action="/departments/${d.id}/rename" class="inline">
          ${csrfField(ctx)}<input name="name" value="${esc(d.name)}" aria-label="Rename department"> <button class="btn sm ghost" type="submit">Rename</button>
        </form>
        <a class="btn sm ghost" href="/departments/${d.id}">Manage · merge · split →</a>
      </div>` : ""}
    </div>
  </details>`;
}

function addDeptBar(ctx) {
  return html`<details class="deptcard adddept">
    <summary><span class="dd-name">+ Add a department</span></summary>
    <div class="dd-body">
      <form method="post" action="/departments" class="inline">
        ${csrfField(ctx)}
        <input name="name" placeholder="Department name" required aria-label="New department name">
        <button class="btn sm" type="submit">Add department</button>
      </form>
    </div>
  </details>`;
}

export function peoplePage(ctx, { employees, roll, seats }) {
  const isAdmin = canImportRoster(ctx.user);
  const showTotals = canViewCompTotals(ctx.user);
  const exact = compVisibility(ctx.user) === "exact";
  const depts = groupByDept(ctx, employees, roll, seats);

  const totalCost = employees.reduce((sum, e) => sum + (e.annual_salary || 0), 0);
  const kpis = [
    kpi("Active headcount", roll.totals.active),
    kpi("Open seats", roll.totals.open, roll.totals.open ? "warn" : ""),
    kpi("Departments", depts.length),
  ];
  if (showTotals) kpis.push(kpi("Total annual cost", money(totalCost)));

  const scopedNote = departmentScope(ctx.user) != null ? " You see your own department." : "";
  const body = html`
    <div class="pagehead row-between">
      <div><h1>People</h1><p class="muted">Everyone on the roster and every seat, grouped by department.${exact ? "" : " Compensation is shown as bands."}${scopedNote}</p></div>
      ${isAdmin ? html`<div class="actions"><a class="btn" href="/roster/new">Add person</a> <a class="btn ghost" href="/roster/import">Import roster</a> <a class="btn ghost" href="/roster/export.csv">Export CSV</a></div>` : ""}
    </div>
    <div class="kpis">${kpis}</div>
    ${isAdmin ? addDeptBar(ctx) : ""}
    ${depts.length ? depts.map((d) => deptDropdown(ctx, d, { isAdmin, showTotals, exact }))
      : html`<div class="card"><p class="muted">No people yet.${isAdmin ? html` Start by <a href="/roster/import">importing your roster</a>.` : ""}</p></div>`}`;
  return renderPage(ctx, { title: "People", body, active: "roster" });
}
