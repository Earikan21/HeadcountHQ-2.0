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
    "(e.g. which departments are over/under target, budget or runway risks, what to " +
    "prioritize). If the data doesn't contain the answer, say so plainly. Keep total " +
    "response under ~200 words. Plain text, not markdown tables.";
  const user = `DATA:\n${str(context, 6000)}\n\nQUESTION: ${str(question, 500)}`;
  return client.chat(system, user, 700);
}
