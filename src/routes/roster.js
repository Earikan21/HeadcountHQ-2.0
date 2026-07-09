import { html, raw, esc } from "../html.js";
import { renderPage, csrfField, errorList, money } from "../views/ui.js";
import { peoplePage } from "../views/people.js";
import { requireAuth, requirePermission } from "../middleware.js";
import { canImportRoster, compVisibility, canViewCompTotals, departmentScope } from "../authz.js";
import { detectHeaderRow, matrixToRows, toCsv } from "../domain/csv.js";
import { parseUpload } from "../domain/adapters.js";
import * as R from "../domain/roster.js";
import { logAudit } from "../repos/audit.js";
import {
  createBatch, getBatch, updateBatchMapping, updateBatchAssumptions, replaceBatchMatrix,
  setBatchHeaderRow, setBatchStatus, listBatches,
  upsertDepartmentByName, upsertEmployee, listEmployees, nextEmployeeId, getEmployeeByExtId,
} from "../repos/roster.js";
import { ensureSeatForEmployee, vacateSeat, fillSeat, getSeat, headcountRollup, listSeats } from "../repos/seats.js";
import { listDepartments, getDepartment, setDepartmentCategory } from "../repos/departments.js";
import { getSettings } from "../repos/settings.js";
import { loadedCost as loadedCostFn } from "../domain/philosophy.js";
import { flagAnomalies, distinctValues } from "../domain/import_ai.js";
import { clientFromConfig, suggestMapping, classifyDepartments, normalizeTitles, fullReadInterpret } from "../domain/ai_import.js";
import { recordImportRun } from "../repos/import_runs.js";
import { FUNCTION_CATEGORIES } from "../data/benchmarks.js";

/** Privacy-safe AI assist available (configured on the host AND toggled on)? */
const aiReady = (ctx) => Boolean(ctx.config.aiImportConfigured) && Boolean(getSettings(ctx.db).ai_import_enabled);
/** Full-read available (configured AND the toggle on — which it is by default)? */
const aiFullReady = (ctx) => Boolean(ctx.config.aiImportConfigured) && Boolean(getSettings(ctx.db).ai_full_read_enabled);

/**
 * Does an auto-detected mapping recognise the file as a roster table? We only need the
 * essentials — a name, a pay figure, and a department. If those can't be found, the
 * file is messy or non-tabular and full-read should interpret it. (Employee ID is
 * required at commit, but its absence isn't a sign of a messy file, so it doesn't
 * trigger full-read — the user maps it on the review step.)
 */
function mappingRecognisesTable(mapping) {
  if (!mapping) return false;
  const has = (k) => Boolean(mapping[k]);
  const named = has("name") || (has("first_name") && has("last_name"));
  return named && has("compensation_amount") && has("department");
}

/**
 * Send the whole file to the provider and rebuild a clean table. Shared by the upload
 * auto-trigger and the (kept) manual endpoint. Returns {ok} rather than throwing so
 * either caller can fall back to manual mapping.
 */
async function runFullRead(ctx, batch) {
  if (!batch || batch.status !== "draft" || !aiFullReady(ctx)) return { ok: false };
  try {
    const client = clientFromConfig(ctx.config);
    const res = await fullReadInterpret({ matrix: batch.matrix, client });
    replaceBatchMatrix(ctx.db, batch.id, res.matrix, res.mapping);
    recordImportRun(ctx.db, { batchId: batch.id, userId: ctx.user.id, phase: "mapping", usedAi: true, provider: ctx.config.AI_IMPORT_PROVIDER, suggestionCount: res.count });
    logAudit(ctx.db, { userId: ctx.user.id, action: "import.ai_fullread", entity: "import_batch", entityId: batch.id, detail: { people: res.count, truncated: res.truncated } });
    return { ok: true, count: res.count };
  } catch (e) {
    console.error(`[ai-import] fullread failed: ${e && e.message ? e.message : e}`);
    return { ok: false };
  }
}

const compCell = (user, annual) => {
  if (annual == null) return "—";
  return compVisibility(user) === "exact" ? money(annual) : (R.band(annual) || "—");
};

export function registerRosterRoutes(router) {
  // ---- Roster view (all signed-in users; scoped + comp-limited by role) ----
  router.get("/roster", (ctx) => {
    if (!requireAuth(ctx)) return;
    const scope = departmentScope(ctx.user);
    const employees = listEmployees(ctx.db, { departmentId: scope });
    const roll = headcountRollup(ctx.db, { departmentId: scope });
    const seats = listSeats(ctx.db, { departmentId: scope });
    ctx.html(200, peoplePage(ctx, { employees, roll, seats }));
  });

  router.get("/roster/export.csv", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const employees = listEmployees(ctx.db, {});
    const rows = employees.map((e) => ({
      employee_id: e.employee_ext_id, name: e.name, department: e.department_name,
      job_title: e.job_title, manager: e.manager, employee_type: e.employee_type,
      employment_status: e.employment_status, compensation_amount: e.comp_amount,
      compensation_unit: e.comp_unit, annual_salary: e.annual_salary,
    }));
    logAudit(ctx.db, { userId: ctx.user.id, action: "roster.exported", entity: "employee", detail: { count: rows.length } });
    ctx.attachment("roster-clean.csv", "text/csv; charset=utf-8", toCsv(R.EXPORT_COLS, rows));
  });


  // ---- Onboard a single person (no CSV re-import) ----
  router.get("/roster/new", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const seatId = ctx.query.get("seat");
    let seat = null;
    if (seatId) { seat = getSeat(ctx.db, Number(seatId)); if (!seat || seat.status !== "open") seat = null; }
    ctx.html(200, onboardPage(ctx, { form: {}, seat }));
  });

  router.post("/roster/new", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const f = ctx.body;
    const seatId = f.seat_id ? Number(f.seat_id) : null;
    const seat = seatId ? getSeat(ctx.db, seatId) : null;
    const errors = [];

    const name = (f.name || "").trim() || [f.first_name, f.last_name].map((x) => (x || "").trim()).filter(Boolean).join(" ");
    if (!name) errors.push("Name is required (full name, or first and last).");

    const departmentId = seat ? seat.department_id : (f.department_id ? Number(f.department_id) : null);
    if (!departmentId || !getDepartment(ctx.db, departmentId)) errors.push("Choose a department.");

    const amount = R.parseAmount(f.comp_amount);
    const unit = R.normUnit(f.comp_unit) || "annual";
    if (f.comp_amount == null || String(f.comp_amount).trim() === "") errors.push("Compensation is required.");
    else if (amount == null || amount <= 0) errors.push("Compensation must be a number greater than 0.");

    let extId = (f.employee_id || "").trim() || nextEmployeeId(ctx.db);
    if (f.employee_id && getEmployeeByExtId(ctx.db, extId)) errors.push(`Employee ID "${extId}" already exists.`);

    if (errors.length) return ctx.html(400, onboardPage(ctx, { form: f, seat, errors }));

    const annual = R.toAnnual(amount, unit, R.DEFAULT_ASSUMPTIONS);
    const status = R.normStatus(f.employment_status) || "active";
    const row = {
      employee_id: extId, name, job_title: (f.job_title || "").trim(),
      manager: (f.manager || "").trim(), employee_type: (f.employee_type || "").trim(),
      employment_status: status, compensation_amount: amount, compensation_unit: unit, annual_salary: annual,
    };
    const empId = upsertEmployee(ctx.db, row, departmentId);
    if (f.start_date) ctx.db.prepare("UPDATE employees SET start_date=? WHERE id=?").run(String(f.start_date), empId);

    const mult = getSettings(ctx.db).loaded_cost_multiplier;
    const loaded = loadedCostFn(annual, mult);
    if (seat) fillSeat(ctx.db, seat.id, empId, loaded);
    else ensureSeatForEmployee(ctx.db, { employeeId: empId, departmentId, title: row.job_title, loadedCost: loaded });

    logAudit(ctx.db, { userId: ctx.user.id, action: "person.onboarded", entity: "employee", entityId: empId, detail: { seatId: seat ? seat.id : null } });
    ctx.redirect(`/roster?msg=Onboarded+${encodeURIComponent(name)}`);
  });

  // ---- Duplicate a person/role (adds headcount; admin only) ----
  router.post("/roster/duplicate/:id", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const src = ctx.db.prepare(
      `SELECT e.*, c.annual_salary AS annual_salary FROM employees e
         LEFT JOIN compensation c ON c.employee_id = e.id WHERE e.id = ?`
    ).get(Number(ctx.params.id));
    if (!src) return ctx.redirect("/model");
    const extId = nextEmployeeId(ctx.db);
    const today = new Date().toISOString().slice(0, 10);
    const roleName = src.job_title || "position";
    const row = {
      employee_id: extId, name: "New " + roleName, job_title: src.job_title || "",
      manager: src.manager || "", employee_type: src.employee_type || "",
      employment_status: "active", compensation_amount: src.annual_salary, compensation_unit: "annual", annual_salary: src.annual_salary,
      start_date: today,
    };
    const empId = upsertEmployee(ctx.db, row, src.department_id);
    const mult = getSettings(ctx.db).loaded_cost_multiplier;
    ensureSeatForEmployee(ctx.db, { employeeId: empId, departmentId: src.department_id, title: src.job_title || "", loadedCost: loadedCostFn(src.annual_salary, mult) });
    logAudit(ctx.db, { userId: ctx.user.id, action: "position.duplicated", entity: "employee", entityId: empId, detail: { from: src.id } });
    ctx.redirect("/model?msg=Position+duplicated");
  });

  // ---- Remove headcount: give a person an end date (admin only) ----
  // Non-destructive: the person stays on the sheet and in history, but stops
  // contributing cost from `end_month` onward. Reversible via /roster/:id/restore.
  router.post("/roster/:id/end", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const id = Number(ctx.params.id);
    const src = ctx.db.prepare("SELECT id, name FROM employees WHERE id = ?").get(id);
    if (!src) return ctx.redirect("/model");
    const m = String(ctx.body.end_month || "");
    const now = new Date();
    // last day of the chosen month (default: this month)
    const [yy, mm] = /^\d{4}-\d{2}$/.test(m) ? m.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
    const endDate = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    ctx.db.prepare("UPDATE employees SET end_date = ?, updated_at = datetime('now') WHERE id = ?").run(endDate, id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "person.ended", entity: "employee", entityId: id, detail: { end_date: endDate } });
    ctx.redirect(ctx.body.back || "/model?msg=Headcount+removed+from+" + endDate.slice(0, 7));
  });

  router.post("/roster/:id/restore", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const id = Number(ctx.params.id);
    ctx.db.prepare("UPDATE employees SET end_date = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "person.restored", entity: "employee", entityId: id });
    ctx.redirect(ctx.body.back || "/model?msg=Headcount+restored");
  });

  // ---- Step 1: upload ----
  router.get("/roster/import", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    ctx.html(200, uploadPage(ctx, {}));
  });
  router.post("/roster/import", async (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const file = ctx.files.file;
    if (!file || !file.data || !file.data.length) {
      return ctx.html(400, uploadPage(ctx, { errors: ["Please choose an Excel (.xlsx) or CSV file to upload."] }));
    }
    const parsed = parseUpload(file.filename, file.data);
    if (parsed.error) return ctx.html(400, uploadPage(ctx, { errors: [parsed.error] }));
    const matrix = parsed.matrix;
    if (matrix.length < 2) {
      return ctx.html(400, uploadPage(ctx, { errors: ["That file has no readable rows. Check the sheet isn't empty, then try again."] }));
    }
    const headerRow = detectHeaderRow(matrix);
    const { headers } = matrixToRows(matrix, headerRow);
    const { mapping } = R.autoMap(headers);
    const batch = createBatch(ctx.db, { filename: file.filename, matrix, headerRow, mapping, createdBy: ctx.user.id });
    logAudit(ctx.db, { userId: ctx.user.id, action: "import.uploaded", entity: "import_batch", entityId: batch.id, detail: { filename: file.filename, rows: batch.row_count } });
    // Auto-run AI column mapping when AI is configured — no button needed.
    let effectiveMapping = mapping;
    let aiFlag = null;
    if (aiReady(ctx)) {
      try {
        const full = getBatch(ctx.db, batch.id);
        const client = clientFromConfig(ctx.config);
        const res = await suggestMapping({ headers: full.headers, rows: full.rawRows, client });
        updateBatchMapping(ctx.db, batch.id, res.mapping);
        recordImportRun(ctx.db, { batchId: batch.id, userId: ctx.user.id, phase: "mapping", usedAi: res.source === "ai", provider: ctx.config.AI_IMPORT_PROVIDER, suggestionCount: Object.values(res.mapping).filter(Boolean).length });
        effectiveMapping = res.mapping;
        aiFlag = res.source === "ai" ? 1 : 0;
      } catch (e) {
        console.error(`[ai-import] auto-map failed: ${e && e.message ? e.message : e}`);
      }
    }
    // Messy or non-tabular? Full-read runs automatically (it's on by default) and
    // rebuilds a clean table — no opt-in card, straight to review.
    if (!mappingRecognisesTable(effectiveMapping) && aiFullReady(ctx)) {
      const fr = await runFullRead(ctx, getBatch(ctx.db, batch.id));
      if (fr.ok) return ctx.redirect(`/roster/import/${batch.id}/review?fr=ok`);
      return ctx.redirect(`/roster/import/${batch.id}/map?fr=failed${aiFlag != null ? "&ai=" + aiFlag : ""}`);
    }
    ctx.redirect(`/roster/import/${batch.id}/map${aiFlag != null ? "?ai=" + aiFlag : ""}`);
  });

  // ---- Step 2: map columns ----
  router.get("/roster/import/:id/map", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    ctx.html(200, mapPage(ctx, { batch }));
  });
  router.post("/roster/import/:id/map", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    const FIXABLE = new Set(["department", "job_title", "employee_type", "employment_status", "compensation_unit", "manager"]);
    const mapping = {};
    for (const f of R.SCHEMA) {
      const v = ctx.body[`map_${f.key}`] || "";
      if (v && batch.headers.includes(v)) { mapping[f.key] = v; continue; }
      // No column? Allow a manually-assigned fixed value for the categorical fields.
      const fixed = FIXABLE.has(f.key) ? String(ctx.body[`fix_${f.key}`] || "").trim() : "";
      mapping[f.key] = fixed ? { value: fixed } : null;
    }
    const missing = R.mappingProblems(mapping);
    if (missing.length) {
      batch.mapping = mapping;
      return ctx.html(400, mapPage(ctx, { batch, errors: ["Map required fields: " + missing.join(", ")] }));
    }
    updateBatchMapping(ctx.db, batch.id, mapping);
    ctx.redirect(`/roster/import/${batch.id}/review`);
  });

  // ---- Change which row holds the column headers (re-runs auto-map) ----
  router.post("/roster/import/:id/header", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    let hr = Number(ctx.body.header_row);
    if (!Number.isInteger(hr) || hr < 0 || hr >= batch.matrix.length) hr = 0;
    const { headers, rows } = matrixToRows(batch.matrix, hr);
    setBatchHeaderRow(ctx.db, batch.id, hr, rows.length);
    updateBatchMapping(ctx.db, batch.id, R.autoMap(headers).mapping);
    ctx.redirect(`/roster/import/${batch.id}/map`);
  });

  // ---- AI assist: suggest a column mapping (headers + type stats only) ----
  router.post("/roster/import/:id/ai-map", async (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    if (!aiReady(ctx)) return ctx.redirect(`/roster/import/${batch.id}/map`);
    const client = clientFromConfig(ctx.config);
    const res = await suggestMapping({ headers: batch.headers, rows: batch.rawRows, client });
    updateBatchMapping(ctx.db, batch.id, res.mapping);
    const mapped = Object.values(res.mapping).filter(Boolean).length;
    recordImportRun(ctx.db, { batchId: batch.id, userId: ctx.user.id, phase: "mapping",
      usedAi: res.source === "ai", provider: ctx.config.AI_IMPORT_PROVIDER, suggestionCount: mapped });
    logAudit(ctx.db, { userId: ctx.user.id, action: "import.ai_mapped", entity: "import_batch", entityId: batch.id, detail: { source: res.source, mapped } });
    ctx.redirect(`/roster/import/${batch.id}/map?ai=${res.source === "ai" ? 1 : 0}`);
  });

  // ---- AI assist: cleanup suggestions (dept categories + title normalization) ----
  router.post("/roster/import/:id/ai-clean", async (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    if (!aiReady(ctx)) return ctx.redirect(`/roster/import/${batch.id}/review`);
    const built = R.buildCanonical(batch.rawRows, batch.mapping);
    const okRows = built.rows.filter((r) => r._ok);
    const deptNames = [...new Set(okRows.map((r) => r.department).filter(Boolean))];
    const titles = [...new Set(okRows.map((r) => r.job_title).filter(Boolean))];
    const client = clientFromConfig(ctx.config);
    const [cat, tit] = await Promise.all([
      classifyDepartments({ names: deptNames, client }),
      normalizeTitles({ titles, client }),
    ]);
    updateBatchAssumptions(ctx.db, batch.id, {
      aiDeptCategory: cat.map, aiTitleMap: tit.map, aiCleanupRun: true,
      aiCleanupSource: { category: cat.source, title: tit.source },
    });
    const usedAi = cat.source === "ai" || tit.source === "ai";
    recordImportRun(ctx.db, { batchId: batch.id, userId: ctx.user.id, phase: "cleanup",
      usedAi, provider: ctx.config.AI_IMPORT_PROVIDER,
      suggestionCount: Object.keys(cat.map).length + Object.keys(tit.map).length });
    logAudit(ctx.db, { userId: ctx.user.id, action: "import.ai_cleaned", entity: "import_batch", entityId: batch.id, detail: { categories: Object.keys(cat.map).length, titles: Object.keys(tit.map).length } });
    ctx.redirect(`/roster/import/${batch.id}/review`);
  });

  // ---- AI full read (opt-in): interpret a messy / non-tabular file ----
  // Sends the raw file contents to the provider. Gated behind the separate
  // ai_full_read_enabled setting. No deterministic fallback — errors surface.
  // Manual re-run of full read (kept as a fallback; it normally runs on upload).
  router.post("/roster/import/:id/fullread", async (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    if (!aiFullReady(ctx)) return ctx.redirect(`/roster/import/${batch.id}/map`);
    const fr = await runFullRead(ctx, batch);
    ctx.redirect(fr.ok ? `/roster/import/${batch.id}/review?fr=ok` : `/roster/import/${batch.id}/map?fr=failed`);
  });

  // ---- Step 3: review ----
  router.get("/roster/import/:id/review", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    const built = R.buildCanonical(batch.rawRows, batch.mapping);
    ctx.html(200, reviewPage(ctx, { batch, built }));
  });

  // ---- Commit / discard ----
  router.post("/roster/import/:id/commit", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (!batch || batch.status !== "draft") return ctx.redirect("/roster/import");
    const built = R.buildCanonical(batch.rawRows, batch.mapping);
    const settingsRow = getSettings(ctx.db);
    const mult = settingsRow.loaded_cost_multiplier;
    // Accepted AI cleanup (confirmed by the user clicking Import after seeing it).
    const a = batch.assumptions || {};
    const titleMap = a.aiTitleMap || {};
    const catMap = a.aiDeptCategory || {};
    let committed = 0, titlesApplied = 0, catsApplied = 0;
    const seenDeptCat = new Set();
    for (const row of built.rows) {
      if (!row._ok) continue;
      if (titleMap[row.job_title]) { row.job_title = titleMap[row.job_title]; titlesApplied++; }
      const deptId = upsertDepartmentByName(ctx.db, row.department);
      if (catMap[row.department] && !seenDeptCat.has(deptId)) {
        setDepartmentCategory(ctx.db, deptId, catMap[row.department]);
        seenDeptCat.add(deptId);
        catsApplied++;
      }
      const empId = upsertEmployee(ctx.db, row, deptId);
      if (row._status !== "inactive") {
        ensureSeatForEmployee(ctx.db, { employeeId: empId, departmentId: deptId, title: row.job_title, loadedCost: loadedCostFn(row.annual_salary, mult) });
      } else {
        // now inactive in the roster — release their seat per the workspace policy
        const cur = ctx.db.prepare("SELECT seat_id FROM employees WHERE id=?").get(empId);
        if (cur && cur.seat_id) vacateSeat(ctx.db, cur.seat_id, settingsRow, ctx.user.id);
      }
      committed++;
    }
    setBatchStatus(ctx.db, batch.id, "committed", committed);
    if (a.aiCleanupRun && (titlesApplied || catsApplied)) {
      recordImportRun(ctx.db, { batchId: batch.id, userId: ctx.user.id, phase: "cleanup",
        usedAi: (a.aiCleanupSource && (a.aiCleanupSource.category === "ai" || a.aiCleanupSource.title === "ai")) || false,
        provider: ctx.config.AI_IMPORT_PROVIDER, acceptedCount: titlesApplied + catsApplied });
    }
    logAudit(ctx.db, { userId: ctx.user.id, action: "import.committed", entity: "import_batch", entityId: batch.id, detail: { committed, titlesApplied, catsApplied } });
    ctx.redirect(`/roster?imported=${committed}`);
  });

  router.post("/roster/import/:id/discard", (ctx) => {
    if (!requirePermission(ctx, canImportRoster)) return;
    const batch = getBatch(ctx.db, Number(ctx.params.id));
    if (batch && batch.status === "draft") setBatchStatus(ctx.db, batch.id, "discarded");
    ctx.redirect("/roster/import");
  });
}

// ============ views ============
// deptRollup + rosterPage moved to src/views/people.js (Directive 4.0 consolidation)

function wizardSteps(active) {
  const steps = [["upload", "Upload"], ["map", "Map columns"], ["review", "Review & import"]];
  return raw(`<div class="wsteps">${steps.map(([k, l], i) =>
    `<span class="wstep ${k === active ? "on" : ""}"><b>${i + 1}</b> ${l}</span>`).join('<span class="warr">›</span>')}</div>`);
}

function uploadPage(ctx, { errors }) {
  const recent = listBatches(ctx.db).filter((b) => b.status === "committed").slice(0, 3);
  const body = html`
    <div class="pagehead"><h1>Import roster</h1></div>
    ${wizardSteps("upload")}
    ${errorList(errors)}
    <section class="card narrow">
      <div class="flash">Upload your roster as an <b>Excel workbook</b> (.xlsx) or a <b>.csv</b>. Include a start-date column — and an end-date column if anyone has left or is leaving. Everything is processed on your own server.</div>
      <form method="post" action="/roster/import" enctype="multipart/form-data">
        ${csrfField(ctx)}
        <label>Roster file (.xlsx or .csv)<input type="file" name="file" accept=".xlsx,.xlsm,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required></label>
        <button class="btn" type="submit">Upload &amp; continue</button>
      </form>
    </section>
    ${recent.length ? html`<section class="card narrow"><h2>Recent imports</h2>
      <table class="table"><tbody>${recent.map((b) => html`<tr><td>${b.filename || "(file)"}</td><td class="right muted">${b.clean_count} imported</td><td class="right muted">${b.committed_at || ""}</td></tr>`)}</tbody></table>
    </section>` : ""}`;
  return renderPage(ctx, { title: "Import roster", body, active: "roster" });
}

function headerRowPicker(ctx, batch) {
  const candidates = batch.matrix.slice(0, 8);
  if (candidates.length < 2) return "";
  const preview = (row) => {
    const cells = row.map((c) => String(c).trim()).filter(Boolean).slice(0, 5).join(" | ");
    return cells.length > 70 ? cells.slice(0, 70) + "…" : (cells || "(blank row)");
  };
  const options = candidates.map((row, i) =>
    html`<option value="${i}" ${i === batch.headerRow ? raw("selected") : ""}>Row ${i + 1}: ${preview(row)}</option>`);
  return html`<form method="post" action="/roster/import/${batch.id}/header" class="hdrpick">
      ${csrfField(ctx)}
      <label>Which row has your column headers?</label>
      <div class="hdrpick-row">
        <select name="header_row">${options}</select>
        <button class="btn sm ghost" type="submit">Use this row</button>
      </div>
      <p class="muted small">If your file starts with a title row, pick the row that holds the real column names, then "Use this row".</p>
    </form>`;
}

function mapPage(ctx, { batch, errors }) {
  const { confidence } = R.autoMap(batch.headers);
  const opts = (sel) => raw(['<option value="">— not mapped —</option>']
    .concat(batch.headers.map((h) => `<option value="${escAttr(h)}" ${batch.mapping[sel] === h ? "selected" : ""}>${escHtml(h)}</option>`))
    .join(""));
  const rows = R.SCHEMA.map((f) => {
    const conf = confidence[f.key];
    const isFixed = batch.mapping[f.key] && typeof batch.mapping[f.key] === "object";
    const badge = isFixed ? '<span class="badge b-high">Assigned</span>'
      : !batch.mapping[f.key] ? '<span class="badge b-none">Unmapped</span>'
      : conf === "high" ? '<span class="badge b-high">Matched</span>'
      : conf === "low" ? '<span class="badge b-low">Check this</span>' : '<span class="badge b-high">Set</span>';
    const FIXABLE = new Set(["department", "job_title", "employee_type", "employment_status", "compensation_unit", "manager"]);
    const fixVal = (batch.mapping[f.key] && typeof batch.mapping[f.key] === "object") ? batch.mapping[f.key].value : "";
    return html`<div class="map-row">
      <div class="canon">${f.label} ${f.required ? raw('<span class="req">*</span>') : ""}</div>
      <div class="map-pick">
        <select name="map_${f.key}">${opts(f.key)}</select>
        ${FIXABLE.has(f.key) ? html`<input class="map-fix" name="fix_${f.key}" placeholder="or set all rows to…" value="${fixVal}" aria-label="Fixed ${f.label} for all rows">` : ""}
      </div>
      <div>${raw(badge)}</div>
    </div>`;
  });
  const aiParam = ctx.query.get("ai");
  const frParam = ctx.query.get("fr");
  const aiNotice = aiParam === "1"
    ? html`<div class="flash ok">AI suggested the mappings below from your column headers and types only — your data stayed on this server. Review and confirm each one.</div>`
    : aiParam === "0"
    ? html`<div class="flash warn">The AI assist was unavailable, so we used the built-in matcher. Review the mappings below.</div>`
    : "";
  const frNotice = frParam === "failed"
    ? html`<div class="flash warn">AI full read couldn't interpret that file. Try fixing the header row above, or map the columns manually.</div>`
    : "";
  const aiPanel = ""; // AI mapping now runs automatically on upload (Directive 4.0)
  // Full read runs automatically on upload for messy files, so no opt-in card here.
  const fullReadPanel = "";

  const body = html`
    <div class="pagehead"><h1>Map your columns</h1><p class="muted">${batch.filename} · ${batch.rawRows.length} rows</p></div>
    ${wizardSteps("map")}
    ${errorList(errors)}
    ${aiNotice}${frNotice}
    <section class="card">
      ${aiPanel}
      ${fullReadPanel}
      ${headerRowPicker(ctx, batch)}
      <div class="flash">We matched your file's columns to our standard fields. Confirm or fix each one. <b>*</b> required. For names, map a single <b>Full name</b> column <i>or</i> <b>First name</b> / <b>Last name</b> — whichever your file has.</div>
      <form method="post" action="/roster/import/${batch.id}/map">
        ${csrfField(ctx)}
        <div class="map-head"><span>Standard field</span><span>Your column</span><span></span></div>
        ${rows}
        <div class="actions" style="margin-top:16px">
          <button class="btn" type="submit">Continue to review</button>
        </div>
      </form>
      <form method="post" action="/roster/import/${batch.id}/discard" class="inline" style="margin-top:8px">${csrfField(ctx)}<button class="linklike" type="submit">Discard import</button></form>
    </section>`;
  return renderPage(ctx, { title: "Map columns", body, active: "roster" });
}

function reviewPage(ctx, { batch, built }) {
  const s = built.summary;
  const a = batch.assumptions || {};
  const titleMap = a.aiTitleMap || {};
  const catMap = a.aiDeptCategory || {};
  const issues = [];
  for (const r of built.rows) for (const x of r._issues) issues.push({ row: r._row, ...x });
  // On-device anomaly flags (run regardless of the AI toggle).
  for (const x of flagAnomalies(built.rows)) issues.push(x);
  const errs = issues.filter((x) => x.level === "error").slice(0, 15);
  const warns = issues.filter((x) => x.level === "warn").slice(0, 20);

  const frNotice = ctx.query.get("fr") === "ok"
    ? html`<div class="flash ok">AI read your file and rebuilt a clean table of ${built.rows.length} row${built.rows.length === 1 ? "" : "s"}. Review below, then import.</div>`
    : "";

  const flags = (list, cls, icon) => list.map((x) => html`<div class="flag ${cls}"><b>Row ${x.row}</b> · ${x.msg}</div>`);
  const preview = built.rows.slice(0, 25).map((r) => {
    const errFields = new Set(r._issues.filter((x) => x.level === "error").map((x) => x.field));
    const cell = (k, v) => html`<td class="${errFields.has(k) ? "cell-err" : ""}">${v}</td>`;
    const newTitle = titleMap[r.job_title];
    const titleCell = newTitle
      ? html`<td><span class="tnew">${newTitle}</span><div class="sub strike">${r.job_title}</div></td>`
      : html`<td>${r.job_title || "—"}</td>`;
    return html`<tr class="${r._ok ? "" : "rowerr"}">
      <td class="muted">${r._row}</td>
      ${cell("employee_id", r.employee_id || "—")}
      ${cell("name", r.name || "—")}
      ${cell("department", r.department || "—")}
      ${titleCell}
      ${cell("compensation_amount", r.compensation_amount == null ? "—" : r.compensation_amount.toLocaleString())}
      <td>${r.annual_salary == null ? "—" : money(r.annual_salary)}</td>
    </tr>`;
  });

  const catLabel = Object.fromEntries(FUNCTION_CATEGORIES);
  const catEntries = Object.entries(catMap);
  const titleEntries = Object.entries(titleMap);
  const cleanupCard = aiReady(ctx) ? html`<section class="card">
      <div class="row-between">
        <div><h2>✨ AI cleanup</h2><p class="muted small">Standardizes job titles and assigns each department a function category. Sends only your department names and job titles — never salaries or people.</p></div>
        <form method="post" action="/roster/import/${batch.id}/ai-clean" class="inline">${csrfField(ctx)}<button class="btn ghost sm" type="submit">${batch.assumptions?.aiCleanupRun ? "Re-run" : "Analyze with AI"}</button></form>
      </div>
      ${batch.assumptions?.aiCleanupRun
        ? (catEntries.length || titleEntries.length
            ? html`<div class="grid2" style="margin-top:8px">
                <div><h3 class="mini">Department categories (${catEntries.length})</h3>
                  ${catEntries.length ? html`<table class="table"><tbody>${catEntries.map(([d, c]) => html`<tr><td><b>${d}</b></td><td class="right">${catLabel[c] || c}</td></tr>`)}</tbody></table>` : raw('<p class="muted small">No changes.</p>')}
                </div>
                <div><h3 class="mini">Title cleanups (${titleEntries.length})</h3>
                  ${titleEntries.length ? html`<table class="table"><tbody>${titleEntries.slice(0, 12).map(([o, n]) => html`<tr><td class="muted strike">${o}</td><td>${n}</td></tr>`)}</tbody></table>` : raw('<p class="muted small">No changes.</p>')}
                </div>
              </div>
              <p class="muted small">Applied to the preview below; they take effect when you import.</p>`
            : raw('<p class="muted small">Nothing to clean up — titles and departments already look standard.</p>'))
        : raw('<p class="muted small">Optional. Run it to preview standardized titles and department categories before importing.</p>')}
    </section>` : "";

  const body = html`
    <div class="pagehead"><h1>Review &amp; import</h1><p class="muted">${batch.filename}</p></div>
    ${wizardSteps("review")}
    ${frNotice}
    <div class="kpis">
      ${kpi("Total rows", s.total)}
      ${kpiC("Clean & ready", s.clean, "good")}
      ${kpiC("Rows with errors", s.withErrors, s.withErrors ? "bad" : "")}
      ${kpiC("Warnings", s.warns, s.warns ? "warn" : "")}
    </div>
    ${cleanupCard}
    <div class="grid2">
      <section class="card">
        <h2>Data preview</h2>
        <div class="tbl-scroll"><table class="table">
          <thead><tr><th>#</th><th>Employee ID</th><th>Name</th><th>Dept</th><th>Title</th><th>Amount</th><th>Annual</th></tr></thead>
          <tbody>${preview}</tbody>
        </table></div>
        ${built.rows.length > 25 ? html`<p class="muted small">Showing first 25 of ${built.rows.length} rows.</p>` : ""}
      </section>
      <section class="card">
        <h2>Issues</h2>
        ${errs.length || warns.length
          ? html`${flags(errs, "e")}${flags(warns, "w")}`
          : raw('<div class="flag g">No issues found.</div>')}
        <div class="actions" style="margin-top:16px">
          <form method="post" action="/roster/import/${batch.id}/commit" class="inline">
            ${csrfField(ctx)}
            <button class="btn" type="submit" ${s.clean ? "" : "disabled"}>Import ${s.clean} clean row${s.clean === 1 ? "" : "s"}</button>
          </form>
          <a class="btn ghost" href="/roster/import/${batch.id}/map">Back to mapping</a>
        </div>
        ${s.withErrors ? html`<p class="muted small">${s.withErrors} row(s) with errors will be skipped. Fix them in your file and re-import to include them.</p>` : ""}
      </section>
    </div>`;
  return renderPage(ctx, { title: "Review import", body, active: "roster" });
}


function onboardPage(ctx, { form, seat, errors }) {
  const depts = listDepartments(ctx.db);
  const UNITS = [["annual","Annual"],["monthly","Monthly"],["semimonthly","Semi-monthly"],["biweekly","Bi-weekly"],["weekly","Weekly"],["daily","Daily"],["hourly","Hourly"]];
  const TYPES = ["Full-Time","Part-Time","Contractor","Intern"];
  const opt = (v, cur) => v === cur ? raw("selected") : "";
  const deptField = seat
    ? html`<input type="hidden" name="seat_id" value="${seat.id}"><p class="muted small">Filling open seat: <b>${seat.title || "Untitled"}</b> in <b>${getDepartment(ctx.db, seat.department_id)?.name || "—"}</b></p>`
    : html`<label>Department<select name="department_id" required><option value="">Choose…</option>${depts.map((d) => html`<option value="${d.id}" ${opt(String(d.id), String(form.department_id))}>${d.name}</option>`)}</select></label>`;
  const body = html`
    <div class="pagehead"><a class="muted small" href="/roster">← Roster</a><h1>${seat ? "Onboard into open seat" : "Add a person"}</h1>
      <p class="muted">Capture the essentials for headcount &amp; cost. ${seat ? "This fills the open seat and records the actual compensation." : "This creates a filled seat for the new hire."} (No sensitive personal data — that belongs in payroll/HRIS.)</p>
    </div>
    ${errorList(errors)}
    <form method="post" action="/roster/new">
      ${csrfField(ctx)}
      <section class="card">
        <h2>Person</h2>
        <div class="formgrid">
          <label>First name<input name="first_name" value="${esc(form.first_name || "")}"></label>
          <label>Last name<input name="last_name" value="${esc(form.last_name || "")}"></label>
        </div>
        <label>Or full name <span class="hint">if you don't have it split</span><input name="name" value="${esc(form.name || "")}"></label>
        <label>Employee ID <span class="hint">leave blank to auto-generate</span><input name="employee_id" value="${esc(form.employee_id || "")}"></label>
      </section>
      <section class="card">
        <h2>Role</h2>
        ${deptField}
        <label>Job title<input name="job_title" value="${esc(form.job_title || (seat ? seat.title : "") || "")}"></label>
        <div class="formgrid">
          <label>Employment type<select name="employee_type"><option value="">—</option>${TYPES.map((t) => html`<option value="${t}" ${opt(t, form.employee_type)}>${t}</option>`)}</select></label>
          <label>Start date<input name="start_date" type="date" value="${esc(form.start_date || "")}"></label>
        </div>
        <label>Manager<input name="manager" value="${esc(form.manager || "")}"></label>
      </section>
      <section class="card">
        <h2>Compensation</h2>
        <div class="formgrid">
          <label>Amount<input name="comp_amount" value="${esc(form.comp_amount || "")}" placeholder="e.g. 150000 or 95k" required></label>
          <label>Per<select name="comp_unit">${UNITS.map(([v, l]) => html`<option value="${v}" ${opt(v, form.comp_unit)}>${l}</option>`)}</select></label>
        </div>
        <p class="muted small">Converted to an annual, fully-loaded figure for budgets and runway.</p>
      </section>
      <button class="btn" type="submit">${seat ? "Onboard &amp; fill seat" : "Add person"}</button>
    </form>`;
  return renderPage(ctx, { title: seat ? "Onboard" : "Add person", body, active: "roster" });
}

// small view helpers
const kpi = (label, val) => html`<div class="kpi"><div class="lbl">${label}</div><div class="val">${val}</div></div>`;
const kpiC = (label, val, tone) => html`<div class="kpi"><div class="lbl">${label}</div><div class="val ${tone}">${val}</div></div>`;
const statusPill = (st) => {
  const s = String(st || "").toLowerCase();
  if (s === "active") return raw('<span class="pill ok2">Active</span>');
  if (s === "inactive") return raw('<span class="pill off">Inactive</span>');
  if (s === "leave") return raw('<span class="pill warn2">On leave</span>');
  return st || "—";
};
const escHtml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escAttr = (s) => escHtml(s).replaceAll('"', "&quot;");
