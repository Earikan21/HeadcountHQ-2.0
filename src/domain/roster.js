/**
 * Roster import engine — pure functions, no DB, no HTTP. Ported and adapted from
 * the original Headcount HQ prototype: canonical schema, column auto-mapping,
 * compensation normalization, row validation, department roll-up, and salary
 * banding (for role-based compensation visibility).
 */

// Canonical fields every roster is normalized into. `syn` = normalized header
// synonyms used for auto-mapping. `required` blocks import if missing.
export const SCHEMA = [
  { key: "employee_id",         label: "Employee ID",         required: true,  syn: ["employeeid","empid","id","eid","employeenumber","empno","workerid"] },
  { key: "first_name",          label: "First name",          required: false, syn: ["firstname","first","givenname","forename","fname","givenname"] },
  { key: "last_name",           label: "Last name",           required: false, syn: ["lastname","last","surname","familyname","lname","famname"] },
  { key: "name",                label: "Full name",           required: false, syn: ["name","fullname","employeename","employee","workername","displayname"] },
  { key: "department",          label: "Department",          required: true,  syn: ["department","dept","team","division","orgunit","businessunit"] },
  { key: "job_title",           label: "Job Title",           required: false, syn: ["jobtitle","title","jobtitles","role","position","jobrole"] },
  { key: "compensation_amount", label: "Compensation Amount", required: true,  syn: ["compensationamount","compamount","compensation","salary","pay","basepay","basesalary","amount","rate","baserate"] },
  { key: "compensation_unit",   label: "Compensation Unit",   required: false, syn: ["compensationunit","compunit","payunit","salaryunit","unit","payfrequency","frequency","perperiod","period"] },
  { key: "manager",             label: "Manager",             required: false, syn: ["manager","managername","reportsto","supervisor","managers"] },
  { key: "employee_type",       label: "Employee Type",       required: false, syn: ["employeetype","emptype","workertype","type","classification","fteclass"] },
  { key: "employment_status",   label: "Employment Status",   required: false, syn: ["employmentstatus","status","empstatus","activestatus","workerstatus"] },
];

export const DEFAULT_ASSUMPTIONS = { hoursPerYear: 2080, daysPerYear: 260, weeksPerYear: 52 };
export const EXPORT_COLS = ["employee_id","name","department","job_title","manager","employee_type","employment_status","compensation_amount","compensation_unit","annual_salary"];

/** Fields that can satisfy the "name" requirement (any one is enough). */
export const NAME_FIELDS = ["name", "first_name", "last_name"];

/**
 * Validate a column mapping. Returns a list of human-readable problems.
 * Name is special: a single Name column OR a First/Last name column will do.
 */
export function mappingProblems(mapping) {
  const missing = [];
  for (const f of SCHEMA) {
    if (f.required && !mapping[f.key]) missing.push(f.label);
  }
  if (!NAME_FIELDS.some((k) => mapping[k])) missing.push("Name (or First/Last name)");
  return missing;
}

export const normHeader = (h) => String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Auto-map source headers to canonical keys. Returns { mapping, confidence }.
 *
 * Two phases so that EXACT synonym matches always win over fuzzy substring
 * matches anywhere in the schema (e.g. "Full Name" must map to Name, not get
 * grabbed by Last name's loose "lname" substring).
 */
export function autoMap(headers) {
  const used = new Set();
  const mapping = {};
  const confidence = {};
  for (const f of SCHEMA) { mapping[f.key] = null; confidence[f.key] = "none"; }
  const normed = headers.map((h) => ({ raw: h, n: normHeader(h) }));

  // Phase 1: exact synonym match.
  for (const field of SCHEMA) {
    for (const h of normed) {
      if (used.has(h.raw)) continue;
      if (field.syn.includes(h.n)) { mapping[field.key] = h.raw; confidence[field.key] = "high"; used.add(h.raw); break; }
    }
  }
  // Phase 2: fuzzy substring match for anything still unmapped.
  for (const field of SCHEMA) {
    if (mapping[field.key]) continue;
    for (const h of normed) {
      if (used.has(h.raw)) continue;
      if (field.syn.some((sx) => h.n.includes(sx) || sx.includes(h.n))) { mapping[field.key] = h.raw; confidence[field.key] = "low"; used.add(h.raw); break; }
    }
  }
  return { mapping, confidence };
}

/** Parse a money-ish string: "$120,000", "95k", "4,800", " 42.50 ". */
export function parseAmount(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).trim().toLowerCase().replace(/[$,\s]/g, "");
  if (s === "") return null;
  let mult = 1;
  if (s.endsWith("k")) { mult = 1000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1e6; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isFinite(n) ? n * mult : null;
}

const UNIT_MAP = [
  ["hourly",      ["hour","hourly","hr","perhour","phr","perhr"]],
  ["daily",       ["day","daily","perday","perdiem","diem"]],
  ["weekly",      ["week","weekly","perweek"]],
  ["biweekly",    ["biweekly","fortnightly","fortnight","every2weeks","every2wk"]],
  ["semimonthly", ["semimonthly","twicemonthly","twiceamonth"]],
  ["monthly",     ["month","monthly","permonth","mo"]],
  ["annual",      ["annual","annually","year","yearly","peryear","perannum","pa","salary","salaried"]],
];
export function normUnit(v) {
  const n = normHeader(v);
  if (!n) return null;
  for (const [key, syns] of UNIT_MAP) if (syns.includes(n)) return key;
  for (const [key, syns] of UNIT_MAP) if (syns.some((sx) => n.includes(sx))) return key;
  return null;
}

export function toAnnual(amount, unitKey, a = DEFAULT_ASSUMPTIONS) {
  if (amount == null) return null;
  switch (unitKey) {
    case "annual":      return amount;
    case "monthly":     return amount * 12;
    case "semimonthly": return amount * 24;
    case "biweekly":    return amount * 26;
    case "weekly":      return amount * a.weeksPerYear;
    case "daily":       return amount * a.daysPerYear;
    case "hourly":      return amount * a.hoursPerYear;
    default:            return null;
  }
}

export function normStatus(v) {
  const n = normHeader(v);
  if (!n) return null;
  if (["active","current","employed","fulltime","parttime","a"].includes(n)) return "active";
  if (n.includes("active") && !n.includes("inactive")) return "active";
  if (["terminated","inactive","left","separated","resigned","ended","former","t"].some((sx) => n.includes(sx))) return "inactive";
  if (["leave","loa","sabbatical","furlough"].some((sx) => n.includes(sx))) return "leave";
  return null;
}

/** Round an annual salary into a band label, e.g. 137000 -> "$125k–$150k". */
export function band(annual, width = 25000) {
  if (annual == null || !isFinite(annual)) return null;
  const lo = Math.floor(annual / width) * width;
  const hi = lo + width;
  const k = (n) => "$" + Math.round(n / 1000) + "k";
  return `${k(lo)}–${k(hi)}`;
}

/**
 * Build the canonical dataset from raw rows + a column mapping.
 * Returns { rows, summary }. Each row has _issues, _ok, _status, annual_salary.
 */
export function buildCanonical(rawRows, mapping, assumptions, opts = {}) {
  assumptions = { ...DEFAULT_ASSUMPTIONS, ...(assumptions || {}) };
  const get = (row, key) => (mapping[key] ? row[mapping[key]] : undefined);
  const seenIds = new Map();
  const rows = [];

  rawRows.forEach((raw, i) => {
    const issues = [];
    const id = (get(raw, "employee_id") ?? "").toString().trim();
    const singleName = (get(raw, "name") ?? "").toString().trim();
    const firstName = (get(raw, "first_name") ?? "").toString().trim();
    const lastName = (get(raw, "last_name") ?? "").toString().trim();
    const name = singleName || [firstName, lastName].filter(Boolean).join(" ").trim();
    const dept = (get(raw, "department") ?? "").toString().trim();
    const title = (get(raw, "job_title") ?? "").toString().trim();
    const rawAmount = get(raw, "compensation_amount");
    const amount = parseAmount(rawAmount);
    const unitKey = normUnit(get(raw, "compensation_unit")) || "annual";
    const status = normStatus(get(raw, "employment_status"));
    const annual = toAnnual(amount, unitKey, assumptions);

    if (!id) issues.push({ level: "error", field: "employee_id", msg: "Missing Employee ID" });
    if (!name) issues.push({ level: "error", field: "name", msg: "Missing Name" });
    if (!dept) issues.push({ level: "error", field: "department", msg: "Missing Department" });

    if (id) {
      if (seenIds.has(id)) issues.push({ level: "warn", field: "employee_id", msg: "Duplicate Employee ID (row " + (seenIds.get(id) + 1) + ")" });
      else seenIds.set(id, i);
    }

    if (rawAmount == null || String(rawAmount).trim() === "") {
      issues.push({ level: "error", field: "compensation_amount", msg: "Missing compensation" });
    } else if (amount == null) {
      issues.push({ level: "error", field: "compensation_amount", msg: 'Compensation not a number: "' + rawAmount + '"' });
    } else if (amount <= 0) {
      issues.push({ level: "error", field: "compensation_amount", msg: "Compensation must be greater than 0" });
    }
    if (amount != null && amount > 0 && unitKey === "hourly") {
      issues.push({ level: "info", field: "compensation_amount", msg: "Hourly pay annualized at " + assumptions.hoursPerYear + " hrs/yr" });
    }

    const rawStatus = get(raw, "employment_status");
    if (rawStatus != null && String(rawStatus).trim() !== "" && !status) {
      issues.push({ level: "warn", field: "employment_status", msg: 'Unrecognized status: "' + rawStatus + '"' });
    }

    const hasError = issues.some((x) => x.level === "error");
    rows.push({
      _row: i + 1,
      employee_id: id, name, department: dept, job_title: title,
      manager: (get(raw, "manager") ?? "").toString().trim(),
      employee_type: (get(raw, "employee_type") ?? "").toString().trim(),
      employment_status: status || (rawStatus ?? "").toString().trim(),
      compensation_amount: amount,
      compensation_unit: unitKey,
      annual_salary: annual,
      _status: status,
      _issues: issues,
      _ok: !hasError,
    });
  });

  const errors = rows.reduce((a, r) => a + r._issues.filter((x) => x.level === "error").length, 0);
  const warns = rows.reduce((a, r) => a + r._issues.filter((x) => x.level === "warn").length, 0);
  const clean = rows.filter((r) => r._ok).length;
  return { rows, assumptions, summary: { total: rows.length, clean, withErrors: rows.length - clean, errors, warns } };
}

/** Department roll-up from canonical rows (active counts toward headcount). */
export function rollup(canonRows, opts = {}) {
  const countable = (r) => r._ok && !(opts.excludeInactive && r._status === "inactive");
  const by = {};
  let totalHc = 0, totalCost = 0;
  for (const r of canonRows) {
    if (!countable(r)) continue;
    const d = r.department || "(none)";
    by[d] = by[d] || { department: d, headcount: 0, annualCost: 0 };
    by[d].headcount += 1;
    by[d].annualCost += r.annual_salary || 0;
    totalHc += 1;
    totalCost += r.annual_salary || 0;
  }
  const departments = Object.values(by)
    .map((d) => ({ ...d, avgCost: d.headcount ? Math.round(d.annualCost / d.headcount) : 0 }))
    .sort((a, b) => b.annualCost - a.annualCost);
  return { departments, totals: { headcount: totalHc, annualCost: totalCost, avgCost: totalHc ? Math.round(totalCost / totalHc) : 0 } };
}
