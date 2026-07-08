/**
 * Shared server-side view helpers: the page layout with role-aware navigation,
 * a CSRF hidden field, flash banners, and small formatting utilities. All HTML
 * goes through the auto-escaping `html` tag from ../html.js.
 */
import { html, raw, esc } from "../html.js";
import { canViewCompTotals, canUseAssistant, displayRole, canViewBudgets, canSetBudgets } from "../authz.js";
import { listPlans } from "../repos/plans.js";

/** A hidden CSRF input bound to the request's double-submit token. */
export function csrfField(ctx) {
  return raw(`<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`);
}

export const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
/** Compact money: $1.2M, $250k, $900. */
export const moneyShort = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + "M";
  if (Math.abs(v) >= 1e3) return "$" + Math.round(v / 1e3) + "k";
  return "$" + v;
};
export const moneyRange = (a, b) =>
  a == null && b == null ? "—" : `${money(a)} – ${money(b)}`;

/**
 * The consolidated dashboard surface (Directive 4.0): Dashboard, Roster,
 * Headcount, and Departments are one surface, unified by the sub-tab bar below.
 */
const CONSOLIDATED = new Set(["dashboard", "roster", "headcount", "departments"]);

/**
 * The plan versions shown as indented children of "Financial model" (item 1). The
 * live roster is "Actual"; every named plan layers scenario hires on top of it.
 */
function modelNavOf(ctx, active) {
  const user = ctx.user;
  if (!user || user.role === "manager" || !ctx.db || !canViewBudgets(user)) return null;
  let plans = [];
  try { plans = listPlans(ctx.db); } catch { plans = []; }
  const onModel = active === "model" || active === "compare";
  const version = active === "model" ? Number(ctx.query.get("version")) || null : null;
  return { plans, currentId: version, onModel, onCompare: active === "compare", canEdit: canSetBudgets(user) };
}

/** Grouped navigation appropriate to the current user + enabled features. */
function navGroups(user, active, features = {}, modelNav = null) {
  if (!user) return [];
  const I = (href, label, key) => ({ href, label, on: active === key });

  // One consolidated group for the merged dashboard surface.
  const dash = [I("/", "Dashboard", "dashboard"), I("/roster", "People", "roster")];
  if (features.org) dash.push(I("/org", "Org chart", "org"));
  if (features.requests) dash.push(I("/requests", "Requests", "requests"));
  const groups = [{ label: "Dashboard", items: dash }];

  if (user.role !== "manager") {
    const model = I("/model", "Financial model", "model");
    if (modelNav) {
      model.on = modelNav.onModel; // the parent stays lit for any plan
      model.children = [{ href: "/model", label: "Actual", on: modelNav.onModel && !modelNav.onCompare && !modelNav.currentId }].concat(
        modelNav.plans.map((p) => ({ href: `/model?version=${p.id}`, label: p.name, on: !modelNav.onCompare && modelNav.currentId === p.id }))
      );
      if (modelNav.plans.length) model.children.push({ href: "/model/compare", label: "Compare…", on: modelNav.onCompare, cls: "cmp" });
      model.addPlan = modelNav.canEdit;
    }
    const plan = [model];
    if (features.planning) plan.push(I("/planning", "Planning", "planning"));
    groups.push({ label: "Model", items: plan });
  }
  if (user.role === "finance_admin") groups.push({ label: "Admin", items: [I("/accounts", "Collaborators", "accounts"), I("/audit", "Audit", "audit")] });
  return groups;
}

/** The sub-tab bar that makes the merged pages read as one surface. */
function dashboardTabs(user, active) {
  if (!CONSOLIDATED.has(active)) return "";
  const t = (href, label, key) => raw(`<a href="${href}" class="subtab ${active === key ? "on" : ""}">${esc(label)}</a>`);
  const tabs = [t("/", "Overview", "dashboard"), t("/roster", "People", "roster")];
  return html`<nav class="subtabs" aria-label="Dashboard sections">${tabs}</nav>`;
}

/** Render a full page in the app shell (sidebar + content). `body` is trusted HTML. */
export function renderPage(ctx, { title, body, active = "", flash = "" }) {
  const user = ctx.user;
  const flashMsg = flash || ctx.query.get("msg") || "";
  const features = (ctx.config && ctx.config.features) || {};
  const groups = navGroups(user, active, features, modelNavOf(ctx, active));
  const subtabs = dashboardTabs(user, active);
  const showAssistant = !!(user && canUseAssistant(user) && ctx.config && ctx.config.aiImportConfigured);
  const navItem = (it) => html`${raw(`<a href="${it.href}" class="nav-link ${it.on ? "on" : ""}">${esc(it.label)}</a>`)}${
    it.children ? html`<div class="nav-children">
      ${it.children.map((ch) => raw(`<a href="${ch.href}" class="${["nav-sublink", ch.cls, ch.on && "on"].filter(Boolean).join(" ")}">${esc(ch.label)}</a>`))}
      ${it.addPlan ? html`<form method="post" action="/model/versions" class="nav-newplan">${csrfField(ctx)}<input name="name" placeholder="New plan" aria-label="New plan name"><button type="submit" class="np-add" title="Add plan" aria-label="Add plan">+</button></form>` : ""}
    </div>` : ""}`;
  const navHtml = groups.map((g) => html`<div class="nav-group">
      <div class="nav-group-label">${g.label}</div>
      ${g.items.map(navItem)}
    </div>`);

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Headcount HQ</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <a class="brand" href="/"><span class="logo">H</span> <span class="brand-name">Headcount HQ</span></a>
      <nav class="side-nav">${navHtml}</nav>
      <div class="side-user">
        <div class="su-id"><span class="su-name">${user ? user.name : ""}</span><span class="su-role">${user ? displayRole(user) : ""}</span></div>
        <div class="su-actions">
          <a href="/account">Settings</a>
          <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">Sign out</button></form>
        </div>
      </div>
    </aside>
    <main class="content">
      <div class="wrap">
        ${flashMsg ? html`<div class="flash">${flashMsg}</div>` : ""}
        ${subtabs}
        ${raw(body)}
      </div>
    </main>
  </div>
  ${showAssistant ? assistantWidget(ctx) : ""}
</body>
</html>`;
}

/** Floating "Ask AI" assistant widget (Directive 4.0) — shown on every page for
 *  users who may use the assistant, once a provider key is configured. */
function assistantWidget(ctx) {
  return html`
  <button id="ai-fab" class="ai-fab" type="button" aria-label="Ask the assistant">Ask AI</button>
  <section id="ai-panel" class="ai-panel" hidden aria-label="Assistant">
    <header class="ai-head"><b>Assistant</b><button id="ai-close" class="ai-x" type="button" aria-label="Close">&times;</button></header>
    <div id="ai-log" class="ai-log"><p class="muted small">Ask about your headcount, budget, and plan. Aggregate figures only — never individual names or salaries.</p></div>
    <form id="ai-form" class="ai-form">
      <input type="hidden" id="ai-csrf" value="${ctx.csrf}">
      <textarea id="ai-q" rows="2" placeholder="e.g. Are we over-invested in any function?"></textarea>
      <button class="btn sm" type="submit">Ask</button>
    </form>
  </section>
  <script src="/static/assistant.js" defer></script>`;
}

/** A standalone (no-nav) page for login / setup / invite screens. */
export function renderAuthPage(ctx, { title, body, wide = false }) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Headcount HQ</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body class="auth">
  <main class="authwrap ${wide ? "wide" : ""}">
    <div class="brand center"><span class="logo">H</span> Headcount HQ</div>
    ${raw(body)}
  </main>
</body>
</html>`;
}

export function errorList(errors) {
  if (!errors || !errors.length) return "";
  return html`<div class="errors"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}
