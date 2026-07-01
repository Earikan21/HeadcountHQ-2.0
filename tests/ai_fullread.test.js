import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFullReadPrompt, extractRows, aiRowsToMatrix } from "../src/domain/ai_import.js";
import { matrixToRows } from "../src/domain/csv.js";
import { buildCanonical } from "../src/domain/roster.js";

test("buildFullReadPrompt includes the raw grid contents (this path intentionally sends values)", () => {
  const matrix = [
    ["SiPhox Inc - Employees Summary"],
    ["Printed on", "6/19/2026"],
    ["Dana Lee", "Engineering", "Sr Engineer", "$185,000"],
  ];
  const { system, user, truncated } = buildFullReadPrompt(matrix);
  assert.equal(truncated, false);
  assert.match(user, /GRID:/);
  assert.match(user, /Dana Lee/);        // full-read DOES send contents (by design)
  assert.match(user, /185,000/);
  assert.match(system, /clean employee roster/);
});

test("buildFullReadPrompt flags truncation past the row cap", () => {
  const big = Array.from({ length: 250 }, (_, i) => [`Person ${i}`, "Eng", "100000"]);
  assert.equal(buildFullReadPrompt(big, 200).truncated, true);
});

test("extractRows tolerates object-with-rows, bare array, and prose wrappers", () => {
  assert.deepEqual(extractRows('{"rows":[{"name":"A"}]}'), [{ name: "A" }]);
  assert.deepEqual(extractRows('Sure! [{"name":"B"}]'), [{ name: "B" }]);
  assert.deepEqual(extractRows('```json\n{"rows":[{"name":"C"}]}\n```'), [{ name: "C" }]);
  assert.throws(() => extractRows("no data here"), /no rows array/);
});

test("aiRowsToMatrix normalizes rows, fills missing ids, drops nameless rows", () => {
  const rows = [
    { employee_id: "E-1", name: "Dana Lee", department: "Engineering", job_title: "Sr Engineer", compensation_amount: 185000, compensation_unit: "annual", employment_status: "active" },
    { name: "Liam Cho", department: "Sales", job_title: "AE", compensation_amount: 150000 }, // no id -> generated
    { department: "Ops" }, // no name -> dropped
    "garbage",             // not an object -> dropped
  ];
  const { matrix, mapping, count } = aiRowsToMatrix(rows);
  assert.equal(count, 2);
  // header row is the canonical field keys; identity mapping
  assert.equal(mapping.employee_id, "employee_id");
  assert.deepEqual(matrix[0][0], "employee_id");

  // feed back through the normal pipeline: both people come out clean
  const { rows: rawRows } = matrixToRows(matrix, 0);
  const built = buildCanonical(rawRows, mapping);
  assert.equal(built.summary.clean, 2);
  const liam = built.rows.find((r) => r.name === "Liam Cho");
  assert.ok(/^E-\d+$/.test(liam.employee_id), "missing id was auto-generated");
  const dana = built.rows.find((r) => r.name === "Dana Lee");
  assert.equal(dana.annual_salary, 185000);
});
