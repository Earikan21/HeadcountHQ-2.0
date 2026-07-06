/**
 * Live, in-app spreadsheet view of the headcount financial model (Directive 4.0).
 * Rendered server-side from `buildHeadcountModel` over the live roster, so it always
 * reflects current data — a real month-by-month build embedded in the tool:
 *   - Employee roster with per-month active flags
 *   - Monthly fully-loaded cost rolled up by department
 *   - Annual summary
 */
import { html, raw } from "../html.js";
import { renderPage, money, moneyShort } from "./ui.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);

export function financialModelPage(ctx, model) {
  const { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, benefitsPct, years } = model;
  const span = cols.length + 8; // 8 label columns + month columns

  const monthHead = cols.map((c) => html`<th class="mc">${c.label}</th>`);

  const rosterRows = roster.length ? roster.map((r) => html`<tr>
      <td class="rowhead">${r.department}</td>
      <td>${r.role}</td>
      <td class="st">${r.status}</td>
      <td class="num">${r.hireMonthLabel === "From start" ? "—" : r.hireMonthLabel}</td>
      <td class="num">${n0(r.annualBase)}</td>
      <td class="num">${n0(r.monthlyBase)}</td>
      <td class="num">${n0(r.monthlyBenefits)}</td>
      <td class="num">${n0(r.loadedMonthly)}</td>
      ${r.active.map((a) => raw(`<td class="mc ${a ? "on" : ""}">${a}</td>`))}
    </tr>`) : html`<tr><td class="rowhead">—</td><td colspan="${span - 1}" class="muted">No roster yet. Import a roster to build the model.</td></tr>`;

  const costRow = (label, series, cls = "") => html`<tr class="${cls}">
      <td class="rowhead">${label}</td><td colspan="7"></td>
      ${series.map((v) => raw(`<td class="num">${moneyShort(v)}</td>`))}
    </tr>`;

  const summary = years.length >= 2
    ? (() => {
        const a = years[0], b = years[years.length - 1];
        const row = (label, va, vb, fmt) => html`<tr>
          <td class="rowhead">${label}</td>
          <td class="num">${fmt(va)}</td>
          <td class="num">${fmt(vb)}</td>
          <td class="num">${fmt(vb - va)}</td>
          <td class="num">${pct(vb, va)}%</td>
        </tr>`;
        return html`<table class="sheet summary">
          <thead><tr><th class="rowhead">Metric</th><th class="num">${a.year} (Y1)</th><th class="num">${b.year} (Y2)</th><th class="num">Change</th><th class="num">Change %</th></tr></thead>
          <tbody>
            ${row("Year-End Headcount", a.yearEndHc, b.yearEndHc, (x) => n0(x))}
            ${row("Total Fully-Loaded Personnel Cost", a.totalCost, b.totalCost, (x) => money(x))}
            ${row("Avg Monthly Headcount", a.avgHc, b.avgHc, (x) => n0(x))}
            ${row("Avg Monthly Fully-Loaded Cost / Head", a.avgCostPerHead, b.avgCostPerHead, (x) => money(x))}
          </tbody>
        </table>`;
      })()
    : "";

  const range = cols.length ? `${cols[0].fullLabel} – ${cols[cols.length - 1].fullLabel}` : "";
  const body = html`
    <div class="hm-band">
      <div class="hm-logo">HQ</div>
      <div><div class="hm-title">HEADCOUNT MODEL</div>
        <div class="hm-sub">${range} · Benefits &amp; payroll load ${benefitsPct}%</div></div>
      <div class="hm-actions"><a class="btn ghost sm" href="/budgets/export.csv">Export CSV</a></div>
    </div>
    <p class="muted small" style="margin:10px 0">Live view — built from your current roster. Base ÷ 12 gives monthly base; the ${benefitsPct}% load is applied on top for a fully-loaded monthly cost. A <b>1</b> marks a month the seat is active. Edit numbers on <a href="/budgets">Budgets</a> and the roster on <a href="/roster">People</a>.</p>

    <div class="sheet-wrap">
      <table class="sheet model">
        <thead><tr>
          <th class="rowhead">Department</th><th>Role / Title</th><th>Status</th><th class="num">Starts</th>
          <th class="num">Annual Base</th><th class="num">Mo Base</th><th class="num">Mo Benefits</th><th class="num">Loaded Mo</th>
          ${monthHead}
        </tr></thead>
        <tbody>
          <tr class="hm-section"><td colspan="${span}">Employee roster</td></tr>
          ${rosterRows}
          <tr class="hm-section"><td colspan="${span}">Monthly fully-loaded cost (base + benefits/taxes)</td></tr>
          ${costRow("Total fully-loaded cost", totalMonthlyCost, "hm-total")}
          ${departments.map((d) => costRow(d, deptMonthlyCost[d]))}
        </tbody>
      </table>
    </div>

    ${years.length >= 2 ? html`<h2 style="margin:22px 0 8px">Annual summary</h2>${summary}` : ""}`;
  return renderPage(ctx, { title: "Financial model", body, active: "model" });
}
