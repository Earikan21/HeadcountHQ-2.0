import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("applies defaults and emailEnabled=false without SMTP_HOST", () => {
  const cfg = loadConfig({ SESSION_SECRET: "0123456789abcdef0" });
  assert.equal(cfg.PORT, 3000);
  assert.equal(cfg.NODE_ENV, "development");
  assert.equal(cfg.emailEnabled, false);
});

test("emailEnabled=true when SMTP_HOST is set", () => {
  const cfg = loadConfig({ SESSION_SECRET: "0123456789abcdef0", SMTP_HOST: "smtp.example.com" });
  assert.equal(cfg.emailEnabled, true);
});

test("rejects a too-short SESSION_SECRET", () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: "short" }), /SESSION_SECRET/);
});

test("refuses the dev-default secret in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "dev-only-insecure-change-me-please-0000" }),
    /placeholder/
  );
});

test("COOKIE_SECURE string coerces to boolean", () => {
  assert.equal(loadConfig({ SESSION_SECRET: "0123456789abcdef0", COOKIE_SECURE: "true" }).COOKIE_SECURE, true);
  assert.equal(loadConfig({ SESSION_SECRET: "0123456789abcdef0", COOKIE_SECURE: "false" }).COOKIE_SECURE, false);
});

test("rejects a non-numeric PORT", () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: "0123456789abcdef0", PORT: "abc" }), /PORT/);
});
