/**
 * The "P&L" tab (plan-scoped). Left: the levers you set — expected benefit per head and
 * ramp months per department, plus a quota over a chosen set of departments. Right: what
 * they produce — benefit / cost / net per department, quota attainment, and a
 * cumulative-net line (the payback curve). Server-rendered SVG chart; no third-party JS.
 */
import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "./ui.js";

const pct = (v) => (v == null ? "—" : Math.round(v * 1000) / 10 + "%");
const netClass = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");

/** Cumulative-net curve over the plan window; where it crosses zero is payback. */
function chart(pnl) {
  const cum = pnl.total.cumNet || [];
  const cols = pnl.cols || [];
  if (cum.length < 2) return "";
  const W = 720, H = 220, L = 64, R = 16, T = 16, B = 28;
  const max = Math.max(1, ...cum), min = Math.min(0, ...cum);
  const span = max - min || 1;
  const x = (i) => L + (i * (W - L - R)) / (cum.length - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - min) / span);
  const pts = cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0).toFixed(1);
  // A few x labels so the axis is readable without crowding.
  const step = Math.max(1, Math.ceil(cols.length / 8));
  const ticks = cols.map((c, i) => ({ c, i })).filter((o) => o.i % step === 0);
  return html`<figure class="cmp-chart">
    <figcaption class="cmp-cap">Cumulative net (benefit − cost) over the plan. Where the line crosses zero is payback.</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative net over the plan">
      ${raw(`<line class="grid" x1="${L}" y1="${zeroY}" x2="${W - R}" y2="${zeroY}"></line>`)}
      ${raw(`<text class="tick" x="${L - 8}" y="${Number(zeroY) + 3}" text-anchor="end">$0</text>`)}
      ${raw(`<text class="tick" x="${L - 8}" y="${(T + 4).toFixed(1)}" text-anchor="end">${esc(moneyShort(max))}</text>`)}
      ${min < 0 ? raw(`<text class="tick" x="${L - 8}" y="${(H - B).toFixed(1)}" text-anchor="end">${esc(moneyShort(min))}</text>`) : ""}
      ${ticks.map((o) => raw(`<text class="tick" x="${x(o.i).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${esc(o.c.fullLabel)}</text>`))}
      ${raw(`<polyline class="ln b" points="${pts}"/>`)}
    </svg>
  </figure>`;
}

export function pnlPage(ctx, { plan, plans, pnl, config }) {
  const opts = plans.map((p) => raw(`<option value="${p.id}" ${plan && String(p.id) === String(plan.id) ? "selected" : ""}>${esc(p.name)}</option>`));
  const picker = html`<form method="get" action="/model/pnl" class="cmp-pick">
    <label>Plan <select name="version" aria-label="Plan" onchange="this.form.submit()">${opts}</select></label>
    <noscript><button class="btn sm" type="submit">View</button></noscript>
  </form>`;

  if (!plans.length) {
    return renderPage(ctx, { title: "P&L", active: "pnl", body: html`
      <div class="hm-line">P&amp;L <span class="muted">benefit vs cost, per department, per scenario</span></div>
      <div class="card"><p class="muted">Create a plan first — the P&amp;L is modelled on a plan (scenario). Add one from the Model sidebar.</p></div>` });
  }
  if (!plan) {
    return renderPage(ctx, { title: "P&L", active: "pnl", body: html`
      <div class="hm-line">P&amp;L <span class="muted">benefit vs cost, per department, per scenario</span></div>
      ${picker}
      <div class="card"><p class="muted">Pick a plan to model its benefit and P&amp;L.</p></div>` });
  }

  const canEdit = ctx.pnlCanEdit;
  const byDept = config.byDept || {};
  const included = new Set((config.quota && config.quota.departments) || []);

  // Inputs: one row per department (benefit per head + ramp), then the quota.
  const inputRows = pnl.departments.map((d) => {
    const lv = byDept[d] || {};
    return html`<tr>
      <td class="rowhead">${d}</td>
      <td class="num"><input type="number" min="0" step="any" name="perhead_${esc(d)}" value="${lv.perHead || ""}" ${canEdit ? "" : "readonly"} aria-label="Benefit per head for ${d}"></td>
      <td class="num"><input type="number" min="1" max="120" step="1" name="ramp_${esc(d)}" value="${lv.rampMonths || ""}" placeholder="1" ${canEdit ? "" : "readonly"} aria-label="Ramp months for ${d}"></td>
      <td class="num"><label class="inline"><input type="checkbox" name="quota_dept" value="${esc(d)}" ${included.has(d) ? "checked" : ""} ${canEdit ? "" : "disabled"}> count</label></td>
    </tr>`;
  });
  const inputs = html`<form method="post" action="/model/pnl/${plan.id}" class="card pnl-inputs">
    ${csrfField(ctx)}
    <h2>Levers <span class="hint">what a head is worth, and how fast it ramps</span></h2>
    <div class="sheet-wrap"><table class="sheet summary">
      <thead><tr><th class="rowhead">Department</th><th class="num">Benefit / head (annual $)</th><th class="num">Ramp (months)</th><th class="num">In quota?</th></tr></thead>
      <tbody>${inputRows}</tbody>
    </table></div>
    <div class="pnl-quota">
      <label>Quota (annual $) <input type="number" min="0" step="any" name="quota_amount" value="${(config.quota && config.quota.amount) || ""}" ${canEdit ? "" : "readonly"}></label>
      <span class="muted small">Attainment = benefit from the checked departments over the next 12 months ÷ quota.</span>
    </div>
    ${canEdit ? html`<button class="btn" type="submit">Save levers</button>` : ""}
  </form>`;

  // Outputs.
  const t = pnl.total;
  const kpi = (label, val, sub = "") => html`<div class="kpi"><div class="lbl">${label}</div><div class="val">${val}</div>${sub ? html`<div class="lbl">${sub}</div>` : ""}</div>`;
  const att = pnl.quota.attainment;
  const kpis = html`<div class="kpis">
    ${kpi("Net, next 12 mo", money(t.net12), `${money(t.benefit12)} benefit − ${money(t.cost12)} cost`)}
    ${kpi("Net, whole plan", money(t.netTotal), t.netTotal >= 0 ? "profitable over the window" : "underwater over the window")}
    ${kpi("Quota attainment", pct(att), pnl.quota.amount ? `${money(pnl.quota.includedBenefit12)} of ${money(pnl.quota.amount)}` : "set a quota below")}
  </div>`;

  const outRows = pnl.perDept.map((d) => html`<tr>
    <td class="rowhead">${d.department}</td>
    <td class="num">${money(d.benefit12)}</td>
    <td class="num">${money(d.cost12)}</td>
    <td class="num ${netClass(d.net12)}">${money(d.net12)}</td>
    <td class="num ${netClass(d.netTotal)}">${money(d.netTotal)}</td>
  </tr>`);
  const outputs = html`
    ${kpis}
    ${chart(pnl)}
    <h2 class="sum-h">By department <span class="hint">next 12 months, and whole-plan net</span></h2>
    <div class="sheet-wrap"><table class="sheet summary">
      <thead><tr><th class="rowhead">Department</th><th class="num">Benefit (12mo)</th><th class="num">Cost (12mo)</th><th class="num">Net (12mo)</th><th class="num">Net (plan)</th></tr></thead>
      <tbody>${outRows}</tbody>
      <tfoot><tr>
        <td class="rowhead"><b>Total</b></td>
        <td class="num">${money(t.benefit12)}</td>
        <td class="num">${money(t.cost12)}</td>
        <td class="num ${netClass(t.net12)}">${money(t.net12)}</td>
        <td class="num ${netClass(t.netTotal)}">${money(t.netTotal)}</td>
      </tr></tfoot>
    </table></div>`;

  return renderPage(ctx, { title: "P&L", active: "pnl", body: html`
    <div class="hm-line">P&amp;L <span class="muted">${esc(plan.name)} · benefit vs cost, per department</span></div>
    ${picker}
    ${ctx.query.get("msg") ? "" : ""}
    <div class="pnl-grid">
      <div class="pnl-col-in">${inputs}</div>
      <div class="pnl-col-out">${outputs}</div>
    </div>` });
}
