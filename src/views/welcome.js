/**
 * The first-run welcome / setup screen (Directive 4.0). Shown to an admin whose
 * workspace has no roster yet, in place of the empty "zeros" dashboard: two guided
 * steps (import roster → set budget) that light up the budget dashboard.
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

export function welcomePage(ctx, { rosterDone = false, budgetDone = false } = {}) {
  const name = String(ctx.user.name || "").split(" ")[0];
  const body = html`
    <div class="pagehead">
      <h1>Welcome${name ? ", " + name : ""}</h1>
      <p class="muted">Let's set up this workspace. Two quick steps and your budget dashboard comes to life.</p>
    </div>
    ${stepCard(1, "Import your roster", "Upload a CSV (Excel: File → Save As → CSV first) of your people. We turn it into departments, seats, and cost — your single source of truth. Everything is processed on your own server.", rosterDone, "/roster/import", "Import roster")}
    ${stepCard(2, "Set your budget", "Set one company-wide headcount and money budget, then allocate it across departments.", budgetDone, "/budgets", "Set budget")}
    <section class="card">
      <h2>Then what?</h2>
      <p class="muted small">Your <b>People</b> view and <b>Budget dashboard</b> update automatically as data comes in. Fine-tune the rules any time under <a href="/philosophy">Philosophy</a>.</p>
      <a class="btn ghost" href="/?home=1">Skip to dashboard &rarr;</a>
    </section>`;
  return renderPage(ctx, { title: "Welcome", body, active: "dashboard" });
}
