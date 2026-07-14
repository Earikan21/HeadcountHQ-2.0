/**
 * Editing one cell of a plan's spreadsheet.
 *
 * Two kinds of row live on that sheet, and they persist differently:
 *
 *   hire:<id>  a person invented by the plan. The value is written straight onto the
 *              hire record — the plan owns it outright.
 *   emp:<extId> a real person on the roster. The value is written as a SPARSE OVERRIDE
 *              on the plan. The roster is never touched, so "base case" and "board
 *              plan" can disagree about the same person and Actual stays true.
 *
 * The sparseness is load-bearing. Writing a value equal to the person's real one
 * *deletes* the override rather than storing a redundant copy — otherwise "reset this
 * row" would slowly stop meaning anything, and a later roster import would be shadowed
 * by overrides the user never knowingly set.
 *
 * A key present with a `null` value is a deliberate clear ("in this plan, they never
 * leave"), which is different from the key being absent. Both are representable.
 */

const MAX_SALARY = 100_000_000;
const MAX_NAME = 80;
const MONTH_RE = /^\d{4}-\d{2}$/;
export const EDITABLE_FIELDS = ["name", "start", "end", "salary"];

/** "2027-06" -> "2027-06-01" */
export const monthStart = (m) => `${m}-01`;
/** "2027-06" -> "2027-06-30" (and February knows about leap years) */
export const monthEnd = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};
/** Compare dates at the granularity the model actually uses: the month. */
const sameMonth = (a, b) => String(a || "").slice(0, 7) === String(b || "").slice(0, 7);

/** Validate and normalise the raw request body into an edit, or explain why not. */
export function parseCellEdit(body = {}) {
  const key = String(body.key || "");
  const field = String(body.field || "");
  const raw = body.value == null ? "" : String(body.value);

  if (!/^(emp:.+|hire:.+)$/.test(key)) return { error: "Unknown row." };
  if (!EDITABLE_FIELDS.includes(field)) return { error: "That column isn't editable." };

  if (field === "salary") {
    const trimmed = raw.trim();
    if (trimmed === "") return { error: "Enter a salary greater than 0." };
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { error: "Salary must be a number." };
    if (n <= 0) return { error: "Salary must be greater than 0." };
    if (n > MAX_SALARY) return { error: "That salary looks like a typo." };
    return { key, field, value: Math.round(n) };
  }

  if (field === "start" || field === "end") {
    const m = raw.trim();
    if (m !== "" && !MONTH_RE.test(m)) return { error: "Use a month like 2027-06." };
    return { key, field, value: m };
  }

  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > MAX_NAME) return { error: `Keep the name under ${MAX_NAME} characters.` };
  return { key, field, value: name };
}

/** The effective start/end months of a row once this edit lands. */
function windowAfter({ field, value }, curStart, curEnd) {
  const s = field === "start" ? value : String(curStart || "").slice(0, 7);
  const e = field === "end" ? value : String(curEnd || "").slice(0, 7);
  return { s, e };
}

/**
 * Apply a parsed edit. Pure: returns the new `hires` or `overrides` to persist and
 * the normalised value to echo back to the input, or an `error`. Never mutates its
 * arguments — the caller owns the write.
 */
export function applyCellEdit({ edit, roster = [], hires = [], overrides = {} }) {
  const { key, field, value } = edit;

  // ---- a person the plan invented -----------------------------------------
  if (key.startsWith("hire:")) {
    const hid = key.slice(5);
    const idx = hires.findIndex((h) => String(h.id) === hid);
    if (idx < 0) return { error: "That planned hire is gone — reload." };
    const h = hires[idx];

    const { s, e } = windowAfter(edit, h.start_month, h.end_month);
    if (s && e && e < s) return { error: "The end month can't come before the start month." };

    const next = { ...h };
    if (field === "name") next.name = value || h.role || "Hire";
    else if (field === "salary") next.annual_salary = value;
    else if (field === "start") next.start_month = value || null;
    else next.end_month = value || null;

    const out = hires.slice();
    out[idx] = next;
    return {
      hires: out,
      overridden: true, // a scenario hire is always plan-local
      marks: { name: true, start: true, end: true, salary: true },
      value: field === "name" ? next.name
        : field === "salary" ? String(next.annual_salary)
        : field === "start" ? (next.start_month || "")
        : (next.end_month || ""),
    };
  }

  // ---- a real person, overridden only within this plan ----------------------
  const extId = key.slice(4);
  const actual = roster.find((r) => String(r.employee_ext_id) === extId);
  if (!actual) return { error: "That person is no longer on the roster — reload." };

  const cur = { ...(overrides[extId] || {}) };
  const has = (f) => Object.prototype.hasOwnProperty.call(cur, f);
  const effStart = has("start_date") ? cur.start_date : actual.start_date;
  const effEnd = has("end_date") ? cur.end_date : actual.end_date;

  const { s, e } = windowAfter(edit, effStart, effEnd);
  if (s && e && e < s) return { error: "The end month can't come before the start month." };

  let echo;
  if (field === "name") {
    // An emptied name means "use the real one", not "this person has no name".
    if (!value || value === actual.name) delete cur.name;
    else cur.name = value;
    echo = cur.name || actual.name || "";
  } else if (field === "salary") {
    if (value === Math.round(Number(actual.annual_salary) || 0)) delete cur.annual_salary;
    else cur.annual_salary = value;
    echo = String(has("annual_salary") ? cur.annual_salary : Math.round(Number(actual.annual_salary) || 0));
  } else {
    const col = field === "start" ? "start_date" : "end_date";
    const real = field === "start" ? actual.start_date : actual.end_date;
    if (sameMonth(value, real)) {
      delete cur[col]; // matches the roster (including both being empty) — no override
    } else if (value === "") {
      cur[col] = null; // deliberately cleared for this plan
    } else {
      cur[col] = field === "start" ? monthStart(value) : monthEnd(value);
    }
    const eff = Object.prototype.hasOwnProperty.call(cur, col) ? cur[col] : real;
    echo = eff ? String(eff).slice(0, 7) : "";
  }

  const out = { ...overrides };
  if (Object.keys(cur).length) out[extId] = cur;
  else delete out[extId]; // fully reset — the row is plain roster truth again

  const held = (f) => Object.prototype.hasOwnProperty.call(out[extId] || {}, f);
  return {
    overrides: out,
    overridden: Boolean(out[extId]),
    marks: { name: held("name"), start: held("start_date"), end: held("end_date"), salary: held("annual_salary") },
    value: echo,
   };
}
