/**
 * Redaction layer + LLM client — the ONLY code that may construct a prompt for
 * an external model, and the only code that performs the network call.
 *
 * The privacy promise of the AI-IMPORT feature lives here:
 *  1. `RedactedPrompt` is a typed token built only by the prompt builders below.
 *     Each builder accepts ONLY privacy-safe inputs (headers, type/stat profiles,
 *     distinct department names, job titles). Salary values, employee names, and
 *     raw rows are never accepted. `complete()` refuses anything else.
 *  2. `completeFullContent()` is the deliberately separate escape hatch used ONLY
 *     by the opt-in AI full-read import (which sends raw file contents).
 *
 * `chat()` is the generic text path used by the headcount ASSISTANT (request
 * justifications, cost/band estimates, ask-your-data). Callers assemble their own
 * (non-import) context; it is not bound by the import redaction rules.
 *
 * Providers: `anthropic` (Messages API), and the OpenAI-compatible family
 * `openai` and `gemini`. A base-URL override lets any other OpenAI-compatible
 * host (Groq, OpenRouter, …) be used with provider=openai.
 */

const KIND = Object.freeze({ MAPPING: "mapping", CLASSIFY: "classify", TITLES: "titles" });

/** A prompt that has passed the redaction builders. Constructible only here. */
export class RedactedPrompt {
  constructor(token, kind, system, user) {
    if (token !== BUILD_TOKEN) {
      throw new Error("RedactedPrompt cannot be constructed directly — use a prompt builder.");
    }
    this.kind = kind;
    this.system = system;
    this.user = user;
    Object.freeze(this);
  }
}
const BUILD_TOKEN = Symbol("redacted-prompt");

// ---- input guards -------------------------------------------------------

function assertStringArray(arr, label) {
  if (!Array.isArray(arr)) throw new TypeError(`${label} must be an array of strings`);
  for (const v of arr) {
    if (typeof v !== "string") throw new TypeError(`${label} must contain only strings`);
  }
}

const PROFILE_KEYS = new Set(["header", "kind", "fillRate", "distinctRatio"]);
const PROFILE_KINDS = new Set(["number", "date", "text", "empty"]);

/** Profiles may only carry the four whitelisted, non-sensitive descriptor keys. */
function assertProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new TypeError("profiles must be an array");
  for (const p of profiles) {
    if (!p || typeof p !== "object") throw new TypeError("each profile must be an object");
    for (const k of Object.keys(p)) {
      if (!PROFILE_KEYS.has(k)) throw new TypeError(`profile has forbidden key "${k}"`);
    }
    if (typeof p.header !== "string") throw new TypeError("profile.header must be a string");
    if (!PROFILE_KINDS.has(p.kind)) throw new TypeError("profile.kind invalid");
    if (typeof p.fillRate !== "number" || typeof p.distinctRatio !== "number") {
      throw new TypeError("profile stats must be numbers");
    }
  }
}

// ---- prompt builders ----------------------------------------------------

/** Mapping suggestion: headers + safe profiles + the target schema keys. */
export function buildMappingPrompt({ headers, profiles, schema }) {
  assertStringArray(headers, "headers");
  assertProfiles(profiles);
  if (!Array.isArray(schema)) throw new TypeError("schema must be an array");
  for (const f of schema) {
    if (typeof f.key !== "string" || typeof f.label !== "string") {
      throw new TypeError("schema entries need string key + label");
    }
  }
  const fieldLines = schema
    .map((f) => `- ${f.key}: ${f.label}${f.required ? " (REQUIRED)" : ""}`)
    .join("\n");
  const colLines = profiles
    .map((p) => `- "${p.header}"  [${p.kind}, ${Math.round(p.fillRate * 100)}% filled, ${Math.round(p.distinctRatio * 100)}% distinct]`)
    .join("\n");
  const system =
    "You are a precise data-mapping assistant for a headcount tool. You match a " +
    "spreadsheet's columns to a fixed set of roster fields, using ONLY the column " +
    "headers and coarse type statistics provided — you never see cell values. " +
    "Respond with a SINGLE JSON object and nothing else (no markdown, no prose).";
  const user =
`Map each target field to the source column that best fits.

Target fields:
${fieldLines}

Source columns (choose from these EXACT header strings, copy them verbatim):
${colLines}

Rules:
- Return a JSON object whose keys are the target field keys above.
- Each value must be one of the EXACT source header strings, or null if no column fits.
- Use each source header at most once.
- Map every field you can; only use null when truly nothing matches.
- Names: if there is ONE combined name column, map it to "name" and leave first_name/last_name null. If names are split, map "first_name" and "last_name" and leave "name" null.
- "compensation_amount" is the pay number (salary/base/rate). "compensation_unit" is the period (annual/hourly/monthly), if a separate column exists.
- "employee_id" is any unique identifier column (ID, employee number, etc).
- A numeric, highly-distinct column is usually compensation or an ID; a low-distinct text column is usually department, status, or type.

Example shape: {"employee_id":"Emp #","name":"Full Name","department":"Team","job_title":"Role","compensation_amount":"Base Pay","compensation_unit":null,"manager":"Reports To","employee_type":"Type","employment_status":"Status","first_name":null,"last_name":null}`;
  return new RedactedPrompt(BUILD_TOKEN, KIND.MAPPING, system, user);
}

/** Department classification: distinct department names + the category set. */
export function buildClassifyPrompt({ departmentNames, categories }) {
  assertStringArray(departmentNames, "departmentNames");
  if (!Array.isArray(categories)) throw new TypeError("categories must be an array");
  const catLines = categories.map(([k, label]) => `- ${k}: ${label}`).join("\n");
  const system =
    "You classify each department name into exactly one function category. You are " +
    "given ONLY a list of department names. Respond with a SINGLE JSON object and " +
    "nothing else (no markdown, no prose).";
  const user =
`Assign every department below to ONE category key.

Categories:
${catLines}

Guidance: engineering/product/design/data/IT -> rnd; sales/marketing/growth/revenue -> sm;
finance/HR/people/legal/ops/admin/recruiting -> ga; customer success/support/onboarding -> cs;
anything that fits none -> other.

Departments:
${departmentNames.map((d) => `- ${d}`).join("\n")}

Return JSON mapping each department name to one category key, e.g. {"Engineering":"rnd","Sales":"sm","People Ops":"ga"}.`;
  return new RedactedPrompt(BUILD_TOKEN, KIND.CLASSIFY, system, user);
}

/** Title normalization: distinct job-title strings. */
export function buildTitlePrompt({ jobTitles }) {
  assertStringArray(jobTitles, "jobTitles");
  const system =
    "You normalize messy job titles into clean, standard forms: expand obvious " +
    "abbreviations (Sr->Senior, Mgr->Manager, Eng->Engineer, VP stays VP), fix " +
    "capitalization, keep the meaning. You are given ONLY a list of title strings. " +
    "Respond with a SINGLE JSON object and nothing else (no markdown, no prose).";
  const user =
`Clean up these job titles.

Titles:
${jobTitles.map((t) => `- ${t}`).join("\n")}

Return a JSON object mapping each ORIGINAL title (verbatim) to its cleaned form.
Only include titles you actually changed. Example: {"sr swe":"Senior Software Engineer","mktg mgr":"Marketing Manager"}.`;
  return new RedactedPrompt(BUILD_TOKEN, KIND.TITLES, system, user);
}

// ---- tolerant JSON parse ------------------------------------------------

/** Extract the first balanced JSON object from a model reply. Throws if none. */
export function parseJsonObject(text) {
  if (typeof text !== "string") throw new TypeError("expected string");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object found");
  const obj = JSON.parse(text.slice(start, end + 1));
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not a JSON object");
  return obj;
}

// ---- network client -----------------------------------------------------

/** Default full endpoints per provider. */
const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};
/** Providers that speak the OpenAI Chat Completions request/response shape. */
const OPENAI_FORMAT = new Set(["openai", "gemini", "groq"]);

export class LlmClient {
  /**
   * @param {object} o
   * @param {"anthropic"|"openai"|"gemini"} o.provider
   * @param {string} o.apiKey
   * @param {string} o.model
   * @param {string} [o.baseUrl]   override base URL for OpenAI-compatible hosts (no /chat/completions)
   * @param {function} [o.fetchImpl]  injectable for tests (defaults to global fetch)
   * @param {number} [o.timeoutMs]
   */
  constructor({ provider, apiKey, model, baseUrl, fetchImpl, timeoutMs = 30000 }) {
    this.provider = provider;
    this.apiKey = apiKey || "";
    this.model = model;
    this.baseUrl = (baseUrl || "").trim();
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  /** The resolved endpoint URL for this provider (or null if unknown). */
  endpoint() {
    if (this.provider === "anthropic") return ENDPOINTS.anthropic;
    if (OPENAI_FORMAT.has(this.provider)) {
      if (this.baseUrl) return this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
      return ENDPOINTS[this.provider];
    }
    return null;
  }

  get configured() {
    return Boolean(this.apiKey) && Boolean(this.endpoint());
  }

  /** Send a RedactedPrompt (privacy-safe import path); resolve to the text reply. */
  async complete(prompt) {
    if (!(prompt instanceof RedactedPrompt)) {
      throw new TypeError("LlmClient.complete requires a RedactedPrompt (refusing raw input).");
    }
    return this._send(prompt.system, prompt.user, 1024);
  }

  /**
   * FULL-CONTENT import path — used ONLY by the opt-in AI full-read import. Sends
   * raw system/user text (which intentionally contains file contents).
   */
  async completeFullContent(system, user, maxTokens = 4096) {
    if (typeof system !== "string" || typeof user !== "string") {
      throw new TypeError("completeFullContent requires string system/user.");
    }
    return this._send(system, user, maxTokens);
  }

  /** Generic text path for the headcount ASSISTANT (justify / estimate / chat). */
  async chat(system, user, maxTokens = 1024) {
    if (typeof system !== "string" || typeof user !== "string") {
      throw new TypeError("chat requires string system/user.");
    }
    return this._send(system, user, maxTokens);
  }

  async _send(system, user, maxTokens) {
    if (!this.configured) throw new Error("LLM client is not configured.");
    const url = this.endpoint();
    const { headers, body } = this._request(system, user, maxTokens);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) {
      const status = res ? res.status : "no-response";
      let detail = "";
      try { if (res && res.text) detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 240); } catch { /* ignore */ }
      throw new Error(`LLM request failed (${status})${detail ? ": " + detail : ""}`);
    }
    const data = await res.json();
    return this._extractText(data);
  }

  _request(system, user, maxTokens) {
    if (this.provider === "anthropic") {
      return {
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: this.model,
          max_tokens: maxTokens,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        },
      };
    }
    // OpenAI-compatible (openai, gemini, or any base-URL override)
    return {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: {
        model: this.model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    };
  }

  _extractText(data) {
    if (this.provider === "anthropic") {
      const part = data && Array.isArray(data.content) ? data.content.find((c) => c.type === "text") : null;
      if (!part || typeof part.text !== "string") throw new Error("unexpected Anthropic response shape");
      return part.text;
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg || typeof msg.content !== "string") throw new Error("unexpected OpenAI-compatible response shape");
    return msg.content;
  }
}

export { KIND };
