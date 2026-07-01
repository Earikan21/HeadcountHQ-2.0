import { html, raw } from "../html.js";
import { renderPage, money } from "../views/ui.js";
import { requireAuth } from "../middleware.js";
import { canViewCompTotals, departmentScope } from "../authz.js";

/** Department hierarchy with subtree headcount + cost roll-up. */
function buildTree(db, scope) {
  const rows = db.prepare(`
    SELECT d.id, d.name, d.parent_id,
      (SELECT COUNT(*) FROM seats s WHERE s.department_id=d.id AND s.status='filled') AS active,
      (SELECT COUNT(*) FROM seats s WHERE s.department_id=d.id AND s.status='open') AS open,
      (SELECT COALESCE(SUM(loaded_cost_estimate),0) FROM seats s WHERE s.department_id=d.id AND s.status NOT IN ('closed')) AS cost
    FROM departments d ORDER BY d.name`).all();
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(node);
    else roots.push(node);
  }
  const roll = (n) => {
    let a = n.active, o = n.open, c = n.cost;
    for (const ch of n.children) { const r = roll(ch); a += r.active; o += r.open; c += r.cost; }
    n.totalActive = a; n.totalOpen = o; n.totalCost = c;
    return { active: a, open: o, cost: c };
  };
  roots.forEach(roll);
  if (scope != null) {
    const ids = Array.isArray(scope) ? scope : [scope];
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }
  return roots;
}

export function registerOrgRoutes(router) {
  router.get("/org", (ctx) => {
    if (!requireAuth(ctx)) return;
    const showCost = canViewCompTotals(ctx.user);
    const scope = departmentScope(ctx.user);
    const roots = buildTree(ctx.db, scope);

    const node = (n) => html`<li>
      <div class="orgnode">
        <div class="orgname">${n.name}</div>
        <div class="orgmeta">${n.totalActive} active${n.totalOpen ? html` · <span class="warn2-txt">${n.totalOpen} open</span>` : ""}${showCost ? html` · ${money(n.totalCost)}` : ""}</div>
      </div>
      ${n.children.length ? html`<ul>${n.children.map(node)}</ul>` : ""}
    </li>`;

    const body = html`
      <div class="pagehead row-between">
        <div><h1>Org chart</h1><p class="muted">Department structure with rolled-up headcount${showCost ? " and cost" : ""}. Reshape it on the <a href="/departments">Departments</a> page.</p></div>
      </div>
      <section class="card">
        ${roots.length ? html`<ul class="orgtree">${roots.map(node)}</ul>` : html`<p class="muted">No departments yet. Add them on the <a href="/departments">Departments</a> page or import a roster.</p>`}
      </section>`;
    ctx.html(200, renderPage(ctx, { title: "Org chart", body, active: "org" }));
  });
}
