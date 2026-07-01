import { test } from "node:test";
import assert from "node:assert/strict";
import { draftJustification, estimateRole, answerQuestion } from "../src/domain/assistant.js";

const fake = (reply, opts = {}) => ({
  configured: opts.configured !== false,
  chat: async () => { if (opts.throw) throw new Error("boom"); return reply; },
});

test("draftJustification returns coerced narrative fields", async () => {
  const client = fake(JSON.stringify({
    justification: "Engineering is under target and the roadmap is slipping.",
    current_hc_narrative: "The team ships one major feature per quarter.",
    new_hc_narrative: "A second squad would double delivery throughput.",
    expected_value_basis: "benchmark",
  }));
  const out = await draftJustification({ role: "Senior Engineer", department: "Engineering", type: "net_new", client });
  assert.match(out.justification, /under target/);
  assert.equal(out.expected_value_basis, "benchmark");
  assert.ok(out.new_hc_narrative.length > 0);
});

test("draftJustification coerces an unknown basis to qualitative", async () => {
  const client = fake(JSON.stringify({ justification: "x", current_hc_narrative: "y", new_hc_narrative: "z", expected_value_basis: "made_up" }));
  const out = await draftJustification({ role: "R", department: "D", client });
  assert.equal(out.expected_value_basis, "qualitative");
});

test("draftJustification throws with no client", async () => {
  await assert.rejects(draftJustification({ role: "R", department: "D", client: null }), /not configured/i);
});

test("estimateRole returns a sane band, rejects malformed", async () => {
  const good = await estimateRole({ title: "Senior Engineer", department: "Engineering", phase: "growth", industry: "b2b_saas",
    client: fake('{"band_min":150000,"band_max":190000,"rationale":"Growth-stage SaaS eng."}') });
  assert.equal(good.band_min, 150000);
  assert.equal(good.band_max, 190000);
  assert.match(good.rationale, /SaaS/);

  await assert.rejects(estimateRole({ title: "X", department: "D", phase: "early", industry: "general",
    client: fake('{"band_min":200000,"band_max":100000}') }), /malformed/); // max < min
  await assert.rejects(estimateRole({ title: "X", department: "D", phase: "early", industry: "general",
    client: fake("not json") }), /no JSON|malformed/);
});

test("answerQuestion passes context+question through and returns text", async () => {
  let seen;
  const client = { configured: true, chat: async (sys, user) => { seen = user; return "You have 5 filled seats.\nRecommendations:\n- Hire in Sales."; } };
  const ans = await answerQuestion({ question: "How many people do we have?", context: "Headcount: 5 filled.", client });
  assert.match(ans, /Recommendations/);
  assert.match(seen, /DATA:/);
  assert.match(seen, /QUESTION: How many/);
});
