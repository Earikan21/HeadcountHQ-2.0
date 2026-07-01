import { html, raw } from "../html.js";
import { renderPage, csrfField, errorList } from "../views/ui.js";
import { requirePermission } from "../middleware.js";
import { canManageDepartments } from "../authz.js";
import {
  listDepartments, listDepartmentsWithCounts, getDepartment, getDepartmentByName,
  createDepartment, renameDepartment, moveEmployees, mergeDepartments,
  deleteDepartmentIfEmpty, listEmployeesInDepartment, setDepartmentCategory,
} from "../repos/departments.js";
import { FUNCTION_CATEGORIES } from "../data/benchmarks.js";
import { logAudit } from "../repos/audit.js";

const CATEGORY_OPTIONS = [["", "Auto (by name)"], ...FUNCTION_CATEGORIES];

const ids = (v) => [].concat(v || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

export function registerDepartmentRoutes(router) {
  // ---- list + create ----
  router.get("/departments", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    ctx.html(200, listPage(ctx, {}));
  });
  router.post("/departments", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const name = String(ctx.body.name || "").trim();
    if (!name) return ctx.html(400, listPage(ctx, { errors: ["Department name is required."] }));
    if (getDepartmentByName(ctx.db, name)) return ctx.html(400, listPage(ctx, { errors: [`A department named "${name}" already exists.`] }));
    const dept = createDepartment(ctx.db, { name, parentId: ctx.body.parent_id ? Number(ctx.body.parent_id) : null });
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.created", entity: "department", entityId: dept.id });
    ctx.redirect("/departments?msg=Department+added");
  });

  // ---- assign function categories (drives the suggested target balance) ----
  router.post("/departments/categories", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    for (const d of listDepartments(ctx.db)) {
      const v = ctx.body[`cat_${d.id}`];
      if (v !== undefined) setDepartmentCategory(ctx.db, d.id, v);
    }
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.categories", entity: "department" });
    ctx.redirect("/departments?msg=Function+categories+saved");
  });

  // ---- manage a single department ----
  router.get("/departments/:id", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    if (!dept) return ctx.redirect("/departments");
    ctx.html(200, managePage(ctx, { dept }));
  });

  router.post("/departments/:id/rename", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    if (!dept) return ctx.redirect("/departments");
    const name = String(ctx.body.name || "").trim();
    const clash = getDepartmentByName(ctx.db, name);
    if (!name) return ctx.html(400, managePage(ctx, { dept, errors: ["Name is required."] }));
    if (clash && clash.id !== dept.id) return ctx.html(400, managePage(ctx, { dept, errors: [`"${name}" already exists — use Merge to combine them.`] }));
    renameDepartment(ctx.db, dept.id, name);
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.renamed", entity: "department", entityId: dept.id, detail: { from: dept.name, to: name } });
    ctx.redirect(`/departments/${dept.id}?msg=Renamed`);
  });

  router.post("/departments/:id/merge", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    const toId = Number(ctx.body.target_id);
    const to = getDepartment(ctx.db, toId);
    if (!dept) return ctx.redirect("/departments");
    if (!to || to.id === dept.id) return ctx.html(400, managePage(ctx, { dept, errors: ["Choose a different department to merge into."] }));
    mergeDepartments(ctx.db, dept.id, toId);
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.merged", entity: "department", entityId: dept.id, detail: { from: dept.name, into: to.name } });
    ctx.redirect(`/departments/${toId}?msg=Merged+${encodeURIComponent(dept.name)}+in`);
  });

  router.post("/departments/:id/move", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    if (!dept) return ctx.redirect("/departments");
    const empIds = ids(ctx.body.emp);
    const toId = Number(ctx.body.target_id);
    const to = getDepartment(ctx.db, toId);
    if (!empIds.length) return ctx.html(400, managePage(ctx, { dept, errors: ["Select at least one person to move."] }));
    if (!to || to.id === dept.id) return ctx.html(400, managePage(ctx, { dept, errors: ["Choose a destination department."] }));
    moveEmployees(ctx.db, empIds, toId);
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.moved_people", entity: "department", entityId: dept.id, detail: { count: empIds.length, to: to.name } });
    ctx.redirect(`/departments/${dept.id}?msg=Moved+${empIds.length}+people`);
  });

  router.post("/departments/:id/split", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    if (!dept) return ctx.redirect("/departments");
    const empIds = ids(ctx.body.emp);
    const newName = String(ctx.body.new_name || "").trim();
    if (!newName) return ctx.html(400, managePage(ctx, { dept, errors: ["Name the new department to split into."] }));
    if (getDepartmentByName(ctx.db, newName)) return ctx.html(400, managePage(ctx, { dept, errors: [`"${newName}" already exists — use Move instead.`] }));
    if (!empIds.length) return ctx.html(400, managePage(ctx, { dept, errors: ["Select the people to move into the new department."] }));
    const created = createDepartment(ctx.db, { name: newName, parentId: dept.parent_id });
    moveEmployees(ctx.db, empIds, created.id);
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.split", entity: "department", entityId: dept.id, detail: { newDept: newName, count: empIds.length } });
    ctx.redirect(`/departments/${created.id}?msg=Split+into+${encodeURIComponent(newName)}`);
  });

  router.post("/departments/:id/delete", (ctx) => {
    if (!requirePermission(ctx, canManageDepartments)) return;
    const dept = getDepartment(ctx.db, Number(ctx.params.id));
    if (!dept) return ctx.redirect("/departments");
    const ok = deleteDepartmentIfEmpty(ctx.db, dept.id);
    if (!ok) return ctx.html(400, managePage(ctx, { dept, errors: ["This department still has people or seats — move or merge them first."] }));
    logAudit(ctx.db, { userId: ctx.user.id, action: "department.deleted", entity: "department", entityId: dept.id, detail: { name: dept.name } });
    ctx.redirect("/departments?msg=Department+deleted");
  });
}

// ============ views ============
function listPage(ctx, { errors }) {
  const depts = listDepartmentsWithCounts(ctx.db);
  const byId = new Map(depts.map((d) => [d.id, d.name]));
  const catSelect = (d) => html`<select name="cat_${d.id}">${CATEGORY_OPTIONS.map(([k, lbl]) => html`<option value="${k}" ${(d.function_category || "") === k ? raw("selected") : ""}>${lbl}</option>`)}</select>`;
  const rows = depts.length ? depts.map((d) => html`<tr>
      <td><b>${d.name}</b></td>
      <td>${d.parent_id ? byId.get(d.parent_id) || "—" : "—"}</td>
      <td>${catSelect(d)}</td>
      <td class="right">${d.emp_count}</td>
      <td class="right"><a class="btn sm ghost" href="/departments/${d.id}">Manage</a></td>
    </tr>`) : raw('<tr><td colspan="5" class="muted">No departments yet. Add one below or import a roster.</td></tr>');
  const body = html`
    <div class="pagehead"><h1>Departments</h1><p class="muted">Your org structure. Rename, merge, or split departments and move people between them — everything stays in sync with seats, roll-ups, and the target balance.</p></div>
    ${errorList(errors)}
    <div class="grid2">
      <section class="card">
        <h2>Departments</h2>
        <p class="muted small">Set each team's <b>function</b> — this drives the suggested target balance. "Auto" guesses from the name.</p>
        <form method="post" action="/departments/categories">
          ${csrfField(ctx)}
          <table class="table"><thead><tr><th>Name</th><th>Parent</th><th>Function</th><th class="right">People</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          ${depts.length ? html`<button class="btn sm" type="submit" style="margin-top:10px">Save functions</button>` : ""}
        </form>
      </section>
      <section class="card">
        <h2>Add a department</h2>
        <form method="post" action="/departments">
          ${csrfField(ctx)}
          <label>Name<input name="name" required></label>
          <label>Parent (optional)<select name="parent_id"><option value="">—</option>${depts.map((d) => html`<option value="${d.id}">${d.name}</option>`)}</select></label>
          <button class="btn" type="submit">Add department</button>
        </form>
      </section>
    </div>`;
  return renderPage(ctx, { title: "Departments", body, active: "departments" });
}

function managePage(ctx, { dept, errors }) {
  const others = listDepartments(ctx.db).filter((d) => d.id !== dept.id);
  const people = listEmployeesInDepartment(ctx.db, dept.id);
  const otherOpts = others.map((d) => html`<option value="${d.id}">${d.name}</option>`);

  const peopleRows = people.length ? people.map((e) => html`<tr>
      <td><input type="checkbox" name="emp" value="${e.id}"></td>
      <td><b>${e.name}</b><div class="sub">${e.employee_ext_id}</div></td>
      <td>${e.job_title || "—"}</td>
      <td>${e.employment_status || "—"}</td>
    </tr>`) : raw('<tr><td colspan="4" class="muted">No people in this department.</td></tr>');

  const body = html`
    <div class="pagehead"><a class="muted small" href="/departments">← Departments</a>
      <h1>${dept.name}</h1><p class="muted">${people.length} ${people.length === 1 ? "person" : "people"}</p></div>
    ${errorList(errors)}
    <div class="grid2">
      <section class="card">
        <h2>Rename</h2>
        <form method="post" action="/departments/${dept.id}/rename">
          ${csrfField(ctx)}
          <label>Name<input name="name" value="${dept.name}" required></label>
          <button class="btn" type="submit">Rename</button>
        </form>
      </section>
      <section class="card">
        <h2>Merge into another department</h2>
        <p class="muted small">Moves all people and seats here into the chosen department, then removes this one.</p>
        <form method="post" action="/departments/${dept.id}/merge">
          ${csrfField(ctx)}
          <label>Merge "${dept.name}" into
            <select name="target_id" required><option value="">Choose…</option>${otherOpts}</select>
          </label>
          <button class="btn ghost" type="submit">Merge</button>
        </form>
        <form method="post" action="/departments/${dept.id}/delete" class="inline" style="margin-top:10px">
          ${csrfField(ctx)}<button class="linklike" type="submit">Delete (if empty)</button>
        </form>
      </section>
    </div>
    <section class="card">
      <h2>People — move or split</h2>
      <p class="muted small">Tick the people you want, then either move them to an existing department or split them into a brand-new one.</p>
      <form method="post" action="/departments/${dept.id}/move">
        ${csrfField(ctx)}
        <table class="table"><thead><tr><th></th><th>Name</th><th>Title</th><th>Status</th></tr></thead><tbody>${peopleRows}</tbody></table>
        <div class="grid2" style="margin-top:14px">
          <div>
            <label>Move selected to<select name="target_id"><option value="">Choose…</option>${otherOpts}</select></label>
            <button class="btn" type="submit" formaction="/departments/${dept.id}/move">Move selected</button>
          </div>
          <div>
            <label>…or split selected into a new department<input name="new_name" placeholder="e.g. Platform"></label>
            <button class="btn ghost" type="submit" formaction="/departments/${dept.id}/split">Create &amp; move selected</button>
          </div>
        </div>
      </form>
    </section>`;
  return renderPage(ctx, { title: dept.name, body, active: "departments" });
}
