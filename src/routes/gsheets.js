/**
 * Google Sheets live push (formatted). Admin connects their Google account once (OAuth),
 * points at a spreadsheet, and pushes the model in — values plus number formats/styles —
 * so the linked sheet stays live and formatted. One-way; the tool stays the source of truth.
 */
import { html } from "../html.js";
import { renderPage, csrfField } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canManageAccounts } from "../authz.js";
import { randomBytes } from "node:crypto";
import { createPkce, authUrl, exchangeCode, whoAmI } from "../domain/gsheets.js";
import { getConnection, saveConnection, setTarget, disconnect } from "../repos/gsheets.js";
import { pushNow, parseSpreadsheetId } from "../domain/gsheets_sync.js";
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

export function registerGoogleSheetsRoutes(router) {
  router.get("/integrations/google", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    ctx.html(200, statusPage(ctx, { conn: getConnection(ctx.db) }));
  });

  router.get("/integrations/google/connect", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    if (!ctx.config.googleSheetsConfigured || !ctx.config.GOOGLE_REDIRECT_URI) {
      return ctx.redirect("/integrations/google?msg=Set+the+Google+app+credentials+on+the+server+first");
    }
    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString("hex");
    stash(state, { verifier, userId: ctx.user.id });
    ctx.redirect(authUrl({ clientId: ctx.config.GOOGLE_CLIENT_ID, redirectUri: ctx.config.GOOGLE_REDIRECT_URI, state, challenge }));
  });

  router.get("/integrations/google/callback", async (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    if (ctx.query.get("error")) return ctx.redirect("/integrations/google?msg=" + encodeURIComponent("Google sign-in was cancelled or failed."));
    const state = ctx.query.get("state") || "", code = ctx.query.get("code") || "";
    const p = take(state);
    if (!p || !code) return ctx.redirect("/integrations/google?msg=" + encodeURIComponent("That sign-in link expired — try Connect again."));
    try {
      const tok = await exchangeCode({ config: ctx.config, code, verifier: p.verifier });
      if (!tok.refresh_token) throw new Error("Google didn't return a refresh token — remove the app's access at myaccount.google.com and connect again.");
      let email = "";
      try { email = await whoAmI({ accessToken: tok.access_token }); } catch { /* non-fatal */ }
      saveConnection(ctx.db, { email, refreshToken: tok.refresh_token, userId: ctx.user.id, secret: ctx.config.SESSION_SECRET });
      logAudit(ctx.db, { userId: ctx.user.id, action: "google.connected", entity: "google_connection", detail: { email } });
      ctx.redirect("/integrations/google?msg=" + encodeURIComponent("Connected — now paste the sheet to write to."));
    } catch (e) {
      ctx.redirect("/integrations/google?msg=" + encodeURIComponent((e && e.message) || "Sign-in failed."));
    }
  });

  router.post("/integrations/google/target", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const id = parseSpreadsheetId(ctx.body.spreadsheet);
    if (!id) return ctx.redirect("/integrations/google?msg=" + encodeURIComponent("Paste a Google Sheets link or its ID."));
    const tab = String(ctx.body.sheet_title || "").trim() || "Headcount";
    setTarget(ctx.db, { spreadsheetId: id, spreadsheetName: String(ctx.body.spreadsheet_name || "").trim(), sheetTitle: tab });
    ctx.redirect("/integrations/google?msg=Sheet+linked");
  });

  router.post("/integrations/google/retarget", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    setTarget(ctx.db, { spreadsheetId: null, spreadsheetName: null, sheetTitle: null });
    ctx.redirect("/integrations/google");
  });

  router.post("/integrations/google/push", async (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    try {
      const res = await pushNow(ctx.db, ctx.config);
      logAudit(ctx.db, { userId: ctx.user.id, action: "google.pushed", entity: "google_connection", detail: res });
      ctx.redirect("/integrations/google?msg=" + encodeURIComponent(`Pushed ${res.rows} rows to “${res.sheet}”.`));
    } catch (e) {
      ctx.redirect("/integrations/google?msg=" + encodeURIComponent("Push failed: " + ((e && e.message) || e)));
    }
  });

  router.post("/integrations/google/disconnect", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    disconnect(ctx.db);
    logAudit(ctx.db, { userId: ctx.user.id, action: "google.disconnected", entity: "google_connection" });
    ctx.redirect("/integrations/google?msg=Disconnected");
  });
}

// ---- view -------------------------------------------------------------------
function statusPage(ctx, { conn }) {
  const head = html`<div class="pagehead"><h1>Google Sheets — live push</h1>
    <p class="muted">Write the model into a Google Sheet with formatting (currency, %, bold totals,
    frozen header) and refresh it on demand. One-way — the tool stays the source of truth.</p></div>`;

  if (!ctx.config.googleSheetsConfigured) {
    return renderPage(ctx, { title: "Google Sheets", active: "google", body: html`${head}
      <section class="card"><p class="muted">Not enabled on this server. Set <code>GOOGLE_CLIENT_ID</code>,
      <code>GOOGLE_CLIENT_SECRET</code> (and a redirect URI of <code>${ctx.config.GOOGLE_REDIRECT_URI || "PUBLIC_URL/integrations/google/callback"}</code>)
      from a Google Cloud OAuth client with the Sheets API enabled.</p></section>` });
  }

  if (!conn) {
    return renderPage(ctx, { title: "Google Sheets", active: "google", body: html`${head}
      <section class="card"><h2>Connect</h2>
        <p class="muted small">Sign in with the Google account that owns (or can edit) the sheet.</p>
        <a class="btn" href="/integrations/google/connect">Connect Google Sheets</a>
      </section>` });
  }

  const connedAs = conn.account_email ? html` as <b>${conn.account_email}</b>` : "";
  if (!conn.spreadsheet_id) {
    return renderPage(ctx, { title: "Google Sheets", active: "google", body: html`${head}
      <section class="card"><h2>Choose a sheet <span class="pill ok2">Connected${connedAs}</span></h2>
        <p class="muted small">Create a Google Sheet (or open an existing one), then paste its link here. The push writes to a tab named below (created if missing).</p>
        <form method="post" action="/integrations/google/target" class="stack">${csrfField(ctx)}
          <label>Google Sheet link or ID<input name="spreadsheet" placeholder="https://docs.google.com/spreadsheets/d/…/edit" required style="width:100%"></label>
          <label>Tab name<input name="sheet_title" value="Headcount"></label>
          <button class="btn" type="submit">Link sheet</button>
        </form>
      </section>` });
  }

  const status = conn.status === "error"
    ? html`<div class="flash warn">Last push failed: ${conn.last_error || "unknown error"}</div>` : "";
  return renderPage(ctx, { title: "Google Sheets", active: "google", body: html`${head}${status}
    <section class="card">
      <h2>Linked <span class="pill ok2">Connected${connedAs}</span></h2>
      <p class="muted small">Writing to tab <b>${conn.sheet_title}</b>${conn.last_pushed_at ? html` · last pushed ${conn.last_pushed_at}` : " · not pushed yet"}.</p>
      <div class="actions" style="margin-top:8px">
        <form method="post" action="/integrations/google/push" class="inline">${csrfField(ctx)}<button class="btn" type="submit">Push now</button></form>
        <form method="post" action="/integrations/google/retarget" class="inline">${csrfField(ctx)}<button class="btn ghost sm" type="submit">Change sheet</button></form>
        <form method="post" action="/integrations/google/disconnect" class="inline confirm-delete" data-confirm="Disconnect Google? The sheet keeps whatever was last written.">${csrfField(ctx)}<button class="linklike danger-link" type="submit">Disconnect</button></form>
      </div>
    </section>` });
}
