import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { LlmClient } from "../src/domain/llm_client.js";
import { loadConfig } from "../src/config.js";

test("Groq is a first-class OpenAI-compatible provider", () => {
  const c = new LlmClient({ provider: "groq", apiKey: "k", model: "llama-3.3-70b-versatile" });
  assert.equal(c.endpoint(), "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(c.configured, true);
});

test("config accepts groq and picks a sensible default model", () => {
  const cfg = loadConfig({ SESSION_SECRET: "0123456789abcdef0", AI_IMPORT_PROVIDER: "groq", AI_IMPORT_API_KEY: "k" });
  assert.equal(cfg.AI_IMPORT_PROVIDER, "groq");
  assert.ok(cfg.AI_IMPORT_MODEL.length > 0);
  assert.equal(cfg.aiImportConfigured, true);
});

// The assistant is always-on once a provider key is configured — no separate toggle.
let srv, admin, client;
before(async () => {
  srv = await startTestServer({ AI_IMPORT_API_KEY: "k", AI_IMPORT_PROVIDER: "groq" });
  admin = makeClient(srv.base);
  await admin.get("/setup");
  await admin.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  // deliberately do NOT toggle any assistant setting
  await admin.get("/accounts");
  const created = await admin.post("/accounts", { name: "Client", email: "ceo@client.co", role: "client", method: "password" });
  const pw = (await created.text()).match(/<code>([^<]+)<\/code>/)[1];
  client = makeClient(srv.base);
  await client.get("/login");
  await client.post("/login", { email: "ceo@client.co", password: pw });
});
after(async () => { await srv.close(); });

test("assistant is on automatically for admins when a key is configured (no toggle)", async () => {
  const page = await (await admin.get("/assistant")).text();
  assert.equal((await admin.get("/assistant")).status, 200);
  assert.ok(!/assistant is currently off/i.test(page), "assistant should be on when a key is configured");
});

test("clients also get the assistant (ask-your-data)", async () => {
  const res = await client.get("/assistant");
  assert.equal(res.status, 200);
  assert.ok(!/assistant is currently off/i.test(await res.text()), "client assistant should be on");
});
