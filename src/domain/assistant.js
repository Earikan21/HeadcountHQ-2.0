/**
 * Headcount assistant — the AI capabilities beyond import: drafting hiring-request
 * justifications, estimating a role's cost/band, and answering + advising on the
 * company's own headcount data.
 *
 * Guardrails (per Directive 2.0): the assistant NEVER fabricates dollar ROI for a
 * role with no real driver, and answers about company data only from the context
 * it is given. Estimates are clearly framed as rough planning numbers. All output
 * is advisory — a human confirms before anything is saved.
 *
 * These use LlmClient.chat (the generic text path). No deterministic fallback:
 * callers handle failures and keep the human's own input.
 */
import { parseJsonObject } from "./llm_client.js";

// The assistant reuses the import feature's client factory (same provider/key).
export { clientFromConfig } from "./ai_import.js";

const str = (v, cap = 1200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, cap);

/**
 * Draft / strengthen a hiring-request justification from the manager's rough notes.
 * @returns {Promise<{justification:string,current_hc_narrative:string,new_hc_narrative:string,expected_value_basis:string}>}
 */
export async function draftJustification({ role, department, type, justification, current, desired, targetNote, client }) {
  if (!client || !client.configured) throw new Error("Assistant not configured.");
  const system =
    "You help a hiring manager write a crisp, honest justification for a headcount " +
    "request at a startup. Be specific and grounded. Do NOT invent metrics, dollar " +
    "figures, or ROI that the manager didn't provide — if there is no hard number, " +
    "keep the case qualitative. Respond with a SINGLE JSON object, no prose.";
  const user =
`Role: ${str(role, 160)}
Department: ${str(department, 120)}
Type: ${str(type, 40)}
${targetNote ? "Target context: " + str(targetNote, 300) + "\n" : ""}Manager's rough notes:
- Business justification: ${str(justification) || "(none)"}
- What they do with CURRENT headcount: ${str(current) || "(none)"}
- What they'd do with the NEW hire: ${str(desired) || "(none)"}

Return JSON: {"justification":"...","current_hc_narrative":"...","new_hc_narrative":"...","expected_value_basis":"qualitative|benchmark|revenue_driver"}.
Improve/expand each into 2-4 clear, specific sentences. If the department is under its target, you may cite the benchmark gap and set expected_value_basis to "benchmark". Only use "revenue_driver" if the manager gave a real revenue link. Otherwise "qualitative". Do NOT fabricate dollar amounts.`;
  const text = await client.chat(system, user, 900);
  const obj = parseJsonObject(text);
  const basis = ["qualitative", "benchmark", "revenue_driver"].includes(obj.expected_value_basis) ? obj.expected_value_basis : "qualitative";
  return {
    justification: str(obj.justification, 1500),
    current_hc_narrative: str(obj.current_hc_narrative, 1500),
    new_hc_narrative: str(obj.new_hc_narrative, 1500),
    expected_value_basis: basis,
  };
}

/**
 * Estimate a realistic annual base-salary band for a proposed role.
 * @returns {Promise<{band_min:number,band_max:number,rationale:string}>}
 */
export async function estimateRole({ title, department, phase, industry, client }) {
  if (!client || !client.configured) throw new Error("Assistant not configured.");
  const system =
    "You estimate a realistic ANNUAL BASE SALARY band (USD) for a role at a startup, " +
    "given the role, department, company stage, and industry. These are rough " +
    "planning estimates, not offers. Respond with a SINGLE JSON object, no prose.";
  const user =
`Role: ${str(title, 160)}
Department: ${str(department, 120)}
Company stage: ${str(phase, 40)}
Industry: ${str(industry, 60)}

Return JSON: {"band_min": <number>, "band_max": <number>, "rationale": "one short sentence"}.
Both numbers are annual base salary in USD, band_min < band_max, realistic for the stage/industry.`;
  const text = await client.chat(system, user, 400);
  const obj = parseJsonObject(text);
  const min = Number(obj.band_min), max = Number(obj.band_max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new Error("Estimate came back malformed.");
  }
  return { band_min: Math.round(min), band_max: Math.round(max), rationale: str(obj.rationale, 240) };
}

/**
 * Answer a question about the company's headcount data AND offer concrete
 * recommendations, using ONLY the provided context. Returns plain text.
 */
export async function answerQuestion({ question, context, client }) {
  if (!client || !client.configured) throw new Error("Assistant not configured.");
  const system =
    "You are a headcount-planning assistant for a startup's finance team. Answer the " +
    "user's question using ONLY the DATA provided — never invent numbers. Be concise " +
    "and specific, citing the actual figures. Then, when the data supports it, add a " +
    "short 'Recommendations' section with 1-3 concrete, actionable suggestions " +
    "(e.g. which departments are over/under target, budget risks, what to " +
    "prioritize). If the data doesn't contain the answer, say so plainly. Keep total " +
    "response under ~200 words. Plain text, not markdown tables.";
  const user = `DATA:\n${str(context, 6000)}\n\nQUESTION: ${str(question, 500)}`;
  return client.chat(system, user, 700);
}

/**
 * Parse a plain-English hiring what-if into structured scenario hires.
 * @returns {Promise<Array<{department:string,role:string,start_month:string|null,annual_salary:number,count:number}>>}
 */
/** A salary basis the model may cite instead of a number; the server does the math. */
const SALARY_BASES = ["dept_avg", "dept_median", "dept_min", "dept_max", "company_avg", "company_median"];

/** Resolve a cited basis (e.g. "dept_avg") to a real figure from the roster stats. */
function resolveSalaryBasis(basis, deptName, payStats) {
  if (!basis || !payStats) return 0;
  const dept = (payStats.departments || []).find((d) => String(d.name).toLowerCase() === String(deptName).toLowerCase());
  const company = payStats.company || {};
  switch (String(basis).toLowerCase()) {
    case "dept_avg": return (dept && dept.avg) || company.avg || 0;      // fall back to company if the dept is new/empty
    case "dept_median": return (dept && dept.median) || company.median || 0;
    case "dept_min": return (dept && dept.min) || 0;
    case "dept_max": return (dept && dept.max) || 0;
    case "company_avg": return company.avg || 0;
    case "company_median": return company.median || 0;
    default: return 0;
  }
}

/**
 * Turn a plain-English hiring what-if into structured hires.
 *
 * `payStats` (from departmentPayStats) is the key to "pay them the department
 * average": rather than trust the model to average salaries — which it does badly — we
 * let it cite a `salary_basis` and resolve the actual number here, in code. An explicit
 * number in the text is still honoured; the basis only fills the salary when the user
 * asked for a statistic.
 */
export async function parseScenarioHires({ description, departments = [], payStats = null, now = new Date(), client }) {
  if (!client || !client.configured) throw new Error("Assistant not configured.");
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const statLine = payStats && payStats.departments && payStats.departments.length
    ? "Department pay (annual base, from the roster): " +
      payStats.departments.map((d) => `${d.name} avg ${d.avg}, median ${d.median}, range ${d.min}-${d.max} (n=${d.count})`).join("; ") +
      `. Company avg ${payStats.company.avg}, median ${payStats.company.median}.`
    : "Department pay figures are unavailable.";
  const system =
    "You convert a hiring what-if described in plain English into structured hires for a forward-looking plan. " +
    'Respond with a SINGLE JSON object, either {"hires":[{"department":"","role":"","start_month":"YYYY-MM","annual_salary":0,"salary_basis":null,"count":1}]} ' +
    'OR, when the request is ambiguous or missing key details, {"question":"<one short clarifying question>"}. Nothing else (no prose, no markdown).';
  const user =
`Known departments: ${departments.join(", ") || "(none)"}
${statLine}
The current month is ${nowMonth}.

Turn this into hires: ${str(description, 500)}

Rules:
- start_month must be "YYYY-MM", and it must be ${nowMonth} or LATER — never earlier. Plans only project forward from today; you cannot hire in the past. Use null if the timing is unspecified.
- If the user asks to start someone in the past, or the timing/department/count/salary is unclear or missing, do NOT guess. Return {"question":"..."} with a single clarifying question and no hires.
- count is an integer (default 1). Prefer an existing department name when the text clearly matches one.
- Salary: if the text gives an explicit amount, put that plain number (no $ or commas) in "annual_salary" and leave "salary_basis" null. Salaries are ANNUAL — multiply a monthly figure by 12.
- If instead the pay should follow a department or company statistic (e.g. "the department average", "median pay", "top of the band"), set "annual_salary" to 0 and set "salary_basis" to exactly one of: ${SALARY_BASES.join(", ")}. Do NOT compute the number yourself — the system fills it from the figures above.`;
  const text = await client.chat(system, user, 2000);
  const obj = parseJsonObject(text);
  const rawHires = Array.isArray(obj.hires) ? obj.hires : [];
  const hires = rawHires.map((h) => {
    const department = String(h.department || "").slice(0, 60).trim() || "(scenario)";
    const basis = SALARY_BASES.includes(String(h.salary_basis || "").toLowerCase()) ? String(h.salary_basis).toLowerCase() : null;
    const explicit = Number(h.annual_salary) || 0;
    const annual_salary = explicit > 0 ? explicit : (basis ? resolveSalaryBasis(basis, department, payStats) : 0);
    const sm = String(h.start_month || "");
    // Never accept a start in the past — plans only project forward.
    const start_month = /^\d{4}-\d{2}$/.test(sm) && sm >= nowMonth ? sm : null;
    return {
      department,
      role: String(h.role || "Scenario hire").slice(0, 60).trim(),
      start_month,
      annual_salary: Math.round(annual_salary),
      count: Math.max(1, Math.min(200, Number(h.count) || 1)),
    };
  }).filter((h) => h.annual_salary > 0);
  // Arrays are objects: carry a clarifying question alongside (route asks before adding).
  const question = typeof obj.question === "string" ? obj.question.trim().slice(0, 240) : "";
  if (question) hires.question = question;
  return hires;
}
