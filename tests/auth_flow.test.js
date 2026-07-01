import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

test("root redirects to /setup when there are no users", async () => {
  const c = makeClient(srv.base);
  const res = await c.get("/");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/setup");
});

test("owner setup creates a finance_admin and signs in", async () => {
  const c = makeClient(srv.base);
  await c.get("/setup"); // sets CSRF cookie
  const res = await c.post("/setup", { name: "Dana Owner", email: "dana@acme.co", password: "supersecret123" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.ok(c.jar.hq_session, "session cookie set");
  const home = await c.get("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Welcome, Dana/);
});

test("second visit to /setup is blocked; /login works", async () => {
  const c = makeClient(srv.base);
  const setup = await c.get("/setup");
  assert.equal(setup.status, 303); // already complete -> /login
  const login = await c.get("/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Sign in/);
});

test("POST without CSRF token is rejected", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  const res = await c.post("/login", { _csrf: "", email: "x@y.z", password: "nope123456" });
  assert.equal(res.status, 403);
});

test("login fails with wrong password, succeeds with right one", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  const bad = await c.post("/login", { email: "dana@acme.co", password: "wrongpass123" });
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Incorrect/);
  const good = await c.post("/login", { email: "dana@acme.co", password: "supersecret123" });
  assert.equal(good.status, 303);
  assert.ok(c.jar.hq_session);
});

test("admin creates a department and a manager; role boundaries hold", async () => {
  const admin = makeClient(srv.base);
  await admin.get("/login");
  await admin.post("/login", { email: "dana@acme.co", password: "supersecret123" });

  // department
  await admin.get("/departments");
  const dep = await admin.post("/departments", { name: "Engineering" });
  assert.equal(dep.status, 303);

  // manager via temporary password
  await admin.get("/accounts");
  const created = await admin.post("/accounts", {
    name: "Mira Manager", email: "mira@acme.co", role: "manager", department_id: "1", method: "password",
  });
  const createdHtml = await created.text();
  const tempPw = createdHtml.match(/<code>([^<]+)<\/code>/)[1];
  assert.ok(tempPw && tempPw.length > 6);

  // manager signs in, is boxed out of admin areas
  const mgr = makeClient(srv.base);
  await mgr.get("/login");
  const mlogin = await mgr.post("/login", { email: "mira@acme.co", password: tempPw });
  assert.equal(mlogin.status, 303); // -> /account (must change pw)
  const acc = await mgr.get("/accounts");
  assert.equal(acc.status, 403);
  const deps = await mgr.get("/departments");
  assert.equal(deps.status, 403);
  const home = await mgr.get("/");
  assert.match(await home.text(), /Department Manager/);
});

test("invite flow: create invite, accept, sign in", async () => {
  const admin = makeClient(srv.base);
  await admin.get("/login");
  await admin.post("/login", { email: "dana@acme.co", password: "supersecret123" });
  await admin.get("/accounts");
  const res = await admin.post("/accounts", {
    name: "Cara Exec", email: "cara@acme.co", role: "c_suite", method: "invite",
  });
  const token = (await res.text()).match(/\/invite\?token=([a-f0-9]+)/)[1];
  assert.ok(token);

  const invitee = makeClient(srv.base);
  const form = await invitee.get(`/invite?token=${token}`);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /Set your password/);
  const accept = await invitee.post("/invite", { token, password: "execpassword123" });
  assert.equal(accept.status, 303);
  assert.ok(invitee.jar.hq_session);
});

test("logout clears the session", async () => {
  const c = makeClient(srv.base);
  await c.get("/login");
  await c.post("/login", { email: "dana@acme.co", password: "supersecret123" });
  const out = await c.post("/logout", {});
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/login");
  const home = await c.get("/");
  assert.equal(home.status, 303); // not signed in -> redirect
});
