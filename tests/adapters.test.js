import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpload, adapterFor, listAdapters } from "../src/domain/adapters.js";

test("CSV adapter parses an upload into a matrix", () => {
  const r = parseUpload("roster.csv", Buffer.from("a,b\n1,2"));
  assert.equal(r.error, null);
  assert.equal(r.adapter, "csv");
  assert.deepEqual(r.matrix[0], ["a", "b"]);
});

test("xlsx upload returns a friendly 'save as CSV' message", () => {
  const r = parseUpload("roster.xlsx", Buffer.from("PK..."));
  assert.equal(r.matrix, null);
  assert.match(r.error, /Save As .* CSV/i);
});

test("registry advertises the CSV adapter", () => {
  assert.ok(listAdapters().some((a) => a.id === "csv"));
  assert.equal(adapterFor("x.tsv").id, "csv");
  assert.equal(adapterFor("x.pdf"), null);
});
