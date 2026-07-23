/**
 * End-to-end Google Sheets push: connect (OAuth), point at a sheet, push. All Google
 * network calls are stubbed via global fetch — no real Google contact.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

let srv, admin;
const realFetch = globalThis.fetch;
const json = (o) => ({ ok: true, json: async () => o });

before(async () => {
  srv = await startTestServer({ PUBLIC_URL: "https://hq.example.com", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    if (u.includes("/oauth2/v2/userinfo")) return json({ email: "owner@acme.co" });
    if (/\/spreadsheets\/[^/?]+\?/.test(u)) return json({ sheets: [{ properties: { sheetId: 0, title: "Headcount" } }] });
    return json({}); // clear, values PUT, batchUpdate
  };
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  // a little roster so the push has rows
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\nE-1,Dana,Sales,120000,Annual";
  await admin.get("/roster/import");
  const up = await admin.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await admin.post(`/roster/import/${id}/map`, { map_employee_id: "Employee ID", map_name: "Name", map_department: "Department", map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit" });
  await admin.post(`/roster/import/${id}/commit`, {});
});
after(async () => { globalThis.fetch = realFetch; await srv.close(); });

const conn = () => srv.db.prepare("SELECT * FROM google_connections WHERE workspace_id=1").get();

test("the admin page shows Connect when configured but not yet connected", async () => {
  const page = await (await admin.get("/integrations/google")).text();
  assert.match(page, /Connect Google Sheets/);
  assert.match(page, /class="nav-link[^"]*"[^>]*>Google Sheets</, "nav item present for the admin");
});

test("connect redirects to Google's consent with offline access", async () => {
  const res = await admin.get("/integrations/google/connect");
  assert.equal(res.status, 303);
  const loc = res.headers.get("location");
  assert.match(loc, /accounts\.google\.com/);
  const q = new URL(loc).searchParams;
  assert.equal(q.get("access_type"), "offline");
  assert.ok(q.get("state"), "carries a state");
});

test("the callback stores an (encrypted) connection", async () => {
  // grab a fresh state from connect, then hit the callback with it
  const loc = (await admin.get("/integrations/google/connect")).headers.get("location");
  const state = new URL(loc).searchParams.get("state");
  const res = await admin.get(`/integrations/google/callback?state=${state}&code=abc123`);
  assert.equal(res.status, 303);
  const c = conn();
  assert.ok(c && c.refresh_token_enc, "a refresh token is stored");
  assert.ok(!/(^|=)rt($|&)/.test(c.refresh_token_enc), "and it's encrypted, not the raw token");
  assert.equal(c.account_email, "owner@acme.co");
});

test("pointing at a sheet parses the id from the pasted URL", async () => {
  await admin.post("/integrations/google/target", { spreadsheet: "https://docs.google.com/spreadsheets/d/SHEET_ID_1234567890/edit#gid=0", sheet_title: "Headcount" });
  assert.equal(conn().spreadsheet_id, "SHEET_ID_1234567890");
});

test("push writes to the sheet and records success", async () => {
  const res = await admin.post("/integrations/google/push", {});
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /Pushed/);
  const c = conn();
  assert.equal(c.status, "connected");
  assert.ok(c.last_pushed_at, "last_pushed_at is set");
});

test("a non-admin can't reach the integration", async () => {
  const anon = makeClient(srv.base);
  await anon.get("/login");
  const res = await anon.get("/integrations/google");
  assert.notEqual(res.status, 200);
});
