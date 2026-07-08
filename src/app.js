/**
 * Builds the HTTP server and the per-request context. Responsibilities:
 *  - security headers
 *  - static assets (with path-traversal protection)
 *  - cookie parsing + helpers
 *  - form body parsing (urlencoded + multipart for uploads)
 *  - session/user attachment (the auth middleware)
 *  - CSRF protection (double-submit cookie) for all POSTs
 *  - dispatch to the router
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "./router.js";
import { registerRoutes } from "./routes.js";
import { getSession } from "./auth/sessions.js";
import { parseBody } from "./http_body.js";
import { SESSION_COOKIE, CSRF_COOKIE } from "./constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "..", "public");
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (roster uploads)

const STATIC_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function buildApp({ config, db }) {
  const router = new Router();
  registerRoutes(router, { config, db });

  const server = createServer(async (req, res) => {
    const ctx = makeContext(req, res, { config, db });
    try {
      setSecurityHeaders(res, config);
      const pathname = ctx.url.pathname;

      if (pathname.startsWith("/static/")) {
        return await serveStatic(pathname.slice("/static/".length), res);
      }

      // Cookies + CSRF token (double-submit). Ensure a CSRF cookie exists.
      ensureCsrfCookie(ctx);
      // Attach the logged-in user, if any.
      attachUser(ctx);
      // Two-factor gate: hold a password-only session at the code step, and force
      // enrollment for anyone not yet set up. Runs before dispatch so no page leaks.
      if (mfaGate(ctx)) return;

      const matched = router.match(req.method, pathname);
      if (!matched) return ctx.send(404, "text/html; charset=utf-8", notFoundPage());

      if (req.method === "POST") {
        await parseBody(req, ctx, MAX_BODY);
        if (!csrfOk(ctx)) return ctx.send(403, "text/html; charset=utf-8", csrfErrorPage());
      }

      ctx.params = matched.params;
      await matched.handler(ctx);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) ctx.send(500, "text/html; charset=utf-8", errorPage());
    }
  });

  return server;
}

function makeContext(req, res, { config, db }) {
  const url = new URL(req.url, "http://localhost");
  const cookies = parseCookies(req.headers.cookie || "");
  const setCookies = [];

  const ctx = {
    req, res, url, config, db,
    params: {},
    query: url.searchParams,
    cookies,
    body: {},
    files: {},
    user: null,
    session: null,
    csrf: cookies[CSRF_COOKIE] || "",
    setCookie(name, value, opts = {}) {
      setCookies.push(serializeCookie(name, value, { httpOnly: true, sameSite: "Lax", path: "/", secure: config.COOKIE_SECURE, ...opts }));
    },
    clearCookie(name) {
      setCookies.push(serializeCookie(name, "", { path: "/", maxAge: 0 }));
    },
    _flush() {
      if (setCookies.length) res.setHeader("Set-Cookie", setCookies);
    },
    send(status, type, bodyStr) {
      ctx._flush();
      res.writeHead(status, { "Content-Type": type });
      res.end(bodyStr);
    },
    html(status, htmlStr) { ctx.send(status, "text/html; charset=utf-8", String(htmlStr)); },
    json(status, obj) { ctx.send(status, "application/json; charset=utf-8", JSON.stringify(obj)); },
    redirect(location, status = 303) {
      ctx._flush();
      // encodeURI keeps URL structure but escapes stray non-ASCII (e.g. an em dash
      // in a flash message), which would otherwise be an illegal header value.
      res.writeHead(status, { Location: encodeURI(location) });
      res.end();
    },
    attachment(filename, type, bodyStr) {
      ctx._flush();
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      res.end(bodyStr);
    },
  };
  return ctx;
}

const CSRF_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
function ensureCsrfCookie(ctx) {
  if (!ctx.csrf) {
    ctx.csrf = randomBytes(24).toString("hex");
    // Persistent (not a session cookie): survives browser restarts and long-open
    // form pages, which avoids spurious "Invalid CSRF token" failures.
    ctx.setCookie(CSRF_COOKIE, ctx.csrf, { maxAge: CSRF_MAX_AGE });
  }
}

function csrfOk(ctx) {
  const rawCsrf = ctx.body._csrf;
  const sent = String((Array.isArray(rawCsrf) ? rawCsrf[0] : rawCsrf) || "");
  const cookie = String(ctx.csrf || "");
  if (!sent || !cookie || sent.length !== cookie.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sent), Buffer.from(cookie));
  } catch {
    return false;
  }
}

/**
 * When 2FA is enforced, keep a logged-in user out of the app until they've both
 * enrolled and cleared the second factor. The allowlist is exactly the pages needed
 * to do those two things (plus sign-out); everything else redirects.
 */
const MFA_ALLOW = new Set(["/login/2fa", "/account/2fa/setup", "/account/2fa/enable", "/logout"]);
function mfaGate(ctx) {
  if (!ctx.config.mfaEnforced || !ctx.user) return false;
  if (MFA_ALLOW.has(ctx.url.pathname)) return false;
  if (ctx.session && ctx.session.mfa_pending) { ctx.redirect("/login/2fa"); return true; }
  if (!ctx.user.totp_enabled) { ctx.redirect("/account/2fa/setup"); return true; }
  return false;
}

function attachUser(ctx) {
  const token = ctx.cookies[SESSION_COOKIE];
  const found = getSession(ctx.db, token);
  if (found) {
    ctx.user = found.user;
    ctx.session = found.session;
  }
}

// ---- helpers ----
function setSecurityHeaders(res, config) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; img-src 'self' data: https://api.qrserver.com; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (config.COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name, value, opts) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.path) s += `; Path=${opts.path}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly) s += "; HttpOnly";
  if (opts.sameSite) s += `; SameSite=${opts.sameSite}`;
  if (opts.secure) s += "; Secure";
  return s;
}

async function serveStatic(relPath, res) {
  const safeRel = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(PUBLIC_DIR, safeRel);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "text/plain", "Forbidden");
  try {
    const data = await readFile(full);
    const ext = safeRel.slice(safeRel.lastIndexOf("."));
    send(res, 200, STATIC_TYPES[ext] || "application/octet-stream", data);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
}
function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}
function notFoundPage() {
  return "<!doctype html><meta charset=utf-8><title>Not found</title><p style='font-family:sans-serif;padding:40px'>Page not found. <a href='/'>Home</a></p>";
}
function csrfErrorPage() {
  return `<!doctype html><meta charset=utf-8><title>Session expired</title>
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px">
<h1 style="font-size:20px">Your page expired</h1>
<p>For your security, this form's token didn't match. This usually means the page sat open
too long, or cookies are being blocked.</p>
<p><b>Go back, reload the page, and submit again.</b></p>
<p style="color:#64748b;font-size:13px">Running it yourself over http://localhost? Set
<code>COOKIE_SECURE=false</code> in your <code>.env</code> — Secure cookies are dropped on non-HTTPS.</p>
<p><a href="/">Back to Headcount HQ</a></p></div>`;
}
function errorPage() {
  return "<!doctype html><meta charset=utf-8><title>Error</title><p style='font-family:sans-serif;padding:40px'>Something went wrong. Please try again.</p>";
}
