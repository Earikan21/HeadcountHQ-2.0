/**
 * Turns the monthly department summary into a Google Sheets payload: the values grid
 * plus a default formatting spec (currency on cost rows, whole numbers on headcount,
 * bold + frozen header, bold TOTAL rows). Kept separate from the API client so the
 * formatting is easy to test and to tweak.
 */
import { modelSummaryMatrix } from "./model_export.js";

const FIRST_DATA_COL = 2; // A Department, B Metric, then one column per month

/** Build { values, format } from the model. `format` classifies rows for styling. */
export function sheetPayload(model, deptOrder = null) {
  const { headers, rows, totals } = modelSummaryMatrix(model, deptOrder);
  const values = [headers, ...rows, ...totals];
  const format = { currencyRows: [], intRows: [], pctRows: [], boldRows: [] };
  values.forEach((r, i) => {
    if (i === 0) return; // header handled separately
    const metric = String(r[1] || "");
    if (metric === "Cost") format.currencyRows.push(i);
    else if (metric === "Headcount") format.intRows.push(i);
    else if (/%$/.test(metric)) format.pctRows.push(i);
    if (String(r[0] || "") === "TOTAL") format.boldRows.push(i);
  });
  return { values, format, cols: headers.length };
}

// ---- Google API request builders -------------------------------------------
const rowRange = (sheetId, row, startCol, endCol) => ({ sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: startCol, endColumnIndex: endCol });
const numberFmt = (sheetId, row, startCol, endCol, type, pattern) => ({
  repeatCell: {
    range: rowRange(sheetId, row, startCol, endCol),
    cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
    fields: "userEnteredFormat.numberFormat",
  },
});
const boldRow = (sheetId, row, endCol) => ({
  repeatCell: {
    range: rowRange(sheetId, row, 0, endCol),
    cell: { userEnteredFormat: { textFormat: { bold: true } } },
    fields: "userEnteredFormat.textFormat.bold",
  },
});

/** The Google batchUpdate requests that format the pushed grid. */
export function makeFormatRequests(sheetId, payload) {
  const endCol = payload.cols;
  const start = FIRST_DATA_COL;
  const reqs = [
    // Freeze the header row and the Department/Metric columns.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: FIRST_DATA_COL } },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    boldRow(sheetId, 0, endCol),
  ];
  for (const r of payload.format.currencyRows) reqs.push(numberFmt(sheetId, r, start, endCol, "CURRENCY", "$#,##0"));
  for (const r of payload.format.intRows) reqs.push(numberFmt(sheetId, r, start, endCol, "NUMBER", "#,##0"));
  for (const r of payload.format.pctRows) reqs.push(numberFmt(sheetId, r, start, endCol, "PERCENT", "0.0%"));
  for (const r of payload.format.boldRows) reqs.push(boldRow(sheetId, r, endCol));
  return reqs;
}
