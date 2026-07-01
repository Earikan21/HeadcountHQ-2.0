/** Small request guards shared across routes. */
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
