import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMatrix, detectHeaderRow, matrixToRows } from "../src/domain/csv.js";
import { coerceMapping } from "../src/domain/import_ai.js";

test("detectHeaderRow finds the real header row under metadata preamble", () => {
  // Mirrors a real export: company title, confidential note, print date, THEN headers.
  const m = parseMatrix([
    "SiPhox Inc - Employees Summary",
    "Confidential",
    "Printed on,6/19/2026",
    "Employee ID,First Name,Last Name,Department,Job Title,Base Salary,Status",
    "E-1,Dana,Lee,Engineering,Sr Engineer,185000,Active",
    "E-2,Liam,Cho,Sales,AE,150000,Active",
  ].join("\n"));
  const hr = detectHeaderRow(m);
  assert.equal(hr, 3, "should pick the row that actually holds column names");
  const { headers } = matrixToRows(m, hr);
  assert.deepEqual(headers, ["Employee ID", "First Name", "Last Name", "Department", "Job Title", "Base Salary", "Status"]);
});

test("detectHeaderRow still handles a clean file (row 0)", () => {
  const m = parseMatrix("Employee ID,Name,Department,Salary\nE-1,Dana,Eng,120000");
  assert.equal(detectHeaderRow(m), 0);
});

test("detectHeaderRow falls back gracefully when no row looks like headers", () => {
  const m = parseMatrix("alpha,beta\n1,2\n3,4");
  // no header-words match; falls back to first row with >=2 non-empty cells
  assert.equal(detectHeaderRow(m), 0);
});

test("coerceMapping tolerates case / spacing differences from the model", () => {
  const headers = ["Employee ID", "Full Name", "Team", "Base Pay"];
  const ai = {
    employee_id: "employee id",   // wrong case/spacing -> should still resolve
    name: "FULL NAME",
    department: "team",
    compensation_amount: "Base Pay",
    job_title: "Nonexistent",     // genuinely absent -> null
  };
  const m = coerceMapping(ai, headers);
  assert.equal(m.employee_id, "Employee ID");
  assert.equal(m.name, "Full Name");
  assert.equal(m.department, "Team");
  assert.equal(m.compensation_amount, "Base Pay");
  assert.equal(m.job_title, null);
});
