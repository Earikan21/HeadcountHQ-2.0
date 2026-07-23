/**
 * Google Sheets client for the one-way live push (values + formatting).
 *
 * Delegated OAuth 2.0 auth-code flow with PKCE. We keep the refresh token (encrypted,
 * elsewhere) and mint short-lived access tokens on demand, then write the model's values
 * into a worksheet and apply number formats / styles via the Sheets API — so the linked
 * Google Sheet stays live AND formatted, unlike a plain CSV/IMPORTDATA link.
 *
 * Every network call goes through an injectable `fetchImpl` so the flow is testable
 * without contacting Google.
 */
import { randomBytes, createHash } from "node:crypto";

export const SCOPES = "https://www.googleapis.com/auth/spreadsheets openid email";
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/** A PKCE verifier + its S256 challenge. */
export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The Google sign-in URL to redirect the user to. access_type=offline + prompt=consent
 *  are what make Google return a refresh token. */
export function authUrl({ clientId, redirectUri, state, challenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH}?${p.toString()}`;
}

async function tokenRequest(config, params, fetchImpl) {
  const body = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    ...params,
  });
  const res = await fetchImpl(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data; // { access_token, refresh_token?, expires_in, ... }
}

export const exchangeCode = ({ config, code, verifier, fetchImpl = globalThis.fetch }) =>
  tokenRequest(config, { grant_type: "authorization_code", code, code_verifier: verifier }, fetchImpl);

export const refreshAccessToken = ({ config, refreshToken, fetchImpl = globalThis.fetch }) =>
  tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);

async function api(url, method, accessToken, body, fetchImpl) {
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.status)) || res.status;
    const e = new Error(`Google API ${method} failed: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** The signed-in account's email (for display). */
export async function whoAmI({ accessToken, fetchImpl = globalThis.fetch }) {
  const me = await api(USERINFO, "GET", accessToken, undefined, fetchImpl);
  return me.email || me.name || "";
}

export async function getSpreadsheet({ accessToken, spreadsheetId, fetchImpl = globalThis.fetch }) {
  return api(`${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title)`, "GET", accessToken, undefined, fetchImpl);
}

/**
 * Push `payload.values` (2-D array) into `sheetTitle` (created if missing), clearing the
 * area first, then apply `makeFormatRequests(sheetId, payload)` for number formats/styles.
 * Returns { sheetId, title, rows }.
 */
export async function pushFormatted({ accessToken, spreadsheetId, sheetTitle, payload, makeFormatRequests, fetchImpl = globalThis.fetch }) {
  const id = encodeURIComponent(spreadsheetId);
  const title = String(sheetTitle || "Headcount");
  const q = (a) => encodeURIComponent(a);

  const meta = await getSpreadsheet({ accessToken, spreadsheetId, fetchImpl });
  const propsOf = (m) => (m.sheets || []).map((s) => s.properties).filter(Boolean);
  let sheet = propsOf(meta).find((p) => String(p.title) === title);
  if (!sheet) {
    await api(`${SHEETS}/${id}:batchUpdate`, "POST", accessToken, { requests: [{ addSheet: { properties: { title } } }] }, fetchImpl);
    const m2 = await getSpreadsheet({ accessToken, spreadsheetId, fetchImpl });
    sheet = propsOf(m2).find((p) => String(p.title) === title);
  }
  const sheetId = sheet ? sheet.sheetId : 0;

  // Clear a generous window so a smaller model doesn't leave stale rows/columns behind.
  await api(`${SHEETS}/${id}/values/${q(`'${title}'!A1:ZZ5000`)}:clear`, "POST", accessToken, {}, fetchImpl);
  // Write the block starting at A1 (RAW — the summary is values, not formulas).
  await api(`${SHEETS}/${id}/values/${q(`'${title}'!A1`)}?valueInputOption=RAW`, "PUT", accessToken, { values: payload.values }, fetchImpl);
  const requests = typeof makeFormatRequests === "function" ? makeFormatRequests(sheetId, payload) : [];
  if (requests && requests.length) await api(`${SHEETS}/${id}:batchUpdate`, "POST", accessToken, { requests }, fetchImpl);
  return { sheetId, title, rows: payload.values.length };
}
