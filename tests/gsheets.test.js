/**
 * Google Sheets push — the pure pieces: URL/id parsing, the OAuth URL, the formatted
 * payload, and the push sequence (all network calls stubbed via an injected fetch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeadcountModel } from "../src/domain/model.js";
import { sheetPayload, makeFormatRequests } from "../src/domain/gsheets_format.js";
import { authUrl, exchangeCode, refreshAccessToken, pushFormatted } from "../src/domain/gsheets.js";
import { parseSpreadsheetId } from "../src/domain/gsheets_sync.js";

const CONFIG = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://hq.example.com/integrations/google/callback" };
const model = () => buildHeadcountModel({
  employees: [
    { employee_ext_id: "E1", department_name: "Engineering", annual_salary: 120000, start_date: "2020-01-01" },
    { employee_ext_id: "E2", department_name: "Sales", annual_salary: 60000, start_date: "2020-01-01" },
  ],
  loadedMultiplier: 1.2, start: { year: 2026, month0: 0 }, months: 6, now: new Date("2026-07-15"),
});

test("parseSpreadsheetId pulls the id from a URL or a bare id", () => {
  assert.equal(parseSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC-dEf_123456789012345/edit#gid=0"), "1AbC-dEf_123456789012345");
  assert.equal(parseSpreadsheetId("1AbC-dEf_123456789012345678"), "1AbC-dEf_123456789012345678");
  assert.equal(parseSpreadsheetId("not a sheet"), "");
});

test("authUrl asks for offline access + consent (so Google returns a refresh token)", () => {
  const u = authUrl({ clientId: "cid", redirectUri: CONFIG.GOOGLE_REDIRECT_URI, state: "st", challenge: "ch" });
  const q = new URL(u).searchParams;
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("scope"), /spreadsheets/);
  assert.equal(q.get("redirect_uri"), CONFIG.GOOGLE_REDIRECT_URI);
});

test("token exchange + refresh POST the token endpoint with the right grant", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, body: opts.body });
    return { ok: true, json: async () => ({ access_token: "at", refresh_token: "rt" }) };
  };
  const a = await exchangeCode({ config: CONFIG, code: "abc", verifier: "v", fetchImpl });
  assert.equal(a.access_token, "at");
  assert.match(seen[0].url, /oauth2\.googleapis\.com\/token/);
  assert.match(seen[0].body, /grant_type=authorization_code/);
  await refreshAccessToken({ config: CONFIG, refreshToken: "rt", fetchImpl });
  assert.match(seen[1].body, /grant_type=refresh_token/);
});

test("sheetPayload classifies rows and makeFormatRequests styles them", () => {
  const payload = sheetPayload(model(), ["Engineering", "Sales"]);
  assert.deepEqual(payload.values[0].slice(0, 2), ["Department", "Metric"]);
  // Cost rows get currency, Headcount rows get integer, TOTAL rows go bold.
  assert.ok(payload.format.currencyRows.length >= 2, "a Cost row per department");
  assert.ok(payload.format.intRows.length >= 2, "a Headcount row per department");
  assert.ok(payload.format.boldRows.length >= 1, "TOTAL rows are bold");

  const reqs = makeFormatRequests(42, payload);
  const froze = reqs.find((r) => r.updateSheetProperties);
  assert.equal(froze.updateSheetProperties.properties.gridProperties.frozenRowCount, 1);
  assert.equal(froze.updateSheetProperties.properties.sheetId, 42);
  const currency = reqs.find((r) => r.repeatCell && r.repeatCell.cell.userEnteredFormat.numberFormat && r.repeatCell.cell.userEnteredFormat.numberFormat.type === "CURRENCY");
  assert.ok(currency, "a currency number-format request exists");
  assert.match(currency.repeatCell.cell.userEnteredFormat.numberFormat.pattern, /\$/);
});

test("pushFormatted writes values then formats, creating the tab if missing", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ method: opts.method, url });
    // First metadata read: tab doesn't exist yet.
    if (/\/spreadsheets\/SS\?/.test(url) && calls.filter((c) => /\/spreadsheets\/SS\?/.test(c.url)).length === 1) {
      return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 7, title: "Other" } }] }) };
    }
    if (/\/spreadsheets\/SS\?/.test(url)) { // metadata read after addSheet
      return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 9, title: "Headcount" } }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const payload = sheetPayload(model(), ["Engineering", "Sales"]);
  const res = await pushFormatted({ accessToken: "at", spreadsheetId: "SS", sheetTitle: "Headcount", payload, makeFormatRequests, fetchImpl });
  assert.equal(res.sheetId, 9);
  assert.equal(res.rows, payload.values.length);
  const urls = calls.map((c) => `${c.method} ${c.url}`);
  assert.ok(urls.some((u) => /:batchUpdate/.test(u) && u.startsWith("POST")), "batchUpdate used (addSheet + formatting)");
  assert.ok(urls.some((u) => /:clear/.test(u)), "the range is cleared first");
  assert.ok(urls.some((u) => /values\/.*!A1\?valueInputOption=RAW/.test(u) && u.startsWith("PUT")), "values written to A1");
});
