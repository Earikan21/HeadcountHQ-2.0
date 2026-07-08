/**
 * Side-by-side comparison of any two versions of the future — Actual, or any named
 * plan. Both sides are built over one aligned window by the route, so every year lines
 * up and the deltas mean what they look like they mean.
 *
 * The chart is server-rendered SVG. The CSP forbids third-party script, and a cost
 * curve does not need a charting library.
 */
import { html, raw, esc } from "../html.js";
import { renderPage, money, moneyShort } from "./ui.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const signed = (v, fmt) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v));
const pctCell = (p) => (p == null ? "—" : (p > 0 ? "+" : "") + p + "%");
const deltaClass = (d) => (d > 0 ? "up" : d < 0 ? "down" : "flat");

/** Two cost curves over the compared years. */
function chart(diff) {
  const years = diff.years;
  if (years.length < 2) return "";
  const W = 720, H = 220, L = 62, R = 16, T = 16, B = 30;
  const max = Math.max(1, ...years.map((y) => Math.max(y.aCost, y.bCost)));
  const x = (i) => L + (i * (W - L - R)) / (years.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const line = (pick) => years.map((yr, i) => `${x(i).toFixed(1)},${y(pick(yr)).toFixed(1)}`).join(" ");
  const dots = (pick, cls) => years.map((yr, i) => raw(`<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(pick(yr)).toFixed(1)}" r="3"/>`));

  return html`<figure class="cmp-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fully-loaded cost by year, ${diff.aLabel} versus ${diff.bLabel}">
      <line class="ax" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line>
      <line class="ax" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>
      ${raw(`<text class="tick" x="${L - 8}" y="${T + 4}" text-anchor="end">${esc(moneyShort(max))}</text>`)}
      ${raw(`<text class="tick" x="${L - 8}" y="${H - B}" text-anchor="end">0</text>`)}
      ${years.map((yr, i) => raw(`<text class="tick" x="${x(i).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${yr.year}</text>`))}
      ${raw(`<polyline class="ln a" points="${line((v) => v.aCost)}"/>`)}
      ${raw(`<polyline class="ln b" points="${line((v) => v.bCost)}"/>`)}
      ${dots((v) => v.aCost, "dt a")}
      ${dots((v) => v.bCost, "dt b")}
    </svg>
    <figcaption class="cmp-legend">
      <span class="key a"></span>${diff.aLabel}
      <span class="key b"></span>${diff.bLabel}
      <span class="muted small">fully-loaded cost per year</span>
    </figcaption>
  </figure>`;
}

export function comparePage(ctx, { diff, plans, a, b }) {
  const opts = (sel) => html`${raw(`<option value="actual" ${sel === "actual" ? "selected" : ""}>Actual (live roster)</option>`)}${
    plans.map((p) => raw(`<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`))}`;

  const t = diff.totals;
  const kpi = (label, val, sub = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val">${val}</div>${sub ? html`<div class="lbl">${sub}</div>` : ""}</div>`;

  const picker = html`<form method="get" action="/model/compare" class="cmp-pick">
    <label>Baseline <select name="a" aria-label="Baseline">${opts(a)}</select></label>
    <span class="cmp-vs">vs</span>
    <label>Compare <select name="b" aria-label="Compare against">${opts(b)}</select></label>
    <button class="btn sm" type="submit">Compare</button>
    <a class="btn sm ghost" href="/model/compare?a=${b}&b=${a}" title="Swap the two sides">&#8646; Swap</a>
  </form>`;

  const noPlans = plans.length === 0;
  const same = String(a) === String(b);

  const yearRows = diff.years.map((y) => html`<tr>
    <td class="rowhead">${y.year}${y.months < 12 ? html` <span class="muted">(${y.months} mo)</span>` : ""}</td>
    <td class="num">${n0(y.aHeadcount)}</td>
    <td class="num">${n0(y.bHeadcount)}</td>
    <td class="num ${deltaClass(y.dHeadcount)}">${y.dHeadcount === 0 ? "—" : signed(y.dHeadcount, n0)}</td>
    <td class="num">${money(y.aCost)}</td>
    <td class="num">${money(y.bCost)}</td>
    <td class="num ${deltaClass(y.dCost)}">${y.dCost === 0 ? "—" : signed(y.dCost, money)}</td>
    <td class="num ${deltaClass(y.dCost)}">${pctCell(y.pctCost)}</td>
  </tr>`);

  const deptRows = diff.departments.map((d) => html`<tr>
    <td class="rowhead">${d.department}</td>
    <td class="num">${money(d.aCost)}</td>
    <td class="num">${money(d.bCost)}</td>
    <td class="num ${deltaClass(d.dCost)}">${d.dCost === 0 ? "—" : signed(d.dCost, money)}</td>
    <td class="num ${deltaClass(d.dCost)}">${pctCell(d.pctCost)}</td>
  </tr>`);

  const body = html`
    <div class="hm-line">Compare plans <span class="muted">${diff.aLabel} vs ${diff.bLabel} · fully loaded · one aligned window</span></div>
    ${picker}
    ${noPlans ? html`<div class="card"><p class="muted">There's nothing to compare yet — create a plan from the sidebar and it'll show up here.</p></div>` : ""}
    ${same ? html`<div class="flash warn">Both sides are the same thing, so every difference is zero. Pick two different plans.</div>` : ""}
    <div class="kpis">
      ${kpi("Total cost, whole window", money(t.bCost), diff.bLabel)}
      ${kpi("vs baseline", t.dCost === 0 ? "—" : signed(t.dCost, money), `${pctCell(t.pctCost)} vs ${diff.aLabel}`)}
      ${kpi("Headcount at the end", n0(t.bEndHeadcount), `${t.dEndHeadcount === 0 ? "same as" : signed(t.dEndHeadcount, n0) + " vs"} ${diff.aLabel}`)}
      ${kpi("Peak headcount", n0(t.bPeakHeadcount), `${diff.aLabel}: ${n0(t.aPeakHeadcount)}`)}
    </div>
    ${chart(diff)}

    <h2 class="sum-h">By year</h2>
    <div class="sheet-wrap">
      <table id="cmp-years" class="sheet summary">
        <thead>
          <tr>
            <th class="rowhead" rowspan="2">Year</th>
            <th class="num" colspan="3">Year-end headcount</th>
            <th class="num" colspan="4">Fully-loaded cost</th>
          </tr>
          <tr>
            <th class="num">${diff.aLabel}</th><th class="num">${diff.bLabel}</th><th class="num">Δ</th>
            <th class="num">${diff.aLabel}</th><th class="num">${diff.bLabel}</th><th class="num">Δ</th><th class="num">%</th>
          </tr>
        </thead>
        <tbody>${yearRows}</tbody>
        <tfoot><tr>
          <td class="rowhead"><b>Whole window</b></td>
          <td class="num">${n0(t.aEndHeadcount)}</td>
          <td class="num">${n0(t.bEndHeadcount)}</td>
          <td class="num ${deltaClass(t.dEndHeadcount)}">${t.dEndHeadcount === 0 ? "—" : signed(t.dEndHeadcount, n0)}</td>
          <td class="num">${money(t.aCost)}</td>
          <td class="num">${money(t.bCost)}</td>
          <td class="num ${deltaClass(t.dCost)}">${t.dCost === 0 ? "—" : signed(t.dCost, money)}</td>
          <td class="num ${deltaClass(t.dCost)}">${pctCell(t.pctCost)}</td>
        </tr></tfoot>
      </table>
    </div>

    <h2 class="sum-h">By department <span class="hint">total cost across the window, biggest swing first</span></h2>
    <div class="sheet-wrap">
      <table id="cmp-depts" class="sheet summary">
        <thead><tr>
          <th class="rowhead">Department</th>
          <th class="num">${diff.aLabel}</th><th class="num">${diff.bLabel}</th><th class="num">Δ</th><th class="num">%</th>
        </tr></thead>
        <tbody>${deptRows.length ? deptRows : html`<tr><td class="rowhead">—</td><td colspan="4" class="muted">No departments yet.</td></tr>`}</tbody>
      </table>
    </div>`;

  return renderPage(ctx, { title: "Compare plans", body, active: "compare" });
}
