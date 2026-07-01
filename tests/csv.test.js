import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "../src/domain/csv.js";

test("parses simple CSV into objects", () => {
  const { headers, rows } = parseCsv("a,b\n1,2\n3,4");
  assert.deepEqual(headers, ["a", "b"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: "1", b: "2" });
});

test("handles quoted fields with commas and quotes", () => {
  const { rows } = parseCsv('name,note\n"Doe, Jane","She said ""hi"""');
  assert.equal(rows[0].name, "Doe, Jane");
  assert.equal(rows[0].note, 'She said "hi"');
});

test("handles embedded newlines and CRLF and BOM", () => {
  const { rows } = parseCsv('﻿a,b\r\n"line1\nline2",x\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, "line1\nline2");
  assert.equal(rows[0].b, "x");
});

test("skips blank lines", () => {
  const { rows } = parseCsv("a\n1\n\n2\n");
  assert.deepEqual(rows.map((r) => r.a), ["1", "2"]);
});

test("toCsv round-trips with escaping", () => {
  const out = toCsv(["a", "b"], [{ a: "x,y", b: 'q"z' }]);
  assert.equal(out, 'a,b\n"x,y","q""z"');
});

import { parseMatrix, detectHeaderRow, matrixToRows } from "../src/domain/csv.js";

test("detectHeaderRow skips a single-cell title row", () => {
  const m = parseMatrix("Q3 2026 Headcount Plan\nEmployee ID,Name,Department\nE-1,Dana,Eng");
  assert.equal(m.length, 3);
  const hr = detectHeaderRow(m);
  assert.equal(hr, 1);
  const { headers, rows } = matrixToRows(m, hr);
  assert.deepEqual(headers, ["Employee ID", "Name", "Department"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Employee ID"], "E-1");
});

test("detectHeaderRow skips a title row padded with empty cells", () => {
  const m = parseMatrix('Company Roster,,,\nID,Name,Dept,Pay\n1,A,Eng,100000');
  assert.equal(detectHeaderRow(m), 1);
});

test("matrixToRows backfills blank header names", () => {
  const m = parseMatrix("ID,,Dept\n1,x,Eng");
  const { headers } = matrixToRows(m, 0);
  assert.equal(headers[1], "Column 2");
});
