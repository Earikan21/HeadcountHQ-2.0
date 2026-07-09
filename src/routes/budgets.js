import { html, raw } from "../html.js";
import { renderPage, csrfField, money, moneyShort } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canSetBudgets, canViewBudgets } from "../authz.js";
import {
  allReconciliation, getCompanyBudget,
  setCompanyHeadcount, setCompanyMoney, setEnvelopeHeadcount, setEnvelopeMoney,
} from "../repos/budgets.js";
import { expectedRange } from "../domain/budget.js";
import { listDepartments } from "../repos/departments.js";
import { getSettings } from "../repos/settings.js";
import { financialModelPage } from "../views/model.js";
import { buildHeadcountModel, applyPlanOverrides, periodBuckets, periodize, yearGroupsOf, modelKpis, windowKey } from "../domain/model.js";
import { alignedWindow, comparePlans } from "../domain/compare.js";
import { comparePage } from "../views/compare.js";
import { listEmployees } from "../repos/roster.js";
import { clientFromConfig, parseScenarioHires } from "../domain/assistant.js";
import { departmentPayStats } from "../domain/metrics.js";
import { logAudit } from "../repos/audit.js";
import { listPlans, getPlan, createPlan, duplicatePlan, renamePlan, planHires, setPlanHires, deletePlan, planAssumptions, setPlanAssumptions, planOverrides, setPlanOverrides, nextHireId } from "../repos/plans.js";
import { parseCellEdit, applyCellEdit } from "../domain/plan_edit.js";

/** Money a department's headcount budget implies: current cost + midpoint of the
 *  expected cost of its still-unfilled budgeted positions. Idempotent. */
function impliedMoneyForDept(r) {
  const unfilled = Math.max(0, r.effHeadcount - r.currentEmployees);
  const range = expectedRange(unfilled, r.costBand);
  const mid = range ? Math.round((range.low + range.high) / 2) : 0;
  return Math.round((r.currentCost || 0) + mid);
}

export function registerBudgetRoutes(router) {
  // Live, in-app spreadsheet financial model with named plan versions (item 11).
  const renderModel = (ctx, versionId = null, extra = {}) => {
    const plans = listPlans(ctx.db);
    const current = versionId ? getPlan(ctx.db, versionId) : null;
    const hires = planHires(current);
    const overrides = current ? planOverrides(current) : {};
    // Overrides are plan-local: `listEmployees` is never written to from here.
    const allEmployees = applyPlanOverrides(listEmployees(ctx.db, {}), overrides);
    const allDepartments = [...new Set(allEmployees.map((e) => e.department_name || "(none)"))].sort();
    const dept = ctx.query.get("dept") || null;
    const employees = dept ? allEmployees.filter((e) => (e.department_name || "(none)") === dept) : allEmployees;
    const scopedHires = dept ? hires.filter((h) => h.department === dept) : hires;
    const assumptions = current ? planAssumptions(current) : {};
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: scopedHires, assumptions });
    ctx.html(200, financialModelPage(ctx, model, {
      period: ctx.query.get("period"), plans, current, hires, dept, allDepartments, assumptions,
      canEdit: canSetBudgets(ctx.user),
      // The sheet is editable only inside a plan, and only for someone who may edit it.
      editable: Boolean(current) && canSetBudgets(ctx.user),
      aiReady: Boolean(ctx.config.aiImportConfigured), ...extra,
    }));
  };
  /** Back to the sheet, preserving the department scope + period the user was in. */
  const backToModel = (ctx, planId) => {
    const dept = String(ctx.body.dept || "").trim();
    const period = String(ctx.body.period || "").trim();
    return `/model?version=${planId}` +
      (dept ? "&dept=" + encodeURIComponent(dept) : "") +
      (["month", "quarter", "year"].includes(period) ? "&period=" + period : "");
  };

  /**
   * Rebuild the model after an edit and slice out just what changed: the edited row,
   * its department subtotal, the grand total, the KPI strip, and the annual summary.
   * Values arrive pre-formatted so the browser never has to know how to price anyone.
   */
  const recompute = (ctx, plan, key) => {
    const overrides = planOverrides(plan);
    const hires = planHires(plan);
    const dept = String(ctx.body.dept || "").trim() || null;
    const period = ["month", "quarter", "year"].includes(String(ctx.body.period)) ? String(ctx.body.period) : "month";

    const all = applyPlanOverrides(listEmployees(ctx.db, {}), overrides);
    const employees = dept ? all.filter((e) => (e.department_name || "(none)") === dept) : all;
    const scopedHires = dept ? hires.filter((h) => h.department === dept) : hires;
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: scopedHires, assumptions: planAssumptions(plan) });

    const buckets = periodBuckets(model.cols, period);
    const groups = yearGroupsOf(model.cols, buckets);
    const series = (monthly) => {
      const per = periodize(monthly, buckets, "sum");
      const yearTotals = {};
      for (const g of groups) if (g.pos.length > 1) {
        const t = g.pos.reduce((a, i) => a + per[i], 0);
        yearTotals[g.year] = { v: Math.round(t), t: t ? moneyShort(t) : "" };
      }
      return { cells: per.map((v) => ({ v: Math.round(v), t: v ? moneyShort(v) : "" })), yearTotals };
    };

    const rowOf = (r) => (key.startsWith("hire:") ? r.hireId === key.slice(5) : r.extId === key.slice(4));
    const row = model.roster.find(rowOf) || null;
    const k = modelKpis(model, new Date());
    const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
    const pctChg = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);

    return {
      row: row ? {
        ...series(row.monthlyCost),
        loaded: n0(row.loadedMonthly),
        base: n0(row.annualBase),
        starts: row.hireMonthLabel === "From start" ? "—" : row.hireMonthLabel,
        gone: row.endDate ? String(row.endDate).slice(0, 7) : "",
      } : null,
      dept: row ? { name: row.department, ...series(model.deptMonthlyCost[row.department] || []) } : null,
      total: series(model.totalMonthlyCost),
      kpis: {
        headcount: n0(k.curHc), spend: money(k.thisYearCost), next12: money(k.next12Cost),
        netnew: `${k.netNew >= 0 ? "+" : ""}${n0(k.netNew)}`, avghead: money(k.avgHead), depts: n0(k.deptCount),
      },
      // Keyed by year and fingerprinted: if the edit moved the window, the client
      // reloads rather than patching numbers into cells that no longer mean the same thing.
      windowKey: windowKey(model, period),
      summary: Object.fromEntries(model.years.map((y, i) => {
        const prev = i > 0 ? model.years[i - 1] : null;
        const comparable = prev && prev.months === 12 && y.months === 12;
        const yoy = comparable ? pctChg(y.totalCost, prev.totalCost) : null;
        return [String(y.year), [
          n0(y.yearEndHc), money(y.totalCost), n0(y.avgHc), money(y.avgCostPerHead),
          yoy == null ? "—" : (yoy > 0 ? "+" : "") + yoy + "%",
        ]];
      })),
    };
  };

  const currentVersionId = (ctx) => {
    const v = Number(ctx.query.get("version")) || null;
    return v && getPlan(ctx.db, v) ? v : null;
  };

  router.get("/model", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    renderModel(ctx, currentVersionId(ctx));
  });

  // Create a new named plan version.
  router.post("/model/versions", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = createPlan(ctx.db, ctx.body.name || "New plan");
    logAudit(ctx.db, { userId: ctx.user.id, action: "plan.created", entity: "plan_version", entityId: plan.id, detail: { name: plan.name } });
    ctx.redirect(`/model?version=${plan.id}`);
  });

  // Rename a plan.
  router.post("/model/versions/:id/rename", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const clean = renamePlan(ctx.db, plan.id, ctx.body.name);
    logAudit(ctx.db, { userId: ctx.user.id, action: "plan.renamed", entity: "plan_version", entityId: plan.id, detail: { from: plan.name, to: clean } });
    ctx.redirect(backToModel(ctx, plan.id));
  });

  // Copy a plan whole — hires, assumptions and per-employee overrides.
  router.post("/model/versions/:id/duplicate", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const copy = duplicatePlan(ctx.db, plan);
    logAudit(ctx.db, { userId: ctx.user.id, action: "plan.duplicated", entity: "plan_version", entityId: copy.id, detail: { from: plan.id, name: copy.name } });
    ctx.redirect(`/model?version=${copy.id}`);
  });

  /**
   * Compare any two versions of the future, Actual included. Both sides are built over
   * one aligned window — otherwise a 10-year plan and a 3-year plan wouldn't be
   * describing the same years, and the deltas would be quietly meaningless.
   */
  router.get("/model/compare", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const plans = listPlans(ctx.db);
    const roster = listEmployees(ctx.db, {});
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;

    /** "actual" or a plan id -> everything needed to build that side. */
    const sideOf = (raw) => {
      const plan = raw === "actual" ? null : plans.find((p) => String(p.id) === String(raw));
      return {
        id: plan ? String(plan.id) : "actual",
        label: plan ? plan.name : "Actual",
        employees: roster, hires: planHires(plan),
        overrides: plan ? planOverrides(plan) : {},
        assumptions: plan ? planAssumptions(plan) : {},
      };
    };
    const aSpec = sideOf(ctx.query.get("a") || "actual");
    const bSpec = sideOf(ctx.query.get("b") || (plans[0] ? String(plans[0].id) : "actual"));

    const win = alignedWindow([aSpec, bSpec], new Date());
    const build = (spec) => ({
      label: spec.label,
      model: buildHeadcountModel({
        employees: applyPlanOverrides(spec.employees, spec.overrides),
        loadedMultiplier: mult, scenarioHires: spec.hires, assumptions: spec.assumptions,
        start: win.start, months: win.months,
      }),
    });

    const diff = comparePlans(build(aSpec), build(bSpec));
    ctx.html(200, comparePage(ctx, { diff, plans, a: aSpec.id, b: bSpec.id }));
  });

  router.post("/model/versions/:id/delete", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    deletePlan(ctx.db, Number(ctx.params.id));
    ctx.redirect("/model");
  });

  // Add a planned hire to a version (manual form).
  router.post("/model/versions/:id/hire", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const b = ctx.body;
    if (String(b.scn_department || "").trim() && Number(b.scn_salary) > 0) {
      const hires = planHires(plan);
      // One record per person, each individually nameable and editable on the sheet.
      const count = Math.max(1, Math.min(200, Number(b.scn_count) || 1));
      const role = String(b.scn_role || "Hire").trim() || "Hire";
      for (let i = 0; i < count; i++) {
        hires.push({
          id: nextHireId(hires), department: String(b.scn_department).trim(), role,
          name: count > 1 ? `${role} ${i + 1}` : role,
          start_month: /^\d{4}-\d{2}$/.test(String(b.scn_start || "")) ? b.scn_start : null,
          end_month: /^\d{4}-\d{2}$/.test(String(b.scn_end || "")) ? b.scn_end : null,
          annual_salary: Number(b.scn_salary) || 0,
        });
      }
      setPlanHires(ctx.db, plan.id, hires);
    }
    ctx.redirect(`/model?version=${plan.id}`);
  });

  // Delete by stable id: array positions shift under concurrent edits.
  router.post("/model/versions/:id/hire/:hid/delete", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const hires = planHires(plan);
    const hid = String(ctx.params.hid);
    const next = hires.filter((h) => String(h.id) !== hid);
    if (next.length !== hires.length) setPlanHires(ctx.db, plan.id, next);
    ctx.redirect(backToModel(ctx, plan.id));
  });

  /**
   * Autosave one cell of the plan sheet. Persists, then recomputes the model
   * server-side and returns the affected numbers already formatted — the cost engine
   * is never reimplemented in the browser.
   */
  router.post("/model/versions/:id/cell", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.json(404, { ok: false, error: "That plan no longer exists — reload." });

    const edit = parseCellEdit(ctx.body);
    if (edit.error) return ctx.json(400, { ok: false, error: edit.error, field: ctx.body.field });

    const roster = listEmployees(ctx.db, {});
    const res = applyCellEdit({ edit, roster, hires: planHires(plan), overrides: planOverrides(plan) });
    if (res.error) return ctx.json(400, { ok: false, error: res.error, field: edit.field });

    if (res.hires) setPlanHires(ctx.db, plan.id, res.hires);
    if (res.overrides) setPlanOverrides(ctx.db, plan.id, res.overrides);
    logAudit(ctx.db, { userId: ctx.user.id, action: "plan.cell_edited", entity: "plan_version", entityId: plan.id, detail: { key: edit.key, field: edit.field } });

    const fresh = getPlan(ctx.db, plan.id);
    return ctx.json(200, { ok: true, value: res.value, overridden: res.overridden, marks: res.marks, ...recompute(ctx, fresh, edit.key) });
  });

  // Duplicate a scenario hire (copy inserted right after it).
  router.post("/model/versions/:id/hire/:hid/duplicate", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const hires = planHires(plan);
    const idx = hires.findIndex((h) => String(h.id) === String(ctx.params.hid));
    if (idx >= 0) {
      const src = hires[idx];
      hires.splice(idx + 1, 0, { ...src, id: nextHireId(hires), name: (src.name || src.role || "Hire") + " (copy)" });
      setPlanHires(ctx.db, plan.id, hires);
    }
    ctx.redirect(backToModel(ctx, plan.id));
  });

  // Duplicate a real person as a NEW scenario headcount (a copy of the role, starting now).
  router.post("/model/versions/:id/emp/:extId/duplicate", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const emp = applyPlanOverrides(listEmployees(ctx.db, {}), planOverrides(plan)).find((e) => String(e.employee_ext_id) === String(ctx.params.extId));
    if (emp) {
      const hires = planHires(plan);
      const now = new Date();
      hires.push({
        id: nextHireId(hires), department: emp.department_name || "(none)", role: emp.job_title || "Role",
        name: (emp.name || emp.job_title || "New hire") + " (copy)",
        start_month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`, end_month: null,
        annual_salary: Number(emp.annual_salary) || 0,
      });
      setPlanHires(ctx.db, plan.id, hires);
    }
    ctx.redirect(backToModel(ctx, plan.id));
  });

  /** Clear a row: drop the employee's overrides, or remove the scenario hire outright. */
  router.post("/model/versions/:id/row/reset", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const key = String(ctx.body.key || "");
    if (key.startsWith("hire:")) {
      const hid = key.slice(5);
      setPlanHires(ctx.db, plan.id, planHires(plan).filter((h) => String(h.id) !== hid));
    } else if (key.startsWith("emp:")) {
      const o = planOverrides(plan);
      delete o[key.slice(4)];
      setPlanOverrides(ctx.db, plan.id, o);
    }
    ctx.redirect(backToModel(ctx, plan.id));
  });

  // Save a plan's assumptions / drivers (YoY salary growth, benefits load override).
  router.post("/model/versions/:id/assumptions", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const a = planAssumptions(plan);
    const dept = String(ctx.body.dept || "").trim();
    const fields = {
      salaryGrowthPct: Math.max(0, Math.min(100, Number(ctx.body.salary_growth) || 0)),
      loadedMultiplier: (() => {
        const lp = String(ctx.body.loaded_pct == null ? "" : ctx.body.loaded_pct).trim();
        if (lp === "") return null;                       // inherit the default
        const n = Number(lp);
        return Number.isFinite(n) && n >= 0 ? Math.round((1 + Math.min(200, n) / 100) * 10000) / 10000 : null;
      })(),
      bonusPct: Math.max(0, Math.min(100, Number(ctx.body.bonus_pct) || 0)),
      hiringSlipMonths: Math.max(0, Math.min(24, Number(ctx.body.hiring_slip) || 0)),
      costPerHire: Math.max(0, Number(ctx.body.cost_per_hire) || 0),
    };
    const isDefault = fields.salaryGrowthPct === 0 && fields.loadedMultiplier == null && fields.bonusPct === 0 && fields.hiringSlipMonths === 0 && fields.costPerHire === 0;
    if (dept) { a.byDept = a.byDept || {}; if (isDefault) delete a.byDept[dept]; else a.byDept[dept] = fields; }
    else { Object.assign(a, fields); }
    // Model length (1-10 years) is plan-wide, never per-department.
    if (ctx.body.horizon_years != null && String(ctx.body.horizon_years) !== "")
      a.horizonYears = clampHorizon(ctx.body.horizon_years);
    setPlanAssumptions(ctx.db, plan.id, a);
    ctx.redirect(`/model?version=${plan.id}${dept ? "&dept=" + encodeURIComponent(dept) : ""}`);
  });

  // Model length (1-10 years). Its own endpoint so submitting it never rewrites the
  // assumption fields (an empty assumptions form would otherwise zero them out).
  router.post("/model/versions/:id/horizon", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const a = planAssumptions(plan);
    a.horizonYears = clampHorizon(ctx.body.horizon_years);
    setPlanAssumptions(ctx.db, plan.id, a);
    const dept = String(ctx.body.dept || "").trim();
    ctx.redirect(`/model?version=${plan.id}${dept ? "&dept=" + encodeURIComponent(dept) : ""}`);
  });

  // Add planned hires to a version from a plain-English description (AI).
  router.post("/model/versions/:id/ai", async (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const plan = getPlan(ctx.db, Number(ctx.params.id));
    if (!plan) return ctx.redirect("/model");
    const description = String(ctx.body.description || "").trim();
    if (!description || !ctx.config.aiImportConfigured) {
      return renderModel(ctx, plan.id, { aiError: description ? "Configure a provider key to use AI." : null });
    }
    try {
      const client = clientFromConfig(ctx.config);
      // Real per-department pay, so "pay them the department average" resolves to an
      // actual figure rather than a number the model invents.
      const payStats = departmentPayStats(listEmployees(ctx.db, {}));
      const parsed = await parseScenarioHires({ description, departments: listDepartments(ctx.db).map((d) => d.name), payStats, client });
      // Data validation before instating: if the AI couldn't pin down the essentials,
      // ask for them rather than inventing a hire.
      if (!parsed.length) {
        return renderModel(ctx, plan.id, { aiAsk: `I need a little more before I can add that: which department, how many, a start month, and a salary (a number, or say "the department average"). You wrote: “${description.slice(0, 140)}”. Can you fill in what's missing?` });
      }
      const problems = [];
      for (const h of parsed) {
        if (!h.department || h.department === "(scenario)") problems.push("which department the " + (h.role || "hire") + " is in");
        if (!(Number(h.annual_salary) > 0)) problems.push("a salary for the " + (h.role || "hire"));
        if (Number(h.annual_salary) > 50_000_000) problems.push("a realistic salary for the " + (h.role || "hire") + " (that one looks like a typo)");
        if (h.start_month && !/^\d{4}-\d{2}$/.test(String(h.start_month))) problems.push("a valid start month (YYYY-MM) for the " + (h.role || "hire"));
      }
      if (problems.length) {
        return renderModel(ctx, plan.id, { aiAsk: "Before I add that, I need " + [...new Set(problems)].join(", and ") + ". Add those details and try again." });
      }
      // The model returns {department, role, count, ...}; explode into individually
      // editable records so AI-added hires behave exactly like hand-added ones.
      const hires = planHires(plan);
      for (const h of parsed) {
        const count = Math.max(1, Math.min(200, Number(h.count) || 1));
        const role = String(h.role || "Hire").trim() || "Hire";
        for (let i = 0; i < count; i++) {
          hires.push({
            id: nextHireId(hires), department: h.department || "(scenario)", role,
            name: count > 1 ? `${role} ${i + 1}` : role,
            start_month: h.start_month || null, end_month: h.end_month || null,
            annual_salary: Number(h.annual_salary) || 0,
          });
        }
      }
      setPlanHires(ctx.db, plan.id, hires);
      ctx.redirect(`/model?version=${plan.id}`);
    } catch (e) {
      const reason = (e && e.message ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 220);
      console.error(`[model] ai plan failed: ${reason}`);
      renderModel(ctx, plan.id, { aiError: "The AI couldn't model that — " + reason + " (check the provider key/model on the server)." });
    }
  });

  router.get("/budgets", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const mode = ctx.query.get("mode") === "money" ? "money" : "headcount";
    ctx.html(200, page(ctx, mode));
  });
  router.post("/budgets", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const mode = ctx.body.mode === "money" ? "money" : "headcount";
    const depts = listDepartments(ctx.db);
    if (mode === "money") {
      setCompanyMoney(ctx.db, ctx.body.company_money, ctx.user.id);
      for (const d of depts) if (ctx.body[`money_${d.id}`] !== undefined) setEnvelopeMoney(ctx.db, d.id, ctx.body[`money_${d.id}`], ctx.user.id);
    } else {
      setCompanyHeadcount(ctx.db, ctx.body.company_headcount, ctx.user.id);
      for (const d of depts) if (ctx.body[`hc_${d.id}`] !== undefined) setEnvelopeHeadcount(ctx.db, d.id, ctx.body[`hc_${d.id}`], ctx.user.id);
    }
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.updated", entity: "budget_envelope", detail: { mode } });
    ctx.redirect(`/budgets?mode=${mode}&msg=Saved`);
  });

  // Fill every department's money budget from what its headcount budget implies.
  router.post("/budgets/fill-from-headcount", (ctx) => {
    if (!requirePermission(ctx, canSetBudgets)) return;
    const { rows } = allReconciliation(ctx.db);
    let applied = 0;
    for (const r of rows) { setEnvelopeMoney(ctx.db, r.id, impliedMoneyForDept(r), ctx.user.id); applied++; }
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.filled_from_headcount", entity: "budget_envelope", detail: { departments: applied } });
    ctx.redirect(`/budgets?mode=money&msg=Money+budgets+set+from+the+headcount+budget`);
  });

  // Export the financial model as CSV using live spreadsheet FORMULAS (item 5):
  // loaded monthly derives from annual base, month cells reference it, and every
  // total is a =SUM(), so editing a salary in Excel/Sheets recomputes the model.
  router.get("/budgets/export.csv", (ctx) => {
    if (!requirePermission(ctx, canViewBudgets)) return;
    const versionId = currentVersionId(ctx);
    const current = versionId ? getPlan(ctx.db, versionId) : null;
    const hires = planHires(current);
    const allEmployees = applyPlanOverrides(listEmployees(ctx.db, {}), current ? planOverrides(current) : {});
    const dept = ctx.query.get("dept") || null;
    const employees = dept ? allEmployees.filter((e) => (e.department_name || "(none)") === dept) : allEmployees;
    const scopedHires = dept ? hires.filter((h) => h.department === dept) : hires;
    const assumptions = current ? planAssumptions(current) : {};
    const mult = Number(getSettings(ctx.db).loaded_cost_multiplier) || 1.2;
    const model = buildHeadcountModel({ employees, loadedMultiplier: mult, scenarioHires: scopedHires, assumptions });
    logAudit(ctx.db, { userId: ctx.user.id, action: "budgets.exported", entity: "plan_version", detail: { rows: model.roster.length, version: versionId, dept } });
    ctx.attachment("financial-model.csv", "text/csv; charset=utf-8", modelToFormulaCsv(model));
  });
}

/** Model length in years: clamp into 1..10; only a missing/blank value defaults to 5. */
function clampHorizon(v) {
  if (v == null || String(v).trim() === "") return 5;
  const n = Number(v);
  return Math.max(1, Math.min(10, Math.round(Number.isFinite(n) ? n : 5)));
}

/** A1 column letter for a 0-based column index (0 -> A, 26 -> AA). */
export function colLetter(n) { let s = ""; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
/** CSV-escape. Formulas below contain no comma/quote, so they pass through unquoted
 *  and Excel/Sheets parse them as formulas rather than text. */
function csvCell(v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
/**
 * The model as a *live* spreadsheet: annual base is the only hardcoded number per
 * person. Loaded monthly is `=D<row>/12*<load>`, each active month references it,
 * and every total is a `=SUM(...)` over the person rows.
 */
export function modelToFormulaCsv(model) {
  const { cols, roster } = model;
  // Every driver that feeds the model, not just the fully-loaded output.
  const fixed = ["Department", "Name", "Role", "Status", "Start", "End",
    "Annual Base", "Load %", "Bonus %", "Salary Growth %", "Cost per Hire", "Loaded Monthly"];
  const header = fixed.concat(cols.map((c) => c.fullLabel));
  const lines = [header.map(csvCell).join(",")];
  const first = 2;                 // row 1 is the header
  const MONTH0 = fixed.length;     // 0-based column index of the first month
  roster.forEach((r, i) => {
    const row = first + i;
    // Loaded monthly stays live: recomputes from base, load and bonus cells.
    const loaded = "=G" + row + "/12*(1+H" + row + "/100)*(1+I" + row + "/100)";
    const months = r.monthlyCost.map((v) => Math.round(v)); // includes proration, growth & one-time cost
    lines.push([
      csvCell(r.department), csvCell(r.name || ""), csvCell(r.role || ""), csvCell(r.status || ""),
      csvCell(r.startDate || ""), csvCell(r.endDate || ""),
      Math.round(r.annualBase), r.loadPct, r.bonusPct, r.growthPct, Math.round(r.costPerHire), loaded,
    ].concat(months).join(","));
  });
  const last = first + roster.length - 1;
  const sum = (L) => (roster.length ? "=SUM(" + L + first + ":" + L + last + ")" : "0");
  const totals = ["TOTAL", "", "", "", "", "", sum("G"), "", "", "", sum("K"), sum("L")]
    .concat(cols.map((c, j) => sum(colLetter(MONTH0 + j))));
  lines.push(totals.map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}


const bar = (used, budget, over) => {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  return raw(`<div class="ubar"><i class="${over ? "over" : pct >= 90 ? "warn" : "ok"}" style="width:${pct}%"></i></div>`);
};
function allocNote(a, kind) {
  if (!a.cap) return html`<span class="muted">set a company budget first</span>`;
  if (a.over > 0) return html`<span class="over-txt">over by ${kind === "money" ? money(a.over) : a.over}</span>`;
  return html`<span class="ok-txt">${kind === "money" ? money(a.remaining) : a.remaining} left</span>`;
}
function tabs(mode) {
  const tab = (m, label) => `<a class="wtab ${m === mode ? "on" : ""}" href="/budgets?mode=${m}">${label}</a>`;
  return raw(`<div class="wtabs">${tab("headcount", "Headcount budget")}${tab("money", "Money budget")}</div>`);
}
function expectedText(addHeads, band) {
  const r = expectedRange(addHeads, band);
  return r ? `+ expected ${moneyShort(r.low)}–${moneyShort(r.high)}` : "";
}

function page(ctx, mode) {
  const editable = canSetBudgets(ctx.user);
  const settings = getSettings(ctx.db);
  const cap = getCompanyBudget(ctx.db);
  const { rows, allocation, company, currentEmployees } = allReconciliation(ctx.db);
  const noDepts = rows.length === 0;

  const head = html`
    <div class="pagehead"><h1>Budgets</h1>
      <p class="muted">Top-down: set one company budget, then allocate it across departments — one number at a time. Current headcount and its cost already count toward what's allocated. Enforcement is <b>${settings.budget_enforcement}</b>.${editable ? raw(' (<a href="/philosophy">change</a>)') : ""}</p>
    </div>
    ${tabs(mode)}
    <p style="margin:8px 0 0"><a class="btn ghost sm" href="/budgets/export.csv">Export financial model (CSV)</a> <span class="muted small">Opens in Excel or Google Sheets.</span></p>`;

  let body;
  if (mode === "headcount") {
    const a = allocation.headcount;
    const deptRows = noDepts ? raw('<tr><td colspan="5" class="muted">No departments yet.</td></tr>')
      : rows.map((r) => {
          const band = r.costBand;
          const add = Math.max(0, r.effHeadcount - r.currentEmployees);
          return html`<tr>
            <td><b>${r.name}</b></td>
            <td class="right">${r.currentEmployees}</td>
            <td class="right">${r.positions.approved}${r.positions.pending ? html` <span class="muted">+${r.positions.pending}</span>` : ""}</td>
            <td>
              <input class="tcell" type="number" min="${r.currentEmployees}" step="1" name="hc_${r.id}" value="${r.effHeadcount}"
                     data-current="${r.currentEmployees}" data-band-low="${band?.low || 0}" data-band-high="${band?.high || 0}" data-expected-target="exp_${r.id}" ${editable ? "" : "readonly"}>
              <div class="exp ${add > 0 ? "on" : ""}" id="exp_${r.id}">${expectedText(add, band)}</div>
            </td>
            <td>${bar(r.positions.approved, r.effHeadcount, r.positions.over > 0)}</td>
          </tr>`;
        });
    body = html`${head}
      <form method="post" action="/budgets">
        ${csrfField(ctx)}<input type="hidden" name="mode" value="headcount">
        <section class="card">
          <h2>Company headcount budget</h2>
          <label>Total positions, company-wide<input type="number" min="0" step="1" name="company_headcount" value="${cap.headcount}" style="max-width:200px" ${editable ? "" : "readonly"}></label>
        </section>
        <div class="kpis">
          <div class="kpi"><div class="lbl">Current employees</div><div class="val">${currentEmployees}</div></div>
          <div class="kpi"><div class="lbl">Approved positions</div><div class="val">${company.positions.approved}</div></div>
          <div class="kpi"><div class="lbl">Allocated / cap</div><div class="val ${a.over ? "bad" : ""}">${a.allocated} / ${cap.headcount}</div><div class="lbl">${allocNote(a, "hc")}</div></div>
        </div>
        <section class="card">
          <h2>Allocate positions to departments</h2>
          <p class="muted small">Allocations start at each team's current headcount. Adding positions shows the expected money impact from that team's salary band.</p>
          <table class="table">
            <thead><tr><th>Department</th><th class="right">Current</th><th class="right">Approved</th><th>Allocated &amp; cost impact</th><th>Fill</th></tr></thead>
            <tbody>${deptRows}</tbody>
          </table>
          ${noDepts ? html`<p class="muted">Add departments first.</p>` : editable ? html`<button class="btn" type="submit" style="margin-top:12px">Save headcount budget</button>` : ""}
        </section>
      </form>
      <script src="/static/budgets.js" defer></script>`;
  } else {
    const a = allocation.money;
    const deptRows = noDepts ? raw('<tr><td colspan="4" class="muted">No departments yet.</td></tr>')
      : rows.map((r) => {
          const unfilled = Math.max(0, r.effHeadcount - r.currentEmployees);
          const implied = expectedRange(unfilled, r.costBand);
          return html`<tr>
            <td><b>${r.name}</b></td>
            <td class="right">${money(r.money.committed)}${r.money.pending ? html` <span class="muted">+${money(r.money.pending)}</span>` : ""}</td>
            <td>
              <input class="tcell wide" type="number" min="0" step="any" name="money_${r.id}" value="${r.effMoney}" ${editable ? "" : "readonly"}>
              ${implied ? html`<div class="exp on">headcount budget implies +${moneyShort(implied.low)}–${moneyShort(implied.high)}</div>` : ""}
            </td>
            <td>${bar(r.money.committed, r.effMoney, r.money.over > 0)}</td>
          </tr>`;
        });
    body = html`${head}
      ${noDepts || !editable ? "" : html`<form method="post" action="/budgets/fill-from-headcount" class="inline" style="margin:0 0 14px">
        ${csrfField(ctx)}<button class="btn ghost" type="submit">↳ Fill money budgets from the headcount budget</button>
        <span class="muted small" style="margin-left:8px">Sets each department's money budget to cover its budgeted positions (current cost + the implied cost of unfilled ones).</span>
      </form>`}
      <form method="post" action="/budgets">
        ${csrfField(ctx)}<input type="hidden" name="mode" value="money">
        <section class="card">
          <h2>Company money budget</h2>
          <label>Total annual, fully-loaded, company-wide<input type="number" min="0" step="any" name="company_money" value="${cap.money}" style="max-width:240px" ${editable ? "" : "readonly"}></label>
        </section>
        <div class="kpis">
          <div class="kpi"><div class="lbl">Committed spend</div><div class="val">${money(company.money.committed)}</div></div>
          <div class="kpi"><div class="lbl">Allocated / cap</div><div class="val ${a.over ? "bad" : ""}">${money(a.allocated)} / ${money(cap.money)}</div><div class="lbl">${allocNote(a, "money")}</div></div>
        </div>
        <section class="card">
          <h2>Allocate money to departments</h2>
          <p class="muted small">Allocations start at each team's current committed cost. The hint shows what the headcount budget implies for still-unfilled positions — or use the button above to fill them all at once.</p>
          <table class="table">
            <thead><tr><th>Department</th><th class="right">Committed</th><th>Allocated</th><th>Spend</th></tr></thead>
            <tbody>${deptRows}</tbody>
          </table>
          ${noDepts ? html`<p class="muted">Add departments first.</p>` : editable ? html`<button class="btn" type="submit" style="margin-top:12px">Save money budget</button>` : ""}
        </section>
      </form>`;
  }
  return renderPage(ctx, { title: "Budgets", body, active: "budgets" });
}
