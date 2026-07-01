import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestMapping, classifyDepartments, normalizeTitles, clientFromConfig } from "../src/domain/ai_import.js";

const headers = ["Employee ID", "Name", "Department", "Job Title", "Salary"];
const rows = [{ "Employee ID": "E-1", Name: "Dana", Department: "Engineering", "Job Title": "sr eng", Salary: "120000" }];

/** A fake client whose complete() returns a fixed reply (or throws). */
const fake = (reply, opts = {}) => ({
  configured: opts.configured !== false,
  complete: async () => { if (opts.throw) throw new Error("boom"); return reply; },
});

test("suggestMapping uses AI when the client returns valid JSON", async () => {
  const client = fake('{"employee_id":"Employee ID","name":"Name","department":"Department","job_title":"Job Title","compensation_amount":"Salary"}');
  const res = await suggestMapping({ headers, rows, client });
  assert.equal(res.source, "ai");
  assert.equal(res.mapping.compensation_amount, "Salary");
  assert.equal(res.confidence.compensation_amount, "ai");
});

test("suggestMapping falls back to the heuristic on AI failure or no client", async () => {
  const thrown = await suggestMapping({ headers, rows, client: fake("", { throw: true }) });
  assert.equal(thrown.source, "heuristic");
  assert.equal(thrown.mapping.employee_id, "Employee ID");

  const none = await suggestMapping({ headers, rows, client: null });
  assert.equal(none.source, "heuristic");

  const unconfigured = await suggestMapping({ headers, rows, client: fake("{}", { configured: false }) });
  assert.equal(unconfigured.source, "heuristic");
});

test("suggestMapping coerces away hallucinated headers/keys", async () => {
  const client = fake('{"employee_id":"Employee ID","name":"Ghost Column","bogus":"x"}');
  const res = await suggestMapping({ headers, rows, client });
  assert.equal(res.source, "ai");
  assert.equal(res.mapping.employee_id, "Employee ID");
  assert.equal(res.mapping.name, null); // "Ghost Column" isn't a real header
  assert.ok(!("bogus" in res.mapping));
});

test("classifyDepartments uses AI then fills gaps with the keyword heuristic", async () => {
  const client = fake('{"Engineering":"rnd"}'); // model only answered one
  const res = await classifyDepartments({ names: ["Engineering", "Sales"], client });
  assert.equal(res.source, "ai");
  assert.equal(res.map.Engineering, "rnd");
  assert.equal(res.map.Sales, "sm"); // filled by keyword fallback
});

test("classifyDepartments falls back entirely on failure", async () => {
  const res = await classifyDepartments({ names: ["Engineering"], client: fake("", { throw: true }) });
  assert.equal(res.source, "heuristic");
  assert.equal(res.map.Engineering, "rnd");

  const empty = await classifyDepartments({ names: [], client: fake("{}") });
  assert.deepEqual(empty.map, {});
});

test("normalizeTitles uses AI, else local cleanup", async () => {
  const ai = await normalizeTitles({ titles: ["sr eng"], client: fake('{"sr eng":"Senior Engineer"}') });
  assert.equal(ai.source, "ai");
  assert.equal(ai.map["sr eng"], "Senior Engineer");

  const local = await normalizeTitles({ titles: ["sr eng"], client: null });
  assert.equal(local.source, "local");
  assert.equal(local.map["sr eng"], "Senior Engineer");

  const onFail = await normalizeTitles({ titles: ["sr eng"], client: fake("", { throw: true }) });
  assert.equal(onFail.source, "local");
  assert.equal(onFail.map["sr eng"], "Senior Engineer");
});

test("clientFromConfig returns null unless a key is configured", () => {
  assert.equal(clientFromConfig({ aiImportConfigured: false }), null);
  assert.equal(clientFromConfig(null), null);
  const c = clientFromConfig({ aiImportConfigured: true, AI_IMPORT_PROVIDER: "anthropic", AI_IMPORT_API_KEY: "k", AI_IMPORT_MODEL: "m" });
  assert.ok(c && c.configured);
});
