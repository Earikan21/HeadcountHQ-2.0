/** Persistence for the Google Sheets connection (one row, workspace 1). */
import { encryptSecret, decryptSecret } from "../auth/secretbox.js";

export const getConnection = (db) =>
  db.prepare("SELECT * FROM google_connections WHERE workspace_id = 1").get() || null;

export const isConnected = (db) => {
  const c = getConnection(db);
  return Boolean(c && c.refresh_token_enc);
};

/** Store (or replace) the connection after a successful OAuth exchange. */
export function saveConnection(db, { email, refreshToken, userId, secret }) {
  const enc = encryptSecret(refreshToken, secret);
  db.prepare(`
    INSERT INTO google_connections (workspace_id, account_email, refresh_token_enc, status, created_by, updated_at)
    VALUES (1, ?, ?, 'connected', ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET
      account_email = excluded.account_email,
      refresh_token_enc = excluded.refresh_token_enc,
      status = 'connected', last_error = NULL, updated_at = datetime('now')
  `).run(email || "", enc, userId || null);
  return getConnection(db);
}

export function getRefreshToken(db, secret) {
  const c = getConnection(db);
  if (!c || !c.refresh_token_enc) return null;
  try { return decryptSecret(c.refresh_token_enc, secret); } catch { return null; }
}

export function updateRefreshToken(db, refreshToken, secret) {
  db.prepare("UPDATE google_connections SET refresh_token_enc = ?, updated_at = datetime('now') WHERE workspace_id = 1")
    .run(encryptSecret(refreshToken, secret));
}

export function setTarget(db, { spreadsheetId, spreadsheetName, sheetTitle }) {
  db.prepare("UPDATE google_connections SET spreadsheet_id = ?, spreadsheet_name = ?, sheet_title = COALESCE(?, sheet_title), updated_at = datetime('now') WHERE workspace_id = 1")
    .run(spreadsheetId || null, spreadsheetName || null, sheetTitle || null);
  return getConnection(db);
}

export function recordPush(db, { ok, error }) {
  if (ok) db.prepare("UPDATE google_connections SET last_pushed_at = datetime('now'), status = 'connected', last_error = NULL WHERE workspace_id = 1").run();
  else db.prepare("UPDATE google_connections SET status = 'error', last_error = ? WHERE workspace_id = 1").run(String(error || "").slice(0, 300));
}

export const disconnect = (db) =>
  db.prepare("DELETE FROM google_connections WHERE workspace_id = 1").run();
