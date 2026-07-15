import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, money } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canUseAssistant } from "../authz.js";
import { getSettings } from "../repos/settings.js";
import { headcountRollup } from "../repos/seats.js";
import { getDepartmentTargets } from "../repos/targets.js";
import { listEmployees } from "../repos/roster.js";
import { allReconciliation } from "../repos/budgets.js";
import { mixVsTarget } from "../domain/philosophy.js";
import { clientFromConfig, answerQuestion } from "../domain/assistant.js";
import { logAudit } from "../repos/audit.js";
import { buildHeadcountModel } from "../domain/model.js";
import { computeMetrics, metricsText } from "../domain/metrics.js";
import { listPlans } from "../repos/plans.js";

const assistReady = (ctx) => Boolean(ctx.config.aiImportConfigured);

/** Suggested starter prompts (each is its own form so it works without JS). */
const QUICK = [
  ["Recommend the top 3 things we should improve about our headcount plan right now.", "Recommend improvements"],
  ["Which departments are over or under their target balance, and what should we do about it?", "Over / under target?"],
  ["What are our biggest budget risks given the current plan?", "Budget risks"],
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
      const reason = (e && e.message ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 220);
      console.error(`[assistant] ask failed: ${reason}`);
      // Keep upstream provider/endpoint detail server-side; the client gets a generic message.
      return ctx.json(200, { error: "The assistant hit an error. Please try again." });
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
      const reason = (e && e.message ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 220);
      console.error(`[assistant] answer failed: ${reason}`);
      // Keep upstream provider/endpoint detail server-side; the user gets a generic message.
      ctx.html(200, page(ctx, { question, error: "The assistant hit an error. Please try again." }));
    }
  });
}

/**
 * Assemble AGGREGATE context for the assistant: department counts, target mix,
 * and company budgets. Deliberately excludes individual names and salaries — only
 * totals and per-department roll-ups are included.
 */
export function buildAssistantContext(db) {
  const s = getSettings(db);
  const roll = headcountRollup(db);
  const targets = getDepartmentTargets(db);
  const emps = listEmployees(db, {});
  const rec = allReconciliation(db);

  // Pre-computed background analytics (per-department averages, ranges, ratios,
  // multiples, tenure, multi-year model) — the single source the assistant reads.
  const metrics = computeMetrics({ employees: emps, settings: s, rollup: roll, reconciliation: rec, now: new Date() });

  // department mix vs the target balance (philosophy)
  const actualByDept = {}; for (const d of roll.departments) actualByDept[d.department] = d.active;
  const targetByDept = {}; for (const [k, v] of Object.entries(targets)) targetByDept[k] = v.target_pct;
  const mixLines = mixVsTarget(actualByDept, targetByDept)
    .filter((m) => m.targetPct != null)
    .map((m) => `  - ${m.name}: ${m.actualPct}% vs ${m.targetPct}% target (${m.variance > 0 ? "+" : ""}${m.variance})`)
    .join("\n");

  let planNames = [];
  try { planNames = listPlans(db).map((p) => p.name); } catch { /* ignore */ }

  return [
    `Company stage: ${s.company_phase}; industry: ${s.industry || "general"}.`,
    metricsText(metrics),
    mixLines ? `Department headcount mix vs target:\n${mixLines}` : ``,
    planNames.length ? `Saved plan versions: ${planNames.join(", ")}.` : ``,
    ``,
    `Everything above is pre-computed aggregate analytics (averages, medians, ranges, ratios, multiples, per-department breakdowns, budgets, and the multi-year model). Answer directly from it. You do NOT have individual salaries tied to a specific person's name — decline only that.`,
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
      <b>aggregate</b> figures only (department counts, targets, budgets) — never individual salaries or names.</p>
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
