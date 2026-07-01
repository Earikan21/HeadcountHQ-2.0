import { html, raw, esc } from "../html.js";
import { renderPage } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canViewAudit } from "../authz.js";
import { recentAudit } from "../repos/audit.js";

const ACTION_LABEL = (a) => String(a || "").replace(/[._]/g, " ");

export function registerAuditRoutes(router) {
  router.get("/audit", (ctx) => {
    if (!requirePermission(ctx, canViewAudit)) return;
    const rows = recentAudit(ctx.db, 300);
    const items = rows.length ? rows.map((r) => {
      let detail = "";
      if (r.detail) { try { detail = Object.entries(JSON.parse(r.detail)).map(([k, v]) => `${k}: ${v}`).join(", "); } catch { detail = r.detail; } }
      return html`<tr>
        <td class="muted nowrap">${r.created_at}</td>
        <td>${r.user_name || raw('<span class="muted">system</span>')}</td>
        <td><span class="mono">${ACTION_LABEL(r.action)}</span></td>
        <td class="muted">${r.entity || ""}${r.entity_id ? " #" + r.entity_id : ""}</td>
        <td class="muted small">${esc(detail)}</td>
      </tr>`;
    }) : raw('<tr><td colspan="5" class="muted">No activity recorded yet.</td></tr>');
    const body = html`
      <div class="pagehead"><h1>Audit log</h1><p class="muted">A record of sensitive actions — sign-ins, account and role changes, imports, approvals, budget edits, and onboarding.</p></div>
      <section class="card">
        <div class="tbl-scroll"><table class="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Detail</th></tr></thead>
          <tbody>${items}</tbody>
        </table></div>
      </section>`;
    ctx.html(200, renderPage(ctx, { title: "Audit", body, active: "audit" }));
  });
}
