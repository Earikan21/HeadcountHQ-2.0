/**
 * Live, in-app spreadsheet financial model (Directive 4.0): a thin title line, a
 * mini dashboard, one row of view/filter controls, then the sheet itself.
 *
 * Plan versions live in the left nav (see views/ui.js) — this page only carries the
 * *editor* for whichever plan is selected: a thin bar (name + Delete) and two
 * collapsed sections (Hires, Assumptions & drivers).
 *
 * Columns are year-grouped and collapse to a single year-total. Everything except
 * the current calendar year starts collapsed, and the sheet scrolls to the current
 * month on load, so a 10-year model opens on "today" rather than on ancient history.
 */
import { html, raw } from "../html.js";

/** Join class names, dropping the empty ones (so we never emit `class="prow scn "`). */
const cx = (...names) => names.filter(Boolean).join(" ");
import { renderPage, csrfField, money, moneyShort } from "./ui.js";
import { canImportRoster } from "../authz.js";
import { esc } from "../html.js";
import { periodBuckets, periodize, yearGroupsOf, modelKpis, windowKey } from "../domain/model.js";

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const pctChg = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const kpi = (label, val, sub = "", k = "") => html`<div class="kpi" data-k="${k}"><div class="lbl">${label}</div><div class="val">${val}</div>${sub ? html`<div class="lbl">${sub}</div>` : ""}</div>`;

/**
 * Cost cells for one row across all year-groups. A group with more than one bucket
 * also gets a year-total cell; exactly one of (buckets, total) is visible, and which
 * one is decided by `collapsed` so the server renders the same state the toggle does.
 */
function yearCells(perBucket, groups, collapsed) {
  return groups.map((g) => {
    const off = collapsed.has(g.year);
    const cells = g.pos.map((i) => raw(`<td class="mc" data-yb="${g.year}" data-v="${Math.round(perBucket[i])}"${off ? " hidden" : ""}>${perBucket[i] ? moneyShort(perBucket[i]) : ""}</td>`));
    if (g.pos.length <= 1) return html`${cells}`; // single bucket (yearly view): nothing to collapse
    const tot = g.pos.reduce((a, i) => a + perBucket[i], 0);
    return html`${cells}${raw(`<td class="mc ytot" data-year="${g.year}" data-v="${Math.round(tot)}"${off ? "" : " hidden"}>${tot ? moneyShort(tot) : ""}</td>`)}`;
  });
}

/** Thin plan bar: which plan you're editing, its model length, and a red Delete. */
function planBar(ctx, extra) {
  const cur = extra.current;
  if (!cur || !extra.canEdit) return "";
  const horizon = Math.max(1, Math.min(10, Number((extra.assumptions || {}).horizonYears) || 5));
  const yrs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return html`<div class="plan-bar">
    <span class="pb-name">Plan: <b>${cur.name}</b></span>
    <form method="post" action="/model/versions/${cur.id}/horizon" class="pb-horizon">
      ${csrfField(ctx)}
      ${extra.dept ? html`<input type="hidden" name="dept" value="${extra.dept}">` : ""}
      <label>Model length
        <select name="horizon_years" aria-label="Model length in years">
          ${yrs.map((y) => html`<option value="${y}" ${y === horizon ? raw("selected") : ""}>${y} yr${y > 1 ? "s" : ""}</option>`)}
        </select>
      </label>
      <button class="btn sm ghost" type="submit">Apply</button>
    </form>
    <form method="post" action="/model/versions/${cur.id}/duplicate" class="inline">
      ${csrfField(ctx)}<button class="btn sm ghost" type="submit" title="Copy this plan's hires, assumptions and edits into a new plan">Duplicate plan</button>
    </form>
    <a class="btn sm ghost" href="/model/compare?a=actual&b=${cur.id}">Compare</a>
    <form method="post" action="/model/versions/${cur.id}/delete" class="inline confirm-delete"
          data-confirm="Delete the plan “${cur.name}”? This can't be undone.">
      ${csrfField(ctx)}<button class="btn sm danger" type="submit">Delete plan</button>
    </form>
  </div>`;
}

/** The plan editor: both sections collapsed by default so the sheet stays visible. */
function planEditor(ctx, extra) {
  const cur = extra.current;
  if (!cur || !extra.canEdit) return "";
  const hires = extra.hires || [];
  const scope = extra.dept || null;
  const A = extra.assumptions || {};
  const cv = scope ? ((A.byDept && A.byDept[scope]) || {}) : A;
  const ph = (k, dflt) => (scope && A[k] != null && A[k] !== "" ? String(A[k]) : dflt);
  const val = (v) => (v != null && v !== "" ? String(v) : "");
  const window_ = (h) => (h.start_month || "start") + (h.end_month ? " → " + h.end_month : "");
  const chips = hires.length
    ? html`<div class="hire-chips">${hires.map((h) => html`<span class="${cx("chip", h.end_month && "temp")}">${h.name || h.role} · ${h.department} · ${window_(h)} · ${money(h.annual_salary)}<form method="post" action="/model/versions/${cur.id}/hire/${h.id}/delete" class="inline">${csrfField(ctx)}<button class="chip-x" type="submit" aria-label="remove">×</button></form></span>`)}</div>`
    : html`<p class="muted small">No planned hires yet.</p>`;
  return html`<section class="plan-editor">
    ${extra.aiError ? html`<div class="flash warn">${extra.aiError}</div>` : ""}
    <details class="plan-sect">
      <summary>Hires${hires.length ? " · " + hires.length : ""}</summary>
      <div class="plan-sect-body">
        ${extra.aiReady ? html`<form method="post" action="/model/versions/${cur.id}/ai" class="scn-ai">${csrfField(ctx)}<input name="description" placeholder="e.g. 2 AEs in Sales, Jun 2027, $120k" aria-label="Describe hires"><button class="btn sm" type="submit">AI</button></form>` : ""}
        <form method="post" action="/model/versions/${cur.id}/hire" class="scn-manual">
          ${csrfField(ctx)}
          <input name="scn_department" placeholder="Dept" aria-label="Department">
          <input name="scn_role" placeholder="Role" aria-label="Role">
          <label class="mo">Start <input name="scn_start" type="month" aria-label="Start month"></label>
          <label class="mo">End <input name="scn_end" type="month" aria-label="End month (optional)"></label>
          <input name="scn_salary" type="number" min="0" step="1000" placeholder="Annual $" aria-label="Annual salary">
          <input name="scn_count" type="number" min="1" step="1" value="1" aria-label="Count" class="tiny">
          <button class="btn sm ghost" type="submit">Add</button>
        </form>
        <p class="muted small">Leave <b>End</b> blank for a permanent hire. Set it to add headcount for a limited time (a contractor, a backfill, a seasonal team). To remove existing headcount, use <b>End</b> on their row — or import an "End date" column for exact dates.</p>
        ${chips}
      </div>
    </details>
    <details class="plan-sect">
      <summary>Assumptions &amp; drivers${scope ? " · " + scope : ""}</summary>
      <div class="plan-sect-body">
        <p class="muted small">${scope ? "Overrides for " + scope + " — leave blank to use the plan default." : "Company defaults. Scope to a department (filter above) to override per team."}</p>
        <form method="post" action="/model/versions/${cur.id}/assumptions" class="asm-form">
          ${csrfField(ctx)}
          ${scope ? html`<input type="hidden" name="dept" value="${scope}">` : ""}
          <label class="asm">YoY salary growth <span class="muted">%</span><input name="salary_growth" type="number" min="0" max="100" step="0.5" value="${val(cv.salaryGrowthPct)}" placeholder="${ph("salaryGrowthPct", "0")}"></label>
          <label class="asm">Benefits / load <span class="muted">× base</span><input name="loaded_mult" type="number" min="1" max="3" step="0.01" value="${val(cv.loadedMultiplier)}" placeholder="${ph("loadedMultiplier", "default")}"></label>
          <label class="asm">Target bonus <span class="muted">% of base</span><input name="bonus_pct" type="number" min="0" max="100" step="1" value="${val(cv.bonusPct)}" placeholder="${ph("bonusPct", "0")}"></label>
          <label class="asm">Hiring slippage <span class="muted">months</span><input name="hiring_slip" type="number" min="0" max="24" step="1" value="${val(cv.hiringSlipMonths)}" placeholder="${ph("hiringSlipMonths", "0")}"></label>
          <label class="asm">Cost per hire <span class="muted">one-time $</span><input name="cost_per_hire" type="number" min="0" step="500" value="${val(cv.costPerHire)}" placeholder="${ph("costPerHire", "0")}"></label>
          <button class="btn sm ghost" type="submit">Save</button>
        </form>
        <p class="muted small">Salary growth compounds each year from now forward. Model length is set in the plan bar above.</p>
      </div>
    </details>
  </section>`;
}

/**
 * Inside a plan the roster-mutating actions (End / Restore / Duplicate) are hidden:
 * they write to `employees`, and having them a few pixels from cells that only write
 * plan overrides is how someone ends a real employee while modelling a layoff.
 * A plan row instead offers Reset (drop its overrides) or Remove (delete the hire).
 */
function rowActions(ctx, r, extra, { isAdmin, editable, key }) {
  if (editable && key) {
    const back = html`${csrfField(ctx)}<input type="hidden" name="key" value="${key}">${extra.dept ? html`<input type="hidden" name="dept" value="${extra.dept}">` : ""}${extra.period ? html`<input type="hidden" name="period" value="${extra.period}">` : ""}`;
    if (r.scenario) {
      return html`<td class="act"><form method="post" action="/model/versions/${extra.current.id}/row/reset" class="inline confirm-delete" data-confirm="Remove ${r.name || "this planned hire"} from this plan?">${back}<button class="linklike danger-link" type="submit" title="Remove this planned hire">Remove</button></form></td>`;
    }
    // Both states are rendered; JS flips them the moment a row becomes overridden,
    // so Reset is reachable without a page load.
    const dirty = Boolean(r.overridden);
    return html`<td class="act">
      <form method="post" action="/model/versions/${extra.current.id}/row/reset" class="inline row-reset" ${dirty ? raw("") : raw("hidden")}>${back}<button class="linklike" type="submit" title="Discard this plan's edits to this person">Reset</button></form>
      <span class="muted small row-clean" ${dirty ? raw("hidden") : raw("")}>&mdash;</span>
    </td>`;
  }
  if (!isAdmin || r.id == null) return html`<td class="act"></td>`;
  return html`<td class="act">
    <form method="post" action="/roster/duplicate/${r.id}" class="inline">${csrfField(ctx)}<button class="linklike" type="submit" title="Duplicate this role">Duplicate</button></form>
    ${r.endDate
      ? html`<form method="post" action="/roster/${r.id}/restore" class="inline">${csrfField(ctx)}<button class="linklike" type="submit" title="Clear the end date">Restore</button></form>`
      : html`<form method="post" action="/roster/${r.id}/end" class="inline endform confirm-delete" data-confirm="Remove ${r.name || "this person"} from the model {when}? You can restore them afterwards.">${csrfField(ctx)}<input type="month" name="end_month" class="endmo" aria-label="End month for ${r.name || "this person"}" title="Last month on the books — blank means the end of this month"><button class="linklike danger-link" type="submit" title="Schedule this headcount to end">End</button></form>`}
  </td>`;
}

export function financialModelPage(ctx, model, extra = {}) {
  const { cols, roster, departments, deptMonthlyCost, totalMonthlyCost, monthlyHeadcount, benefitsPct, years } = model;
  const isAdmin = canImportRoster(ctx.user);
  const period = ["month", "quarter", "year"].includes(extra.period) ? extra.period : "month";
  const buckets = periodBuckets(cols, period);
  const groups = yearGroupsOf(cols, buckets);
  const LABELS = 9; // label columns before the period columns
  const editable = Boolean(extra.editable);

  const now = new Date();
  const { nowIdx, nowLabel, curHc, thisYear, thisYearCost, next12Cost, netNew, avgHead } = modelKpis(model, now);

  // Every year but the current one starts collapsed to its year-total column.
  const collapsed = new Set(groups.filter((g) => g.pos.length > 1 && g.year !== thisYear).map((g) => g.year));
  // The bucket the user should land on: the one holding "now".
  const nowBucket = buckets.findIndex((b) => b.idxs.includes(nowIdx));

  const dash = html`<div class="kpis model-kpis">
    ${kpi("Headcount now", n0(curHc), "as of " + nowLabel, "headcount")}
    ${kpi(`${thisYear} spend`, money(thisYearCost), "fully loaded, this year", "spend")}
    ${kpi("Next 12-mo cost", money(next12Cost), "from " + nowLabel, "next12")}
    ${kpi("Net new (12 mo)", `${netNew >= 0 ? "+" : ""}${n0(netNew)}`, "planned change", "netnew")}
    ${kpi("Avg loaded / head", money(avgHead), "per month, now", "avghead")}
    ${kpi("Departments", n0(departments.length), benefitsPct + "% benefits load", "depts")}
  </div>`;

  const allDepts = extra.allDepartments || departments;
  const params = [];
  if (extra.current) params.push("version=" + extra.current.id);
  if (extra.dept) params.push("dept=" + encodeURIComponent(extra.dept));
  const q = (base) => base + (params.length ? (base.includes("?") ? "&" : "?") + params.join("&") : "");
  const periodTab = (p, label) => raw(`<a class="ptab ${p === period ? "on" : ""}" href="${q("/model?period=" + p)}">${label}</a>`);

  // One line: view period, search, department scope, zoom, and the two actions.
  const controls = html`<div class="model-controls">
    <div class="ptabs">${periodTab("month", "Monthly")}${periodTab("quarter", "Quarterly")}${periodTab("year", "Yearly")}</div>
    <input id="f-search" type="search" placeholder="Search name / role" aria-label="Search">
    <select id="f-dept" aria-label="Scope to department"><option value="">All departments</option>${allDepts.map((d) => html`<option value="${d}" ${extra.dept === d ? raw("selected") : ""}>${d}</option>`)}</select>
    <span class="zoomctl"><button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button><span id="zoom-lvl">100%</span><button id="zoom-in" type="button" aria-label="Zoom in">+</button></span>
    <span class="spacer"></span>
    ${editable ? raw('<span id="save-pill" class="save-pill" role="status" aria-live="polite" hidden></span>') : ""}
    <a class="btn ghost sm" href="${q("/budgets/export.csv")}">Export CSV</a>
  </div>`;

  const sortableHead = (key, label, type, cls = "") => raw(`<th class="sortable ${cls}" rowspan="2" data-sort="${key}" data-type="${type}">${label}</th>`);
  const yearGroupHead = groups.map((g) => {
    const multi = g.pos.length > 1;
    const off = collapsed.has(g.year);
    const toggle = multi ? `<button type="button" class="ytoggle" data-year="${g.year}" aria-label="${off ? "Expand" : "Collapse"} ${g.year}">${off ? "+" : "–"}</button> ` : "";
    return raw(`<th class="ygrp" data-year="${g.year}" data-span="${g.pos.length}" colspan="${off ? 1 : g.pos.length}">${toggle}${g.year}</th>`);
  });
  const bucketHead = groups.map((g) => {
    const off = collapsed.has(g.year);
    return html`${g.pos.map((i) => raw(`<th class="mc" data-yb="${g.year}"${i === nowBucket ? ' data-now="1"' : ""}${off ? " hidden" : ""}>${buckets[i].label}</th>`))}${g.pos.length > 1 ? raw(`<th class="mc ytot" data-year="${g.year}"${off ? "" : " hidden"}>${g.year} total</th>`) : ""}`;
  });

  // A row's stable identity: a plan hire it owns, or a real person it may override.
  const rowKey = (r) => (r.scenario ? (r.hireId ? "hire:" + r.hireId : "") : (r.extId ? "emp:" + r.extId : ""));
  const ov = (r, f) => Boolean(r.overridden && r.overridden[f]);
  /** An editable cell, or its read-only text when the sheet isn't editable. */
  const cell = (r, field, type, value, text, cls = "num") => {
    const key = rowKey(r);
    if (!editable || !key) return raw(`<td class="${cls}">${esc(text)}</td>`);
    const mark = r.scenario || ov(r, field === "start" ? "start_date" : field === "end" ? "end_date" : field === "salary" ? "annual_salary" : "name");
    const attrs = type === "number" ? ' min="0" step="1000"' : "";
    return raw(`<td class="${cls} cell${mark ? " ovr" : ""}" data-cell="${field}">` +
      `<input class="cell-input" type="${type}"${attrs} data-key="${esc(key)}" data-field="${field}" value="${esc(value)}" aria-label="${esc(field)} for ${esc(r.name || "row")}"></td>`);
  };

  const prowFor = (r) => {
    const per = periodize(r.monthlyCost, buckets, "sum");
    const key = rowKey(r);
    const startsText = r.hireMonthLabel === "From start" ? "—" : r.hireMonthLabel;
    const endsText = r.endDate ? String(r.endDate).slice(0, 7) : "—";
    return html`<tr class="${cx("prow", r.scenario && "scn", r.endDate && "ends")}" data-key="${key}" data-dept="${r.department}" data-name="${(r.name || "").toLowerCase()}" data-role="${(r.role || "").toLowerCase()}" data-status="${(r.status || "").toLowerCase()}" data-start="${r.startDate || ""}" data-end="${r.endDate || ""}" data-salary="${Math.round(r.annualBase)}" data-loaded="${Math.round(r.loadedMonthly)}">
      ${cell(r, "name", "text", r.name || "", r.name || "—", "rowhead")}
      <td>${r.department}</td>
      <td>${r.role}</td>
      <td class="st">${r.status}</td>
      ${cell(r, "start", "month", String(r.startDate || "").slice(0, 7), startsText)}
      ${cell(r, "end", "month", String(r.endDate || "").slice(0, 7), endsText)}
      ${cell(r, "salary", "number", String(Math.round(r.annualBase)), n0(r.annualBase))}
      <td class="num loaded">${n0(r.loadedMonthly)}</td>
      ${rowActions(ctx, r, extra, { isAdmin, editable, key })}
      ${yearCells(per, groups, collapsed)}
    </tr>`;
  };

  const grandTotal = html`<tr class="grp total-grp">
    <td class="rowhead grplabel"><b>Total fully-loaded cost</b></td>
    <td class="grpfill" colspan="${LABELS - 1}"></td>
    ${yearCells(periodize(totalMonthlyCost, buckets, "sum"), groups, collapsed)}
  </tr>`;

  const deptBlocks = departments.map((d) => {
    const members = roster.filter((r) => r.department === d);
    const sub = periodize(deptMonthlyCost[d], buckets, "sum");
    const head = html`<tr class="grp" data-dept="${d}">
      <td class="rowhead grplabel"><button type="button" class="grptoggle" data-dept="${d}" aria-label="Collapse ${d}">▾</button> <b>${d}</b> <span class="muted">(${members.length})</span></td>
      <td class="grpfill" colspan="${LABELS - 1}"></td>
      ${yearCells(sub, groups, collapsed)}
    </tr>`;
    return html`${head}${members.map(prowFor)}`;
  });

  const rosterTable = html`<table id="model-sheet" class="sheet model outline" data-version="${extra.current ? extra.current.id : ""}" data-period="${period}" data-dept="${extra.dept || ""}" data-editable="${editable ? "1" : ""}" data-windowkey="${windowKey(model, period)}">
    <thead>
      <tr>
        ${sortableHead("name", "Name", "text", "rowhead")}
        ${sortableHead("dept", "Department", "text")}
        ${sortableHead("role", "Role / Title", "text")}
        ${sortableHead("status", "Status", "text")}
        ${sortableHead("start", "Starts", "text")}
        ${sortableHead("end", "Ends", "text")}
        ${sortableHead("salary", "Annual Base", "num")}
        ${sortableHead("loaded", "Loaded Mo", "num")}
        <th rowspan="2" class="acth">Actions</th>
        ${yearGroupHead}
      </tr>
      <tr>${bucketHead}</tr>
    </thead>
    <tbody id="roster-body">
      ${roster.length ? html`${grandTotal}${deptBlocks}` : html`<tr><td class="rowhead">—</td><td colspan="${LABELS - 1 + buckets.length}" class="muted">No roster yet. Import a roster (include a start-date column) to build the model.</td></tr>`}
    </tbody>
  </table>`;

  // One row per year in the window — a 10-year model gets 10 rows, not a first-vs-last
  // summary that quietly hides everything in between.
  const summary = years.length ? (() => {
    const rows = years.map((y, i) => {
      const prev = i > 0 ? years[i - 1] : null;
      // A partial first/last year would make YoY nonsense, so we don't print one.
      const comparable = prev && prev.months === 12 && y.months === 12;
      const yoy = comparable ? pctChg(y.totalCost, prev.totalCost) : null;
      return html`<tr data-year="${y.year}">
        <td class="rowhead">${y.year}${y.months < 12 ? html` <span class="muted">(${y.months} mo)</span>` : ""}</td>
        <td class="num">${n0(y.yearEndHc)}</td>
        <td class="num">${money(y.totalCost)}</td>
        <td class="num">${n0(y.avgHc)}</td>
        <td class="num">${money(y.avgCostPerHead)}</td>
        <td class="num ${yoy != null && yoy > 0 ? "up" : yoy != null && yoy < 0 ? "down" : ""}">${yoy == null ? "—" : (yoy > 0 ? "+" : "") + yoy + "%"}</td>
      </tr>`;
    });
    return html`<h2 class="sum-h">Annual summary <span class="hint">every year in the model</span></h2>
      <table id="annual-summary" class="sheet summary">
        <thead><tr>
          <th class="rowhead">Year</th><th class="num">Year-end headcount</th><th class="num">Total fully-loaded cost</th>
          <th class="num">Avg monthly headcount</th><th class="num">Avg loaded / head</th><th class="num">YoY cost</th>
        </tr></thead>
        <tbody>${rows}</tbody></table>`;
  })() : "";

  const range = cols.length ? `${cols[0].fullLabel} – ${cols[cols.length - 1].fullLabel}` : "";
  const body = html`
    <div class="hm-line">Headcount model${extra.dept ? " · " + extra.dept : ""} <span class="muted">${range} · fully loaded (base + ${benefitsPct}% benefits/taxes)</span></div>
    ${dash}
    ${controls}
    ${planBar(ctx, extra)}
    ${planEditor(ctx, extra)}
    ${editable ? html`<input type="hidden" id="model-csrf" value="${ctx.csrf}">
      <p class="muted small edit-hint">Editing <b>${extra.current.name}</b>. Name, start, end and salary save as you go, and change only this plan — the roster stays as imported. <b>Reset</b> puts a person back to their real values.</p>` : ""}
    <div class="sheet-wrap">${rosterTable}</div>
    ${summary}
    <script src="/static/model.js" defer></script>`;
  return renderPage(ctx, { title: "Financial model", body, active: "model" });
}
