import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, passwordProblem } from "../src/auth/passwords.js";

test("hash + verify round-trip", () => {
  const { hash, salt } = hashPassword("correct horse battery");
  assert.ok(hash && salt);
  assert.equal(verifyPassword("correct horse battery", hash, salt), true);
  assert.equal(verifyPassword("wrong", hash, salt), false);
});

test("unique salt per call", () => {
  assert.notEqual(hashPassword("x").salt, hashPassword("x").salt);
});

test("password strength gate", () => {
  assert.match(passwordProblem("short"), /10 characters/);
  assert.equal(passwordProblem("longenough10"), null);
});
