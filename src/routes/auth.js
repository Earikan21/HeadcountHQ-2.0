import { html } from "../html.js";
import { renderAuthPage, csrfField, errorList } from "../views/ui.js";
import { countUsers, getUserByEmail, createUserWithPassword, touchLogin, setPassword, getUserById } from "../repos/users.js";
import { verifyPassword, passwordProblem } from "../auth/passwords.js";
import { createSession, destroySession } from "../auth/sessions.js";
import { getInviteByToken, markInviteAccepted } from "../repos/invites.js";
import { logAudit } from "../repos/audit.js";
import { tooManyAttempts, clearAttempts } from "../auth/ratelimit.js";
import { clientIp } from "../middleware.js";
import { SESSION_COOKIE } from "../constants.js";

const startSession = (ctx, user) => {
  const { token } = createSession(ctx.db, user.id, { ip: clientIp(ctx.req), userAgent: ctx.req.headers["user-agent"] || "" });
  ctx.setCookie(SESSION_COOKIE, token);
};

export function registerAuthRoutes(router) {
  // ---- First-run owner setup ----
  router.get("/setup", (ctx) => {
    if (countUsers(ctx.db) > 0) return ctx.redirect("/login");
    ctx.html(200, setupForm(ctx, {}));
  });
  router.post("/setup", (ctx) => {
    if (countUsers(ctx.db) > 0) return ctx.send(403, "text/plain", "Setup already complete");
    const { name = "", email = "", password = "" } = ctx.body;
    const errors = [];
    if (!name.trim()) errors.push("Name is required.");
    if (!/.+@.+\..+/.test(email)) errors.push("A valid email is required.");
    const pw = passwordProblem(password);
    if (pw) errors.push(pw);
    if (errors.length) return ctx.html(400, setupForm(ctx, { errors, name, email }));

    const user = createUserWithPassword(ctx.db, { email, name, role: "finance_admin", password });
    logAudit(ctx.db, { userId: user.id, action: "owner.created", entity: "user", entityId: user.id });
    startSession(ctx, user);
    ctx.redirect("/");
  });

  // ---- Login ----
  router.get("/login", (ctx) => {
    if (ctx.user) return ctx.redirect("/");
    if (countUsers(ctx.db) === 0) return ctx.redirect("/setup");
    ctx.html(200, loginForm(ctx, {}));
  });
  router.post("/login", (ctx) => {
    const { email = "", password = "" } = ctx.body;
    const key = `${clientIp(ctx.req)}:${email.toLowerCase()}`;
    if (tooManyAttempts(key)) {
      return ctx.html(429, loginForm(ctx, { errors: ["Too many attempts. Wait a few minutes and try again."], email }));
    }
    const user = getUserByEmail(ctx.db, email);
    const ok = user && user.status === "active" && verifyPassword(password, user.password_hash, user.password_salt);
    if (!ok) {
      logAudit(ctx.db, { userId: user ? user.id : null, action: "login.failed", entity: "user", detail: { email } });
      return ctx.html(401, loginForm(ctx, { errors: ["Incorrect email or password."], email }));
    }
    clearAttempts(key);
    touchLogin(ctx.db, user.id);
    logAudit(ctx.db, { userId: user.id, action: "login.success", entity: "user", entityId: user.id });
    startSession(ctx, user);
    ctx.redirect(user.must_change_password ? "/account?msg=Please+set+a+new+password" : "/");
  });

  // ---- Logout ----
  router.post("/logout", (ctx) => {
    destroySession(ctx.db, ctx.cookies[SESSION_COOKIE]);
    ctx.clearCookie(SESSION_COOKIE);
    ctx.redirect("/login");
  });

  // ---- Invite acceptance ----
  router.get("/invite", (ctx) => {
    const token = ctx.query.get("token") || "";
    const inv = getInviteByToken(ctx.db, token);
    if (!inv || inv._state !== "valid") {
      return ctx.html(400, renderAuthPage(ctx, { title: "Invite", body: html`<div class="card auth"><h1>Invite link</h1><p class="muted">This invite is invalid, expired, or already used. Ask your administrator for a new one.</p></div>` }));
    }
    ctx.html(200, inviteForm(ctx, { token, email: inv.email }));
  });
  router.post("/invite", (ctx) => {
    const { token = "", password = "" } = ctx.body;
    const inv = getInviteByToken(ctx.db, token);
    if (!inv || inv._state !== "valid") return ctx.send(400, "text/plain", "Invite invalid or expired");
    const pwErr = passwordProblem(password);
    if (pwErr) return ctx.html(400, inviteForm(ctx, { token, email: inv.email, errors: [pwErr] }));
    const user = getUserByEmail(ctx.db, inv.email);
    if (!user) return ctx.send(400, "text/plain", "No matching account");
    setPassword(ctx.db, user.id, password, { mustChange: false });
    markInviteAccepted(ctx.db, inv.id);
    logAudit(ctx.db, { userId: user.id, action: "invite.accepted", entity: "user", entityId: user.id });
    startSession(ctx, user);
    ctx.redirect("/");
  });
}

// ---- views ----
function setupForm(ctx, { errors, name = "", email = "" }) {
  const body = html`<div class="card auth">
    <h1>Create the owner account</h1>
    <p class="muted">This is the Finance Admin who owns the workspace. You can add more people afterward.</p>
    ${errorList(errors)}
    <form method="post" action="/setup">
      ${csrfField(ctx)}
      <label>Full name<input name="name" value="${name}" autocomplete="name" required></label>
      <label>Email<input name="email" type="email" value="${email}" autocomplete="username" required></label>
      <label>Password <span class="hint">at least 10 characters</span><input name="password" type="password" autocomplete="new-password" required></label>
      <button class="btn" type="submit">Create owner &amp; sign in</button>
    </form>
  </div>`;
  return renderAuthPage(ctx, { title: "Setup", body });
}

function loginForm(ctx, { errors, email = "" }) {
  const body = html`<div class="card auth">
    <h1>Sign in</h1>
    ${errorList(errors)}
    <form method="post" action="/login">
      ${csrfField(ctx)}
      <label>Email<input name="email" type="email" value="${email}" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Sign in</button>
    </form>
  </div>`;
  return renderAuthPage(ctx, { title: "Sign in", body });
}

function inviteForm(ctx, { token, email, errors }) {
  const body = html`<div class="card auth">
    <h1>Set your password</h1>
    <p class="muted">Welcome. Choose a password for <b>${email}</b> to activate your account.</p>
    ${errorList(errors)}
    <form method="post" action="/invite">
      ${csrfField(ctx)}
      <input type="hidden" name="token" value="${token}">
      <label>Password <span class="hint">at least 10 characters</span><input name="password" type="password" autocomplete="new-password" required></label>
      <button class="btn" type="submit">Activate account</button>
    </form>
  </div>`;
  return renderAuthPage(ctx, { title: "Set password", body });
}
