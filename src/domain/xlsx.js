/**
 * A dependency-free .xlsx reader, good enough for rosters.
 *
 * An .xlsx file is a ZIP of XML parts. We read the ZIP central directory, inflate
 * the parts we need, and walk the first worksheet's <sheetData> into a matrix of
 * strings — the same shape the CSV adapter produces, so the import wizard is
 * unchanged.
 *
 * The parts that matter:
 *   xl/workbook.xml            sheet order, and the 1900/1904 date system
 *   xl/_rels/workbook.xml.rels sheet name -> part path
 *   xl/sharedStrings.xml       the string pool (t="s" cells hold an index into it)
 *   xl/styles.xml              cellXfs -> numFmtId, which is how we spot dates
 *   xl/worksheets/sheetN.xml   the cells
 *
 * Dates are the sharp edge: Excel stores "2026-03-01" as the number 46082, and a
 * roster's start/end dates are worthless as integers. A cell is a date only if its
 * style points at a date number-format, so we parse styles.xml to find out.
 *
 * Deliberately not supported: .xls (old binary format), encrypted workbooks, and
 * ZIP64. Each fails with a clear message rather than silently producing garbage.
 */
import { inflateRawSync } from "node:zlib";

// ---- ZIP -------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const ZIP64_MARKER = 0xffffffff;

/** Locate the End Of Central Directory record (it trails an optional comment). */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read a ZIP into `name -> Buffer`. Only stored (0) and deflate (8) entries, which
 * is everything Excel, LibreOffice, and Sheets emit.
 */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("Not a readable .xlsx file (too small).");
  if (buf.readUInt32LE(0) === 0xe011cfd0) throw new Error("That looks like an old .xls file. Save it as .xlsx (or .csv) and upload again.");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("Not a readable .xlsx file (no ZIP directory found).");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === ZIP64_MARKER || count === 0xffff) throw new Error("ZIP64 .xlsx files aren't supported. Re-save the sheet, or export it as CSV.");

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + cmtLen;

    if (compSize === ZIP64_MARKER || localOff === ZIP64_MARKER) throw new Error("ZIP64 .xlsx files aren't supported. Re-save the sheet, or export it as CSV.");
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    // The local header repeats the name/extra lengths, and its extra field can
    // differ in length from the central one — always trust the local header here.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    // Cap the inflated size so a "zip bomb" (a tiny deflate stream that expands to
    // gigabytes) can't OOM-crash the single-process server. 64 MB is far above any
    // real sharedStrings/sheet part; exceeding it throws ERR_BUFFER_TOO_LARGE, which
    // the caller already catches and surfaces as a clean "unreadable file" error.
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
    // any other method: skip the entry rather than fail the whole workbook
  }
  if (!out.size) throw new Error("Not a readable .xlsx file (no entries).");
  return out;
}

// ---- XML (just enough) ------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`)) || tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`));
  return m ? m[1] : null;
};

/** Concatenate every <t> in a fragment (rich text splits a string across runs). */
function textOf(fragment) {
  let s = "";
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return decodeXml(s);
}

// ---- dates ------------------------------------------------------------------

// Number formats Excel reserves for dates/times.
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Does a custom format code describe a date/time? Ignore quoted literals and [Red] etc. */
export function isDateFormatCode(code) {
  if (!code) return false;
  const bare = String(code)
    .replace(/"[^"]*"/g, "")     // "text"
    .replace(/\[[^\]]*\]/g, "")  // [Red], [$-409]
    .replace(/\\./g, "");        // escaped chars
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

/**
 * Excel serial -> ISO date. 25569 = days between 1899-12-30 and 1970-01-01, which
 * already absorbs Excel's fictitious 1900-02-29. The 1904 system shifts by 1462 days.
 */
export function serialToISO(serial, date1904 = false) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const days = n + (date1904 ? 1462 : 0);
  const ms = Math.round((days - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null; // not plausibly a roster date
  return d.toISOString().slice(0, 10);
}

/** styleIndex -> true when that style's number format is a date. */
function dateStyles(stylesXml) {
  const isDate = [];
  if (!stylesXml) return isDate;

  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*\/?>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = decodeXml(attr(m[0], "formatCode") || "");
    if (Number.isFinite(id)) custom.set(id, code);
  }

  const block = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!block) return isDate;
  for (const m of block[1].matchAll(/<xf\s[^>]*\/?>/g)) {
    const id = Number(attr(m[0], "numFmtId") || 0);
    isDate.push(BUILTIN_DATE_IDS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id))));
  }
  return isDate;
}

// ---- worksheet --------------------------------------------------------------

/** "BC12" -> 54 (0-based column). */
export function colIndexOf(ref) {
  let n = 0;
  for (const ch of String(ref)) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return Math.max(0, n - 1);
}

/** Resolve the first sheet's part path via workbook.xml + its rels. */
function firstSheetPath(files) {
  const wb = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const sheet = wb.match(/<sheet\s[^>]*\/?>/);
  const rid = sheet ? attr(sheet[0], "r:id") || attr(sheet[0], "id") : null;
  if (rid) {
    for (const m of rels.matchAll(/<Relationship\s[^>]*\/?>/g)) {
      if (attr(m[0], "Id") === rid) {
        let t = attr(m[0], "Target") || "";
        if (!t) break;
        return t.startsWith("/") ? t.slice(1) : t.startsWith("xl/") ? t : "xl/" + t;
      }
    }
  }
  // Fall back to the lowest-numbered worksheet part.
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  return sheets[0] || null;
}

/**
 * Parse an .xlsx buffer into a matrix of strings (rows of cells), padded so every
 * row is the same width. Blank spreadsheet rows are preserved, because the import
 * wizard's header detection reasons about row positions.
 */
export function parseXlsx(buffer) {
  const files = unzip(buffer);
  const path = firstSheetPath(files);
  if (!path || !files.has(path)) throw new Error("That .xlsx has no readable worksheet.");

  const wbXml = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(wbXml);

  const shared = [];
  const ss = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ss) for (const m of ss.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const isDate = dateStyles(files.get("xl/styles.xml")?.toString("utf8"));
  const sheet = files.get(path).toString("utf8");
  const data = sheet.match(/<sheetData[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!data) return [];

  const rows = [];
  let width = 0;
  let expected = 1; // 1-based spreadsheet row number

  for (const rm of data[1].matchAll(/<row(\s[^>]*)?>([\s\S]*?)<\/row>|<row(\s[^>]*)\/>/g)) {
    const rowTag = rm[1] || rm[3] || "";
    const inner = rm[2] || "";
    const rNum = Number(attr("<row " + rowTag.trim() + ">", "r")) || expected;
    while (expected < rNum) { rows.push([]); expected++; } // preserve blank rows
    expected = rNum + 1;

    const cells = [];
    for (const cm of inner.matchAll(/<c(\s[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = "<c" + cm[1] + ">";
      const body = cm[2] || "";
      const col = colIndexOf(attr(tag, "r") || "");
      const type = attr(tag, "t") || "n";
      const sIdx = Number(attr(tag, "s"));

      let value = "";
      if (type === "inlineStr") {
        value = textOf(body);
      } else {
        const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        const rawV = v ? decodeXml(v[1]) : "";
        if (type === "s") value = shared[Number(rawV)] ?? "";
        else if (type === "b") value = rawV === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";                 // #REF!, #N/A, ...
        else if (type === "str") value = rawV;             // cached formula string
        else {
          // numeric: a date only if its style says so
          const looksDated = Number.isFinite(sIdx) && isDate[sIdx];
          value = (looksDated && serialToISO(rawV, date1904)) || rawV;
        }
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    width = Math.max(width, cells.length);
    rows.push(cells);
  }

  // Trim trailing blank rows, then pad every row to the full width.
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows.map((r) => { const out = r.slice(); while (out.length < width) out.push(""); return out; });
}
