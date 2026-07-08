/**
 * Centralised, validated runtime configuration. This is the only module that
 * reads process.env, so configuration rules live in exactly one place.
 *
 * A tiny .env loader is included (no dependency) so local runs are convenient;
 * on a host you set real environment variables instead.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolveFeatures } from "./features.js";

/** Minimal .env parser: KEY=VALUE lines, # comments, optional surrounding quotes. */
export function loadDotEnv(path = ".env", env = process.env) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in env)) env[key] = val;
  }
}

const DEV_SECRET_PREFIX = "dev-only-insecure";

/** Built-in default model per provider when AI_IMPORT_MODEL isn't set. */
const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
};

/**
 * Build the validated config object. Throws an Error with a readable message if
 * anything required is missing or invalid.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const errors = [];

  const NODE_ENV = oneOf(env.NODE_ENV, ["development", "test", "production"], "development");
  const PORT = toInt(env.PORT, 3000, "PORT", errors);
  const HOST = env.HOST || "0.0.0.0";
  const DATABASE_PATH = env.DATABASE_PATH || "./data/headcount.sqlite";
  const SESSION_SECRET = env.SESSION_SECRET || "";
  const COOKIE_SECURE = toBool(env.COOKIE_SECURE, false);
  // Two-factor auth is required for everyone by default. MFA_ENFORCED=false is an
  // escape hatch (emergency access recovery, and the test harness) — never set it in
  // normal production.
  const mfaEnforced = toBool(env.MFA_ENFORCED, true);

  const SMTP_HOST = (env.SMTP_HOST || "").trim();
  const SMTP_PORT = toInt(env.SMTP_PORT, 587, "SMTP_PORT", errors);
  const SMTP_USER = env.SMTP_USER || "";
  const SMTP_PASS = env.SMTP_PASS || "";
  const SMTP_FROM = env.SMTP_FROM || "Headcount HQ <no-reply@example.com>";

  // Optional AI-assisted import. The key is read here only; it is never stored in
  // the DB and never rendered back to any page. With no key, the feature is simply
  // unavailable and the import falls back to the deterministic mapper.
  //   - anthropic / openai  -> talk to their own APIs
  //   - gemini              -> Google's free-tier API via its OpenAI-compatible endpoint
  //   - AI_IMPORT_BASE_URL  -> override the base URL for any OTHER OpenAI-compatible
  //                            provider (e.g. Groq, OpenRouter). Used with provider=openai.
  const AI_IMPORT_PROVIDER = oneOf(env.AI_IMPORT_PROVIDER, ["anthropic", "openai", "gemini", "groq"], "anthropic");
  const AI_IMPORT_API_KEY = (env.AI_IMPORT_API_KEY || "").trim();
  const AI_IMPORT_BASE_URL = (env.AI_IMPORT_BASE_URL || "").trim();
  const AI_IMPORT_MODEL = (env.AI_IMPORT_MODEL || "").trim() ||
    DEFAULT_MODELS[AI_IMPORT_PROVIDER] || DEFAULT_MODELS.anthropic;

  if (SESSION_SECRET.length < 16) {
    errors.push("SESSION_SECRET must be set to at least 16 characters.");
  }
  if (NODE_ENV === "production" && SESSION_SECRET.startsWith(DEV_SECRET_PREFIX)) {
    errors.push("SESSION_SECRET is still the development placeholder — set a real secret in production.");
  }

  if (errors.length) {
    throw new Error("Invalid configuration:\n" + errors.map((e) => "  - " + e).join("\n"));
  }

  return {
    NODE_ENV,
    PORT,
    HOST,
    DATABASE_PATH,
    SESSION_SECRET,
    COOKIE_SECURE,
    mfaEnforced,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
    emailEnabled: SMTP_HOST.length > 0,
    AI_IMPORT_PROVIDER,
    AI_IMPORT_API_KEY,
    AI_IMPORT_BASE_URL,
    AI_IMPORT_MODEL,
    aiImportConfigured: AI_IMPORT_API_KEY.length > 0,
    // Feature flags (Directive 4.0). Hidden areas default OFF for the internal tool;
    // re-enable per area with FEATURE_<AREA>=true. See src/features.js.
    features: resolveFeatures(env),
  };
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
function toInt(value, fallback, name, errors) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer (got "${value}").`);
    return fallback;
  }
  return n;
}
function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}
