/**
 * Reimagined Overview dashboard (Directive 4.0) for a fractional-CFO headcount/cost
 * console. Replaces the HQ-1.0 target-balance + budget cards with a date-anchored
 * KPI strip, a headcount + fully-loaded-cost trend (server-rendered SVG, actual +
 * plan), cost-by-department shares, a plan comparison, and auto-insights. All figures
 * come from the pre-computed metrics layer.
 */
import { html, raw } from "../html.js";
import { money, moneyShort } from "./ui.js";

const kpiCard = (k) => html`<div class="kpi"><div class="lbl">${k.label}</div><div class="val">${k.value}</div>${k.sub ? html`<div class="lbl">${k.sub}</div>` : ""}</div>`;

function trendSvg(years, nowYear) {
  if (!years || years.length < 2) return raw('<p class="muted small">Add a roster with start dates to see the trend.</p>');
  const W = 640, pad = 12, n = years.length;
  const maxHc = Math.max(1, ...years.map((y) => y.headcount));
  const maxCost = Math.max(1, ...years.map((y) => y.cost));
  const X = (i) => pad + (i * (W - 2 * pad)) / (n - 1);
  const YH = (v) => 138 - (v / maxHc) * 112;
  const YC = (v) => 138 - (v / maxCost) * 112;
  const area = `M ${X(0)} 138 ` + years.map((y, i) => `L ${X(i).toFixed(1)} ${YC(y.cost).toFixed(1)}`).join(" ") + ` L ${X(n - 1)} 138 Z`;
  const hcActual = years.map((y, i) => (y.year <= nowYear ? `${X(i).toFixed(1)},${YH(y.headcount).toFixed(1)}` : null)).filter(Boolean).join(" ");
  const hcPlanned = years.map((y, i) => (y.year >= nowYear ? `${X(i).toFixed(1)},${YH(y.headcount).toFixed(1)}` : null)).filter(Boolean).join(" ");
  const nowI = years.findIndex((y) => y.year === nowYear);
  const nowX = (nowI >= 0 ? X(nowI) : W / 2).toFixed(1);
  return raw(`<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="Headcount and fully-loaded cost trend, actual then planned">
    <path d="${area}" fill="var(--brand-soft)"></path>
    <polyline points="${hcActual}" fill="none" stroke="var(--brand)" stroke-width="2.5"></polyline>
    <polyline points="${hcPlanned}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-dasharray="5 4" opacity="0.7"></polyline>
    <line x1="${nowX}" y1="6" x2="${nowX}" y2="140" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 3"></line>
    <text x="12" y="148" font-size="9" fill="var(--muted)">${years[0].year}</text>
    <text x="${nowX - 8}" y="148" font-size="9" fill="var(--muted)">now</text>
    <text x="${W - 30}" y="148" font-size="9" fill="var(--muted)">${years[n - 1].year}</text>
  </svg>`);
}

export function overviewDashboard(ctx, data) {
  const { greeting, roleLine, kpis, trendYears, nowYear, deptBars, planRows, targetYear, insights } = data;

  const bars = deptBars.length ? deptBars.map((d) => html`<div class="ov-bar">
      <div class="ov-bar-top"><span>${d.name}</span><span class="muted">${d.pct}% · ${moneyShort(d.cost)}</span></div>
      <div class="ov-bar-track"><i style="width:${Math.max(2, d.pct)}%"></i></div>
    </div>`) : html`<p class="muted small">Import a roster to see cost by department.</p>`;

  const planTable = html`<table class="table"><thead><tr><th>Plan</th><th class="right">HC ${targetYear}</th><th class="right">Cost</th></tr></thead>
    <tbody>${planRows.map((p) => html`<tr><td>${p.name}</td><td class="right">${p.hc}</td><td class="right">${money(p.cost)}</td></tr>`)}</tbody></table>`;

  return html`
    <div class="pagehead"><h1>${greeting}</h1><p class="muted">${roleLine}</p></div>
    <div class="kpis model-kpis">${kpis.map(kpiCard)}</div>

    <section class="card">
      <div class="row-between"><h2>Headcount &amp; fully-loaded cost</h2><span class="muted small">actual + plan · <a href="/model">open model →</a></span></div>
      ${trendSvg(trendYears, nowYear)}
    </section>

    <div class="grid2">
      <section class="card">
        <h2>Fully-loaded cost by department</h2>
        <div class="ov-bars">${bars}</div>
      </section>
      <section class="card">
        <div class="row-between"><h2>Plans</h2><span class="muted small"><a href="/model">edit →</a></span></div>
        ${planTable}
      </section>
    </div>

    ${insights.length ? html`<section class="card ov-insights">
      <h2>Auto insights</h2>
      <ul class="plainlist">${insights.map((s) => html`<li>${s}</li>`)}</ul>
    </section>` : ""}`;
}
