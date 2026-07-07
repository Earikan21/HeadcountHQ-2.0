/**
 * Live, in-app spreadsheet view of the headcount financial model (Directive 4.0):
 * a mini dashboard, month/quarter/year period toggle, a sortable + filterable
 * roster with fully-loaded cost per period, department roll-ups, and an annual
 * summary. Rendered from `buildHeadcountModel` over the live roster.
 */
import { html, raw } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "./ui.js";
import { canImportRoster } from "../authz.js";
import { periodBuckets, periodize } from "../domain/model.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const pctChg = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const kpi = (label, val, sub = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val">${val}</div>${sub ? html`<div class="lbl">${sub}</div>` : ""}</div>`;

function versionBar(ctx, extra) {
  const plans = extra.plans || [];
  const cur = extra.current;
  const tab = (href, label, on) => html`<a class="vtab ${on ? "on" : ""}" href="${href}">${label}</a>`;
  return html`<div class="version-bar">
    <span class="vlabel">Plans</span>
    ${tab("/model", "Actual", !cur)}
    ${plans.map((pl) => tab(`/model?version=${pl.id}`, pl.name, cur && cur.id === pl.id))}
    ${extra.canEdit ? html`<form method="post" action="/model/versions" class="vnew">${csrfField(ctx)}<input name="name" placeholder="New plan name" aria-label="New plan name"><button class="btn sm" type="submit">+ Save as plan</button></form>` : ""}
  </div>`;
}

function planEditor(ctx, extra) {
  const cur = extra.current;
  if (!cur || !extra.canEdit) return "";
  const hires = extra.hires || [];
  const rows = hires.length ? hires.map((h, i) => html`<tr>
      <td><b>${h.count}\u00d7 ${h.role}</b></td><td>${h.department}</td><td>${h.start_month || "from start"}</td><td class="right">${money(h.annual_salary)}</td>
      <td><form method="post" action="/model/versions/${cur.id}/hire/${i}/delete" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">remove</button></form></td>
    </tr>`) : html`<tr><td colspan="5" class="muted">No planned hires yet — add one below.</td></tr>`;
  return html`<section class="card plan-editor">
    <div class="row-between"><h2>Plan: ${cur.name} <span class="hint">layered on the live roster</span></h2>
      <form method="post" action="/model/versions/${cur.id}/delete" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">Delete plan</button></form></div>
    ${extra.aiError ? html`<div class="flash warn">${extra.aiError}</div>` : ""}
    ${extra.aiReady ? html`<form method="post" action="/model/versions/${cur.id}/ai" class="scn-ai">${csrfField(ctx)}<input name="description" placeholder="e.g. hire 2 AEs in Sales starting June 2027 at $120k" aria-label="Describe hires"><button class="btn sm" type="submit">Add with AI</button></form>` : ""}
    <form method="post" action="/model/versions/${cur.id}/hire" class="scn-manual">
      ${csrfField(ctx)}
      <input name="scn_department" placeholder="Department" aria-label="Department">
      <input name="scn_role" placeholder="Role" aria-label="Role">
      <input name="scn_start" type="month" aria-label="Start month">
      <input name="scn_salary" type="number" min="0" step="1000" placeholder="Annual $" aria-label="Annual salary">
      <input name="scn_count" type="number" min="1" step="1" value="1" aria-label="Count" style="width:64px">
      <button class="btn sm ghost" type="submit">Add hire</button>
    </form>
    <table class="table" style="margin-top:10px"><thead><tr><th>Role</th><th>Dept</th><th>Start</th><th class="right">Salary</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

export function financialModelPage(ctx, model, extra = {}) {
  const { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, years } = model;
  const isAdmin = canImportRoster(ctx.user);
  const period = ["month", "quarter", "year"].includes(extra.period) ? extra.period : "month";
  const buckets = periodBuckets(cols, period);

  // current-month index within the window, for the dashboard
  const now = new Date();
  let nowIdx = cols.findIndex((c) => c.year === now.getFullYear() && c.month0 === now.getMonth());
  if (nowIdx < 0) nowIdx = cols.length - 1;
  const curHc = monthlyHeadcount[nowIdx] || 0;
  const endHc = monthlyHeadcount[cols.length - 1] || 0;
  const runRate = (totalMonthlyCost[nowIdx] || 0) * 12;
  const avgHead = curHc ? Math.round((totalMonthlyCost[nowIdx] || 0) / curHc) : 0;

  const dash = html`<div class="kpis model-kpis">
    ${kpi("Current headcount", n0(curHc))}
    ${kpi("Planned (end of range)", n0(endHc), endHc !== curHc ? `${endHc > curHc ? "+" : ""}${endHc - curHc} vs today` : "")}
    ${kpi("Annual run-rate", money(runRate), "fully loaded")}
    ${kpi("Avg loaded / head", money(avgHead), "per month")}
    ${kpi("Departments", n0(departments.length))}
    ${kpi("Benefits load", benefitsPct + "%", "")}
  </div>`;

  const periodTab = (p, label) => raw(`<a class="ptab ${p === period ? "on" : ""}" href="/model?period=${p}">${label}</a>`);
  const controls = html`<div class="model-controls">
    <div class="ptabs">${periodTab("month", "Monthly")}${periodTab("quarter", "Quarterly")}${periodTab("year", "Yearly")}</div>
    <input id="f-search" type="search" placeholder="Search name / role / dept" aria-label="Search">
    <select id="f-dept" aria-label="Filter department"><option value="">All departments</option>${departments.map((d) => html`<option value="${d}">${d}</option>`)}</select>
    <input id="f-min" type="number" placeholder="Min $" aria-label="Min salary" style="width:96px">
    <input id="f-max" type="number" placeholder="Max $" aria-label="Max salary" style="width:96px">
    <span class="zoomctl"><button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button><span id="zoom-lvl">100%</span><button id="zoom-in" type="button" aria-label="Zoom in">+</button></span>
    ${isAdmin ? html`<a class="btn sm" href="/roster/new">+ Add person</a>` : ""}
    <a class="btn ghost sm" href="/budgets/export.csv">Export CSV</a>
  </div>`;

  const monthHead = buckets.map((b, i) => raw(`<th class="mc" data-sort="p${i}" data-type="num">${b.label}</th>`));
  const sortableHead = (key, label, type, cls = "") => raw(`<th class="sortable ${cls}" data-sort="${key}" data-type="${type}">${label}</th>`);

  const prowFor = (r) => {
    const per = periodize(r.monthlyCost, buckets, "sum");
    return html`<tr class="prow ${r.scenario ? "scn" : ""}" data-name="${(r.name || "").toLowerCase()}" data-role="${(r.role || "").toLowerCase()}" data-dept="${r.department}" data-status="${(r.status || '').toLowerCase()}" data-start="${r.startDate || ''}" data-salary="${Math.round(r.annualBase)}" data-loaded="${Math.round(r.loadedMonthly)}">
      <td class="rowhead">${r.name || "—"}</td>
      <td>${r.department}</td>
      <td>${r.role}</td>
      <td class="st">${r.status}</td>
      <td class="num">${r.hireMonthLabel === "From start" ? "—" : r.hireMonthLabel}</td>
      <td class="num">${n0(r.annualBase)}</td>
      <td class="num">${n0(r.loadedMonthly)}</td>
      ${isAdmin && r.id != null ? html`<td class="act"><form method="post" action="/roster/duplicate/${r.id}" class="inline">${csrfField(ctx)}<button class="linklike" type="submit" title="Duplicate this role">Duplicate</button></form></td>` : html`<td class="act"></td>`}
      ${per.map((v) => raw(`<td class="mc" data-v="${Math.round(v)}">${v ? moneyShort(v) : ""}</td>`))}
    </tr>`;
  };

  const rosterTable = html`<table id="model-sheet" class="sheet model">
    <thead><tr>
      ${sortableHead("name", "Name", "text", "rowhead")}
      ${sortableHead("dept", "Department", "text")}
      ${sortableHead("role", "Role / Title", "text")}
      ${sortableHead("status", "Status", "text")}
      ${sortableHead("start", "Starts", "text", "num")}
      ${sortableHead("salary", "Annual Base", "num", "num")}
      ${sortableHead("loaded", "Loaded Mo", "num", "num")}
      <th></th>
      ${monthHead}
    </tr></thead>
    <tbody id="roster-body">
      ${roster.length ? roster.map(prowFor) : html`<tr><td class="rowhead">—</td><td colspan="${7 + buckets.length}" class="muted">No roster yet. Import a roster to build the model.</td></tr>`}
    </tbody>
  </table>`;

  const costRow = (label, series, cls = "") => {
    const per = periodize(series, buckets, "sum");
    return html`<tr class="${cls}"><td class="rowhead">${label}</td>${per.map((v) => raw(`<td class="num">${moneyShort(v)}</td>`))}</tr>`;
  };
  const totalsTable = html`<table class="sheet model totals">
    <thead><tr><th class="rowhead">Fully-loaded cost</th>${buckets.map((b) => raw(`<th class="num">${b.label}</th>`))}</tr></thead>
    <tbody>
      ${costRow("Total", totalMonthlyCost, "hm-total")}
      ${departments.map((d) => costRow(d, deptMonthlyCost[d]))}
    </tbody>
  </table>`;

  const summary = years.length >= 2 ? (() => {
    const a = years[0], b = years[years.length - 1];
    const row = (label, va, vb, fmt) => html`<tr><td class="rowhead">${label}</td><td class="num">${fmt(va)}</td><td class="num">${fmt(vb)}</td><td class="num">${fmt(vb - va)}</td><td class="num">${pctChg(vb, va)}%</td></tr>`;
    return html`<h2 style="margin:22px 0 8px">Annual summary</h2>
      <table class="sheet summary">
        <thead><tr><th class="rowhead">Metric</th><th class="num">${a.year}</th><th class="num">${b.year}</th><th class="num">Change</th><th class="num">%</th></tr></thead>
        <tbody>
          ${row("Year-End Headcount", a.yearEndHc, b.yearEndHc, (x) => n0(x))}
          ${row("Total Fully-Loaded Cost", a.totalCost, b.totalCost, (x) => money(x))}
          ${row("Avg Monthly Headcount", a.avgHc, b.avgHc, (x) => n0(x))}
          ${row("Avg Loaded Cost / Head", a.avgCostPerHead, b.avgCostPerHead, (x) => money(x))}
        </tbody></table>`;
  })() : "";

  const range = cols.length ? `${cols[0].fullLabel} – ${cols[cols.length - 1].fullLabel}` : "";
  const body = html`
    <div class="hm-band">
      <div class="hm-logo">HQ</div>
      <div><div class="hm-title">HEADCOUNT MODEL</div><div class="hm-sub">${range} · fully-loaded (base + ${benefitsPct}% benefits/taxes)</div></div>
    </div>
    ${versionBar(ctx, extra)}
    ${dash}
    ${controls}
    ${planEditor(ctx, extra)}
    <div class="sheet-wrap">${rosterTable}</div>
    <h2 style="margin:22px 0 8px">Monthly fully-loaded cost by department</h2>
    <div class="sheet-wrap">${totalsTable}</div>
    ${summary}
    <script src="/static/model.js" defer></script>`;
  return renderPage(ctx, { title: "Financial model", body, active: "model" });
}
