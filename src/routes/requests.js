import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, errorList, money, moneyRange } from "../views/ui.js";
import { requireAuth, requirePermission } from "../middleware.js";
import { canCreateRequest, canApproveRequests, departmentScope, canSeeAllDepartments, canViewDepartment } from "../authz.js";
import * as RQ from "../domain/requests.js";
import * as BUD from "../domain/budget.js";
import { mixVsTarget } from "../domain/philosophy.js";
import { createRequest, getRequest, listRequests, statusHistory, setStatus } from "../repos/requests.js";
import { departmentReconciliation, departmentUsage, getEnvelope } from "../repos/budgets.js";
import { listDepartments, getDepartment } from "../repos/departments.js";
import { getSettings } from "../repos/settings.js";
import { headcountRollup } from "../repos/seats.js";
import { getDepartmentTargets } from "../repos/targets.js";
import { createSeat, getSeat } from "../repos/seats.js";
import { clientFromConfig, draftJustification, estimateRole } from "../domain/assistant.js";
import { logAudit } from "../repos/audit.js";

const STATUS_PILL = {
  submitted: '<span class="pill">Submitted</span>',
  under_review: '<span class="pill warn2">Under review</span>',
  approved: '<span class="pill ok2">Approved</span>',
  deferred: '<span class="pill warn2">Deferred</span>',
  declined: '<span class="pill off">Declined</span>',
};
const TYPE_LABEL = { net_new: "Net-new", backfill: "Backfill" };

/** AI assistant available (configured + toggled on)? */
const assistReady = (ctx) => Boolean(ctx.config.aiImportConfigured) && Boolean(getSettings(ctx.db).ai_assistant_enabled);

/** A short "this dept is X% under/over target" note to ground a justification. */
function deptTargetNote(db, deptId) {
  const dept = getDepartment(db, deptId);
  if (!dept) return "";
  const roll = headcountRollup(db);
  const targets = getDepartmentTargets(db);
  const actualByDept = {}, targetByDept = {};
  for (const d of roll.departments) actualByDept[d.department] = d.active;
  for (const [k, v] of Object.entries(targets)) targetByDept[k] = v.target_pct;
  const m = mixVsTarget(actualByDept, targetByDept).find((x) => x.name === dept.name);
  if (!m || m.targetPct == null) return "";
  const dir = m.variance < 0 ? `${Math.abs(m.variance)}% UNDER` : `${m.variance}% OVER`;
  return `${dept.name} is ${dir} its headcount target (${m.actualPct}% actual vs ${m.targetPct}% target).`;
}

/** Which department a request is filed against, honoring the requester's scope. */
function pickRequestDept(scope, formDeptId) {
  if (scope == null) return Number(formDeptId);   // company-wide role: any department
  if (scope.length === 1) return scope[0];         // owns exactly one
  const chosen = Number(formDeptId);               // owns several: must pick one they own
  return scope.includes(chosen) ? chosen : NaN;
}

export function registerRequestRoutes(router) {
  router.get("/requests", (ctx) => {
    if (!requireAuth(ctx)) return;
    const scope = departmentScope(ctx.user);
    const requests = listRequests(ctx.db, { departmentId: scope });
    ctx.html(200, listPage(ctx, { requests }));
  });

  router.get("/requests/new", (ctx) => {
    if (!requirePermission(ctx, canCreateRequest)) return;
    ctx.html(200, formPage(ctx, { form: {} }));
  });

  router.post("/requests", async (ctx) => {
    if (!requirePermission(ctx, canCreateRequest)) return;
    const scope = departmentScope(ctx.user);
    const form = ctx.body;
    const action = String(form.action || "submit");
    // A collaborator files for one of THEIR departments; company-wide roles pick any.
    const departmentId = pickRequestDept(scope, form.department_id);

    // ---- AI assist actions: draft justification / estimate band, then re-render ----
    if (action === "ai_justify" || action === "ai_estimate") {
      if (!assistReady(ctx)) return ctx.html(200, formPage(ctx, { form, notice: "The assistant is off — a Finance Admin can enable it under Philosophy." }));
      const dept = getDepartment(ctx.db, departmentId);
      const s = getSettings(ctx.db);
      const client = clientFromConfig(ctx.config);
      try {
        if (action === "ai_estimate") {
          if (!String(form.title || "").trim()) return ctx.html(200, formPage(ctx, { form, notice: "Add a role / title first, then estimate." }));
          const est = await estimateRole({ title: form.title, department: dept?.name || "", phase: s.company_phase, industry: s.industry, client });
          const merged = { ...form, band_min: est.band_min, band_max: est.band_max };
          return ctx.html(200, formPage(ctx, { form: merged, notice: `Estimated band ${money(est.band_min)}–${money(est.band_max)}. ${est.rationale} — rough estimate, adjust as needed.` }));
        }
        const draft = await draftJustification({
          role: form.title, department: dept?.name || "", type: form.type,
          justification: form.justification, current: form.current_hc_narrative, desired: form.new_hc_narrative,
          targetNote: deptTargetNote(ctx.db, departmentId), client,
        });
        const merged = { ...form, ...draft };
        return ctx.html(200, formPage(ctx, { form: merged, notice: "Drafted with AI — review and edit before submitting." }));
      } catch (e) {
        console.error(`[assistant] ${action} failed: ${e && e.message ? e.message : e}`);
        return ctx.html(200, formPage(ctx, { form, notice: "The assistant couldn't help just now — try again, or fill it in manually." }));
      }
    }

    const candidate = {
      department_id: departmentId,
      title: form.title, type: form.type,
      band_min: form.band_min, band_max: form.band_max,
      target_start_month: form.target_start_month,
      justification: form.justification,
      current_hc_narrative: form.current_hc_narrative,
      new_hc_narrative: form.new_hc_narrative,
      expected_value_basis: form.expected_value_basis,
      expected_value_amount: form.expected_value_amount || null,
    };
    const problems = RQ.requestProblems(candidate);
    if (!getDepartment(ctx.db, departmentId)) problems.push("Choose a valid department.");
    if (problems.length) return ctx.html(400, formPage(ctx, { form, errors: problems }));

    const mult = getSettings(ctx.db).loaded_cost_multiplier;
    const est = RQ.estimatedCost(candidate.band_min, candidate.band_max, mult);
    const req = createRequest(ctx.db, candidate, ctx.user.id, est);
    logAudit(ctx.db, { userId: ctx.user.id, action: "request.created", entity: "hiring_request", entityId: req.id });
    ctx.redirect(`/requests/${req.id}?msg=Request+submitted`);
  });

  router.get("/requests/:id", (ctx) => {
    if (!requireAuth(ctx)) return;
    const req = getRequest(ctx.db, Number(ctx.params.id));
    if (!req) return ctx.redirect("/requests");
    if (!canViewDepartment(ctx.user, req.department_id)) {
      return ctx.send(403, "text/html; charset=utf-8", "<p style='font-family:sans-serif;padding:40px'>You don't have access to that request.</p>");
    }
    ctx.html(200, detailPage(ctx, { req }));
  });

  router.post("/requests/:id/decision", (ctx) => {
    if (!requirePermission(ctx, canApproveRequests)) return;
    const req = getRequest(ctx.db, Number(ctx.params.id));
    if (!req) return ctx.redirect("/requests");
    const action = String(ctx.body.action || "");
    const note = String(ctx.body.note || "");
    const map = { review: "under_review", approve: "approved", defer: "deferred", decline: "declined" };
    const to = map[action];
    if (!to || !RQ.canTransitionRequest(req.status, to)) {
      return ctx.html(400, detailPage(ctx, { req, errors: ["That action isn't available from the current status."] }));
    }

    if (to === "approved") {
      const settings = getSettings(ctx.db);
      const env = getEnvelope(ctx.db, req.department_id);
      const usage = departmentUsage(ctx.db, req.department_id);
      const exceed = BUD.wouldExceed(
        { headcountBudget: env.headcount_budget, moneyBudget: env.money_budget, approvedPositions: usage.approvedPositions, committedMoney: usage.committedMoney },
        1, req.estimated_cost || 0
      );
      if (BUD.approvalBlocked(settings.budget_enforcement, exceed)) {
        const why = [exceed.positionsOver ? "headcount budget" : null, exceed.moneyOver ? "money budget" : null].filter(Boolean).join(" and ");
        return ctx.html(400, detailPage(ctx, { req, errors: [`Approving this would exceed the department's ${why}. Budget enforcement is set to "hard" — raise the budget or decline.`] }));
      }
      // create the seat this approval opens
      const seat = createSeat(ctx.db, {
        departmentId: req.department_id, title: req.title, status: "open",
        loadedCost: req.estimated_cost || null, sourceRequestId: req.id,
      });
      setStatus(ctx.db, req.id, req.status, "approved", ctx.user.id, note, seat.id);
      logAudit(ctx.db, { userId: ctx.user.id, action: "request.approved", entity: "hiring_request", entityId: req.id, detail: { seatId: seat.id, overBudget: exceed.any } });
      return ctx.redirect(`/requests/${req.id}?msg=Approved+${exceed.any ? "(over+budget)" : ""}`);
    }

    setStatus(ctx.db, req.id, req.status, to, ctx.user.id, note);
    logAudit(ctx.db, { userId: ctx.user.id, action: "request." + to, entity: "hiring_request", entityId: req.id });
    ctx.redirect(`/requests/${req.id}?msg=Updated`);
  });
}

// ============ views ============
function listPage(ctx, { requests }) {
  const canCreate = canCreateRequest(ctx.user);
  const rows = requests.length ? requests.map((r) => html`<tr>
      <td><a href="/requests/${r.id}"><b>${r.title}</b></a><div class="sub">${r.department_name || "—"} · ${TYPE_LABEL[r.type] || r.type}</div></td>
      <td>${moneyRange(r.band_min, r.band_max)}</td>
      <td>${raw(STATUS_PILL[r.status] || r.status)}</td>
      <td class="muted">${r.requester_name || "—"}</td>
    </tr>`) : raw('<tr><td colspan="4" class="muted">No requests yet.</td></tr>');
  const body = html`
    <div class="pagehead row-between">
      <div><h1>Hiring requests</h1><p class="muted">Bottom-up requests to open or backfill a seat, reconciled against each department's budget.</p></div>
      ${canCreate ? html`<a class="btn" href="/requests/new">New request</a>` : ""}
    </div>
    <section class="card">
      <table class="table"><thead><tr><th>Role</th><th>Band</th><th>Status</th><th>Requester</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  return renderPage(ctx, { title: "Requests", body, active: "requests" });
}

function budgetPanel(ctx, deptId, addMoney) {
  const rec = departmentReconciliation(ctx.db, deptId);
  const p = rec.positions, m = rec.money;
  return html`<div class="flash">
    <b>Department budget fit.</b>
    Positions: <b>${p.approved}/${p.budget || "—"}</b> approved${p.pending ? html`, ${p.pending} pending` : ""}.
    Money: <b>${money(m.committed)}/${m.budget ? money(m.budget) : "—"}</b> committed${m.pending ? html`, ${money(m.pending)} pending` : ""}.
    ${addMoney != null ? html`<div class="small">This request adds 1 position${addMoney ? html` and about ${money(addMoney)} fully-loaded` : ""}.</div>` : ""}
  </div>`;
}

function formPage(ctx, { form, errors, notice }) {
  const scope = departmentScope(ctx.user);
  const depts = listDepartments(ctx.db);
  const ai = assistReady(ctx);
  const scopeOwn = scope == null ? null : depts.filter((d) => scope.includes(d.id));
  let soloDeptId = null, deptField;
  if (scope == null) {
    deptField = html`<label>Department<select name="department_id" required><option value="">Choose...</option>${depts.map((d) => html`<option value="${d.id}" ${String(form.department_id) === String(d.id) ? raw("selected") : ""}>${d.name}</option>`)}</select></label>`;
  } else if (scopeOwn.length === 1) {
    soloDeptId = scopeOwn[0].id;
    deptField = html`<input type="hidden" name="department_id" value="${soloDeptId}"><p class="muted small">Department: <b>${scopeOwn[0].name}</b></p>`;
  } else {
    deptField = html`<label>Department<select name="department_id" required><option value="">Choose...</option>${scopeOwn.map((d) => html`<option value="${d.id}" ${String(form.department_id) === String(d.id) ? raw("selected") : ""}>${d.name}</option>`)}</select></label>`;
  }
  const body = html`
    <div class="pagehead"><a class="muted small" href="/requests">← Requests</a><h1>New hiring request</h1>
      <p class="muted">Every request must be justified — including what changes with the new hire. Compensation is a <b>band</b>, not an exact salary.</p></div>
    ${errorList(errors)}
    ${notice ? html`<div class="flash ok">${notice}</div>` : ""}
    ${soloDeptId != null ? budgetPanel(ctx, soloDeptId, null) : ""}
    <form method="post" action="/requests">
      ${csrfField(ctx)}
      <section class="card">
        <h2>The role</h2>
        ${deptField}
        <label>Role / title<input name="title" value="${esc(form.title || "")}" required></label>
        <div class="formgrid">
          <label>Type
            <select name="type" required>
              <option value="">Choose…</option>
              <option value="net_new" ${form.type === "net_new" ? raw("selected") : ""}>Net-new</option>
              <option value="backfill" ${form.type === "backfill" ? raw("selected") : ""}>Backfill</option>
            </select>
          </label>
          <label>Target start (month)<input name="target_start_month" type="month" value="${esc(form.target_start_month || "")}"></label>
        </div>
        <div class="formgrid">
          <label>Comp band — min<input name="band_min" type="number" min="0" step="any" value="${esc(form.band_min || "")}"></label>
          <label>Comp band — max<input name="band_max" type="number" min="0" step="any" value="${esc(form.band_max || "")}"></label>
        </div>
        ${ai ? html`<button class="btn ghost sm" name="action" value="ai_estimate" type="submit" formnovalidate>✨ Estimate band with AI</button>` : ""}
      </section>
      <section class="card">
        <h2>Justify the hire</h2>
        <label>Business justification <span class="hint">why this role, why now</span>
          <textarea name="justification" rows="3" required>${esc(form.justification || "")}</textarea></label>
        <label>What do you do with your <b>current</b> headcount?
          <textarea name="current_hc_narrative" rows="2" required>${esc(form.current_hc_narrative || "")}</textarea></label>
        <label>What would you do with the <b>new</b> headcount? <span class="hint">the incremental benefit</span>
          <textarea name="new_hc_narrative" rows="2" required>${esc(form.new_hc_narrative || "")}</textarea></label>
        <div class="formgrid">
          <label>Basis for the expected value
            <select name="expected_value_basis">
              <option value="qualitative" ${form.expected_value_basis === "qualitative" ? raw("selected") : ""}>Qualitative</option>
              <option value="benchmark" ${form.expected_value_basis === "benchmark" ? raw("selected") : ""}>Benchmark gap (under target)</option>
              <option value="revenue_driver" ${form.expected_value_basis === "revenue_driver" ? raw("selected") : ""}>Revenue driver</option>
            </select>
          </label>
          <label>Expected $ value / year <span class="hint">optional</span><input name="expected_value_amount" type="number" min="0" step="any" value="${esc(form.expected_value_amount || "")}"></label>
        </div>
        ${ai ? html`<button class="btn ghost sm" name="action" value="ai_justify" type="submit" formnovalidate>✨ Draft / strengthen with AI</button>
          <p class="muted small" style="margin-top:4px">Uses your rough notes above (and how this department sits vs. its target). Review before submitting.</p>` : ""}
      </section>
      <button class="btn" type="submit">Submit request</button>
    </form>`;
  return renderPage(ctx, { title: "New request", body, active: "requests" });
}

function detailPage(ctx, { req, errors }) {
  const hist = statusHistory(ctx.db, req.id);
  const isApprover = canApproveRequests(ctx.user);
  const open = RQ.OPEN_STATUSES.includes(req.status);
  const valueRow = req.expected_value_amount
    ? `${money(req.expected_value_amount)}/yr (${req.expected_value_basis || "qualitative"})`
    : (req.expected_value_basis || "qualitative");

  const decision = (isApprover && open) ? html`
    <section class="card">
      <h2>Decision</h2>
      ${budgetPanel(ctx, req.department_id, req.estimated_cost || 0)}
      <form method="post" action="/requests/${req.id}/decision">
        ${csrfField(ctx)}
        <label>Note <span class="hint">optional, recorded in history</span><textarea name="note" rows="2"></textarea></label>
        <div class="actions">
          ${req.status === "submitted" ? html`<button class="btn ghost" name="action" value="review" type="submit">Move to review</button>` : ""}
          <button class="btn" name="action" value="approve" type="submit">Approve → open seat</button>
          <button class="btn ghost" name="action" value="defer" type="submit">Defer</button>
          <button class="btn ghost" name="action" value="decline" type="submit">Decline</button>
        </div>
      </form>
    </section>` : "";

  const body = html`
    <div class="pagehead row-between">
      <div><a class="muted small" href="/requests">← Requests</a>
        <h1>${req.title}</h1>
        <p class="muted">${req.department_name} · ${TYPE_LABEL[req.type] || req.type} · band ${moneyRange(req.band_min, req.band_max)} ${req.target_start_month ? "· start " + req.target_start_month : ""}</p>
      </div>
      <div>${raw(STATUS_PILL[req.status] || req.status)}</div>
    </div>
    ${errorList(errors)}
    ${req.status === "approved" && req.seat_id && getSeat(ctx.db, req.seat_id)?.status === "open"
      ? html`<div class="reveal">This request is approved and its seat is open. <a href="/roster/new?seat=${req.seat_id}"><b>Onboard the hire →</b></a></div>` : ""}
    <div class="grid2">
      <section class="card">
        <h2>Justification &amp; incremental benefit</h2>
        <p><b>Why this role:</b><br>${esc(req.justification || "—")}</p>
        <p><b>With current headcount:</b><br>${esc(req.current_hc_narrative || "—")}</p>
        <p><b>With the new headcount:</b><br>${esc(req.new_hc_narrative || "—")}</p>
        <p class="muted small">Expected value: ${valueRow} · Est. fully-loaded cost: <b>${req.estimated_cost ? money(req.estimated_cost) : "—"}</b></p>
      </section>
      <div>
        ${decision}
        <section class="card">
          <h2>History</h2>
          <ul class="timeline">${hist.map((h) => html`<li><b>${(h.to_status || "").replace("_", " ")}</b> <span class="muted">— ${h.actor_name || "system"} · ${h.created_at}</span>${h.note ? html`<div class="sub">${esc(h.note)}</div>` : ""}</li>`)}</ul>
        </section>
      </div>
    </div>`;
  return renderPage(ctx, { title: req.title, body, active: "requests" });
}
