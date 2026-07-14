/**
 * Excel live link via Power Query (pull-based). The tool exposes a token-authed
 * export URL; you point Excel's Data → From Web at it and Refresh. Excel loads the
 * model as a values table that recalculates any tab linking to it. One-way: the tool
 * stays the source of truth. No OAuth, no cloud app — just a URL + a rotatable token.
 */
import { html, raw } from "../html.js";
import { renderPage, csrfField } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canManageAccounts } from "../authz.js";
import { getToken, rotateToken, deleteToken, tokenValid } from "../repos/export_tokens.js";
import { listEmployees } from "../repos/roster.js";
import { getSettings } from "../repos/settings.js";
import { buildHeadcountModel, applyPlanOverrides } from "../domain/model.js";
import { getPlan, planHires, planOverrides, planAssumptions } from "../repos/plans.js";
import { modelValuesCsv } from "../domain/model_export.js";
import { logAudit } from "../repos/audit.js";

function exportUrl(ctx, token) {
  const base = ctx.config.PUBLIC_URL || "";
  return `${base || "https://your-host"}/export/model.csv?token=${token}`;
}

export function registerExcelRoutes(router) {
  // --- The data endpoint Power Query fetches. Token-authed, no session/cookie. ---
  router.get("/export/model.csv", (ctx) => {
    const token = ctx.query.get("token") || "";
    if (!tokenValid(ctx.db, token)) {
      return ctx.send(401, "text/plain; charset=utf-8", "Invalid or missing token.");
    }
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const versionId = Number(ctx.query.get("version")) || null;
    const plan = versionId ? getPlan(ctx.db, versionId) : null;
    const dept = ctx.query.get("dept") || null;
    // A plan applies its overrides + scenario hires + assumptions; Actual is the roster.
    const all = applyPlanOverrides(listEmployees(ctx.db, {}), plan ? planOverrides(plan) : {});
    const employees = dept ? all.filter((e) => (e.department_name || "(none)") === dept) : all;
    const hires = plan ? planHires(plan) : [];
    const scopedHires = dept ? hires.filter((h) => h.department === dept) : hires;
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: scopedHires, assumptions: plan ? planAssumptions(plan) : {} });
    // Power Query re-fetches this on Refresh; a values table, not formulas.
    ctx.send(200, "text/csv; charset=utf-8", modelValuesCsv(model));
  });

  // --- Admin: manage the link + token ---
  router.get("/integrations/excel", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    ctx.html(200, statusPage(ctx, { row: getToken(ctx.db) }));
  });

  router.post("/integrations/excel/token", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const row = rotateToken(ctx.db, ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "export_token.rotated", entity: "export_token" });
    ctx.html(200, statusPage(ctx, { row, justRotated: true }));
  });

  // Create a token if one doesn't exist yet, then return to where the button was
  // (a plan or Actual), reopening the "Link to Excel" popup.
  router.post("/integrations/excel/token/ensure", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    if (!getToken(ctx.db)) {
      rotateToken(ctx.db, ctx.user.id);
      logAudit(ctx.db, { userId: ctx.user.id, action: "export_token.rotated", entity: "export_token" });
    }
    let back = String(ctx.body.return || "/model");
    if (!back.startsWith("/model")) back = "/model";      // only ever bounce back into the model
    ctx.redirect(back + (back.includes("?") ? "&" : "?") + "excel=1");
  });

  router.post("/integrations/excel/token/delete", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    deleteToken(ctx.db);
    logAudit(ctx.db, { userId: ctx.user.id, action: "export_token.disabled", entity: "export_token" });
    ctx.redirect("/integrations/excel?msg=Link+disabled");
  });
}

// ---- view -------------------------------------------------------------------
function statusPage(ctx, { row, justRotated = false }) {
  const head = html`<div class="pagehead"><h1>Excel live link</h1>
    <p class="muted">Pull your headcount model into Excel with <b>Power Query</b>: point Data → From Web at the URL below
    and hit Refresh whenever you want the latest. The tool stays the source of truth; any tab that links to the loaded
    table recalculates on refresh.</p></div>`;

  const publicNote = ctx.config.PUBLIC_URL ? "" : html`<div class="flash warn">Tip: set <code>PUBLIC_URL</code> on the server so this shows your real address instead of a placeholder.</div>`;

  if (!row) {
    return renderPage(ctx, { title: "Excel live link", active: "excel", body: html`${head}${publicNote}
      <section class="card"><h2>Create the link</h2>
        <p class="muted small">This generates a private URL that returns your live model as CSV. Anyone with the URL can read
        it, so treat it like a password — you can rotate or disable it any time.</p>
        <form method="post" action="/integrations/excel/token">${csrfField(ctx)}<button class="btn" type="submit">Generate link</button></form>
      </section>` });
  }

  const url = exportUrl(ctx, row.token);
  return renderPage(ctx, { title: "Excel live link", active: "excel", body: html`${head}${publicNote}
    ${justRotated ? html`<div class="flash ok">New link generated. The old URL no longer works.</div>` : ""}
    <section class="card">
      <h2>Your link <span class="pill ok2">Active</span></h2>
      <p class="muted small">Created ${row.created_at}${row.last_used_at ? html` · last fetched ${row.last_used_at}` : " · not fetched yet"}.</p>
      <label>Power Query URL
        <input type="text" class="mono" value="${url}" readonly onclick="this.select()" aria-label="Power Query export URL" style="width:100%">
      </label>
      <div class="actions" style="margin-top:8px">
        <form method="post" action="/integrations/excel/token" class="inline">${csrfField(ctx)}<button class="btn ghost sm" type="submit" title="Generate a new URL and invalidate this one">Rotate</button></form>
        <form method="post" action="/integrations/excel/token/delete" class="inline confirm-delete" data-confirm="Disable the Excel link? The URL will stop working.">${csrfField(ctx)}<button class="linklike danger-link" type="submit">Disable link</button></form>
      </div>
    </section>
    <section class="card">
      <h2>Set it up in Excel (once)</h2>
      <ol class="twofa-steps">
        <li>In Excel: <b>Data → Get Data → From Other Sources → From Web</b> (or <b>Data → From Web</b>).</li>
        <li>Paste the URL above and choose <b>Anonymous</b> access when prompted. Click <b>Load</b> — your model lands in a table.</li>
        <li>Link your other tabs to that table with normal formulas (SUMIFS, lookups, references).</li>
        <li>To update everything: <b>Data → Refresh All</b>. For hands-off updates, set <b>Query → Properties → Refresh every N minutes</b> or <b>Refresh on open</b>.</li>
      </ol>
      <p class="muted small">The table is values that refresh; your formulas linking to it recalc automatically on each refresh.</p>
    </section>` });
}
