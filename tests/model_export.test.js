/** The shared spreadsheet matrix: outputs are linked formulas, not hardcoded numbers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelMatrix, modelMatrixCells, colLetter } from "../src/domain/model_export.js";
import { buildHeadcountModel } from "../src/domain/model.js";

test("column letters", () => {
  assert.equal(colLetter(0), "A"); assert.equal(colLetter(11), "L"); assert.equal(colLetter(12), "M"); assert.equal(colLetter(26), "AA");
});

test("matrix carries every driver and links the cost outputs to the inputs", () => {
  const emp = [{ name: "Dana", employee_ext_id: "E1", department_name: "Eng", job_title: "SWE", annual_salary: 120000, employment_status: "active", start_date: "2026-01-01" }];
  const model = buildHeadcountModel({ employees: emp, loadedMultiplier: 1.3, start: { year: 2026, month0: 0 }, months: 3, now: new Date("2026-01-01"), assumptions: { bonusPct: 10 } });
  const { headers, rows, total } = modelMatrix(model);

  assert.deepEqual(headers.slice(0, 12), ["Department", "Name", "Role", "Status", "Start", "End", "Annual Base", "Load %", "Bonus %", "Salary Growth %", "Cost per Hire", "Loaded Monthly"]);
  const r = rows[0];
  assert.equal(r[6], 120000);           // base is a literal input
  assert.equal(r[7], 30);               // load %
  assert.equal(r[8], 10);               // bonus %
  assert.equal(r[11], "=G2/12*(1+H2/100)*(1+I2/100)", "loaded monthly is a formula over base/load/bonus");
  // month cell is a formula referencing loaded monthly (so editing base recomputes it)
  assert.match(r[12], /^=\$L2\*/, "month cost links to loaded monthly");

  // the formula actually reproduces the model's number: L * factor
  const L = 120000 / 12 * 1.3 * 1.1;                 // = loaded monthly incl bonus
  const factor = Number(r[12].match(/\*([\d.]+)/)[1]);
  assert.ok(Math.abs(L * factor - model.roster[0].monthlyCost[0]) < 1, "formula equals the engine cost");

  // totals are SUMs, never precomputed numbers
  assert.equal(total[0], "TOTAL");
  assert.equal(total[6], "=SUM(G2:G2)");
  assert.equal(total[11], "=SUM(L2:L2)");
  assert.equal(total[12], "=SUM(M2:M2)");
});

test("a one-time cost per hire is added in the hire month, still linked", () => {
  const emp = [{ name: "X", employee_ext_id: "E1", department_name: "Eng", annual_salary: 120000, employment_status: "active", start_date: "2026-02-01" }];
  const model = buildHeadcountModel({ employees: emp, loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 3, now: new Date("2026-01-01"), assumptions: { costPerHire: 5000 } });
  const r = modelMatrix(model).rows[0];
  assert.equal(r[12], 0, "no cost before they start (Jan)");
  assert.match(r[13], /^=\$L2\*[\d.]+\+5000$/, "hire month links to loaded monthly and adds the one-time cost");
});

test("cells flatten to header + rows + total", () => {
  const emp = [{ name: "A", employee_ext_id: "E1", department_name: "Eng", annual_salary: 120000, employment_status: "active" }];
  const model = buildHeadcountModel({ employees: emp, loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 2, now: new Date("2026-01-01") });
  const cells = modelMatrixCells(model);
  assert.equal(cells.length, 3);       // header + 1 person + total
  assert.equal(cells[0][0], "Department");
  assert.equal(cells[2][0], "TOTAL");
});
