import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, errorList, money } from "../views/ui.js";
import { requireAuth, requirePermission } from "../middleware.js";
import { canManageAccounts, ROLES, ROLE_LABELS, displayRole } from "../authz.js";
import {
  listUsers, getUserById, getUserByEmail, createUserWithPassword, createPendingUser,
  setUserStatus, setPassword,
} from "../repos/users.js";
import { listDepartments } from "../repos/departments.js";
import { departmentsForUser, departmentIdsForUser, setDepartmentsForUser } from "../repos/collaborators.js";
import { getDelegatedBudget, setDelegatedBudget } from "../repos/budgets.js";
import { createInvite } from "../repos/invites.js";
import { passwordProblem, verifyPassword } from "../auth/passwords.js";
import { destroyAllForUser } from "../auth/sessions.js";
import { logAudit } from "../repos/audit.js";
import { randomBytes } from "node:crypto";

const tempPassword = () => randomBytes(9).toString("base64url");

// Role choices offered when creating an account. "client" is a virtual option
// (Directive 4.0 M21): stored as a c_suite account flagged is_client, giving the
// external client a clean, editable-budget view with no backend/admin surfaces.
const ACCOUNT_ROLE_OPTIONS = [
  ["finance_admin", ROLE_LABELS.finance_admin],
  ["c_suite", ROLE_LABELS.c_suite],
  ["manager", ROLE_LABELS.manager],
  ["client", "Client — external, clean view"],
];

export function registerAccountRoutes(router) {
  router.get("/accounts", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    ctx.html(200, accountsPage(ctx, {}));
  });

  router.post("/accounts", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const { name = "", email = "", role = "", method = "invite", department_id = "" } = ctx.body;
    const errors = [];
    if (!name.trim()) errors.push("Name is required.");
    if (!/.+@.+\..+/.test(email)) errors.push("A valid email is required.");
    if (!ROLES.includes(role) && role !== "client") errors.push("Choose a role.");
    const isClientRole = role === "client";
    const clientFull = isClientRole && !!ctx.body.client_full;
    const dbRole = isClientRole ? "c_suite" : role;
    const deptId = isClientRole ? null : (department_id ? Number(department_id) : null);
    if (role === "manager" && !deptId) errors.push("Managers must be assigned a department.");
    if (getUserByEmail(ctx.db, email)) errors.push("A user with that email already exists.");
    if (errors.length) return ctx.html(400, accountsPage(ctx, { errors, form: ctx.body }));

    let banner;
    if (method === "password") {
      const pw = tempPassword();
      const user = createUserWithPassword(ctx.db, { email, name, role: dbRole, password: pw, departmentId: deptId, mustChange: true, isClient: isClientRole, clientFull });
      logAudit(ctx.db, { userId: ctx.user.id, action: "account.created", entity: "user", entityId: user.id, detail: { role, method: "password" } });
      banner = html`<div class="reveal"><b>Account created for ${esc(name)}.</b> Share this temporary password securely — it won't be shown again:
        <code>${pw}</code> They'll be asked to change it on first sign-in.</div>`;
    } else {
      const user = createPendingUser(ctx.db, { email, name, role: dbRole, departmentId: deptId, isClient: isClientRole, clientFull });
      const token = createInvite(ctx.db, { email, role: dbRole, departmentId: deptId, createdBy: ctx.user.id });
      logAudit(ctx.db, { userId: ctx.user.id, action: "account.invited", entity: "user", entityId: user.id, detail: { role, method: "invite" } });
      const link = inviteLink(ctx, token);
      banner = html`<div class="reveal"><b>Invite created for ${esc(name)}.</b> Send them this link to set their password (valid 7 days):
        <code>${link}</code></div>`;
    }
    ctx.html(200, accountsPage(ctx, { banner }));
  });

  router.post("/accounts/:id/status", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const id = Number(ctx.params.id);
    const target = getUserById(ctx.db, id);
    if (!target) return ctx.redirect("/accounts");
    if (target.id === ctx.user.id) return ctx.html(400, accountsPage(ctx, { errors: ["You can't disable your own account."] }));
    const next = ctx.body.status === "disabled" ? "disabled" : "active";
    setUserStatus(ctx.db, id, next);
    if (next === "disabled") destroyAllForUser(ctx.db, id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "account.status", entity: "user", entityId: id, detail: { status: next } });
    ctx.redirect("/accounts?msg=Account+updated");
  });

  router.post("/accounts/:id/invite", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const target = getUserById(ctx.db, Number(ctx.params.id));
    if (!target) return ctx.redirect("/accounts");
    const token = createInvite(ctx.db, { email: target.email, role: target.role, departmentId: target.department_id, createdBy: ctx.user.id });
    logAudit(ctx.db, { userId: ctx.user.id, action: "account.reinvited", entity: "user", entityId: target.id });
    ctx.html(200, accountsPage(ctx, { banner: html`<div class="reveal"><b>New invite link for ${esc(target.name)}:</b> <code>${inviteLink(ctx, token)}</code></div>` }));
  });

  // ---- Owner responsibilities (which departments) + delegated budget pool ----
  router.post("/accounts/:id/departments", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const id = Number(ctx.params.id);
    if (!getUserById(ctx.db, id)) return ctx.redirect("/accounts");
    const raw = ctx.body.department_id ?? [];
    const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Boolean);
    setDepartmentsForUser(ctx.db, id, ids);
    logAudit(ctx.db, { userId: ctx.user.id, action: "account.departments", entity: "user", entityId: id, detail: { departments: ids } });
    ctx.redirect("/accounts?msg=Departments+updated");
  });

  router.post("/accounts/:id/budget", (ctx) => {
    if (!requirePermission(ctx, canManageAccounts)) return;
    const id = Number(ctx.params.id);
    if (!getUserById(ctx.db, id)) return ctx.redirect("/accounts");
    setDelegatedBudget(ctx.db, id, ctx.body.headcount_budget, ctx.body.money_budget, ctx.user.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "account.budget", entity: "user", entityId: id });
    ctx.redirect("/accounts?msg=Delegated+budget+updated");
  });

  // ---- Self-service account settings (any signed-in user) ----
  router.get("/account", (ctx) => {
    if (!requireAuth(ctx)) return;
    ctx.html(200, settingsPage(ctx, {}));
  });
  router.post("/account/password", (ctx) => {
    if (!requireAuth(ctx)) return;
    const { current = "", password = "" } = ctx.body;
    const fresh = getUserById(ctx.db, ctx.user.id);
    const errors = [];
    if (!verifyPassword(current, fresh.password_hash, fresh.password_salt)) errors.push("Current password is incorrect.");
    const pw = passwordProblem(password);
    if (pw) errors.push(pw);
    if (errors.length) return ctx.html(400, settingsPage(ctx, { errors }));
    setPassword(ctx.db, ctx.user.id, password, { mustChange: false });
    logAudit(ctx.db, { userId: ctx.user.id, action: "password.changed", entity: "user", entityId: ctx.user.id });
    ctx.redirect("/account?msg=Password+updated");
  });
}

function inviteLink(ctx, token) {
  const proto = ctx.config.COOKIE_SECURE ? "https" : (ctx.req.headers["x-forwarded-proto"] || "http");
  const host = ctx.req.headers["host"] || `localhost:${ctx.config.PORT}`;
  return `${proto}://${host}/invite?token=${token}`;
}

// ---- views ----
function accountsPage(ctx, { errors, banner, form = {} }) {
  const users = listUsers(ctx.db);
  const depts = listDepartments(ctx.db);

  const manageBlock = (u) => {
    const owned = departmentIdsForUser(ctx.db, u.id);
    const pool = getDelegatedBudget(ctx.db, u.id);
    const checks = depts.map((d) => html`<label class="check"><input type="checkbox" name="department_id" value="${d.id}" ${owned.includes(d.id) ? raw("checked") : ""}> ${d.name}</label>`);
    return html`<details class="manage">
      <summary>Manage responsibilities &amp; budget</summary>
      <form method="post" action="/accounts/${u.id}/departments" class="stack">
        ${csrfField(ctx)}
        <div class="checkgrid">${depts.length ? checks : html`<span class="muted">No departments yet.</span>`}</div>
        <button class="btn sm" type="submit">Save departments</button>
      </form>
      <form method="post" action="/accounts/${u.id}/budget" class="formgrid">
        ${csrfField(ctx)}
        <label>Delegated headcount<input name="headcount_budget" type="number" min="0" step="1" value="${pool.headcount_budget || 0}"></label>
        <label>Delegated budget ($)<input name="money_budget" type="number" min="0" step="any" value="${pool.money_budget || 0}"></label>
        <button class="btn sm" type="submit">Save budget</button>
      </form>
    </details>`;
  };

  const rows = users.map((u) => {
    const owned = departmentsForUser(ctx.db, u.id);
    const deptLabel = owned.length ? owned.map((d) => d.name).join(", ") : "-";
    const pool = getDelegatedBudget(ctx.db, u.id);
    const poolLabel = (pool.headcount_budget || pool.money_budget) ? `${pool.headcount_budget} / ${money(pool.money_budget)}` : "-";
    return html`<tr>
      <td><b>${u.name}</b><div class="sub">${u.email}</div></td>
      <td>${displayRole(u)}</td>
      <td>${deptLabel}</td>
      <td>${poolLabel}</td>
      <td>${u.last_login_at ? "Active" : (u.password_hash ? "Active" : "Pending invite")} ${u.status === "disabled" ? raw('<span class="pill off">Disabled</span>') : ""}</td>
      <td class="right">
        ${u.id === ctx.user.id ? raw('<span class="muted">you</span>') : html`
          <form method="post" action="/accounts/${u.id}/status" class="inline">
            ${csrfField(ctx)}
            <input type="hidden" name="status" value="${u.status === "disabled" ? "active" : "disabled"}">
            <button class="btn sm ghost" type="submit">${u.status === "disabled" ? "Enable" : "Disable"}</button>
          </form>
          <form method="post" action="/accounts/${u.id}/invite" class="inline">
            ${csrfField(ctx)}<button class="btn sm ghost" type="submit">Invite link</button>
          </form>`}
        ${u.role !== "finance_admin" ? manageBlock(u) : ""}
      </td>
    </tr>`;
  });

  const deptOptions = depts.map((d) => html`<option value="${d.id}" ${String(form.department_id) === String(d.id) ? raw("selected") : ""}>${d.name}</option>`);

  const body = html`
    <div class="pagehead"><h1>Collaborators</h1><p class="muted">The people this workspace collaborates with. A business owner can be responsible for several departments; Finance hands each owner one budget pool they split across those departments.</p></div>
    ${banner || ""}
    ${errorList(errors)}
    <div class="grid2">
      <section class="card">
        <h2>People</h2>
        <table class="table">
          <thead><tr><th>Name</th><th>Role</th><th>Departments</th><th>Delegated (HC / $)</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
      <section class="card">
        <h2>Add a collaborator</h2>
        <form method="post" action="/accounts">
          ${csrfField(ctx)}
          <label>Full name<input name="name" value="${form.name || ""}" required></label>
          <label>Email<input name="email" type="email" value="${form.email || ""}" required></label>
          <label>Role
            <select name="role" required>
              <option value="">Choose...</option>
              ${ACCOUNT_ROLE_OPTIONS.map(([r, lbl]) => html`<option value="${r}" ${form.role === r ? raw("selected") : ""}>${lbl}</option>`)}
            </select>
          </label>
          <label>Department <span class="hint">required for department owners; add more after creating</span>
            <select name="department_id"><option value="">-</option>${deptOptions}</select>
          </label>
          <label class="radio"><input type="checkbox" name="client_full" ${form.role === undefined ? raw("checked") : (form.client_full ? raw("checked") : "")}> Full data view — show exact compensation (applies to the Client role)</label>
          <fieldset class="radios">
            <label class="radio"><input type="radio" name="method" value="invite" checked> Send an invite link (they set their own password)</label>
            <label class="radio"><input type="radio" name="method" value="password"> Set a temporary password now</label>
          </fieldset>
          <button class="btn" type="submit">Create collaborator</button>
        </form>
        <p class="muted small">Need a department first? Manage them on the <a href="/departments">Departments</a> page.</p>
      </section>
    </div>`;
  return renderPage(ctx, { title: "Collaborators", body, active: "accounts" });
}

function settingsPage(ctx, { errors }) {
  const mustChange = getUserById(ctx.db, ctx.user.id).must_change_password;
  const body = html`
    <div class="pagehead"><h1>Account settings</h1></div>
    ${mustChange ? html`<div class="flash warn">For security, please set a new password to replace your temporary one.</div>` : ""}
    ${errorList(errors)}
    <section class="card narrow">
      <h2>Change password</h2>
      <form method="post" action="/account/password">
        ${csrfField(ctx)}
        <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label>New password <span class="hint">at least 10 characters</span><input name="password" type="password" autocomplete="new-password" required></label>
        <button class="btn" type="submit">Update password</button>
      </form>
    </section>`;
  return renderPage(ctx, { title: "Account", body });
}
