/** Push the current headcount model into the linked Google Sheet, formatted. */
import { getConnection, getRefreshToken, updateRefreshToken, recordPush } from "../repos/gsheets.js";
import { refreshAccessToken, pushFormatted } from "./gsheets.js";
import { sheetPayload, makeFormatRequests } from "./gsheets_format.js";
import { buildHeadcountModel } from "./model.js";
import { listEmployees } from "../repos/roster.js";
import { getSettings } from "../repos/settings.js";
import { listDepartmentsByCreation } from "../repos/departments.js";

/** Extract a spreadsheet id from a pasted Google Sheets URL or a bare id. */
export function parseSpreadsheetId(input) {
  const s = String(input || "").trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : "";
}

export async function pushNow(db, config, fetchImpl = globalThis.fetch) {
  const conn = getConnection(db);
  if (!conn || !conn.refresh_token_enc) throw new Error("Not connected to Google.");
  if (!conn.spreadsheet_id) throw new Error("No target spreadsheet chosen.");

  const rt = getRefreshToken(db, config.SESSION_SECRET);
  let tok;
  try {
    tok = await refreshAccessToken({ config, refreshToken: rt, fetchImpl });
  } catch (e) { recordPush(db, { ok: false, error: e.message }); throw e; }
  // Google may rotate the refresh token; keep the newest.
  if (tok.refresh_token && tok.refresh_token !== rt) updateRefreshToken(db, tok.refresh_token, config.SESSION_SECRET);

  try {
    const mult = Number(getSettings(db).loaded_cost_multiplier) || 1.2;
    const model = buildHeadcountModel({ employees: listEmployees(db, {}), loadedMultiplier: mult });
    const order = listDepartmentsByCreation(db).map((d) => d.name);
    const payload = sheetPayload(model, order);
    const res = await pushFormatted({
      accessToken: tok.access_token,
      spreadsheetId: conn.spreadsheet_id,
      sheetTitle: conn.sheet_title || "Headcount",
      payload, makeFormatRequests, fetchImpl,
    });
    recordPush(db, { ok: true });
    return { rows: res.rows, sheet: res.title };
  } catch (e) { recordPush(db, { ok: false, error: e.message }); throw e; }
}
