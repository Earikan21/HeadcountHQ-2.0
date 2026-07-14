/**
 * The Excel-Online push: build the Actual model as a linked-formula matrix and write
 * it into the connected workbook. One-way (the tool is the source of truth). Network
 * goes through Microsoft Graph; a rotated refresh token is persisted.
 */
import { buildHeadcountModel } from "./model.js";
import { listEmployees } from "../repos/roster.js";
import { getSettings } from "../repos/settings.js";
import { modelMatrixCells } from "./model_export.js";
import { getConnection, getRefreshToken, updateRefreshToken, recordPush } from "../repos/excel.js";
import { refreshAccessToken, pushMatrix } from "./msgraph.js";

/** The Actual model (whole roster, workspace load) as spreadsheet cells. */
export function buildActualMatrix(db) {
  const employees = listEmployees(db, {});
  const mult = Number(getSettings(db).loaded_cost_multiplier) || 1.2;
  const model = buildHeadcountModel({ employees, loadedMultiplier: mult });
  return modelMatrixCells(model);
}

/** Refresh an access token, push the matrix, record the outcome. Throws on failure. */
export async function pushNow(db, config) {
  const conn = getConnection(db);
  if (!conn) throw new Error("Not connected to Microsoft 365.");
  if (!conn.item_id) throw new Error("No workbook is linked yet — choose one first.");
  const refreshToken = getRefreshToken(db, config.SESSION_SECRET);
  if (!refreshToken) throw new Error("Microsoft sign-in has expired — reconnect.");
  try {
    const tok = await refreshAccessToken({ config, refreshToken });
    if (tok.refresh_token && tok.refresh_token !== refreshToken) updateRefreshToken(db, tok.refresh_token, config.SESSION_SECRET);
    const res = await pushMatrix({ accessToken: tok.access_token, itemId: conn.item_id, worksheet: conn.worksheet, matrix: buildActualMatrix(db) });
    recordPush(db, { ok: true });
    return res;
  } catch (e) {
    recordPush(db, { ok: false, error: e && e.message ? e.message : String(e) });
    throw e;
  }
}

/**
 * Fire-and-forget push after a headcount change. Never throws into the request path;
 * failures are recorded on the connection for the status page to show.
 */
export function maybePush(ctx) {
  try {
    if (!ctx.config.excelSyncConfigured) return;
    const conn = getConnection(ctx.db);
    if (!conn || !conn.item_id) return;
    Promise.resolve().then(() => pushNow(ctx.db, ctx.config)).catch(() => { /* recorded in recordPush */ });
  } catch { /* never disrupt the mutating request */ }
}
