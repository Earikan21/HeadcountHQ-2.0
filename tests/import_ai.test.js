import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellKind, columnProfiles, coerceMapping, distinctValues, flagAnomalies, ANOMALY,
  normalizeTitleLocal, normalizeTitlesLocal, keywordDeptCategories,
  coerceCategoryMap, coerceTitleMap, heuristicMapping, SCHEMA_KEYS,
} from "../src/domain/import_ai.js";

test("cellKind classifies coarse types", () => {
  assert.equal(cellKind(""), "empty");
  assert.equal(cellKind("  "), "empty");
  assert.equal(cellKind("$120,000"), "number");
  assert.equal(cellKind("95k"), "number");
  assert.equal(cellKind("9500/mo"), "number");
  assert.equal(cellKind("2024-01-15"), "date");
  assert.equal(cellKind("01/15/2024"), "date");
  assert.equal(cellKind("Engineering"), "text");
});

test("columnProfiles emits only header + type stats, never raw values", () => {
  const headers = ["EmpID", "Full Name", "Base"];
  const rows = [
    { EmpID: "E-1", "Full Name": "Dana Lee", Base: "$185,000" },
    { EmpID: "E-2", "Full Name": "Liam Cho", Base: "120000" },
  ];
  const profiles = columnProfiles(headers, rows);
  assert.equal(profiles.length, 3);
  // Base column reads as numeric, fully filled, fully distinct
  const base = profiles.find((p) => p.header === "Base");
  assert.equal(base.kind, "number");
  assert.equal(base.fillRate, 1);
  assert.equal(base.distinctRatio, 1);
  // no profile object carries any raw value
  const blob = JSON.stringify(profiles);
  assert.ok(!blob.includes("Dana Lee"));
  assert.ok(!blob.includes("185"));
  assert.ok(!blob.includes("E-1"));
  // only the four whitelisted keys exist
  for (const p of profiles) {
    assert.deepEqual(Object.keys(p).sort(), ["distinctRatio", "fillRate", "header", "kind"]);
  }
});

test("coerceMapping keeps only valid schema keys + real headers, deduped", () => {
  const headers = ["Employee ID", "Name", "Dept"];
  const ai = {
    employee_id: "Employee ID",
    name: "Name",
    department: "Dept",
    bogus_key: "Name",       // not a schema key -> dropped
    job_title: "Nonexistent", // not a real header -> dropped
    manager: "Name",          // header already used by name -> dropped
  };
  const m = coerceMapping(ai, headers);
  assert.equal(m.employee_id, "Employee ID");
  assert.equal(m.name, "Name");
  assert.equal(m.department, "Dept");
  assert.equal(m.job_title, null);
  assert.equal(m.manager, null);
  assert.ok(!("bogus_key" in m));
  // every schema key present
  for (const k of SCHEMA_KEYS) assert.ok(k in m);
});

test("coerceMapping tolerates junk input", () => {
  const m = coerceMapping(null, ["A"]);
  assert.equal(m.name, null);
  const m2 = coerceMapping("not an object", ["A"]);
  assert.equal(m2.name, null);
});

test("distinctValues returns trimmed, deduped, bounded values", () => {
  const rows = [
    { d: "Engineering" }, { d: "engineering" }, { d: " Sales " }, { d: "" }, { d: "Sales" },
  ];
  assert.deepEqual(distinctValues(rows, "d"), ["Engineering", "Sales"]);
  assert.deepEqual(distinctValues(rows, null), []);
  assert.equal(distinctValues(rows, "d", 1).length, 1);
});

test("flagAnomalies catches sub-floor comp and far-from-median outliers", () => {
  const mk = (row, annual, ok = true) => ({ _row: row, _ok: ok, annual_salary: annual });
  const rows = [
    mk(1, 120000), mk(2, 130000), mk(3, 125000), mk(4, 140000),
    mk(5, 50),            // below absolute floor
    mk(6, 5000000),       // > 12x median
    mk(7, 0, true),       // zero ignored (not > 0)
    mk(8, 99999, false),  // not ok -> ignored
  ];
  const flags = flagAnomalies(rows);
  const byRow = Object.fromEntries(flags.map((f) => [f.row, f.msg]));
  assert.match(byRow[5], /too low/);
  assert.match(byRow[6], /above the team median/);
  assert.ok(!(7 in byRow));
  assert.ok(!(8 in byRow));
});

test("flagAnomalies needs a minimum sample before ratio rules fire", () => {
  // Only 2 points; ratio rules suppressed, but absolute floor still applies.
  const rows = [
    { _row: 1, _ok: true, annual_salary: 1000000 },
    { _row: 2, _ok: true, annual_salary: 120000 }, // would be <0.1x of 1M but sample < MIN
  ];
  assert.ok(ANOMALY.MIN_SAMPLE > 2);
  assert.equal(flagAnomalies(rows).length, 0);
});

test("normalizeTitleLocal cleans casing and expands abbreviations", () => {
  assert.equal(normalizeTitleLocal("  sr   software   engineer "), "Senior Software Engineer");
  assert.equal(normalizeTitleLocal("eng mgr"), "Engineer Manager");
  assert.equal(normalizeTitleLocal("VP of Sales"), "VP Of Sales");
});

test("normalizeTitlesLocal only includes titles that change", () => {
  const map = normalizeTitlesLocal(["Senior Engineer", "sr eng", ""]);
  assert.ok(!("Senior Engineer" in map)); // already clean
  assert.equal(map["sr eng"], "Senior Engineer");
});

test("keywordDeptCategories + coerce helpers", () => {
  const cats = keywordDeptCategories(["Engineering", "Sales", "Finance", "Mystery Team"]);
  assert.equal(cats["Engineering"], "rnd");
  assert.equal(cats["Sales"], "sm");
  assert.equal(cats["Finance"], "ga");
  assert.equal(cats["Mystery Team"], "other");

  const cc = coerceCategoryMap({ Engineering: "rnd", Sales: "not_a_cat", Ghost: "rnd" }, ["Engineering", "Sales"]);
  assert.deepEqual(cc, { Engineering: "rnd" });

  const tc = coerceTitleMap({ "sr eng": "Senior Engineer", "ae": "ae", "x": "y" }, ["sr eng", "ae"]);
  assert.deepEqual(tc, { "sr eng": "Senior Engineer" }); // unchanged + unknown dropped
});

test("heuristicMapping wraps the existing auto-mapper", () => {
  const { mapping, source } = heuristicMapping(["Employee ID", "Name", "Department", "Salary"]);
  assert.equal(source, "heuristic");
  assert.equal(mapping.employee_id, "Employee ID");
  assert.equal(mapping.compensation_amount, "Salary");
});
