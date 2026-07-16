/** The "P&L" tab: model a plan's benefit vs cost per department, and quota attainment.
 *  Levers (benefit per head, ramp months, quota) are stored in the plan's assumptions. */
import { requirePermission } from "../middleware.js";
import { canViewBudgets, canSetBudgets } from "../authz.js";
import { listPlans, getPlan, planHires, planOverrides, planAssumptions, setPlanAssumptions } from "../repos/plans.js";
import { applyPlanOverrides, buildHeadcountModel } from "../domain/model.js";
import { computePnl, benefitConfig } from "../domain/pnl.js";
import { listEmployees } from "../repos/roster.js";
import { getSettings } from "../repos/settings.js";
import { logAudit } from "../repos/audit.js";
import { pnlPage } from "../views/pnl.js";

export function registerPnlRoutes(router) {
  // Build the model + P&L for a plan (all departments; the P&L is where you set levers,
  // so it isn't narrowed by the workspace focus lock).
  const buildForPlan = (ctx, plan) => {
    const employees = applyPlanOverrides(listEmployees(ctx.db, {}), plan ? planOverrides(plan) : {});
    const hires = plan ? planHires(plan) : [];
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const assumptions = plan ? planAssumptions(plan) : {};
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: hires, assumptions });
    const config = benefitConfig(assumptions);
    return { model, config, pnl: computePnl(model, config) };
  };

  const emptyPnl = { departments: [], perDept: [], total: {}, quota: {}, cols: [] };

  router.get("/model/pnl", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    ctx.pnlCanEdit = canSetBudgets(ctx.user);
    const plans = listPlans(ctx.db);
    const versionId = Number(ctx.query.get("version")) || (plans[0] ? plans[0].id : null);
    const plan = versionId ? getPlan(ctx.db, versionId) : null;
    if (!plan) return ctx.html(200, pnlPage(ctx, { plan: null, plans, pnl: emptyPnl, config: benefitConfig({}) }));
    const { config, pnl } = buildForPlan(ctx, plan);
    ctx.html(200, pnlPage(ctx, { plan, plans, pnl, config }));
  });

  router.post("/model/pnl/:id", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model/pnl");
    const { model } = buildForPlan(ctx, plan);
    const a = planAssumptions(plan);
    const byDept = {};
    for (const d of model.departments) {
      const ph = Math.max(0, Number(ctx.body[`perhead_${d}`]) || 0);
      const rm = Number(ctx.body[`ramp_${d}`]) || 0;
      if (ph > 0 || rm > 0) byDept[d] = { perHead: ph, rampMonths: Math.max(1, Math.min(120, Math.round(rm || 1))) };
    }
    const rawQ = ctx.body.quota_dept;
    const depts = rawQ == null ? [] : (Array.isArray(rawQ) ? rawQ : [rawQ]);
    a.benefit = {
      byDept,
      quota: { amount: Math.max(0, Number(ctx.body.quota_amount) || 0), departments: depts.map(String) },
    };
    setPlanAssumptions(ctx.db, plan.id, a);
    logAudit(ctx.db, { userId: ctx.user.id, action: "plan.pnl_levers", entity: "plan_version", entityId: plan.id });
    ctx.redirect(`/model/pnl?version=${plan.id}&msg=Saved`);
  });
}
