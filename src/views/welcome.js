/**
 * The first-run welcome screen. Shown to an admin whose workspace has no roster yet,
 * in place of an empty "zeros" dashboard: one step — import the roster — which is all
 * it takes to light up the financial model.
 */
import { html, raw } from "../html.js";
import { renderPage } from "./ui.js";

function stepCard(n, title, desc, done, href, cta) {
  return html`<section class="card wcard ${done ? "done" : ""}">
    <div class="wstepno">${done ? raw("&#10003;") : n}</div>
    <div class="wstepbody">
      <h2>${title}</h2>
      <p class="muted small">${desc}</p>
      ${done ? raw('<span class="pill ok2">Done</span>') : html`<a class="btn" href="${href}">${cta}</a>`}
    </div>
  </section>`;
}

export function welcomePage(ctx, { rosterDone = false } = {}) {
  const name = String(ctx.user.name || "").split(" ")[0];
  const body = html`
    <div class="pagehead">
      <h1>Welcome${name ? ", " + name : ""}</h1>
      <p class="muted">One step. Import your roster and the financial model builds itself.</p>
    </div>
    ${stepCard(1, "Import your roster", "Upload an Excel workbook (.xlsx) or a CSV of your people — include a start-date column. We turn it into departments, seats, and a fully-loaded cost model that runs up to ten years out. Everything is processed on your own server.", rosterDone, "/roster/import", "Import roster")}
    <section class="card">
      <h2>Then what?</h2>
      <p class="muted small">Your <b>People</b> view and <b>Financial model</b> fill in automatically. From there you can scope to a department, plan hires under a named scenario, and ask the assistant about any of it.</p>
      <a class="btn ghost" href="/?home=1">Skip to dashboard &rarr;</a>
    </section>`;
  return renderPage(ctx, { title: "Welcome", body, active: "dashboard" });
}
