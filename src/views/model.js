/**
 * Live, in-app spreadsheet view of the headcount financial model (Directive 4.0),
 * with zoom controls and what-if scenario hiring. Rendered server-side from
 * `buildHeadcountModel` over the live roster (+ any scenario hires), so it always
 * reflects current data.
 */
import { html, raw } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "./ui.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);

function rosterRow(r) {
  return html`<tr class="${r.scenario ? "scn" : ""}">
      <td class="rowhead">${r.department}</td>
      <td>${r.role}</td>
      <td class="st">${r.status}</td>
      <td class="num">${r.hireMonthLabel === "From start" ? "—" : r.hireMonthLabel}</td>
      <td class="num">${n0(r.annualBase)}</td>
      <td class="num">${n0(r.monthlyBase)}</td>
      <td class="num">${n0(r.monthlyBenefits)}</td>
      <td class="num">${n0(r.loadedMonthly)}</td>
      ${r.active.map((a) => raw(`<td class="mc ${a ? "on" : ""}">${a}</td>`))}
    </tr>`;
}

function scenarioPanel(ctx, extra) {
  const depts = extra.departments || [];
  const aiReady = extra.aiReady;
  const active = (extra.scenarioHires || []);
  const summary = active.length
    ? html`<div class="scn-active">Modeling: ${active.map((h) => `${h.count}× ${h.role || "hire"} in ${h.department} from ${h.start_month || "start"} @ ${money(h.annual_salary)}`).join("; ")} · <a href="/model">clear</a></div>`
    : "";
  const aiNote = extra.aiError ? html`<div class="flash warn">${extra.aiError}</div>`
    : extra.aiNote ? html`<div class="flash ok">${extra.aiNote}</div>` : "";
  return html`<section class="card scn-card">
    <h2>Scenario planning <span class="hint">what-if — nothing is saved</span></h2>
    ${aiNote}${summary}
    ${aiReady ? html`<form method="post" action="/model/ai-scenario" class="scn-ai">
      ${csrfField(ctx)}
      <input name="description" placeholder="e.g. hire 2 AEs in Sales starting June 2027 at $120k" aria-label="Describe a scenario">
      <button class="btn sm" type="submit">Ask AI to model it</button>
    </form>` : html`<p class="muted small">Configure a provider key to describe scenarios in plain English.</p>`}
    <form method="post" action="/model" class="scn-manual">
      ${csrfField(ctx)}
      <select name="scn_department" aria-label="Department">
        <option value="">Department…</option>
        ${depts.map((d) => html`<option value="${d}">${d}</option>`)}
      </select>
      <input name="scn_role" placeholder="Role" aria-label="Role">
      <input name="scn_start" type="month" aria-label="Start month">
      <input name="scn_salary" type="number" min="0" step="1000" placeholder="Annual $" aria-label="Annual salary">
      <input name="scn_count" type="number" min="1" step="1" value="1" aria-label="Count" style="width:64px">
      <button class="btn sm ghost" type="submit">Model hire</button>
    </form>
  </section>`;
}

export function financialModelPage(ctx, model, extra = {}) {
  const { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, benefitsPct, years } = model;
  const base = roster.filter((r) => !r.scenario);
  const scen = roster.filter((r) => r.scenario);
  const span = cols.length + 8;
  const monthHead = cols.map((c) => html`<th class="mc">${c.label}</th>`);

  const emptyRow = html`<tr><td class="rowhead">—</td><td colspan="${span - 1}" class="muted">No roster yet. Import a roster to build the model.</td></tr>`;
  const costRow = (label, series, cls = "") => html`<tr class="${cls}">
      <td class="rowhead">${label}</td><td colspan="7"></td>
      ${series.map((v) => raw(`<td class="num">${moneyShort(v)}</td>`))}
    </tr>`;

  const summary = years.length >= 2 ? (() => {
    const a = years[0], b = years[years.length - 1];
    const row = (label, va, vb, fmt) => html`<tr>
      <td class="rowhead">${label}</td><td class="num">${fmt(va)}</td><td class="num">${fmt(vb)}</td>
      <td class="num">${fmt(vb - va)}</td><td class="num">${pct(vb, va)}%</td></tr>`;
    return html`<table class="sheet summary">
      <thead><tr><th class="rowhead">Metric</th><th class="num">${a.year} (Y1)</th><th class="num">${b.year} (Y2)</th><th class="num">Change</th><th class="num">Change %</th></tr></thead>
      <tbody>
        ${row("Year-End Headcount", a.yearEndHc, b.yearEndHc, (x) => n0(x))}
        ${row("Total Fully-Loaded Personnel Cost", a.totalCost, b.totalCost, (x) => money(x))}
        ${row("Avg Monthly Headcount", a.avgHc, b.avgHc, (x) => n0(x))}
        ${row("Avg Monthly Fully-Loaded Cost / Head", a.avgCostPerHead, b.avgCostPerHead, (x) => money(x))}
      </tbody></table>`;
  })() : "";

  const range = cols.length ? `${cols[0].fullLabel} – ${cols[cols.length - 1].fullLabel}` : "";
  const body = html`
    <div class="hm-band">
      <div class="hm-logo">HQ</div>
      <div><div class="hm-title">HEADCOUNT MODEL</div>
        <div class="hm-sub">${range} · Benefits &amp; payroll load ${benefitsPct}%</div></div>
      <div class="hm-actions">
        <span class="zoomctl"><button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button><span id="zoom-lvl">100%</span><button id="zoom-in" type="button" aria-label="Zoom in">+</button></span>
        <a class="btn ghost sm" href="/budgets/export.csv">Export CSV</a>
      </div>
    </div>
    <p class="muted small" style="margin:10px 0">Live view — built from your current roster. Base ÷ 12 is monthly base; the ${benefitsPct}% load gives a fully-loaded monthly cost. A <b>1</b> marks a month the seat is active.</p>

    ${scenarioPanel(ctx, { ...extra, departments })}

    <div class="sheet-wrap">
      <table id="model-sheet" class="sheet model">
        <thead><tr>
          <th class="rowhead">Department</th><th>Role / Title</th><th>Status</th><th class="num">Starts</th>
          <th class="num">Annual Base</th><th class="num">Mo Base</th><th class="num">Mo Benefits</th><th class="num">Loaded Mo</th>
          ${monthHead}
        </tr></thead>
        <tbody>
          <tr class="hm-section"><td colspan="${span}">Employee roster</td></tr>
          ${base.length ? base.map(rosterRow) : emptyRow}
          ${scen.length ? html`<tr class="hm-section scn"><td colspan="${span}">Scenario hires (what-if)</td></tr>${scen.map(rosterRow)}` : ""}
          <tr class="hm-section"><td colspan="${span}">Monthly fully-loaded cost (base + benefits/taxes)</td></tr>
          ${costRow("Total fully-loaded cost", totalMonthlyCost, "hm-total")}
          ${departments.map((d) => costRow(d, deptMonthlyCost[d]))}
        </tbody>
      </table>
    </div>

    ${years.length >= 2 ? html`<h2 style="margin:22px 0 8px">Annual summary${scen.length ? raw(' <span class="hint">includes scenario hires</span>') : ""}</h2>${summary}` : ""}
    <script src="/static/model.js" defer></script>`;
  return renderPage(ctx, { title: "Financial model", body, active: "model" });
}
