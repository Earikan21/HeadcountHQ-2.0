/**
 * Live, in-app spreadsheet financial model (Directive 4.0): mini dashboard,
 * month/quarter/year period toggle, plan versions, a sortable + filterable roster
 * with fully-loaded cost per period, and Excel-style collapsible rows (by
 * department) and columns (by year). Rendered from `buildHeadcountModel`.
 */
import { html, raw } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "./ui.js";
import { canImportRoster } from "../authz.js";
import { periodBuckets, periodize } from "../domain/model.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const pctChg = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const kpi = (label, val, sub = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val">${val}</div>${sub ? html`<div class="lbl">${sub}</div>` : ""}</div>`;

/** Group the display buckets by calendar year, keeping their positions. */
function yearGroupsOf(cols, buckets) {
  const groups = [];
  buckets.forEach((b, i) => {
    const yr = cols[b.idxs[0]].year;
    let g = groups[groups.length - 1];
    if (!g || g.year !== yr) { g = { year: yr, pos: [] }; groups.push(g); }
    g.pos.push(i);
  });
  return groups;
}

/** Cost cells for one row across all year-groups: bucket cells + a hidden year-total. */
function yearCells(perBucket, groups) {
  return groups.map((g) => {
    const cells = g.pos.map((i) => raw(`<td class="mc" data-yb="${g.year}" data-v="${Math.round(perBucket[i])}">${perBucket[i] ? moneyShort(perBucket[i]) : ""}</td>`));
    if (g.pos.length <= 1) return html`${cells}`; // single bucket (e.g. yearly view): nothing to collapse
    const tot = g.pos.reduce((a, i) => a + perBucket[i], 0);
    return html`${cells}${raw(`<td class="mc ytot" data-year="${g.year}" data-v="${Math.round(tot)}" hidden>${tot ? moneyShort(tot) : ""}</td>`)}`;
  });
}

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
  const a = extra.assumptions || {};
  const chips = hires.length
    ? html`<div class="hire-chips">${hires.map((h, i) => html`<span class="chip">${h.count}× ${h.role} · ${h.department} · ${h.start_month || "start"} · ${money(h.annual_salary)}<form method="post" action="/model/versions/${cur.id}/hire/${i}/delete" class="inline">${csrfField(ctx)}<button class="chip-x" type="submit" aria-label="remove">×</button></form></span>`)}</div>`
    : html`<p class="muted small">No planned hires yet.</p>`;
  return html`<section class="card plan-editor">
    <div class="row-between"><h2>Plan: ${cur.name} <span class="hint">layered on the live roster</span></h2>
      <form method="post" action="/model/versions/${cur.id}/delete" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">Delete plan</button></form></div>
    ${extra.aiError ? html`<div class="flash warn">${extra.aiError}</div>` : ""}
    <div class="plan-grid">
      <div>
        <h3 class="mini">Hires</h3>
        ${extra.aiReady ? html`<form method="post" action="/model/versions/${cur.id}/ai" class="scn-ai">${csrfField(ctx)}<input name="description" placeholder="e.g. 2 AEs in Sales, Jun 2027, $120k" aria-label="Describe hires"><button class="btn sm" type="submit">AI</button></form>` : ""}
        <form method="post" action="/model/versions/${cur.id}/hire" class="scn-manual">
          ${csrfField(ctx)}
          <input name="scn_department" placeholder="Dept" aria-label="Department">
          <input name="scn_role" placeholder="Role" aria-label="Role">
          <input name="scn_start" type="month" aria-label="Start month">
          <input name="scn_salary" type="number" min="0" step="1000" placeholder="Annual $" aria-label="Annual salary">
          <input name="scn_count" type="number" min="1" step="1" value="1" aria-label="Count" style="width:56px">
          <button class="btn sm ghost" type="submit">Add</button>
        </form>
        ${chips}
      </div>
      <div>
        <h3 class="mini">Assumptions &amp; drivers</h3>
        <form method="post" action="/model/versions/${cur.id}/assumptions" class="asm-form">
          ${csrfField(ctx)}
          <label class="asm">YoY salary growth <span class="muted">%</span><input name="salary_growth" type="number" min="0" max="100" step="0.5" value="${a.salaryGrowthPct || 0}"></label>
          <label class="asm">Benefits / load <span class="muted">× base</span><input name="loaded_mult" type="number" min="1" max="3" step="0.01" value="${a.loadedMultiplier || ""}" placeholder="default"></label>
          <label class="asm">Target bonus <span class="muted">% of base</span><input name="bonus_pct" type="number" min="0" max="100" step="1" value="${a.bonusPct || 0}"></label>
          <label class="asm">Hiring slippage <span class="muted">months</span><input name="hiring_slip" type="number" min="0" max="24" step="1" value="${a.hiringSlipMonths || 0}"></label>
          <label class="asm">Cost per hire <span class="muted">one-time $</span><input name="cost_per_hire" type="number" min="0" step="500" value="${a.costPerHire || 0}"></label>
          <button class="btn sm ghost" type="submit">Save</button>
        </form>
        <p class="muted small" style="margin-top:6px">Applied to this plan only. Salary growth compounds each year from now forward.</p>
      </div>
    </div>
  </section>`;
}

export function financialModelPage(ctx, model, extra = {}) {
  const { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, years } = model;
  const isAdmin = canImportRoster(ctx.user);
  const period = ["month", "quarter", "year"].includes(extra.period) ? extra.period : "month";
  const buckets = periodBuckets(cols, period);
  const groups = yearGroupsOf(cols, buckets);
  const LABELS = 8; // label columns before the period columns

  const now = new Date();
  let nowIdx = cols.findIndex((c) => c.year === now.getFullYear() && c.month0 === now.getMonth());
  if (nowIdx < 0) nowIdx = Math.max(0, cols.length - 1);
  const nowLabel = cols.length ? cols[nowIdx].fullLabel : "";
  const curHc = monthlyHeadcount[nowIdx] || 0;
  const thisYear = cols.length ? cols[nowIdx].year : now.getFullYear();
  const thisYearCost = cols.reduce((a, c, i) => a + (c.year === thisYear ? totalMonthlyCost[i] : 0), 0);
  const endI = Math.min(nowIdx + 11, cols.length - 1);
  const next12Cost = totalMonthlyCost.slice(nowIdx, endI + 1).reduce((a, b) => a + b, 0);
  const hc12 = monthlyHeadcount[Math.min(nowIdx + 12, cols.length - 1)] || 0;
  const netNew = hc12 - curHc;
  const avgHead = curHc ? Math.round((totalMonthlyCost[nowIdx] || 0) / curHc) : 0;

  const dash = html`<div class="kpis model-kpis">
    ${kpi("Headcount now", n0(curHc), "as of " + nowLabel)}
    ${kpi(`${thisYear} spend`, money(thisYearCost), "fully loaded, this year")}
    ${kpi("Next 12-mo cost", money(next12Cost), "from " + nowLabel)}
    ${kpi("Net new (12 mo)", `${netNew >= 0 ? "+" : ""}${n0(netNew)}`, "planned change")}
    ${kpi("Avg loaded / head", money(avgHead), "per month, now")}
    ${kpi("Departments", n0(departments.length), benefitsPct + "% benefits load")}
  </div>`;

  const allDepts = extra.allDepartments || departments;
  const q = (base) => base + (extra.current ? "&version=" + extra.current.id : "") + (extra.dept ? "&dept=" + encodeURIComponent(extra.dept) : "");
  const periodTab = (p, label) => raw(`<a class="ptab ${p === period ? "on" : ""}" href="${q("/model?period=" + p)}">${label}</a>`);
  const controls = html`<div class="model-controls">
    <div class="ptabs">${periodTab("month", "Monthly")}${periodTab("quarter", "Quarterly")}${periodTab("year", "Yearly")}</div>
    <input id="f-search" type="search" placeholder="Search name / role / dept" aria-label="Search">
    <select id="f-dept" aria-label="Scope to department"><option value="">All departments</option>${allDepts.map((d) => html`<option value="${d}" ${extra.dept === d ? raw("selected") : ""}>${d}</option>`)}</select>
    <input id="f-min" type="number" placeholder="Min $" aria-label="Min salary" style="width:96px">
    <input id="f-max" type="number" placeholder="Max $" aria-label="Max salary" style="width:96px">
    <span class="zoomctl"><button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button><span id="zoom-lvl">100%</span><button id="zoom-in" type="button" aria-label="Zoom in">+</button></span>
    ${isAdmin ? html`<a class="btn sm" href="/roster/new">+ Add person</a>` : ""}
    <a class="btn ghost sm" href="/budgets/export.csv">Export CSV</a>
  </div>`;

  const sortableHead = (key, label, type, cls = "") => raw(`<th class="sortable ${cls}" rowspan="2" data-sort="${key}" data-type="${type}">${label}</th>`);
  const yearGroupHead = groups.map((g) => { const multi = g.pos.length > 1; const toggle = multi ? `<button type="button" class="ytoggle" data-year="${g.year}" aria-label="Collapse ${g.year}">–</button> ` : ""; return raw(`<th class="ygrp" data-year="${g.year}" data-span="${g.pos.length}" colspan="${g.pos.length}">${toggle}${g.year}</th>`); });
  const bucketHead = groups.map((g) => html`${g.pos.map((i) => raw(`<th class="mc" data-yb="${g.year}">${buckets[i].label}</th>`))}${g.pos.length > 1 ? raw(`<th class="mc ytot" data-year="${g.year}" hidden>${g.year} total</th>`) : ""}`);

  const prowFor = (r) => {
    const per = periodize(r.monthlyCost, buckets, "sum");
    return html`<tr class="prow ${r.scenario ? "scn" : ""}" data-dept="${r.department}" data-name="${(r.name || "").toLowerCase()}" data-role="${(r.role || "").toLowerCase()}" data-status="${(r.status || "").toLowerCase()}" data-start="${r.startDate || ""}" data-salary="${Math.round(r.annualBase)}" data-loaded="${Math.round(r.loadedMonthly)}">
      <td class="rowhead">${r.name || "—"}</td>
      <td>${r.department}</td>
      <td>${r.role}</td>
      <td class="st">${r.status}</td>
      <td class="num">${r.hireMonthLabel === "From start" ? "—" : r.hireMonthLabel}</td>
      <td class="num">${n0(r.annualBase)}</td>
      <td class="num">${n0(r.loadedMonthly)}</td>
      ${isAdmin && r.id != null ? html`<td class="act"><form method="post" action="/roster/duplicate/${r.id}" class="inline">${csrfField(ctx)}<button class="linklike" type="submit" title="Duplicate this role">Duplicate</button></form></td>` : html`<td class="act"></td>`}
      ${yearCells(per, groups)}
    </tr>`;
  };

  const grandTotal = html`<tr class="grp total-grp">
    <td class="rowhead grplabel"><b>Total fully-loaded cost</b></td>
    <td class="grpfill" colspan="${LABELS - 1}"></td>
    ${yearCells(periodize(totalMonthlyCost, buckets, "sum"), groups)}
  </tr>`;

  const deptBlocks = departments.map((d) => {
    const members = roster.filter((r) => r.department === d);
    const sub = periodize(deptMonthlyCost[d], buckets, "sum");
    const head = html`<tr class="grp" data-dept="${d}">
      <td class="rowhead grplabel"><button type="button" class="grptoggle" data-dept="${d}" aria-label="Collapse ${d}">▾</button> <b>${d}</b> <span class="muted">(${members.length})</span></td>
      <td class="grpfill" colspan="${LABELS - 1}"></td>
      ${yearCells(sub, groups)}
    </tr>`;
    return html`${head}${members.map(prowFor)}`;
  });

  const rosterTable = html`<table id="model-sheet" class="sheet model outline">
    <thead>
      <tr>
        ${sortableHead("name", "Name", "text", "rowhead")}
        ${sortableHead("dept", "Department", "text")}
        ${sortableHead("role", "Role / Title", "text")}
        ${sortableHead("status", "Status", "text")}
        ${sortableHead("start", "Starts", "text")}
        ${sortableHead("salary", "Annual Base", "num")}
        ${sortableHead("loaded", "Loaded Mo", "num")}
        <th rowspan="2"></th>
        ${yearGroupHead}
      </tr>
      <tr>${bucketHead}</tr>
    </thead>
    <tbody id="roster-body">
      ${roster.length ? html`${grandTotal}${deptBlocks}` : html`<tr><td class="rowhead">—</td><td colspan="${LABELS - 1 + buckets.length}" class="muted">No roster yet. Import a roster (include a start-date column) to build the model.</td></tr>`}
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
      <div><div class="hm-title">HEADCOUNT MODEL${extra.dept ? " · " + extra.dept : ""}</div><div class="hm-sub">${range} · fully-loaded (base + ${benefitsPct}% benefits/taxes)${extra.dept ? " · one department (summary scoped)" : ""}</div></div>
    </div>
    ${versionBar(ctx, extra)}
    ${dash}
    ${controls}
    ${planEditor(ctx, extra)}
    <p class="muted small" style="margin:0 0 8px">Tip: click a department (▾) to collapse its people, or a year (–) to collapse its columns. Sort by any header; filter above.</p>
    <div class="sheet-wrap">${rosterTable}</div>
    ${summary}
    <script src="/static/model.js" defer></script>`;
  return renderPage(ctx, { title: "Financial model", body, active: "model" });
}
