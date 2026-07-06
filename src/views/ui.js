/**
 * Shared server-side view helpers: the page layout with role-aware navigation,
 * a CSRF hidden field, flash banners, and small formatting utilities. All HTML
 * goes through the auto-escaping `html` tag from ../html.js.
 */
import { html, raw, esc } from "../html.js";
import { canViewCompTotals, canUseAssistant, displayRole } from "../authz.js";

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

/** Grouped navigation appropriate to the current user + enabled features. */
function navGroups(user, active, features = {}) {
  if (!user) return [];
  const I = (href, label, key) => ({ href, label, on: active === key });

  // One consolidated group for the merged dashboard surface.
  const dash = [I("/", "Dashboard", "dashboard"), I("/roster", "People", "roster")];
  if (features.org) dash.push(I("/org", "Org chart", "org"));
  if (features.requests) dash.push(I("/requests", "Requests", "requests"));
  if (canUseAssistant(user)) dash.push(I("/assistant", "Assistant", "assistant"));
  const groups = [{ label: "Dashboard", items: dash }];

  if (user.role !== "manager") {
    const plan = [I("/budgets", "Budgets", "budgets"), I("/model", "Financial model", "model")];
    if (features.planning) plan.push(I("/planning", "Planning", "planning"));
    if (user.role === "finance_admin") plan.push(I("/philosophy", "Philosophy", "philosophy"));
    groups.push({ label: "Planning", items: plan });
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
  const groups = navGroups(user, active, features);
  const subtabs = dashboardTabs(user, active);
  const navHtml = groups.map((g) => html`<div class="nav-group">
      <div class="nav-group-label">${g.label}</div>
      ${g.items.map((it) => raw(`<a href="${it.href}" class="nav-link ${it.on ? "on" : ""}">${esc(it.label)}</a>`))}
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
</body>
</html>`;
}

/** A standalone (no-nav) page for login / setup / invite screens. */
export function renderAuthPage(ctx, { title, body }) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Headcount HQ</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body class="auth">
  <main class="authwrap">
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
