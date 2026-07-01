import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

test("serves the home page", async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const body = await res.text();
  assert.match(body, /Headcount HQ/);
});

test("health returns ok text", async () => {
  const res = await fetch(`${srv.base}/health`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /healthy/);
});

test("health.json returns ok", async () => {
  const res = await fetch(`${srv.base}/health.json`);
  const json = await res.json();
  assert.equal(json.status, "ok");
});

test("sets security headers", async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("serves the stylesheet", async () => {
  const res = await fetch(`${srv.base}/static/app.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/css/);
});

test("blocks path traversal on static", async () => {
  const res = await fetch(`${srv.base}/static/../server.js`);
  assert.ok(res.status === 404 || res.status === 403);
});

test("unknown route returns 404", async () => {
  const res = await fetch(`${srv.base}/nope`);
  assert.equal(res.status, 404);
});
