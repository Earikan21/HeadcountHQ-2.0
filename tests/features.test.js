import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { resolveFeatures } from "../src/features.js";

// ---- pure unit: default flag resolution ----
test("features default OFF for the internal tool", () => {
  const f = resolveFeatures({});
  assert.equal(f.org, false);
  assert.equal(f.planning, false);
  assert.equal(f.requests, false);
  assert.equal(f.benchmarks, false);
});

test("an env override re-enables a single area", () => {
  const f = resolveFeatures({ FEATURE_ORG: "true", FEATURE_PLANNING: "1" });
  assert.equal(f.org, true);
  assert.equal(f.planning, true);
  assert.equal(f.requests, false);
});

// ---- integration: the internal-tool build (all hidden areas OFF) ----
let srv, c;
before(async () => {
  srv = await startTestServer({
    FEATURE_ORG: "false",
    FEATURE_PLANNING: "false",
    FEATURE_REQUESTS: "false",
    FEATURE_BENCHMARKS: "false",
  });
  c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
});
after(async () => { await srv.close(); });

test("hidden areas 404 (route-level guard, not just a hidden link)", async () => {
  for (const path of ["/org", "/planning", "/requests", "/requests/new"]) {
    const res = await c.get(path);
    assert.equal(res.status, 404, `${path} should 404 when its feature is off`);
  }
});

test("nav omits hidden areas but keeps the consolidated + kept areas", async () => {
  const home = await (await c.get("/")).text();
  assert.ok(!/href="\/org"/.test(home), "org link hidden");
  assert.ok(!/href="\/planning"/.test(home), "planning link hidden");
  assert.ok(!/href="\/requests"/.test(home), "requests link hidden");
  // kept
  assert.match(home, /href="\/budgets"/);
  assert.match(home, /href="\/philosophy"/);
  assert.match(home, /href="\/audit"/);
});

test("the consolidated dashboard renders the sub-tab bar (one surface)", async () => {
  const home = await (await c.get("/")).text();
  assert.match(home, /class="subtabs"/);
  assert.match(home, /class="subtab[^"]*"[^>]*>Overview/);
  assert.match(home, /href="\/roster"[^>]*class="subtab[^"]*"[^>]*>People/);
});

test("benchmark endpoints 404 and the phase/industry surface is gone from Philosophy", async () => {
  const suggest = await c.post("/philosophy/targets/suggest", {});
  assert.equal(suggest.status, 404, "benchmark suggest must 404 when hidden");
  const applyPhase = await c.post("/philosophy/apply-phase", {});
  assert.equal(applyPhase.status, 404, "apply-phase must 404 when hidden");
  const phil = await (await c.get("/philosophy")).text();
  assert.ok(!/Suggest a starting balance/.test(phil), "benchmark suggest button hidden");
  assert.ok(!/Company phase &amp; industry/.test(phil), "phase/industry card hidden");
  // core budget-enforcement rule stays (the concentrated Philosophy)
  assert.match(phil, /budget_enforcement/);
});
