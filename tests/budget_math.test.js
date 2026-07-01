import { test } from "node:test";
import assert from "node:assert/strict";
import { costBand, expectedRange } from "../src/domain/budget.js";

test("costBand returns min/max/avg over loaded costs", () => {
  const b = costBand([130000, 195000, 260000]);
  assert.equal(b.low, 130000);
  assert.equal(b.high, 260000);
  assert.equal(b.avg, 195000);
  assert.equal(b.count, 3);
  assert.equal(costBand([]), null);
});

test("expectedRange multiplies a band across added heads", () => {
  const band = { low: 100000, high: 200000 };
  const r = expectedRange(2, band);
  assert.equal(r.low, 200000);   // 2 x 100k
  assert.equal(r.high, 400000);  // 2 x 200k
  assert.equal(expectedRange(0, band), null);
  assert.equal(expectedRange(2, null), null);
});
