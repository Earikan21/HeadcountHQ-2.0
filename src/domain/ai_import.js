/**
 * AI-import orchestration — the async layer routes call. It ties the pure
 * helpers (import_ai.js) to the redaction layer + network client
 * (llm_client.js), and ALWAYS degrades gracefully for the privacy-safe path:
 * any AI failure (no key, timeout, bad JSON) falls back to the deterministic
 * result, so a normal import never blocks on the model.
 *
 * The FULL-READ path (fullReadInterpret) is different: it is opt-in, sends raw
 * file contents, and has no deterministic fallback — if it fails, the caller
 * surfaces the error and the user stays on the normal mapping flow.
 */
import { SCHEMA } from "./roster.js";
import { FUNCTION_CATEGORIES } from "../data/benchmarks.js";
import {
  SCHEMA_KEYS,
  columnProfiles, coerceMapping, heuristicMapping,
  keywordDeptCategories, coerceCategoryMap,
  normalizeTitlesLocal, coerceTitleMap,
} from "./import_ai.js";
import {
  LlmClient, buildMappingPrompt, buildClassifyPrompt, buildTitlePrompt, parseJsonObject,
} from "./llm_client.js";

/** Log an AI failure to the server console (diagnostic only; no payload). */
function logAiFailure(stage, client, err) {
  const where = client ? `${client.provider} ${client.model}` : "no-client";
  console.error(`[ai-import] ${stage} fell back (${where}): ${err && err.message ? err.message : err}`);
}

/** Build an LlmClient from runtime config, or null when not configured. */
export function clientFromConfig(config, fetchImpl) {
  if (!config || !config.aiImportConfigured) return null;
  return new LlmClient({
    provider: config.AI_IMPORT_PROVIDER,
    apiKey: config.AI_IMPORT_API_KEY,
    model: config.AI_IMPORT_MODEL,
    baseUrl: config.AI_IMPORT_BASE_URL,
    fetchImpl,
  });
}

/**
 * Suggest a column mapping. With a configured client, asks the model using ONLY
 * headers + safe profiles; otherwise (or on any failure) returns the heuristic.
 * @returns {Promise<{mapping:object, confidence:object, source:string}>}
 */
export async function suggestMapping({ headers, rows, client }) {
  const fallback = () => heuristicMapping(headers);
  if (!client || !client.configured) return fallback();
  try {
    const profiles = columnProfiles(headers, rows);
    const prompt = buildMappingPrompt({ headers, profiles, schema: SCHEMA });
    const text = await client.complete(prompt);
    const mapping = coerceMapping(parseJsonObject(text), headers);
    const confidence = {};
    for (const f of SCHEMA) confidence[f.key] = mapping[f.key] ? "ai" : "none";
    return { mapping, confidence, source: "ai" };
  } catch (e) {
    logAiFailure("mapping", client, e);
    return fallback();
  }
}

/**
 * Classify departments into function categories.
 * @returns {Promise<{map:object, source:string}>}
 */
export async function classifyDepartments({ names, client }) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return { map: {}, source: "local" };
  if (!client || !client.configured) return { map: keywordDeptCategories(list), source: "heuristic" };
  try {
    const prompt = buildClassifyPrompt({ departmentNames: list, categories: FUNCTION_CATEGORIES });
    const text = await client.complete(prompt);
    const map = coerceCategoryMap(parseJsonObject(text), list);
    const filled = { ...keywordDeptCategories(list), ...map };
    return { map: filled, source: "ai" };
  } catch (e) {
    logAiFailure("classify", client, e);
    return { map: keywordDeptCategories(list), source: "heuristic" };
  }
}

/**
 * Normalize messy job titles.
 * @returns {Promise<{map:object, source:string}>}
 */
export async function normalizeTitles({ titles, client }) {
  const list = (titles || []).filter(Boolean);
  if (!list.length) return { map: {}, source: "local" };
  if (!client || !client.configured) return { map: normalizeTitlesLocal(list), source: "local" };
  try {
    const prompt = buildTitlePrompt({ jobTitles: list });
    const text = await client.complete(prompt);
    const map = coerceTitleMap(parseJsonObject(text), list);
    return { map, source: "ai" };
  } catch (e) {
    logAiFailure("titles", client, e);
    return { map: normalizeTitlesLocal(list), source: "local" };
  }
}

// ===========================================================================
// FULL-READ (opt-in) — sends raw file contents so the AI can interpret messy /
// non-tabular layouts. No deterministic fallback: failures propagate.
// ===========================================================================

const MAX_FULLREAD_ROWS = 200;
const CELL_CAP = 120;

/** Render the raw matrix as compact, indexed TSV for the model. */
function gridToTsv(matrix, maxRows) {
  return matrix.slice(0, maxRows)
    .map((r, i) => i + "\t" + r.map((c) => String(c == null ? "" : c).replace(/\t/g, " ").slice(0, CELL_CAP)).join("\t"))
    .join("\n");
}

/** Build the full-content prompt. NOTE: this intentionally contains cell values. */
export function buildFullReadPrompt(matrix, maxRows = MAX_FULLREAD_ROWS) {
  const truncated = matrix.length > maxRows;
  const system =
    "You extract a clean employee roster from a messy spreadsheet grid. The grid may " +
    "contain title rows, notes, blank rows, sub-headers, merged sections, or unusual " +
    "layouts. Identify every real person and output normalized records. Respond with a " +
    "SINGLE JSON object and nothing else (no markdown, no prose).";
  const user =
`Each line is one file row: a row index, then TAB-separated cells.

GRID:
${gridToTsv(matrix, maxRows)}

Extract every employee. For each person return these fields (use null when unknown):
- employee_id, name, first_name, last_name, department, job_title,
  compensation_amount (a number only), compensation_unit (annual/hourly/monthly/weekly),
  employment_status (active/inactive/leave), manager, employee_type

Return JSON exactly like: {"rows":[{"employee_id":"E-1","name":"Dana Lee","department":"Engineering","job_title":"Senior Engineer","compensation_amount":185000,"compensation_unit":"annual","employment_status":"active","manager":null,"employee_type":"Full-Time","first_name":null,"last_name":null}]}

Prefer "name" if the file has a single full name; otherwise first_name/last_name. Do NOT invent people; include only rows that are clearly a person.`;
  return { system, user, truncated };
}

/** Extract the rows array from a model reply (tolerates object-with-rows or bare array). */
export function extractRows(text) {
  if (typeof text !== "string") throw new TypeError("expected string");
  const objStart = text.indexOf("{"), objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const obj = JSON.parse(text.slice(objStart, objEnd + 1));
      if (obj && Array.isArray(obj.rows)) return obj.rows;
    } catch { /* fall through to array attempt */ }
  }
  const arrStart = text.indexOf("["), arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const arr = JSON.parse(text.slice(arrStart, arrEnd + 1));
    if (Array.isArray(arr)) return arr;
  }
  throw new Error("no rows array in AI response");
}

/**
 * Turn AI-extracted rows into a clean matrix + identity mapping the normal
 * import pipeline can consume. Fills missing employee_id, drops rows without a
 * name. Pure.
 * @returns {{matrix:string[][], mapping:object, count:number}}
 */
export function aiRowsToMatrix(rows) {
  const cols = SCHEMA_KEYS;
  const out = [];
  let seq = 0;
  for (const r of rows || []) {
    if (!r || typeof r !== "object") continue;
    const rec = {};
    let any = false;
    for (const c of cols) {
      const v = r[c] == null ? "" : String(r[c]);
      rec[c] = v;
      if (v.trim()) any = true;
    }
    const hasName = rec.name.trim() || rec.first_name.trim() || rec.last_name.trim();
    if (!any || !hasName) continue;
    if (!rec.employee_id.trim()) rec.employee_id = "E-" + String(++seq).padStart(4, "0");
    out.push(rec);
  }
  const matrix = [cols.slice(), ...out.map((rec) => cols.map((c) => rec[c]))];
  const mapping = {};
  for (const c of cols) mapping[c] = c;
  return { matrix, mapping, count: out.length };
}

/**
 * Full-read interpret: send the raw grid, get normalized rows back.
 * @returns {Promise<{matrix:string[][], mapping:object, count:number, truncated:boolean, source:string}>}
 */
export async function fullReadInterpret({ matrix, client, maxRows = MAX_FULLREAD_ROWS }) {
  if (!client || !client.configured) throw new Error("AI is not configured for full-read.");
  const { system, user, truncated } = buildFullReadPrompt(matrix, maxRows);
  const text = await client.completeFullContent(system, user, 4096);
  const rows = extractRows(text);
  const built = aiRowsToMatrix(rows);
  if (!built.count) throw new Error("The AI did not find any people in that file.");
  return { ...built, truncated, source: "ai" };
}
