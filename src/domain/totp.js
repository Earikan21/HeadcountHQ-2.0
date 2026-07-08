/**
 * Time-based one-time passwords (RFC 6238), the mechanism behind Google
 * Authenticator, 1Password, Authy and the rest. Zero dependencies — it's an
 * HMAC-SHA1 over a 30-second counter, and Node's `crypto` already does HMAC.
 *
 *   secret  a shared random key, shown to the user as base32 and embedded in the
 *           otpauth:// URI their app scans.
 *   code    HMAC-SHA1(secret, floor(now/30)) -> dynamic-truncated -> 6 digits.
 *
 * Verification allows ±1 time step so a slightly fast/slow phone clock still works.
 * SHA-1 is not a weakness here: TOTP's security rests on the secret and the short
 * validity window, and SHA-1 is what every authenticator app implements.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Encode bytes as base32 (no padding) — how the secret is shown and stored. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 to bytes. Case-insensitive; spaces and '=' padding are ignored. */
export function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/[\s=]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret (default 20 bytes = 160 bits, the RFC-recommended SHA-1 size). */
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

/** HOTP: the code for an explicit counter. */
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (two 32-bit halves avoids >>> 32-bit limits).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP: the code for a moment in time (default: now). */
export function totp(secret, { time = Date.now(), step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotp(secret, Math.floor(time / 1000 / step), digits);
}

/**
 * Constant-time check of a user-entered token against the secret, allowing a drift
 * of `window` steps either side of now. Returns true/false; never throws on a
 * malformed token (that's just a mismatch).
 */
export function verifyTotp(secret, token, { time = Date.now(), step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS, window = 1 } = {}) {
  const t = String(token || "").replace(/\s/g, "");
  if (!secret || !new RegExp(`^\\d{${digits}}$`).test(t)) return false;
  const counter = Math.floor(time / 1000 / step);
  for (let i = -window; i <= window; i++) {
    let candidate;
    try { candidate = hotp(secret, counter + i, digits); } catch { return false; }
    const a = Buffer.from(candidate), b = Buffer.from(t);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * The otpauth:// URI an authenticator app reads (also what the QR encodes). `issuer`
 * shows as the account's app name; `label` is usually the user's email.
 */
export function otpauthURL({ secret, label, issuer = "Headcount HQ" }) {
  const enc = encodeURIComponent;
  const acct = `${enc(issuer)}:${enc(label)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${acct}?${params.toString()}`;
}

// ---- recovery codes --------------------------------------------------------

/**
 * One-time backup codes for a lost phone. We return the plaintext to show ONCE, and
 * SHA-256 hashes to store — a leaked DB never reveals a usable code. Format is
 * `xxxx-xxxx` in Crockford-ish base32 (no vowels/ambiguous chars) for easy typing.
 */
import { createHash } from "node:crypto";
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U
export const hashRecoveryCode = (code) =>
  createHash("sha256").update(String(code).toUpperCase().replace(/[\s-]/g, "")).digest("hex");

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(8);
    let s = "";
    for (let j = 0; j < 8; j++) s += RECOVERY_ALPHABET[raw[j] & 31];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
