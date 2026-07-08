/**
 * The dependency-free .xlsx reader. The interesting parts are the ZIP container,
 * the shared-string pool, and Excel's date serials — a roster whose start dates
 * arrive as "45306" is worse than useless.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseXlsx, serialToISO, colIndexOf, isDateFormatCode, decodeXml, unzip } from "../src/domain/xlsx.js";
import { parseUpload, adapterFor, listAdapters } from "../src/domain/adapters.js";

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

test("column refs decode to zero-based indices", () => {
  assert.equal(colIndexOf("A1"), 0);
  assert.equal(colIndexOf("B2"), 1);
  assert.equal(colIndexOf("Z10"), 25);
  assert.equal(colIndexOf("AA1"), 26);
  assert.equal(colIndexOf("BC12"), 54);
});

test("date serials convert, and implausible ones are left alone", () => {
  assert.equal(serialToISO(45306), "2024-01-15");
  assert.equal(serialToISO(1), null, "1900-01-01 is not a plausible roster date");
  assert.equal(serialToISO(0), null);
  assert.equal(serialToISO(-5), null);
  assert.equal(serialToISO("not a number"), null);
  // the 1904 (Mac) date system shifts by 1462 days
  assert.equal(serialToISO(45306 - 1462, true), "2024-01-15");
});

test("date format codes are told apart from number formats", () => {
  assert.ok(isDateFormatCode("yyyy-mm-dd"));
  assert.ok(isDateFormatCode("d/m/yy"));
  assert.ok(isDateFormatCode("[$-409]mmm\\ yyyy"));
  assert.ok(!isDateFormatCode("General"));
  assert.ok(!isDateFormatCode("#,##0.00"));
  assert.ok(!isDateFormatCode('0.0%'));
  assert.ok(!isDateFormatCode('"days"'), "a quoted literal is not a date pattern");
  assert.ok(!isDateFormatCode(""));
});

test("xml entities decode, including numeric ones", () => {
  assert.equal(decodeXml("a &amp; b"), "a & b");
  assert.equal(decodeXml("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeXml("&#65;&#x42;"), "AB");
  assert.equal(decodeXml("O&apos;Neill"), "O'Neill");
});

test("a deflated workbook parses into a matrix, with dates and entities resolved", () => {
  const m = parseXlsx(fixture("roster.xlsx"));
  assert.equal(m.length, 5);
  assert.deepEqual(m[1], ["Employee ID", "Name", "Department", "Compensation Amount", "Compensation Unit", "Start date", "End date"]);
  assert.deepEqual(m[2], ["E-1", "Dana Lee", "Engineering", "120000", "Annual", "2024-01-15", ""]);
  assert.equal(m[3][1], "Liam O'Neill & Co", "shared strings are entity-decoded");
  assert.equal(m[4][6], "2026-09-30", "the end date is a real date, not a serial");
  assert.ok(m.every((r) => r.length === 7), "every row padded to the full width");
});

test("a stored (uncompressed) workbook parses identically", () => {
  assert.deepEqual(parseXlsx(fixture("roster-stored.xlsx")), parseXlsx(fixture("roster.xlsx")));
});

test("compensation stays numeric — only date-styled cells are converted", () => {
  const m = parseXlsx(fixture("roster.xlsx"));
  assert.equal(m[2][3], "120000", "a salary is not a date, even though 120000 is a valid serial");
});

test("the adapter registry routes .xlsx, and parseUpload uses it", () => {
  assert.ok(listAdapters().some((a) => a.id === "xlsx"));
  assert.equal(adapterFor("Roster Q3.XLSX").id, "xlsx");
  assert.equal(adapterFor("roster.csv").id, "csv");
  const { error, matrix, adapter } = parseUpload("roster.xlsx", fixture("roster.xlsx"));
  assert.equal(error, null);
  assert.equal(adapter, "xlsx");
  assert.equal(matrix[2][1], "Dana Lee");
});

test("bad input fails with a message, never a stack trace", () => {
  assert.match(parseUpload("roster.xls", Buffer.from("junk")).error, /old binary \.xls/);
  assert.match(parseUpload("roster.pdf", Buffer.from("junk")).error, /Unsupported file type/);
  // a .xlsx that isn't a zip
  const bad = parseUpload("roster.xlsx", Buffer.from("this is not a zip file at all"));
  assert.equal(bad.matrix, null);
  assert.match(bad.error, /Not a readable \.xlsx/);
  // the legacy OLE compound-document header (a real .xls renamed to .xlsx)
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]);
  assert.match(parseUpload("roster.xlsx", ole).error, /old \.xls file/);
  assert.throws(() => unzip(Buffer.alloc(4)), /too small/);
});
