import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";
import { allReconciliation } from "../src/repos/budgets.js";

const MAP = {
  map_employee_id: "Employee ID", map_name: "Name", map_department: "Department",
  map_compensation_amount: "Compensation Amount", map_compensation_unit: "Compensation Unit",
};
async function withRoster() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  const CSV = "Employee ID,Name,Department,Compensation Amount,Compensation Unit\n" +
    "E-1,Dana,Engineering,120000,Annual\nE-2,Liam,Engineering,160000,Annual\nE-3,Mara,Sales,100000,Annual";
  await c.get("/roster/import");
  const up = await c.upload("/roster/import", {}, { field: "file", filename: "r.csv", content: CSV });
  const id = up.headers.get("location").match(/import\/(\d+)\/map/)[1];
  await c.post(`/roster/import/${id}/map`, MAP);
  await c.post(`/roster/import/${id}/commit`, {});
  const eng = srv.db.prepare("SELECT id FROM departments WHERE name='Engineering'").get().id;
  return { srv, c, eng };
}

test("current headcount + cost count toward Allocated (not 0)", async () => {
  const { srv } = await withRoster();
  const { allocation } = allReconciliation(srv.db);
  // 3 current employees, no budgets set -> allocated reflects current, not 0
  assert.equal(allocation.headcount.allocated, 3);
  // money allocated = current fully-loaded cost (1.3x): (120k+160k)*1.3 + 100k*1.3
  assert.equal(allocation.money.allocated, Math.round((120000 + 160000 + 100000) * 1.3));
  await srv.close();
});

test("effective allocation is floored at current headcount", async () => {
  const { srv, c, eng } = await withRoster();
  await c.post("/budgets", { mode: "headcount", company_headcount: "10", [`hc_${eng}`]: "1" }); // below current (2)
  const { rows } = allReconciliation(srv.db);
  const e = rows.find((r) => r.id === eng);
  assert.equal(e.currentEmployees, 2);
  assert.equal(e.effHeadcount, 2, "can't allocate below current headcount");
  await srv.close();
});

test("allocating heads beyond current shows expected cost range from the band", async () => {
  const { srv, c, eng } = await withRoster();
  // budget 4 = 2 more than the 2 current; band per head = [120k,160k] x1.3 = [156k,208k]
  await c.post("/budgets", { mode: "headcount", company_headcount: "10", [`hc_${eng}`]: "4" });
  const pageHtml = await (await c.get("/budgets?mode=headcount")).text();
  assert.match(pageHtml, /expected/i);
  assert.match(pageHtml, /\$312k/);  // 2 x 156k
  assert.match(pageHtml, /\$416k/);  // 2 x 208k
  await srv.close();
});

test("the live-update script is served", async () => {
  const { srv, c } = await withRoster();
  const res = await c.get("/static/budgets.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  await srv.close();
});

test("money budgets accept arbitrary amounts (not just round thousands)", async () => {
  const { srv, c, eng } = await withRoster();
  // an awkward, non-round amount
  await c.post("/budgets", { mode: "money", company_money: "201500", [`money_${eng}`]: "201500" });
  const row = srv.db.prepare("SELECT money_budget FROM budget_envelopes WHERE department_id=?").get(eng);
  assert.equal(row.money_budget, 201500);
  assert.equal(srv.db.prepare("SELECT company_money_budget AS m FROM workspace_settings WHERE workspace_id=1").get().m, 201500);
  // the input no longer constrains to multiples of 1000
  const pageHtml = await (await c.get("/budgets?mode=money")).text();
  assert.ok(!pageHtml.includes('step="1000"'), "money input must not force a 1000 step");
  assert.match(pageHtml, /name="money_[0-9]+"/);
  assert.match(pageHtml, /step="any"/);
  await srv.close();
});
