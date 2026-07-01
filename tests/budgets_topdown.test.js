import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { allReconciliation, getCompanyBudget } from "../src/repos/budgets.js";

async function admin() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "ada@acme.co", password: "supersecret123" });
  await c.post("/departments", { name: "Engineering" });
  await c.post("/departments", { name: "Sales" });
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  const sales = srv.db.prepare("SELECT id FROM departments WHERE name='Sales'").get().id;
  return { srv, c, eng, sales };
}

test("headcount and money budgets are set independently, one at a time", async () => {
  const { srv, c, eng, sales } = await admin();
  await c.post("/budgets", { mode: "headcount", company_headcount: "20", [`hc_${eng}`]: "12", [`hc_${sales}`]: "6" });
  await c.post("/budgets", { mode: "money", company_money: "3000000", [`money_${eng}`]: "2000000", [`money_${sales}`]: "800000" });

  const cb = getCompanyBudget(srv.db);
  assert.equal(cb.headcount, 20);
  assert.equal(cb.money, 3000000);
  const { allocation } = allReconciliation(srv.db);
  assert.equal(allocation.headcount.allocated, 18);
  assert.equal(allocation.headcount.remaining, 2);
  assert.equal(allocation.money.allocated, 2800000);
  assert.equal(allocation.money.remaining, 200000);
  await srv.close();
});

test("saving headcount does NOT wipe money allocations (partial update)", async () => {
  const { srv, c, eng } = await admin();
  await c.post("/budgets", { mode: "money", company_money: "1000000", [`money_${eng}`]: "500000" });
  await c.post("/budgets", { mode: "headcount", company_headcount: "10", [`hc_${eng}`]: "4" });
  const { allocation } = allReconciliation(srv.db);
  assert.equal(allocation.money.allocated, 500000, "money allocation preserved");
  assert.equal(allocation.headcount.allocated, 4);
  await srv.close();
});

test("over-allocating beyond the company cap is flagged", async () => {
  const { srv, c, eng, sales } = await admin();
  await c.post("/budgets", { mode: "headcount", company_headcount: "10", [`hc_${eng}`]: "8", [`hc_${sales}`]: "5" });
  const { allocation } = allReconciliation(srv.db);
  assert.equal(allocation.headcount.allocated, 13);
  assert.equal(allocation.headcount.over, 3);
  const pageHtml = await (await c.get("/budgets?mode=headcount")).text();
  assert.match(pageHtml, /over by 3/i);
  await srv.close();
});

test("headcount mode shows current employees; page has both tabs", async () => {
  const { srv, c } = await admin();
  const pageHtml = await (await c.get("/budgets")).text();
  assert.match(pageHtml, /Current employees/);
  assert.match(pageHtml, /Headcount budget/);
  assert.match(pageHtml, /Money budget/);
  assert.match(pageHtml, /Allocate positions to departments/);
  await srv.close();
});
