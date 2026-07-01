/**
 * AI-assisted import — PURE logic only. No network, no DB, no process.env.
 *
 * This module holds everything the AI feature needs that does NOT touch the
 * outside world: building a privacy-safe column *profile* (types/stats, never
 * raw values), deterministic anomaly flagging over compensation, coercing an
 * untrusted AI mapping back into a safe one, and the local (non-AI) fallbacks
 * for title normalization and department classification.
 *
 * Keeping this network-free is what lets it be exhaustively unit-tested and
 * guarantees the value-touching work (comp parsing, anomaly flags) stays on the
 * box. The network + redaction live in llm_client.js; the orchestration that
 * ties them together lives in ai_import.js.
 */
import { SCHEMA, autoMap, normHeader } from "./roster.js";
import { classifyDepartment } from "./philosophy.js";
import { FUNCTION_CATEGORY_KEYS } from "../data/benchmarks.js";

/** Canonical fields the AI may map columns onto (keys only). */
export const SCHEMA_KEYS = SCHEMA.map((f) => f.key);

// ---------------------------------------------------------------------------
// Column profile — type/stat descriptors that are safe to send to a model.
// Crucially this NEVER includes a raw cell value; only the inferred kind and
// coarse fill/distinctness ratios, which are enough to disambiguate (e.g. a
// numeric, mostly-unique column next to a header "Base" is the comp column).
// ---------------------------------------------------------------------------

const NUMERIC_RE = /^\s*\$?\s*-?[\d,]*\.?\d+\s*(k|m)?\s*(\/?\s*(yr|year|mo|month|hr|hour|wk|week))?\s*$/i;
const DATE_RE = /^\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*$/;

/** Classify a single cell into a coarse kind. */
export function cellKind(v) {
  const s = String(v == null ? "" : v).trim();
  if (s === "") return "empty";
  if (DATE_RE.test(s)) return "date";
  if (NUMERIC_RE.test(s)) return "number";
  return "text";
}

/**
 * Build a per-column profile from the raw rows. Returns one descriptor per
 * header: { header, kind, fillRate, distinctRatio }. No raw values escape.
 */
export function columnProfiles(headers, rows) {
  const n = rows.length || 0;
  return headers.map((header) => {
    let filled = 0;
    const kinds = { empty: 0, number: 0, date: 0, text: 0 };
    const distinct = new Set();
    for (const row of rows) {
      const raw = row[header];
      const s = String(raw == null ? "" : raw).trim();
      const k = cellKind(s);
      kinds[k]++;
      if (s !== "") { filled++; distinct.add(s.toLowerCase()); }
    }
    // dominant non-empty kind
    let kind = "text";
    let best = -1;
    for (const k of ["number", "date", "text"]) {
      if (kinds[k] > best) { best = kinds[k]; kind = k; }
    }
    if (filled === 0) kind = "empty";
    return {
      header,
      kind,
      fillRate: n ? Math.round((filled / n) * 100) / 100 : 0,
      distinctRatio: filled ? Math.round((distinct.size / filled) * 100) / 100 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Mapping coercion — turn an untrusted AI mapping into a safe one.
// ---------------------------------------------------------------------------

const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Coerce an arbitrary object (e.g. parsed AI JSON) into a valid mapping:
 *  - only known SCHEMA keys are kept,
 *  - each value must resolve to an ACTUAL header — exact match, or a
 *    case/punctuation-insensitive match (so "employee id" still finds
 *    "Employee ID"); anything else is dropped,
 *  - a given header is used at most once (first key wins).
 * Returns a mapping with every SCHEMA key present (null when unmapped).
 */
export function coerceMapping(aiMapping, headers) {
  const headerSet = new Set(headers);
  const byNorm = new Map();
  for (const h of headers) { const k = normKey(h); if (!byNorm.has(k)) byNorm.set(k, h); }
  const used = new Set();
  const out = {};
  for (const key of SCHEMA_KEYS) out[key] = null;
  if (aiMapping && typeof aiMapping === "object") {
    for (const key of SCHEMA_KEYS) {
      const v = aiMapping[key];
      if (typeof v !== "string") continue;
      const header = headerSet.has(v) ? v : byNorm.get(normKey(v));
      if (header && !used.has(header)) { out[key] = header; used.add(header); }
    }
  }
  return out;
}

/** Distinct, trimmed, non-empty values from one column (bounded). */
export function distinctValues(rows, header, limit = 300) {
  if (!header) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const s = String(row[header] == null ? "" : row[header]).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anomaly flagging — deterministic, on-device, over the compensation column.
// Runs regardless of whether AI is enabled. Output mirrors buildCanonical's
// issue shape: { row, field, level, msg }.
// ---------------------------------------------------------------------------

export const ANOMALY = Object.freeze({
  ABSOLUTE_FLOOR: 3000,   // an annual salary below this is almost certainly a typo
  LOW_RATIO: 0.1,         // < 10% of the median is suspicious
  HIGH_RATIO: 12,         // > 12x the median is suspicious
  MIN_SAMPLE: 4,          // need a few points before ratios mean anything
});

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Flag improbable compensation values among the clean rows. Pure: takes the
 * canonical rows produced by buildCanonical and returns a list of warnings.
 */
export function flagAnomalies(canonRows) {
  const flags = [];
  const considered = canonRows.filter(
    (r) => r && r._ok && typeof r.annual_salary === "number" && r.annual_salary > 0
  );
  const med = median(considered.map((r) => r.annual_salary));
  for (const r of considered) {
    const v = r.annual_salary;
    if (v < ANOMALY.ABSOLUTE_FLOOR) {
      flags.push({ row: r._row, field: "compensation_amount", level: "warn",
        msg: `Annual comp of ${Math.round(v).toLocaleString()} looks too low — possible typo or wrong pay unit` });
      continue;
    }
    if (med != null && considered.length >= ANOMALY.MIN_SAMPLE) {
      if (v < med * ANOMALY.LOW_RATIO) {
        flags.push({ row: r._row, field: "compensation_amount", level: "warn",
          msg: `Annual comp far below the team median (${Math.round(med).toLocaleString()}) — please double-check` });
      } else if (v > med * ANOMALY.HIGH_RATIO) {
        flags.push({ row: r._row, field: "compensation_amount", level: "warn",
          msg: `Annual comp far above the team median (${Math.round(med).toLocaleString()}) — please double-check` });
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Local fallbacks (used when AI is off, or when an AI call fails).
// ---------------------------------------------------------------------------

const TITLE_ABBREV = [
  [/\bsr\.?\b/gi, "Senior"],
  [/\bjr\.?\b/gi, "Junior"],
  [/\bmgr\.?\b/gi, "Manager"],
  [/\bdir\.?\b/gi, "Director"],
  [/\bvp\b/gi, "VP"],
  [/\beng\.?\b/gi, "Engineer"],
  [/\bengr\.?\b/gi, "Engineer"],
  [/\bdev\b/gi, "Developer"],
  [/\bacct\.?\b/gi, "Account"],
  [/\bops\b/gi, "Operations"],
  [/\badmin\b/gi, "Administrator"],
  [/\brep\.?\b/gi, "Representative"],
];

/** Deterministic title cleanup: collapse spaces, title-case, expand abbreviations. */
export function normalizeTitleLocal(title) {
  let s = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  if (!s) return "";
  // title-case words, keeping all-caps acronyms (<=3 chars) as-is
  s = s.split(" ").map((w) => {
    if (w.length <= 3 && w === w.toUpperCase()) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
  for (const [re, rep] of TITLE_ABBREV) s = s.replace(re, rep);
  return s.replace(/\s+/g, " ").trim();
}

/** Map of raw title -> normalized title, only including ones that actually change. */
export function normalizeTitlesLocal(titles) {
  const map = {};
  for (const t of titles || []) {
    const norm = normalizeTitleLocal(t);
    if (norm && norm !== String(t).trim()) map[t] = norm;
  }
  return map;
}

/** Deterministic department -> function-category map using the name heuristic. */
export function keywordDeptCategories(names) {
  const map = {};
  for (const name of names || []) {
    if (!name) continue;
    map[name] = classifyDepartment(name);
  }
  return map;
}

/** Validate an AI category map: only real category keys survive. */
export function coerceCategoryMap(aiMap, names) {
  const nameSet = new Set(names);
  const valid = new Set(FUNCTION_CATEGORY_KEYS);
  const out = {};
  if (aiMap && typeof aiMap === "object") {
    for (const [k, v] of Object.entries(aiMap)) {
      if (nameSet.has(k) && typeof v === "string" && valid.has(v)) out[k] = v;
    }
  }
  return out;
}

/** Validate an AI title map: keep only sane, changed, non-empty rewrites. */
export function coerceTitleMap(aiMap, titles) {
  const titleSet = new Set(titles);
  const out = {};
  if (aiMap && typeof aiMap === "object") {
    for (const [k, v] of Object.entries(aiMap)) {
      if (!titleSet.has(k)) continue;
      if (typeof v !== "string") continue;
      const clean = v.replace(/\s+/g, " ").trim();
      if (clean && clean.length <= 120 && clean !== String(k).trim()) out[k] = clean;
    }
  }
  return out;
}

/** The deterministic heuristic mapping (wraps the existing auto-mapper). */
export function heuristicMapping(headers) {
  const { mapping, confidence } = autoMap(headers);
  return { mapping, confidence, source: "heuristic" };
}

export { normHeader };
