/** Small request guards shared across routes. */
import { featureEnabled } from "./features.js";

/**
 * Ensure a feature flag is enabled; otherwise 404 (a hidden feature should be
 * indistinguishable from a non-existent page). Returns true if OK. Used for
 * sub-routes of an otherwise-registered area (e.g. benchmark actions inside
 * Philosophy). Whole hidden areas are simply not registered — see routes.js.
 */
export function requireFeature(ctx, key) {
  if (featureEnabled(ctx.config, key)) return true;
  ctx.send(404, "text/html; charset=utf-8",
    "<!doctype html><meta charset=utf-8><title>Not found</title><p style='font-family:sans-serif;padding:40px'>Page not found. <a href='/'>Home</a></p>");
  return false;
}

export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

/** Ensure a logged-in user; otherwise redirect to login. Returns true if OK. */
export function requireAuth(ctx) {
  if (!ctx.user) { ctx.redirect("/login"); return false; }
  return true;
}

/** Ensure the user passes the predicate; otherwise 403. Returns true if OK. */
export function requirePermission(ctx, predicate) {
  if (!ctx.user) { ctx.redirect("/login"); return false; }
  if (!predicate(ctx.user)) {
    ctx.send(403, "text/html; charset=utf-8",
      "<!doctype html><meta charset=utf-8><p style='font-family:sans-serif;padding:40px'>You don't have access to that.</p>");
    return false;
  }
  return true;
}
