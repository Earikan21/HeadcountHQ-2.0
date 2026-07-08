import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpload, adapterFor, listAdapters } from "../src/domain/adapters.js";

test("CSV adapter parses an upload into a matrix", () => {
  const r = parseUpload("roster.csv", Buffer.from("a,b\n1,2"));
  assert.equal(r.error, null);
  assert.equal(r.adapter, "csv");
  assert.deepEqual(r.matrix[0], ["a", "b"]);
});

test("xlsx is handled natively; a corrupt one fails with a message, not a crash", () => {
  const r = parseUpload("roster.xlsx", Buffer.from("PK..."));
  assert.equal(r.matrix, null, "a truncated workbook is rejected");
  assert.match(r.error, /Not a readable \.xlsx/);
  assert.ok(!/Save As/i.test(r.error), "we no longer tell people to re-save as CSV");
});

test("the old binary .xls still gets a friendly nudge", () => {
  const r = parseUpload("roster.xls", Buffer.from("junk"));
  assert.equal(r.matrix, null);
  assert.match(r.error, /old binary \.xls/);
});

test("registry advertises the CSV and XLSX adapters", () => {
  assert.ok(listAdapters().some((a) => a.id === "csv"));
  assert.ok(listAdapters().some((a) => a.id === "xlsx"));
  assert.equal(adapterFor("x.tsv").id, "csv");
  assert.equal(adapterFor("x.xlsx").id, "xlsx");
  assert.equal(adapterFor("x.xlsm").id, "xlsx");
  assert.equal(adapterFor("x.pdf"), null);
});
