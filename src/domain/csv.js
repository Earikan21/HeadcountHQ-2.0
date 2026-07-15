/**
 * Dependency-free CSV parsing. Handles quoted fields, embedded commas/newlines,
 * and escaped double-quotes ("").
 *
 *  - parseMatrix(text)  -> string[][]  (raw rows of cells; blank lines dropped)
 *  - parseCsv(text)     -> { headers, rows }  (assumes row 0 is the header)
 *  - detectHeaderRow(m) -> index of the most likely header row
 *  - matrixToRows(m, h) -> { headers, rows } using header row index h
 *  - toCsv(cols, rows)  -> string
 */

/** Parse into an array of records (array of cell strings). Drops blank lines. */
export function parseMatrix(text) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, "");

  const endRecord = () => {
    record.push(field); field = "";
    const nonEmpty = record.some((c) => c.trim() !== "");
    if (nonEmpty) records.push(record);
    record = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      endRecord();
    } else field += c;
  }
  if (field !== "" || record.length) endRecord();
  return records;
}

/**
 * Words that appear in real roster column headers. Used to identify the actual
 * header row even when a file starts with title/metadata rows (e.g. a company
 * name, "Printed on 6/19/2026", export timestamps) that also have several cells.
 */
const HEADER_WORDS = new Set([
  "employee", "emp", "id", "eid", "number", "no",
  "name", "first", "firstname", "last", "lastname", "full", "given", "surname",
  "department", "dept", "team", "division", "org", "unit", "group", "function",
  "title", "role", "position", "job",
  "salary", "compensation", "comp", "pay", "wage", "rate", "amount", "base", "annual",
  "unit", "frequency", "period",
  "manager", "supervisor", "reports",
  "status", "employment", "type", "classification",
  "email", "start", "hire", "date", "level", "location", "office",
]);

/** Tokenize a cell into lowercase word tokens. */
function tokens(cell) {
  return String(cell == null ? "" : cell).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** How many cells in a row look like header labels (contain a known header word). */
function headerScore(row) {
  let score = 0;
  for (const cell of row) {
    const ts = tokens(cell);
    if (ts.length && ts.some((t) => HEADER_WORDS.has(t))) score++;
  }
  return score;
}

/**
 * Pick the most likely header row. Strategy:
 *   1. Among the first ~15 rows, choose the row with the MOST header-like cells
 *      (cells whose words match common roster column names). This correctly skips
 *      title/metadata preamble rows that happen to have multiple cells.
 *   2. If no row is clearly header-like (best score < 2), fall back to the first
 *      row with at least two non-empty cells (the original heuristic).
 */
export function detectHeaderRow(matrix) {
  if (!matrix.length) return 0;
  const limit = Math.min(matrix.length, 15);
  let bestIdx = -1, bestScore = 0;
  for (let i = 0; i < limit; i++) {
    const score = headerScore(matrix[i]);
    if (score > bestScore) { bestScore = score; bestIdx = i; } // strictly greater keeps the earliest best
  }
  if (bestScore >= 2) return bestIdx;
  // Fallback: first row with >= 2 non-empty cells.
  for (let i = 0; i < matrix.length; i++) {
    if (matrix[i].filter((c) => c.trim() !== "").length >= 2) return i;
  }
  return 0;
}

/** Build { headers, rows } from a matrix using the given header row index. */
export function matrixToRows(matrix, headerRow = 0) {
  if (!matrix.length) return { headers: [], rows: [] };
  const hr = Math.min(Math.max(0, headerRow), matrix.length - 1);
  const headers = matrix[hr].map((h, idx) => (h.trim() || `Column ${idx + 1}`));
  const rows = [];
  for (let r = hr + 1; r < matrix.length; r++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = matrix[r][idx] !== undefined ? matrix[r][idx] : ""; });
    rows.push(obj);
  }
  return { headers, rows };
}

/** Convenience: parse assuming the first (auto-detected) row is the header. */
export function parseCsv(text) {
  const m = parseMatrix(text);
  return matrixToRows(m, detectHeaderRow(m));
}

/** Serialize array-of-objects to CSV using the given column order. */
export function toCsv(columns, rows) {
  const esc = (v) => {
    let str = v == null ? "" : String(v);
    // Neutralize spreadsheet formula/DDE injection: a cell that opens with a
    // formula trigger is prefixed with a single quote so Excel/Sheets treats it
    // as text. Roster export cells are labels/dates/whole numbers, never formulas.
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return /[",\n\r]/.test(str) ? '"' + str.replaceAll('"', '""') + '"' : str;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(","));
  return lines.join("\n");
}
