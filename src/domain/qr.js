/**
 * A dependency-free QR encoder, just big enough for an otpauth:// URI.
 *
 * Why hand-rolled: the strict CSP (`img-src 'self' data:`) forbids pulling a QR from
 * an external service, and adding an npm dependency isn't in this project's grain. So
 * we encode the code ourselves and render it as an inline SVG.
 *
 * Scope, deliberately narrow: byte mode, error-correction level M, versions 1–10.
 * That comfortably covers an otpauth URI (~120–180 bytes). Anything larger throws,
 * and the caller falls back to showing the manual setup key. Correctness is checked
 * against a reference library in tests/qr.test.js.
 *
 * References: ISO/IEC 18004. The algorithm is the standard one — Reed–Solomon over
 * GF(256), the eight data masks scored by penalty, BCH-coded format bits.
 */

const EC_LEVEL = "M";
const ECL_BITS = 0b00; // format-info bits for level M

// Total data codewords and EC-block layout per version at level M (ISO/IEC 18004,
// Annex). Each entry: { ecPerBlock, blocks: [[blockCount, dataCodewordsPerBlock], ...] }.
const VERSION_M = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 60], [2, 61]] },
  9: { ec: 22, blocks: [[3, 58], [2, 59]] },
  10: { ec: 26, blocks: [[4, 69], [1, 70]] },
};

// Alignment-pattern centre coordinates per version (empty for v1).
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Remainder bits appended after the final codeword, per version.
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

// ---- GF(256) ---------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed–Solomon EC codewords for one data block. */
export function ecCodewords(data, ecLen) {
  // Generator polynomial of degree ecLen.
  // Monic generator in descending order (gen[0] = leading coeff = 1): the product of
  // (x + α^i) for i = 0..ecLen-1. gen[j] is the shift-by-x term; gen[j+1] the ×α^i term.
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = rem[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], coef);
  }
  return rem.slice(data.length);
}

// ---- bitstream -------------------------------------------------------------
function toBytes(str) {
  // otpauth URIs are ASCII; encode as UTF-8 to be safe for any label.
  return Array.from(Buffer.from(String(str), "utf8"));
}

export function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const info = VERSION_M[v];
    const dataCodewords = info.blocks.reduce((a, [n, d]) => a + n * d, 0);
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + byteLen * 8;
    if (needBits <= dataCodewords * 8) return v;
  }
  throw new Error("Content too long for a version-1..10 QR code.");
}

function buildCodewords(bytes, version) {
  const info = VERSION_M[version];
  const totalData = info.blocks.reduce((a, [n, d]) => a + n * d, 0);
  const countBits = version <= 9 ? 8 : 16;

  // Bit buffer.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);            // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  // Terminator (up to 4 bits) then pad to a byte boundary.
  const cap = totalData * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords.
  const pad = [0xec, 0x11];
  let p = 0;
  while (bits.length < cap) { push(pad[p % 2], 8); p++; }

  // Bits -> data codewords.
  const dataCW = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCW.push(byte);
  }

  // Split into blocks, compute EC per block.
  const dataBlocks = [], ecBlocks = [];
  let idx = 0;
  for (const [count, dlen] of info.blocks) {
    for (let b = 0; b < count; b++) {
      const block = dataCW.slice(idx, idx + dlen);
      idx += dlen;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, info.ec));
    }
  }

  // Interleave data, then EC.
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  const maxEc = Math.max(...ecBlocks.map((b) => b.length));
  for (let i = 0; i < maxEc; i++) for (const blk of ecBlocks) if (i < blk.length) out.push(blk[i]);
  return out;
}

// ---- matrix ----------------------------------------------------------------
function emptyMatrix(n) {
  const m = [];
  for (let i = 0; i < n; i++) m.push(new Array(n).fill(null)); // null = free, else 0/1
  return m;
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
    const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
    const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
    m[rr][cc] = dark ? 1 : 0;
  }
}

function placeAlignment(m, version) {
  const centres = ALIGN[version];
  const last = centres[centres.length - 1];
  for (const r of centres) for (const c of centres) {
    // Skip only the three that coincide with the finder patterns. Alignment patterns
    // that cross the timing rows ARE drawn (they override the timing modules).
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (c === 6 && r === last)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      m[r + dr][c + dc] = ring === 1 ? 0 : 1;
    }
  }
}

// Version information (18 bits: 6-bit version + 12-bit BCH) — required for v7+.
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}
function placeVersion(m, version) {
  if (version < 7) return;
  const n = m.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const a = n - 11 + (i % 3), d = Math.floor(i / 3);
    m[d][a] = b; // top-right block
    m[a][d] = b; // bottom-left block (transpose)
  }
}

function reserveFormat(m) {
  const n = m.length;
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 2;       // 2 = reserved
    if (m[i][8] === null) m[i][8] = 2;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 2;
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 2;
  }
  m[n - 8][8] = 1; // dark module (always set)
}

function buildFunctionMatrix(version) {
  const n = version * 4 + 17;
  const m = emptyMatrix(n);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, n - 7);
  placeFinder(m, n - 7, 0);
  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  placeAlignment(m, version);
  placeVersion(m, version);
  reserveFormat(m);
  return m;
}

/** Zig-zag place the interleaved codeword bits into the free modules. */
function placeData(m, codewords, version) {
  const n = m.length;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  for (let i = 0; i < REMAINDER[version]; i++) bits.push(0);

  let bit = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < n; vert++) {
      const row = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const cc = right - j;
        if (m[row][cc] === null) {
          m[row][cc] = bit < bits.length ? bits[bit] : 0;
          bit++;
        }
      }
    }
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Which modules are data (mask applies) vs function (untouched). */
function dataMask(version) {
  const fn = buildFunctionMatrix(version);
  return fn.map((row) => row.map((v) => v === null));
}

function applyMask(m, isData, maskFn) {
  const out = m.map((row) => row.slice());
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) {
    if (isData[r][c] && maskFn(r, c)) out[r][c] ^= 1;
  }
  return out;
}

// ---- penalty scoring (ISO rules 1–4) ---------------------------------------
function penalty(m) {
  const n = m.length;
  let score = 0;
  const at = (r, c) => m[r][c] & 1;
  // Rule 1: runs of 5+ same-colour in rows and columns.
  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (at(r, c) === at(r, c - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
      else run = 1;
    }
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (at(r, c) === at(r - 1, c)) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
      else run = 1;
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = at(r, c);
    if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns (with 4-module light run) in rows/cols.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const line = (get) => {
    for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) { const v = get(r, c + k); if (v !== P1[k]) m1 = false; if (v !== P2[k]) m2 = false; }
      if (m1) score += 40; if (m2) score += 40;
    }
  };
  line((r, c) => at(r, c));            // rows
  line((r, c) => at(c, r));            // cols (transpose)
  // Rule 4: overall dark/light balance.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += at(r, c);
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ---- format info (BCH 15,5) ------------------------------------------------
export function formatBits(maskIdx) {
  const data = (ECL_BITS << 3) | maskIdx; // 5 bits
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function writeFormat(m, maskIdx) {
  const n = m.length;
  const bits = formatBits(maskIdx);
  const bit = (i) => (bits >> i) & 1;
  // Copy 1, wrapping the top-left finder: bits 0-5 down column 8, then the corner,
  // then bits 9-14 along row 8. (ISO/IEC 18004 §8.9 — the earlier code had row/col
  // swapped, which no scanner could read.)
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
  // Copy 2: bits 0-7 along the bottom of row 8, bits 8-14 up column 8.
  for (let i = 0; i <= 7; i++) m[8][n - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) m[n - 15 + i][8] = bit(i);
  m[n - 8][8] = 1; // dark module (must stay set)
}

/** Encode `text` into a QR module matrix (2D array of 0/1). */
export const _internal = { VERSION_M, REMAINDER, ALIGN, buildFunctionMatrix, dataMask, MASKS };

export function qrMatrix(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);

  const base = buildFunctionMatrix(version);
  placeData(base, codewords, version);
  const isData = dataMask(version);

  let best = null, bestScore = Infinity, bestMask = 0;
  for (let mi = 0; mi < 8; mi++) {
    const masked = applyMask(base, isData, MASKS[mi]);
    writeFormat(masked, mi);
    const s = penalty(masked);
    if (s < bestScore) { bestScore = s; best = masked; bestMask = mi; }
  }
  void bestMask;
  // Normalise reserved/function cells to 0/1.
  return best.map((row) => row.map((v) => (v === null || v === 2 ? 0 : v & 1)));
}

/** Render `text` as a crisp, self-contained SVG QR code (data-URI-free, CSP-safe). */
export function qrSvg(text, { size = 200, margin = 4 } = {}) {
  let matrix;
  try { matrix = qrMatrix(text); } catch { return ""; }
  const n = matrix.length;
  const total = n + margin * 2;
  // One <path> of all dark modules is far smaller than one <rect> each.
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (matrix[r][c]) d += "M" + (c + margin) + " " + (r + margin) + "h1v1h-1z";
  }
  const svgOpen = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 ' + total + " " + total + '" shape-rendering="crispEdges" role="img" aria-label="QR code">';
  return svgOpen + '<rect width="' + total + '" height="' + total + '" fill="#fff"/>' +
    '<path d="' + d + '" fill="#000"/></svg>';
}
