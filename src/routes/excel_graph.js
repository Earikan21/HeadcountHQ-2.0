/**
 * DORMANT — the original Graph *push* integration (Excel Online via Microsoft OAuth).
 *
 * We switched the live link to Power Query (routes/excel.js). This file is kept "in
 * background just in case": it is NOT registered in routes.js, so none of these routes
 * are mounted. To re-enable the push approach, register `registerExcelGraphRoutes`
 * (instead of, or alongside a different path prefix than, the Power Query routes) and
 * set MSFT_CLIENT_ID / MSFT_CLIENT_SECRET / MSFT_REDIRECT_URI. The supporting logic
 * lives in domain/msgraph.js, domain/excel_sync.js and repos/excel.js (all still
 * present), and the excel_connections table is intentionally not dropped.
 */
import { html } from "../html.js";
import { renderPage, csrfField } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canManageAccounts } from "../authz.js";
import { randomBytes } from "node:crypto";
import { createPkce, authUrl, exchangeCode, refreshAccessToken, whoAmI, searchWorkbooks } from "../domain/msgraph.js";
import { getConnection, saveConnection, getRefreshToken, setTarget, disconnect } from "../repos/excel.js";
import { pushNow } from "../domain/excel_sync.js";
import { logAudit } from "../repos/audit.js";

const pending = new Map();
const PENDING_TTL = 10 * 60 * 1000;
function stash(state, data) { pending.set(state, { ...data, exp: Date.now() + PENDING_TTL }); }
function take(state) {
  const v = pending.get(state);
  pending.delete(state);
  if (!v || v.exp < Date.now()) return null;
  return v;
}

export function registerExcelGraphRoutes(router) {
  router.get("/integrations/excel-graph", async (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const conn = getConnection(ctx.db);
    let workbooks = null, listError = null;
    if (conn && !conn.item_id && ctx.config.excelSyncConfigured) {
      try {
        const rt = getRefreshToken(ctx.db, ctx.config.SESSION_SECRET);
        const tok = await refreshAccessToken({ config: ctx.config, refreshToken: rt });
        workbooks = await searchWorkbooks({ accessToken: tok.access_token });
      } catch (e) { listError = e && e.message ? e.message : String(e); }
    }
    ctx.html(200, statusPage(ctx, { conn, workbooks, listError }));
  });

  router.get("/integrations/excel-graph/connect", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    if (!ctx.config.excelSyncConfigured || !ctx.config.MSFT_REDIRECT_URI) {
      return ctx.redirect("/integrations/excel-graph?msg=Set+the+Microsoft+app+credentials+first");
    }
    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString("hex");
    stash(state, { verifier, userId: ctx.user.id });
    ctx.redirect(authUrl({ clientId: ctx.config.MSFT_CLIENT_ID, redirectUri: ctx.config.MSFT_REDIRECT_URI, tenant: ctx.config.MSFT_TENANT, state, challenge }));
  });

  router.get("/integrations/excel-graph/callback", async (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    if (ctx.query.get("error")) return ctx.redirect("/integrations/excel-graph?msg=" + encodeURIComponent("Microsoft sign-in was cancelled or failed."));
    const state = ctx.query.get("state") || "", code = ctx.query.get("code") || "";
    const p = take(state);
    if (!p || !code) return ctx.redirect("/integrations/excel-graph?msg=" + encodeURIComponent("That sign-in link expired — try Connect again."));
    try {
      const tok = await exchangeCode({ config: ctx.config, code, verifier: p.verifier });
      let email = "";
      try { email = await whoAmI({ accessToken: tok.access_token }); } catch { /* non-fatal */ }
      saveConnection(ctx.db, { email, refreshToken: tok.refresh_token, userId: ctx.user.id, secret: ctx.config.SESSION_SECRET });
      logAudit(ctx.db, { userId: ctx.user.id, action: "excel.connected", entity: "excel_connection", detail: { email } });
      ctx.redirect("/integrations/excel-graph?msg=" + encodeURIComponent("Connected — now choose a workbook."));
    } catch (e) {
      ctx.redirect("/integrations/excel-graph?msg=" + encodeURIComponent((e && e.message) || "Sign-in failed."));
    }
  });

  router.post("/integrations/excel-graph/target", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const itemId = String(ctx.body.item_id || "").trim();
    const worksheet = String(ctx.body.worksheet || "").trim() || "HeadcountModel";
    if (!itemId) return ctx.redirect("/integrations/excel-graph?msg=Pick+a+workbook+first");
    setTarget(ctx.db, { itemId, workbookName: String(ctx.body.workbook_name || "").trim(), worksheet });
    ctx.redirect("/integrations/excel-graph?msg=Workbook+linked");
  });

  router.post("/integrations/excel-graph/retarget", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    setTarget(ctx.db, { itemId: null, workbookName: null, worksheet: null });
    ctx.redirect("/integrations/excel-graph");
  });

  router.post("/integrations/excel-graph/push", async (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    try {
      const res = await pushNow(ctx.db, ctx.config);
      logAudit(ctx.db, { userId: ctx.user.id, action: "excel.pushed", entity: "excel_connection", detail: res });
      ctx.redirect("/integrations/excel-graph?msg=Pushed+to+Excel");
    } catch (e) {
      ctx.redirect("/integrations/excel-graph?msg=" + encodeURIComponent("Push failed: " + ((e && e.message) || e)));
    }
  });

  router.post("/integrations/excel-graph/disconnect", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    disconnect(ctx.db);
    ctx.redirect("/integrations/excel-graph?msg=Disconnected");
  });
}

function statusPage(ctx, { conn, workbooks, listError }) {
  const head = html`<div class="pagehead"><h1>Excel Online sync (Graph push — dormant)</h1>
    <p class="muted">Legacy push integration, kept in reserve. The active live link uses Power Query.</p></div>`;
  if (!ctx.config.excelSyncConfigured) return renderPage(ctx, { title: "Excel push", active: "excel", body: html`${head}<section class="card"><p class="muted">Set MSFT_CLIENT_ID / MSFT_CLIENT_SECRET / MSFT_REDIRECT_URI to enable.</p></section>` });
  if (!conn) return renderPage(ctx, { title: "Excel push", active: "excel", body: html`${head}<section class="card"><a class="btn" href="/integrations/excel-graph/connect">Connect Excel Online</a></section>` });
  if (!conn.item_id) {
    const picker = listError ? html`<div class="flash warn">${listError}</div>`
      : !workbooks || !workbooks.length ? html`<p class="muted">No .xlsx workbooks found.</p>`
      : html`<form method="post" action="/integrations/excel-graph/target" class="stack">${csrfField(ctx)}<div class="checkgrid">${workbooks.map((w) => html`<label class="check"><input type="radio" name="item_id" value="${w.id}" required> ${w.name}</label>`)}</div><label>Worksheet<input name="worksheet" value="HeadcountModel"></label><button class="btn" type="submit">Link</button></form>`;
    return renderPage(ctx, { title: "Excel push", active: "excel", body: html`${head}<section class="card"><h2>Choose a workbook</h2>${picker}</section>` });
  }
  return renderPage(ctx, { title: "Excel push", active: "excel", body: html`${head}<section class="card"><form method="post" action="/integrations/excel-graph/push" class="inline">${csrfField(ctx)}<button class="btn" type="submit">Push now</button></form></section>` });
}
