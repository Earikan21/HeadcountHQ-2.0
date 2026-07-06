import { html, raw } from "../html.js";
import { renderPage, csrfField } from "../views/ui.js";
import { requireAuth, requirePermission } from "../middleware.js";
import { canManageSeats, departmentScope } from "../authz.js";
import { listSeats, headcountRollup, vacateSeat, setSeatStatus, getSeat } from "../repos/seats.js";
import { getSettings } from "../repos/settings.js";
import { fillRate } from "../domain/seats.js";

const STATUS_PILL = {
  filled: '<span class="pill ok2">Filled</span>',
  open: '<span class="pill warn2">Open</span>',
  frozen: '<span class="pill off">Frozen</span>',
  approved: '<span class="pill">Approved</span>',
  proposed: '<span class="pill">Proposed</span>',
  closed: '<span class="pill off">Closed</span>',
};

export function registerSeatRoutes(router) {
  router.get("/headcount", (ctx) => {
    // Roster + Headcount merged into the consolidated People view (Directive 4.0).
    ctx.redirect("/roster");
  });

  router.post("/seats/:id/vacate", (ctx) => {
    if (!requirePermission(ctx, canManageSeats)) return;
    vacateSeat(ctx.db, Number(ctx.params.id), getSettings(ctx.db), ctx.user.id);
    ctx.redirect("/roster?msg=Seat+vacated");
  });
  router.post("/seats/:id/reopen", (ctx) => {
    if (!requirePermission(ctx, canManageSeats)) return;
    const seat = getSeat(ctx.db, Number(ctx.params.id));
    if (seat && seat.status === "frozen") setSeatStatus(ctx.db, seat.id, "open", ctx.user.id);
    ctx.redirect("/roster?msg=Seat+re-approved");
  });
  router.post("/seats/:id/close", (ctx) => {
    if (!requirePermission(ctx, canManageSeats)) return;
    const seat = getSeat(ctx.db, Number(ctx.params.id));
    if (seat && seat.status !== "closed") setSeatStatus(ctx.db, seat.id, "closed", ctx.user.id);
    ctx.redirect("/roster?msg=Seat+closed");
  });
}

function kpi(label, val, tone = "") {
  return html`<div class="kpi"><div class="lbl">${label}</div><div class="val ${tone}">${val}</div></div>`;
}

function page(ctx, { roll, seats }) {
  const t = roll.totals;
  const isAdmin = canManageSeats(ctx.user);
  const pct = Math.round(fillRate(t) * 100);
  const settings = getSettings(ctx.db);

  const deptRows = roll.departments.map((d) => html`<tr>
      <td><b>${d.department}</b></td>
      <td class="right">${d.approved}</td>
      <td class="right">${d.active}</td>
      <td class="right">${d.open}</td>
      <td class="right">${d.approved ? Math.round((d.active / d.approved) * 100) : 0}%</td>
    </tr>`);

  const seatRows = seats.map((s) => html`<tr>
      <td>${s.title || "—"}</td>
      <td>${s.department_name || "—"}</td>
      <td>${raw(STATUS_PILL[s.status] || s.status)}</td>
      <td>${s.occupant_name || "—"}</td>
      ${isAdmin ? html`<td class="right">${seatActions(ctx, s)}</td>` : ""}
    </tr>`);

  const body = html`
    <div class="pagehead row-between">
      <div><h1>Headcount</h1><p class="muted">Approved vs. active by seat. Seat behavior follows your <a href="/philosophy">philosophy</a> (mode: <b>${settings.seat_mode}</b>, backfill: <b>${settings.backfill_policy}</b>).</p></div>
    </div>
    <div class="kpis">
      ${kpi("Approved headcount", t.approved)}
      ${kpi("Active (filled)", t.active, "good")}
      ${kpi("Open seats", t.open, t.open ? "warn" : "")}
      ${kpi("Fill rate", pct + "%")}
    </div>
    <div class="grid2">
      <section class="card">
        <h2>By department</h2>
        <table class="table">
          <thead><tr><th>Department</th><th class="right">Approved</th><th class="right">Active</th><th class="right">Open</th><th class="right">Fill</th></tr></thead>
          <tbody>${roll.departments.length ? deptRows : raw('<tr><td colspan="5" class="muted">No seats yet — import a roster to populate filled seats.</td></tr>')}</tbody>
        </table>
      </section>
      <section class="card">
        <h2>Seats</h2>
        <table class="table">
          <thead><tr><th>Title</th><th>Dept</th><th>Status</th><th>Occupant</th>${isAdmin ? raw("<th></th>") : ""}</tr></thead>
          <tbody>${seats.length ? seatRows : raw('<tr><td colspan="5" class="muted">No open seats.</td></tr>')}</tbody>
        </table>
      </section>
    </div>`;
  return renderPage(ctx, { title: "Headcount", body, active: "headcount" });
}

function seatActions(ctx, s) {
  const form = (action, label, cls = "ghost") => html`<form method="post" action="/seats/${s.id}/${action}" class="inline">
      ${csrfField(ctx)}<button class="btn sm ${cls}" type="submit">${label}</button>
    </form>`;
  if (s.status === "filled") return form("vacate", "Mark vacated");
  if (s.status === "frozen") return form("reopen", "Re-approve");
  if (s.status === "open") return html`<a class="btn sm" href="/roster/new?seat=${s.id}">Fill seat</a> ${form("close", "Close")}`;
  if (s.status !== "closed") return form("close", "Close");
  return "";
}
