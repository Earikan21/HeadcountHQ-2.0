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

const ext = (filename) => String(filename || "").toLowerCase().split(".").pop();

export const csvAdapter = {
  id: "csv",
  label: "CSV / TSV",
  extensions: ["csv", "tsv", "txt"],
  sniff(filename) { return ["csv", "tsv", "txt"].includes(ext(filename)); },
  parse(buffer) { return parseMatrix(buffer.toString("utf8")); },
};

// Registry — add adapters here (e.g. an XLSX adapter, or a connector adapter).
const ADAPTERS = [csvAdapter];

export function listAdapters() { return ADAPTERS.map((a) => ({ id: a.id, label: a.label, extensions: a.extensions })); }

export function adapterFor(filename) {
  return ADAPTERS.find((a) => a.sniff(filename)) || null;
}

/** Parse an uploaded file into a matrix, choosing an adapter by filename. */
export function parseUpload(filename, buffer) {
  const adapter = adapterFor(filename);
  if (!adapter) {
    const e = String(ext(filename));
    const hint = e === "xlsx" || e === "xls"
      ? "Excel isn't supported directly — in Excel choose File → Save As → CSV, then upload that."
      : "Unsupported file type. Upload a .csv file.";
    return { error: hint, matrix: null };
  }
  return { error: null, matrix: adapter.parse(buffer), adapter: adapter.id };
}
