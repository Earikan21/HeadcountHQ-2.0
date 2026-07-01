import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeClient } from "./helpers.js";

async function adminWithDepts() {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  await c.post("/departments", { name: "Engineering" });
  await c.post("/departments", { name: "Sales" });
  return { srv, c };
}
const engTarget = (db) => db.prepare("SELECT target_pct FROM target_ratios WHERE key='Engineering'").get()?.target_pct;

test("Suggest produces phase-specific targets (early vs scale differ)", async () => {
  const { srv, c } = await adminWithDepts();
  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "early", industry: "general" });
  await c.post("/philosophy/targets/suggest", {});
  const early = engTarget(srv.db);

  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "scale", industry: "general" });
  await c.post("/philosophy/targets/suggest", {});
  const scale = engTarget(srv.db);

  assert.ok(early > scale, `Engineering target should be higher early (${early}) than at scale (${scale})`);
  await srv.close();
});

test("Philosophy page renders the industry dropdown", async () => {
  const { srv, c } = await adminWithDepts();
  const pageHtml = await (await c.get("/philosophy")).text();
  assert.match(pageHtml, /<select name="industry">/);
  assert.match(pageHtml, /B2B SaaS/);
  assert.match(pageHtml, /Other \/ General/);
  await srv.close();
});

test("admin-assigned categories make custom-named departments weight correctly", async () => {
  const srv = await startTestServer();
  const c = makeClient(srv.base);
  await c.get("/setup");
  await c.post("/setup", { name: "Ada", email: "a@b.co", password: "supersecret123" });
  await c.post("/departments", { name: "Studio" });  // wouldn't auto-classify
  await c.post("/departments", { name: "Atlas" });    // wouldn't auto-classify
  const studio = srv.db.prepare("SELECT id FROM departments WHERE name='Studio'").get().id;
  const atlas = srv.db.prepare("SELECT id FROM departments WHERE name='Atlas'").get().id;
  await c.post("/departments/categories", { [`cat_${studio}`]: "rnd", [`cat_${atlas}`]: "ga" });
  assert.equal(srv.db.prepare("SELECT function_category AS f FROM departments WHERE id=?").get(studio).f, "rnd");

  await c.post("/philosophy", { seat_mode: "seat", backfill_policy: "auto", company_phase: "mid", industry: "general" });
  await c.post("/philosophy/targets/suggest", {});
  const sTarget = srv.db.prepare("SELECT target_pct AS p FROM target_ratios WHERE key='Studio'").get().p;
  const aTarget = srv.db.prepare("SELECT target_pct AS p FROM target_ratios WHERE key='Atlas'").get().p;
  assert.ok(sTarget > aTarget, `R&D Studio (${sTarget}) should outweigh G&A Atlas (${aTarget})`);
  assert.ok(sTarget > 40, "Studio gets a real share, not the catch-all ~2%");

  const page = await (await c.get("/departments")).text();
  assert.match(page, /Function/);
  assert.match(page, /Auto \(by name\)/);
  await srv.close();
});
