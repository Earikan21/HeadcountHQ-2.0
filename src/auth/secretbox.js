/**
 * Symmetric encryption for secrets we must store reversibly (the Microsoft refresh
 * token). AES-256-GCM with a key derived from SESSION_SECRET via scrypt, so a leaked
 * database is useless without the app secret. Format: base64(iv).base64(tag).base64(ct).
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

let cachedKey = null, cachedFrom = null;
function keyFor(secret) {
  const s = String(secret || "");
  if (cachedKey && cachedFrom === s) return cachedKey;
  cachedKey = scryptSync(s, "hq-secretbox-v1", 32);
  cachedFrom = s;
  return cachedKey;
}

export function encryptSecret(plain, secret) {
  const key = keyFor(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(packed, secret) {
  const parts = String(packed || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted secret.");
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
