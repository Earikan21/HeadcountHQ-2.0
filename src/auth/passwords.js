/**
 * Password hashing with scrypt (node:crypto) — a memory-hard KDF suitable for
 * password storage. Each password gets a unique random salt. Verification is
 * constant-time to avoid timing leaks.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

/** @param {string} password @returns {{hash:string, salt:string}} */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN).toString("hex");
  return { hash, salt };
}

/** Constant-time verify. @returns {boolean} */
export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const derived = scryptSync(password, salt, KEYLEN);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(derived, stored);
}

/** Basic strength gate for new passwords. @returns {string|null} error message */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 10) {
    return "Password must be at least 10 characters.";
  }
  return null;
}
