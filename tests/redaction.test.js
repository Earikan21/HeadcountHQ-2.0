import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RedactedPrompt, LlmClient,
  buildMappingPrompt, buildClassifyPrompt, buildTitlePrompt, parseJsonObject,
} from "../src/domain/llm_client.js";
import { columnProfiles } from "../src/domain/import_ai.js";
import { SCHEMA } from "../src/domain/roster.js";
import { FUNCTION_CATEGORIES } from "../src/data/benchmarks.js";

test("RedactedPrompt cannot be constructed directly", () => {
  assert.throws(() => new RedactedPrompt("nope", "mapping", "s", "u"), /cannot be constructed directly/);
});

test("builders reject inputs that aren't privacy-safe", () => {
  // a profile carrying a forbidden key (e.g. a sample value) is rejected
  assert.throws(
    () => buildMappingPrompt({ headers: ["A"], profiles: [{ header: "A", kind: "number", fillRate: 1, distinctRatio: 1, sample: "$120k" }], schema: SCHEMA }),
    /forbidden key/
  );
  // non-string headers rejected
  assert.throws(() => buildMappingPrompt({ headers: [{}], profiles: [], schema: SCHEMA }), /must contain only strings/);
  // classify rejects non-string department names
  assert.throws(() => buildClassifyPrompt({ departmentNames: [1, 2], categories: FUNCTION_CATEGORIES }), /must contain only strings/);
  // titles must be strings
  assert.throws(() => buildTitlePrompt({ jobTitles: [null] }), /must contain only strings/);
});

test("LEAK TEST: a full roster never leaks comp or employee names into the prompt", () => {
  const headers = ["EmpID", "Full Name", "Dept", "Base Salary", "Title", "Start"];
  const rows = [
    { EmpID: "E-1", "Full Name": "Dana Lee", Dept: "Engineering", "Base Salary": "$185,000", Title: "Sr Eng", Start: "2023-01-02" },
    { EmpID: "E-2", "Full Name": "Liam Cho", Dept: "Sales", "Base Salary": "242000", Title: "AE", Start: "2024-06-01" },
    { EmpID: "E-3", "Full Name": "Mara Ito", Dept: "Engineering", "Base Salary": "133750", Title: "Engineer", Start: "2022-03-03" },
  ];
  const profiles = columnProfiles(headers, rows);
  const prompt = buildMappingPrompt({ headers, profiles, schema: SCHEMA });
  const blob = prompt.system + "\n" + prompt.user;

  // headers ARE allowed to appear; row VALUES must not.
  for (const secret of ["Dana Lee", "Liam Cho", "Mara Ito", "185,000", "185000", "242000", "133750", "E-1", "E-2", "E-3"]) {
    assert.ok(!blob.includes(secret), `prompt leaked "${secret}"`);
  }
  // sanity: the safe header strings did make it in
  assert.ok(blob.includes("Base Salary"));
  assert.ok(blob.includes("Full Name"));
});

test("classify/title prompts carry only the names/titles they were given", () => {
  const cp = buildClassifyPrompt({ departmentNames: ["Engineering", "Sales"], categories: FUNCTION_CATEGORIES });
  assert.ok((cp.system + cp.user).includes("Engineering"));
  assert.ok(!(cp.system + cp.user).includes("Dana Lee"));
  const tp = buildTitlePrompt({ jobTitles: ["sr eng"] });
  assert.ok((tp.system + tp.user).includes("sr eng"));
});

test("parseJsonObject extracts the first balanced object, rejects non-objects", () => {
  assert.deepEqual(parseJsonObject('here you go: {"a":1,"b":"x"} done'), { a: 1, b: "x" });
  assert.throws(() => parseJsonObject("no json here"), /no JSON object/);
  assert.throws(() => parseJsonObject("[1,2,3]"), /no JSON object|not a JSON object/);
});

test("LlmClient.complete refuses anything that isn't a RedactedPrompt", async () => {
  const client = new LlmClient({ provider: "anthropic", apiKey: "k", model: "m", fetchImpl: async () => { throw new Error("should not be called"); } });
  await assert.rejects(client.complete("raw string built from row data"), /requires a RedactedPrompt/);
  await assert.rejects(client.complete({ system: "x", user: "y" }), /requires a RedactedPrompt/);
});

test("LlmClient parses Anthropic + OpenAI shapes via injected fetch", async () => {
  const prompt = buildTitlePrompt({ jobTitles: ["sr eng"] });

  const anthropic = new LlmClient({
    provider: "anthropic", apiKey: "k", model: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: '{"sr eng":"Senior Engineer"}' }] }) }),
  });
  assert.equal(await anthropic.complete(prompt), '{"sr eng":"Senior Engineer"}');

  const openai = new LlmClient({
    provider: "openai", apiKey: "k", model: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }),
  });
  assert.equal(await openai.complete(prompt), "{}");
});

test("Gemini provider uses the Google endpoint with Bearer auth + OpenAI shape", async () => {
  const prompt = buildTitlePrompt({ jobTitles: ["sr eng"] });
  let seenUrl, seenAuth;
  const gemini = new LlmClient({
    provider: "gemini", apiKey: "gkey", model: "gemini-2.5-flash",
    fetchImpl: async (url, opts) => {
      seenUrl = url; seenAuth = opts.headers.authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sr eng":"Senior Engineer"}' } }] }) };
    },
  });
  assert.equal(gemini.endpoint(), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(await gemini.complete(prompt), '{"sr eng":"Senior Engineer"}');
  assert.match(seenUrl, /generativelanguage\.googleapis\.com/);
  assert.equal(seenAuth, "Bearer gkey");
});

test("base-URL override points an OpenAI-format provider at another host (e.g. Groq)", async () => {
  const prompt = buildTitlePrompt({ jobTitles: ["x"] });
  let seenUrl;
  const groq = new LlmClient({
    provider: "openai", apiKey: "k", model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1/",  // trailing slash tolerated
    fetchImpl: async (url) => { seenUrl = url; return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
  });
  assert.equal(groq.endpoint(), "https://api.groq.com/openai/v1/chat/completions");
  await groq.complete(prompt);
  assert.equal(seenUrl, "https://api.groq.com/openai/v1/chat/completions");
});

test("LlmClient throws on non-ok responses and when unconfigured", async () => {
  const prompt = buildTitlePrompt({ jobTitles: ["x"] });
  const bad = new LlmClient({ provider: "anthropic", apiKey: "k", model: "m", fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(bad.complete(prompt), /failed \(429\)/);

  const unconfigured = new LlmClient({ provider: "anthropic", apiKey: "", model: "m" });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(unconfigured.complete(prompt), /not configured/);
});
