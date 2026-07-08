/**
 * Import-adapter framework. An adapter turns an uploaded file into a parse
 * matrix (rows of cells) so new formats — and, later, live HRIS/ATS connectors —
 * drop in without touching the import wizard.
 *
 *   Adapter = {
 *     id, label, extensions: string[],
 *     sniff(filename, buffer) -> boolean,
 *     parse(buffer) -> string[][]   // matrix of raw cells
 *   }
 *
 * Live connectors (Workday, BambooHR, Greenhouse, …) implement the same shape,
 * returning a matrix from their API instead of a file. They need vendor
 * credentials/partner apps, so they are out of scope here (documented), but the
 * import pipeline below is the seam they plug into.
 */
import { parseMatrix } from "./csv.js";
import { parseXlsx } from "./xlsx.js";

const ext = (filename) => String(filename || "").toLowerCase().split(".").pop();

export const csvAdapter = {
  id: "csv",
  label: "CSV / TSV",
  extensions: ["csv", "tsv", "txt"],
  sniff(filename) { return ["csv", "tsv", "txt"].includes(ext(filename)); },
  parse(buffer) { return parseMatrix(buffer.toString("utf8")); },
};

export const xlsxAdapter = {
  id: "xlsx",
  label: "Excel workbook",
  extensions: ["xlsx", "xlsm"],
  sniff(filename) { return ["xlsx", "xlsm"].includes(ext(filename)); },
  parse(buffer) { return parseXlsx(buffer); },
};

// Registry — add adapters here (e.g. a connector adapter).
const ADAPTERS = [csvAdapter, xlsxAdapter];

export function listAdapters() { return ADAPTERS.map((a) => ({ id: a.id, label: a.label, extensions: a.extensions })); }

export function adapterFor(filename) {
  return ADAPTERS.find((a) => a.sniff(filename)) || null;
}

/** Parse an uploaded file into a matrix, choosing an adapter by filename. */
export function parseUpload(filename, buffer) {
  const adapter = adapterFor(filename);
  if (!adapter) {
    const e = String(ext(filename));
    const hint = e === "xls"
      ? "That's the old binary .xls format. In Excel choose File \u2192 Save As \u2192 .xlsx (or .csv), then upload that."
      : "Unsupported file type. Upload a .xlsx or .csv file.";
    return { error: hint, matrix: null };
  }
  // A malformed workbook shouldn't take the request down — surface it as an error.
  try {
    return { error: null, matrix: adapter.parse(buffer), adapter: adapter.id };
  } catch (e) {
    return { error: (e && e.message) || "That file couldn't be read.", matrix: null };
  }
}
