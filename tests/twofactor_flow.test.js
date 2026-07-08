/**
 * Two-factor auth, end to end, with enforcement ON (as in production).
 *
 * The invariants: a user with no 2FA is forced to enroll before reaching the app; a
 * user with 2FA on must pass a code (or recovery code) after their password; and the
 * roster/model — everything — stays sealed off until both are satisfied.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { totp } from "../src/domain/totp.js";

let srv, admin;
const secretOf = (email) => srv.db.prepare("SELECT totp_secret FROM users WHERE email=?").get(email).totp_secret;
const code = (email) => totp(secretOf(email));

before(async () => {
  srv = await startTestServer({ MFA_ENFORCED: "true" });
  admin = makeClient(srv.base);
});
after(async () => { await srv.close(); });

test("a freshly set-up owner is forced to enroll before anything else", async () => {
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  // The app redirects everywhere to enrollment.
  const home = await admin.get("/");
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/account/2fa/setup");
  const roster = await admin.get("/roster");
  assert.equal(roster.headers.get("location"), "/account/2fa/setup");

  // The setup page offers both a scannable QR and a typed key.
  const page = await (await admin.get("/account/2fa/setup")).text();
  assert.match(page, /<svg xmlns/, "QR is rendered inline");
  assert.match(page, /Setup key/);
  assert.match(page, /aria-label="QR code"/);
  assert.ok(secretOf("ada@acme.co"), "a candidate secret was parked on the account");
  assert.equal(srv.db.prepare("SELECT totp_enabled FROM users WHERE email='ada@acme.co'").get().totp_enabled, 0);
});

test("a wrong code is rejected; the right code turns 2FA on and reveals recovery codes", async () => {
  await admin.get("/account/2fa/setup"); // (re)issues a secret
  const bad = await admin.post("/account/2fa/enable", { code: "000000" });
  assert.equal(bad.status, 400);
  assert.equal(srv.db.prepare("SELECT totp_enabled FROM users WHERE email='ada@acme.co'").get().totp_enabled, 0);

  const ok = await admin.post("/account/2fa/enable", { code: code("ada@acme.co") });
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /Two-factor is on/);
  const shown = [...body.matchAll(/<li><code>([0-9A-Z]{4}-[0-9A-Z]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(shown.length, 10, "ten recovery codes shown once");
  globalThis.__recovery = shown;

  assert.equal(srv.db.prepare("SELECT totp_enabled FROM users WHERE email='ada@acme.co'").get().totp_enabled, 1);
  // now enrolled: the app opens up
  assert.equal((await admin.get("/")).status, 200);
});

test("a new login requires the second factor", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  const afterPw = await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  assert.equal(afterPw.headers.get("location"), "/login/2fa", "password alone lands on the code step");
  // still sealed off until the code
  assert.equal((await c.get("/")).headers.get("location"), "/login/2fa");
  assert.equal((await c.get("/roster")).headers.get("location"), "/login/2fa");

  const wrong = await c.post("/login/2fa", { code: "000000" });
  assert.equal(wrong.status, 401);
  const good = await c.post("/login/2fa", { code: code("ada@acme.co") });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "/");
  assert.equal((await c.get("/")).status, 200, "now fully signed in");
});

test("a recovery code works once and is then spent", async () => {
  const codes = globalThis.__recovery;
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  const used = codes[0];
  const ok = await c.post("/login/2fa", { mode: "recovery", code: used });
  assert.equal(ok.headers.get("location"), "/");
  assert.equal((await c.get("/")).status, 200);

  // the same code cannot be reused
  const c2 = makeClient(srv.base);
  await c2.get("/login");
  await c2.post("/login", { email: "ada@acme.co", password: "supersecret123" });
  const reuse = await c2.post("/login/2fa", { mode: "recovery", code: used });
  assert.equal(reuse.status, 401);
  assert.equal(srv.db.prepare("SELECT json_array_length(totp_recovery_json) n FROM users WHERE email='ada@acme.co'").get().n, 9, "one code consumed");
});

test("an admin can reset a locked-out user's 2FA, forcing re-enrollment", async () => {
  // add a second collaborator (client role needs no department) and enroll them
  const created = await admin.post("/accounts", { name: "Bo", email: "bo@acme.co", role: "client", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  const bo = makeClient(srv.base);
  await bo.get("/login");
  await bo.post("/login", { email: "bo@acme.co", password: pw });
  assert.equal((await bo.get("/")).headers.get("location"), "/account/2fa/setup", "new account must enroll");
  await bo.get("/account/2fa/setup");
  await bo.post("/account/2fa/enable", { code: code("bo@acme.co") });
  assert.equal(srv.db.prepare("SELECT totp_enabled FROM users WHERE email='bo@acme.co'").get().totp_enabled, 1);

  // Admin resets Bo (lost phone)
  const boId = srv.db.prepare("SELECT id FROM users WHERE email='bo@acme.co'").get().id;
  const reset = await admin.post(`/accounts/${boId}/2fa/reset`, {});
  assert.equal(reset.status, 303);
  const row = srv.db.prepare("SELECT totp_enabled, totp_secret FROM users WHERE id=?").get(boId);
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);

  // Bo's old sessions are gone; a fresh login logs in on password (no 2FA) but is
  // then forced to re-enroll rather than sent to the code step.
  const bo2 = makeClient(srv.base);
  await bo2.get("/login");
  const afterPw = await bo2.post("/login", { email: "bo@acme.co", password: pw });
  // No 2FA now, so password alone signs in (temp password sends them to reset it) —
  // crucially NOT the /login/2fa code step.
  assert.notEqual(afterPw.headers.get("location"), "/login/2fa");
  assert.equal((await bo2.get("/")).headers.get("location"), "/account/2fa/setup", "then forced to re-enroll");
});

test("resetting someone's 2FA requires admin rights", async () => {
  const adaId = srv.db.prepare("SELECT id FROM users WHERE email='ada@acme.co'").get().id;
  const anon = makeClient(srv.base); // not signed in
  const res = await anon.post(`/accounts/${adaId}/2fa/reset`, {});
  assert.ok(res.status === 303 || res.status === 403, "not allowed without admin rights");
  assert.equal(srv.db.prepare("SELECT totp_enabled FROM users WHERE id=?").get(adaId).totp_enabled, 1, "admin's 2FA untouched");
});

test("with enforcement off (default in tests), no 2FA is required", async () => {
  const s2 = await startTestServer(); // MFA_ENFORCED defaults to false in the harness
  const c = makeClient(s2.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Zed", email: "z@acme.co", password: "supersecret123" });
  assert.equal((await c.get("/")).status, 200, "straight into the app, no enrollment gate");
  await s2.close();
});
