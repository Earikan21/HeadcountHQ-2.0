/** The TOTP core, checked against RFC 6238 vectors, plus recovery codes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Encode, base32Decode, totp, verifyTotp, generateSecret, otpauthURL, hashRecoveryCode, generateRecoveryCodes } from "../src/domain/totp.js";

test("base32 round-trips arbitrary bytes", () => {
  for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "hello world!"]) {
    assert.equal(base32Decode(base32Encode(Buffer.from(s))).toString(), s);
  }
  assert.match(generateSecret(), /^[A-Z2-7]+$/);
});

test("RFC 6238 SHA-1 test vectors (8-digit)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [t, code] of vectors) assert.equal(totp(secret, { time: t * 1000, digits: 8 }), code, `T=${t}`);
});

test("6-digit codes are the low 6 of the 8-digit code", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totp(secret, { time: 59000 }), "287082");
});

test("verification accepts ±1 step of drift, rejects beyond", () => {
  const secret = generateSecret();
  const t = 1_700_000_000_000;
  assert.ok(verifyTotp(secret, totp(secret, { time: t }), { time: t }));
  assert.ok(verifyTotp(secret, totp(secret, { time: t - 30000 }), { time: t, window: 1 }));
  assert.ok(verifyTotp(secret, totp(secret, { time: t + 30000 }), { time: t, window: 1 }));
  assert.ok(!verifyTotp(secret, totp(secret, { time: t + 60000 }), { time: t, window: 1 }));
});

test("verification rejects junk and never throws", () => {
  const secret = generateSecret();
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, "12 34 56"]) {
    assert.doesNotThrow(() => verifyTotp(secret, bad));
  }
  assert.equal(verifyTotp(secret, "000000", { time: 0 }) && verifyTotp(secret, "111111", { time: 0 }), false);
  // spaces around a real code are tolerated
  const t = 1_700_000_000_000, code = totp(secret, { time: t });
  assert.ok(verifyTotp(secret, ` ${code} `, { time: t }));
});

test("otpauth URI carries the standard parameters Google Authenticator expects", () => {
  const uri = otpauthURL({ secret: "JBSWY3DPEHPK3PXP", label: "ada@acme.co" });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=Headcount(\+|%20)HQ/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
  assert.match(uri, /ada%40acme\.co/);
});

test("recovery codes are readable, hashed one-way, and salt-free deterministic", () => {
  const { codes, hashes } = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(hashes.length, 10);
  for (const c of codes) assert.match(c, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(hashRecoveryCode(codes[0]), hashes[0]);
  // formatting-insensitive: dashes/case/spaces don't matter
  assert.equal(hashRecoveryCode(codes[0].toLowerCase().replace("-", " ")), hashes[0]);
  assert.notEqual(hashes[0], codes[0], "stored value is a hash, not the code");
  assert.equal(new Set(hashes).size, 10, "codes are unique");
});
