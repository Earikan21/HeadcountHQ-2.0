/**
 * Two-factor auth (TOTP) — the second-factor login step and enrollment.
 *
 * Login is two phases. `/login` checks the password and, if the user has 2FA on,
 * creates a session flagged `mfa_pending` and sends them here to `/login/2fa`. The
 * global gate in app.js keeps a pending session out of everything else until the code
 * (or a recovery code) clears it. Enrollment lives under `/account/2fa/*`.
 *
 * The QR image is a self-rendered inline SVG (see domain/qr.js) because the strict
 * CSP forbids external image hosts; the base32 secret is shown too, so an app that
 * can't scan still works via manual entry.
 */
import { html, raw } from "../html.js";
import { renderAuthPage, renderPage, csrfField, errorList } from "../views/ui.js";
import { requireAuth } from "../middleware.js";
import { getUserById, setTotpSecret, enableTotp, resetTotp, consumeRecoveryCode, regenerateRecoveryCodes, recoveryCodesRemaining } from "../repos/users.js";
import { markSessionMfaPassed } from "../auth/sessions.js";
import { generateSecret, verifyTotp, otpauthURL, generateRecoveryCodes } from "../domain/totp.js";
import { qrSvg } from "../domain/qr.js";
import { logAudit } from "../repos/audit.js";
import { tooManyAttempts, clearAttempts } from "../auth/ratelimit.js";
import { clientIp } from "../middleware.js";
import { SESSION_COOKIE } from "../constants.js";

const digitsOnly = (s) => String(s || "").replace(/\D/g, "");

export function registerTwoFactorRoutes(router) {
  // ---- Second factor at login -------------------------------------------------
  router.get("/login/2fa", (ctx) => {
    if (!ctx.user) return ctx.redirect("/login");
    if (!ctx.session || !ctx.session.mfa_pending) return ctx.redirect("/"); // already cleared
    ctx.html(200, twoFactorForm(ctx, {}));
  });

  router.post("/login/2fa", (ctx) => {
    if (!ctx.user) return ctx.redirect("/login");
    if (!ctx.session || !ctx.session.mfa_pending) return ctx.redirect("/");
    const key = `2fa:${clientIp(ctx.req)}:${ctx.user.id}`;
    if (tooManyAttempts(key)) return ctx.html(429, twoFactorForm(ctx, { errors: ["Too many attempts. Wait a few minutes and try again."] }));

    const fresh = getUserById(ctx.db, ctx.user.id);
    const useRecovery = String(ctx.body.mode || "") === "recovery";
    const passed = useRecovery
      ? consumeRecoveryCode(ctx.db, fresh.id, ctx.body.code)
      : verifyTotp(fresh.totp_secret, digitsOnly(ctx.body.code));

    if (!passed) {
      logAudit(ctx.db, { userId: fresh.id, action: "login.2fa_failed", entity: "user", entityId: fresh.id, detail: { mode: useRecovery ? "recovery" : "totp" } });
      return ctx.html(401, twoFactorForm(ctx, { errors: [useRecovery ? "That recovery code is invalid or already used." : "Incorrect code. Check your authenticator and try again."], recovery: useRecovery }));
    }
    clearAttempts(key);
    markSessionMfaPassed(ctx.db, ctx.cookies[SESSION_COOKIE]);
    logAudit(ctx.db, { userId: fresh.id, action: "login.2fa_success", entity: "user", entityId: fresh.id, detail: { mode: useRecovery ? "recovery" : "totp" } });
    ctx.redirect(fresh.must_change_password ? "/account?msg=Please+set+a+new+password" : "/");
  });

  // ---- Enrollment -------------------------------------------------------------
  router.get("/account/2fa/setup", (ctx) => {
    if (!requireAuth(ctx)) return;
    if (ctx.user.totp_enabled) return ctx.redirect("/account?msg=Two-factor+is+already+on");
    // A candidate secret is generated once and parked on the row (enabled=0) so the
    // GET and the confirming POST agree on the same key. Regenerated each visit so a
    // half-finished attempt never lingers.
    const secret = generateSecret();
    setTotpSecret(ctx.db, ctx.user.id, secret);
    ctx.html(200, setupPage(ctx, { secret }));
  });

  router.post("/account/2fa/enable", (ctx) => {
    if (!requireAuth(ctx)) return;
    const fresh = getUserById(ctx.db, ctx.user.id);
    if (fresh.totp_enabled) return ctx.redirect("/account");
    const secret = fresh.totp_secret;
    if (!secret) return ctx.redirect("/account/2fa/setup");
    if (!verifyTotp(secret, digitsOnly(ctx.body.code))) {
      return ctx.html(400, setupPage(ctx, { secret, errors: ["That code didn't match. Make sure your phone's clock is correct, then try the current 6-digit code."] }));
    }
    const { codes, hashes } = generateRecoveryCodes();
    enableTotp(ctx.db, fresh.id, hashes);
    // Re-issue the current session as fully authenticated (it was never pending, but
    // this also future-proofs enabling right after a pending state).
    markSessionMfaPassed(ctx.db, ctx.cookies[SESSION_COOKIE]);
    logAudit(ctx.db, { userId: fresh.id, action: "2fa.enabled", entity: "user", entityId: fresh.id });
    ctx.html(200, recoveryPage(ctx, { codes, firstTime: true }));
  });

  // ---- Manage (regenerate codes; admins reset a locked-out user) ---------------
  router.post("/account/2fa/recovery", (ctx) => {
    if (!requireAuth(ctx)) return;
    const fresh = getUserById(ctx.db, ctx.user.id);
    if (!fresh.totp_enabled) return ctx.redirect("/account");
    if (!verifyTotp(fresh.totp_secret, digitsOnly(ctx.body.code))) {
      return ctx.html(400, manageRecoveryPage(ctx, { errors: ["Enter a current code from your authenticator to regenerate backup codes."] }));
    }
    const codes = regenerateRecoveryCodes(ctx.db, fresh.id);
    logAudit(ctx.db, { userId: fresh.id, action: "2fa.recovery_regenerated", entity: "user", entityId: fresh.id });
    ctx.html(200, recoveryPage(ctx, { codes, firstTime: false }));
  });

  router.get("/account/2fa/recovery", (ctx) => {
    if (!requireAuth(ctx)) return;
    if (!ctx.user.totp_enabled) return ctx.redirect("/account/2fa/setup");
    ctx.html(200, manageRecoveryPage(ctx, {}));
  });
}

// ---- views -----------------------------------------------------------------

function twoFactorForm(ctx, { errors, recovery = false }) {
  const body = html`<div class="card auth">
    <h1>Two-step verification</h1>
    <p class="muted">${recovery ? "Enter one of your backup recovery codes." : "Enter the 6-digit code from your authenticator app."}</p>
    ${errorList(errors)}
    <form method="post" action="/login/2fa">
      ${csrfField(ctx)}
      <input type="hidden" name="mode" value="${recovery ? "recovery" : "totp"}">
      ${recovery
        ? html`<label>Recovery code<input name="code" autocomplete="one-time-code" placeholder="xxxx-xxxx" autofocus required></label>`
        : html`<label>Authentication code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" placeholder="123456" autofocus required></label>`}
      <button class="btn" type="submit">Verify &amp; sign in</button>
    </form>
    <p class="muted small" style="margin-top:14px">
      ${recovery
        ? raw('<a href="/login/2fa">Use your authenticator instead</a>')
        : raw('Lost your phone? <a href="/login/2fa?recovery=1">Use a recovery code</a>')}
      · <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">Sign out</button></form>
    </p>
  </div>`;
  // honour ?recovery=1 on the GET too
  return renderAuthPage(ctx, { title: "Two-step verification", body });
}

function setupPage(ctx, { secret, errors }) {
  const uri = otpauthURL({ secret, label: ctx.user.email });
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();
  const body = html`
    <div class="pagehead"><h1>Set up two-factor authentication</h1>
      <p class="muted">Your workspace requires a second step at sign-in. It takes about a minute.</p></div>
    ${errorList(errors)}
    <section class="card twofa-setup">
      <ol class="twofa-steps">
        <li><b>Install an authenticator app</b> if you don't have one — Google Authenticator, 1Password, Authy, or similar.</li>
        <li><b>Scan this QR code</b>, or enter the key by hand.
          <div class="twofa-enroll">
            <div class="twofa-qr">${raw(qrSvg(uri, { size: 200 }))}</div>
            <div class="twofa-key">
              <div class="muted small">Setup key (manual entry)</div>
              <code class="twofa-secret">${grouped}</code>
              <div class="muted small">Account: ${ctx.user.email}</div>
            </div>
          </div>
        </li>
        <li><b>Enter the 6-digit code</b> your app shows to finish.
          <form method="post" action="/account/2fa/enable" class="twofa-confirm">
            ${csrfField(ctx)}
            <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" placeholder="123456" aria-label="Authentication code" required>
            <button class="btn" type="submit">Turn on two-factor</button>
          </form>
        </li>
      </ol>
    </section>`;
  return renderPage(ctx, { title: "Set up two-factor", body, active: "account" });
}

function recoveryPage(ctx, { codes, firstTime }) {
  const body = html`
    <div class="pagehead"><h1>${firstTime ? "Two-factor is on 🎉" : "New recovery codes"}</h1>
      <p class="muted">Save these backup codes somewhere safe. Each works <b>once</b> if you lose your phone. This is the only time they're shown.</p></div>
    <section class="card">
      <ul class="recovery-codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul>
      <p class="muted small">Regenerating codes later invalidates this set.</p>
      <a class="btn" href="/">Continue to Headcount HQ</a>
      <a class="btn ghost" href="/account">Account settings</a>
    </section>`;
  return renderPage(ctx, { title: "Recovery codes", body, active: "account" });
}

function manageRecoveryPage(ctx, { errors }) {
  const remaining = recoveryCodesRemaining(ctx.db, ctx.user.id);
  const body = html`
    <div class="pagehead"><h1>Backup recovery codes</h1>
      <p class="muted">You have <b>${remaining}</b> unused code${remaining === 1 ? "" : "s"} left. Regenerate to get a fresh set of ten (the old ones stop working).</p></div>
    ${errorList(errors)}
    <section class="card">
      <form method="post" action="/account/2fa/recovery" class="twofa-confirm">
        ${csrfField(ctx)}
        <label>Confirm with a current code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" placeholder="123456" required></label>
        <button class="btn" type="submit">Regenerate recovery codes</button>
      </form>
    </section>`;
  return renderPage(ctx, { title: "Recovery codes", body, active: "account" });
}
