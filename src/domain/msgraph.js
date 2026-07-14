/**
 * Microsoft Graph client for the one-way Excel Online live link.
 *
 * Delegated OAuth 2.0 auth-code flow with PKCE (no implicit grant, no secret in the
 * browser). We keep the refresh token (encrypted, elsewhere) and mint short-lived
 * access tokens on demand, then PATCH the model into one worksheet as FORMULAS so the
 * workbook recalculates and any tab linking to it updates.
 *
 * Every network call goes through an injectable `fetchImpl` so the flow is testable
 * without contacting Microsoft.
 */
import { randomBytes, createHash } from "node:crypto";

export const SCOPES = "offline_access Files.ReadWrite User.Read";
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const authority = (tenant) => `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0`;
const GRAPH = "https://graph.microsoft.com/v1.0";

/** A PKCE verifier + its S256 challenge. */
export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The Microsoft sign-in URL to redirect the user to. */
export function authUrl({ clientId, redirectUri, tenant, state, challenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${authority(tenant)}/authorize?${p.toString()}`;
}

async function tokenRequest(config, params, fetchImpl) {
  const body = new URLSearchParams({
    client_id: config.MSFT_CLIENT_ID,
    client_secret: config.MSFT_CLIENT_SECRET,
    redirect_uri: config.MSFT_REDIRECT_URI,
    ...params,
  });
  const res = await fetchImpl(`${authority(config.MSFT_TENANT)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data; // { access_token, refresh_token, expires_in, ... }
}

export const exchangeCode = ({ config, code, verifier, fetchImpl = globalThis.fetch }) =>
  tokenRequest(config, { grant_type: "authorization_code", code, code_verifier: verifier }, fetchImpl);

export const refreshAccessToken = ({ config, refreshToken, fetchImpl = globalThis.fetch }) =>
  tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES }, fetchImpl);

async function graph(accessToken, method, path, body, fetchImpl) {
  const res = await fetchImpl(GRAPH + path, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code)) || res.status;
    const e = new Error(`Graph ${method} ${path.split("?")[0]} failed: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** Fetch the signed-in account's email (for display). */
export async function whoAmI({ accessToken, fetchImpl = globalThis.fetch }) {
  const me = await graph(accessToken, "GET", "/me?$select=userPrincipalName,mail,displayName", undefined, fetchImpl);
  return me.mail || me.userPrincipalName || me.displayName || "";
}

/** List the signed-in user's Excel workbooks (for choosing a push target). */
export async function searchWorkbooks({ accessToken, fetchImpl = globalThis.fetch }) {
  const data = await graph(accessToken, "GET", "/me/drive/root/search(q='.xlsx')?$select=id,name,webUrl&$top=50", undefined, fetchImpl);
  return (data.value || [])
    .filter((f) => /\.xlsx$/i.test(f.name || ""))
    .map((f) => ({ id: f.id, name: f.name, webUrl: f.webUrl }));
}

/** A1 helpers. */
const colLetter = (n) => { let s = ""; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/**
 * Push the matrix (2D array of formulas/values) into `worksheet` starting at A1.
 * Creates the worksheet if missing, clears a generous area to drop stale cells, then
 * writes the whole block. Returns { rows, cols }.
 */
export async function pushMatrix({ accessToken, itemId, worksheet, matrix, fetchImpl = globalThis.fetch }) {
  const base = `/me/drive/items/${encodeURIComponent(itemId)}/workbook`;
  const ws = encodeURIComponent(worksheet);

  // Ensure the worksheet exists.
  const list = await graph(accessToken, "GET", `${base}/worksheets?$select=name`, undefined, fetchImpl);
  const have = (list.value || []).some((w) => String(w.name).toLowerCase() === String(worksheet).toLowerCase());
  if (!have) await graph(accessToken, "POST", `${base}/worksheets/add`, { name: worksheet }, fetchImpl);

  const rows = matrix.length;
  const cols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  // Clear a generous window so a smaller model doesn't leave old rows/columns behind.
  const clearAddr = `A1:${colLetter(Math.max(cols + 2, 30))}${rows + 300}`;
  await graph(accessToken, "POST", `${base}/worksheets('${ws}')/range(address='${clearAddr}')/clear`, { applyTo: "All" }, fetchImpl);

  // Normalise to a rectangular block and write formulas (Graph reads "=" as a formula).
  const block = matrix.map((r) => { const row = r.slice(); while (row.length < cols) row.push(""); return row; });
  const addr = `A1:${colLetter(cols - 1)}${rows}`;
  await graph(accessToken, "PATCH", `${base}/worksheets('${ws}')/range(address='${addr}')`, { formulas: block }, fetchImpl);
  return { rows, cols };
}
