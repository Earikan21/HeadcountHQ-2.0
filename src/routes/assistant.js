import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, money } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canUseAssistant } from "../authz.js";
import { getSettings } from "../repos/settings.js";
import { headcountRollup } from "../repos/seats.js";
import { getDepartmentTargets } from "../repos/targets.js";
import { listEmployees } from "../repos/roster.js";
import { allReconciliation } from "../repos/budgets.js";
import { getFinancials } from "../repos/planning.js";
import { mixVsTarget } from "../domain/philosophy.js";
import { clientFromConfig, answerQuestion } from "../domain/assistant.js";
import { logAudit } from "../repos/audit.js";
import { buildHeadcountModel } from "../domain/model.js";
import { listPlans } from "../repos/plans.js";

const assistReady = (ctx) => Boolean(ctx.config.aiImportConfigured);

/** Suggested starter prompts (each is its own form so it works without JS). */
const QUICK = [
  ["Recommend the top 3 things we should improve about our headcount plan right now.", "Recommend improvements"],
  ["Which departments are over or under their target balance, and what should we do about it?", "Over / under target?"],
  ["What are our biggest budget or runway risks given the current plan?", "Budget & runway risks"],
];

export function registerAssistantRoutes(router) {
  router.get("/assistant", (ctx) => {
    if (!requirePermission(ctx, canUseAssistant)) return;
    ctx.html(200, page(ctx, {}));
  });

  // JSON endpoint powering the floating assistant widget (Directive 4.0).
  router.post("/assistant/ask", async (ctx) => {
    if (!requirePermission(ctx, canUseAssistant)) return;
    const q = String(ctx.body.question || "").trim();
    if (!q) return ctx.json(200, { error: "Type a question first." });
    if (!assistReady(ctx)) return ctx.json(200, { error: "The assistant isn't configured yet — a provider key must be set on the server." });
    try {
      const client = clientFromConfig(ctx.config);
      const answer = await answerQuestion({ question: q, context: buildAssistantContext(ctx.db), client });
      logAudit(ctx.db, { userId: ctx.user.id, action: "assistant.asked", entity: "assistant", detail: { chars: q.length } });
      return ctx.json(200, { answer });
    } catch (e) {
      console.error(`[assistant] ask failed: ${e && e.message ? e.message : e}`);
      return ctx.json(200, { error: "The assistant couldn't answer just now — please try again." });
    }
  });

  router.post("/assistant", async (ctx) => {
    if (!requirePermission(ctx, canUseAssistant)) return;
    const question = String(ctx.body.question || "").trim();
    if (!question) return ctx.html(200, page(ctx, {}));
    if (!assistReady(ctx)) return ctx.html(200, page(ctx, { question, error: "The assistant is off. A Finance Admin can enable it under Philosophy." }));
    const context = buildAssistantContext(ctx.db);
    try {
      const client = clientFromConfig(ctx.config);
      const answer = await answerQuestion({ question, context, client });
      logAudit(ctx.db, { userId: ctx.user.id, action: "assistant.asked", entity: "assistant", detail: { chars: question.length } });
      ctx.html(200, page(ctx, { question, answer }));
    } catch (e) {
      console.error(`[assistant] answer failed: ${e && e.message ? e.message : e}`);
      ctx.html(200, page(ctx, { question, error: "The assistant couldn't answer just now — please try again." }));
    }
  });
}

/**
 * Assemble AGGREGATE context for the assistant: department counts, target mix,
 * company budgets, and runway. Deliberately excludes individual names and
 * salaries — only totals and per-department roll-ups are included.
 */
export function buildAssistantContext(db) {
  const s = getSettings(db);
  const roll = headcountRollup(db);
  const targets = getDepartmentTargets(db);
  const emps = listEmployees(db, {});
  const totalBase = emps.reduce((a, e) => a + (e.annual_salary || 0), 0);
  const mult = Number(s.loaded_cost_multiplier) || 1.3;
  const loaded = Math.round(totalBase * mult);
  const rec = allReconciliation(db);
  const fin = getFinancials(db);
  const runway = Number(fin.monthly_burn) > 0 ? Math.floor(Number(fin.cash_balance) / Number(fin.monthly_burn)) : null;

  const actualByDept = {};
  for (const d of roll.departments) actualByDept[d.department] = d.active;
  const targetByDept = {};
  for (const [k, v] of Object.entries(targets)) targetByDept[k] = v.target_pct;
  const mix = mixVsTarget(actualByDept, targetByDept);

  // per-department compensation (aggregate — averages, totals, and ranges; never individuals)
  const compByDept = {};
  for (const e of emps) {
    const d = e.department_name || "(none)";
    const sal = e.annual_salary || 0;
    if (!compByDept[d]) compByDept[d] = { sum: 0, n: 0, min: Infinity, max: 0 };
    const cd = compByDept[d];
    cd.sum += sal; cd.n += 1;
    if (sal > 0) { cd.min = Math.min(cd.min, sal); cd.max = Math.max(cd.max, sal); }
  }
  const deptLines = roll.departments.map((d) => {
    const m = mix.find((x) => x.name === d.department) || {};
    const t = m.targetPct != null ? `, ${m.actualPct}% of headcount vs ${m.targetPct}% target (${m.variance > 0 ? "+" : ""}${m.variance})` : "";
    const c = compByDept[d.department];
    const comp = c && c.n ? `, avg base ${money(Math.round(c.sum / c.n))}, range ${money(c.min === Infinity ? 0 : c.min)}\u2013${money(c.max)}, dept base total ${money(Math.round(c.sum))}, loaded ${money(Math.round(c.sum * mult))}` : "";
    return `- ${d.department}: ${d.active} filled, ${d.approved} approved${t}${comp}`;
  }).join("\n");

  // company-wide salary distribution (aggregate)
  const sals = emps.map((e) => e.annual_salary || 0).filter((x) => x > 0).sort((a, b) => a - b);
  const avgSal = sals.length ? Math.round(sals.reduce((a, b) => a + b, 0) / sals.length) : 0;
  const median = sals.length ? sals[Math.floor(sals.length / 2)] : 0;

  // employment type / status breakdown
  const byType = {}, byStatus = {};
  for (const e of emps) {
    const ty = e.employee_type || "unspecified"; byType[ty] = (byType[ty] || 0) + 1;
    const st = e.employment_status || "unspecified"; byStatus[st] = (byStatus[st] || 0) + 1;
  }
  const typeLine = Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a";
  const statusLine = Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a";

  // forward financial model — fully-loaded cost by year (built from start dates, 5-year horizon)
  let modelLines = "  (no roster yet)";
  try {
    const model = buildHeadcountModel({ employees: emps, loadedMultiplier: mult });
    if (model.years.length) modelLines = model.years.map((y) => `  - ${y.year}: end headcount ${y.yearEndHc}, fully-loaded ${money(y.totalCost)}, avg loaded/head ${money(y.avgCostPerHead)}`).join("\n");
  } catch { /* ignore */ }

  let planNames = [];
  try { planNames = listPlans(db).map((p) => p.name); } catch { /* ignore */ }

  return [
    `Company stage: ${s.company_phase}; industry: ${s.industry || "general"}. Fully-loaded multiplier: ${mult}x (base + benefits/taxes).`,
    `Headcount: ${roll.totals.active} filled, ${roll.totals.approved} approved, ${roll.totals.open} open. Types: ${typeLine}. Status: ${statusLine}.`,
    `Company base comp ${money(totalBase)}; fully-loaded ${money(loaded)}. Base salary distribution: min ${money(sals[0] || 0)}, avg ${money(avgSal)}, median ${money(median)}, max ${money(sals[sals.length - 1] || 0)}.`,
    `Headcount budget: ${rec.allocation.headcount.cap || "not set"} (allocated ${rec.allocation.headcount.allocated}). Money budget: ${rec.allocation.money.cap ? money(rec.allocation.money.cap) : "not set"}; committed ${money(rec.company.money.committed)}.`,
    fin.cash_balance ? `Cash ${money(fin.cash_balance)}; monthly burn ${money(fin.monthly_burn)}; runway ${runway != null ? runway + " months" : "n/a"}.` : `Financials (cash/burn) not entered yet.`,
    planNames.length ? `Saved plan versions: ${planNames.join(", ")}.` : ``,
    ``,
    `Departments (filled / approved / target mix / compensation):`,
    deptLines || "(no departments yet)",
    ``,
    `Financial model — fully-loaded cost by year:`,
    modelLines,
    ``,
    `You have ALL aggregate figures above, including per-department average and range of pay, salary distribution, budgets, runway, and the year-by-year model. You do NOT have individual salaries tied to a specific person's name — decline only that.`,
  ].join("\n");
}

function page(ctx, { question, answer, error }) {
  const ready = assistReady(ctx);
  const quickForms = QUICK.map(([q, label]) => html`<form method="post" action="/assistant" class="inline">
      ${csrfField(ctx)}<input type="hidden" name="question" value="${esc(q)}">
      <button class="btn ghost sm" type="submit" ${ready ? "" : "disabled"}>${label}</button>
    </form>`);

  const answerCard = (answer || error)
    ? html`<section class="card">
        ${question ? html`<p class="muted small">You asked: <i>${esc(question)}</i></p>` : ""}
        ${error ? html`<div class="flash warn">${error}</div>` : html`<div class="assistant-answer">${raw(answerHtml(answer))}</div>`}
      </section>`
    : "";

  const body = html`
    <div class="pagehead"><h1>Assistant</h1>
      <p class="muted">Ask about your headcount, budget, and plan — and get recommendations. It reads
      <b>aggregate</b> figures only (department counts, targets, budgets, runway) — never individual salaries or names.</p>
    </div>
    ${ready ? "" : html`<div class="flash warn">The assistant is currently off. A Finance Admin can turn it on under <a href="/philosophy">Philosophy → AI assistant</a> (a provider key must be configured).</div>`}
    <section class="card">
      <form method="post" action="/assistant">
        ${csrfField(ctx)}
        <label>Ask a question or request a recommendation
          <textarea name="question" rows="3" placeholder="e.g. Are we over-invested in any function? What should we prioritize next quarter?" ${ready ? "" : "disabled"}>${esc(question || "")}</textarea></label>
        <div class="actions" style="margin-top:10px">
          <button class="btn" type="submit" ${ready ? "" : "disabled"}>Ask</button>
        </div>
      </form>
      <div class="quickrow" style="margin-top:12px">
        <span class="muted small">Try:</span> ${quickForms}
      </div>
    </section>
    ${answerCard}`;
  return renderPage(ctx, { title: "Assistant", body, active: "assistant" });
}

/** Render the assistant's plain-text answer into safe HTML (paragraphs + simple lists). */
function answerHtml(text) {
  const lines = String(text || "").split(/\r?\n/);
  let out = "", inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (inList) { out += "</ul>"; inList = false; } continue; }
    const li = t.match(/^([-*]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += `<li>${esc(li[2])}</li>`;
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      out += `<p>${esc(t)}</p>`;
    }
  }
  if (inList) out += "</ul>";
  return out;
}
