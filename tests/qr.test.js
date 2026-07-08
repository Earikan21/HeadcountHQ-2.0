/**
 * The hand-rolled QR encoder. npm is unavailable in this environment, so instead of a
 * reference library we anchor to the spec two ways: (1) the format-info BCH strings
 * are the exact values from ISO/IEC 18004, and the Reed–Solomon output is a genuine
 * zero-syndrome codeword (what a scanner's decoder verifies); (2) a full round-trip —
 * encode, then decode our own matrix back through mask/zigzag/de-interleave/parse —
 * recovers the original payload for real otpauth URIs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { qrMatrix, qrSvg, ecCodewords, formatBits, pickVersion, _internal } from "../src/domain/qr.js";

// A standalone GF(256) to check the RS invariant independently of the encoder's own.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gfmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

test("Reed–Solomon produces genuine zero-syndrome codewords", () => {
  const cases = [[[32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10],
    [Array.from({ length: 44 }, (_, i) => (i * 7 + 3) & 255), 26],
    [Array.from({ length: 61 }, (_, i) => (i * 13 + 1) & 255), 22]];
  for (const [data, ec] of cases) {
    const cw = data.concat(ecCodewords(data, ec));
    for (let i = 0; i < ec; i++) { // C(α^i) must be 0
      let acc = 0; for (const c of cw) acc = gfmul(acc, EXP[i]) ^ c;
      assert.equal(acc, 0, `syndrome ${i} for ec=${ec}`);
    }
  }
});

test("format-info BCH matches the ISO/IEC 18004 level-M strings", () => {
  const spec = ["101010000010010", "101000100100101", "101111001111100", "101101101001011",
    "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
  for (let m = 0; m < 8; m++) {
    assert.equal((formatBits(m) >>> 0).toString(2).padStart(15, "0"), spec[m], `mask ${m}`);
  }
});

test("version is picked to fit, and overflow is refused", () => {
  assert.equal(pickVersion(10), 1);
  assert.ok(pickVersion(150) >= 7);
  assert.throws(() => pickVersion(100000), /too long/i);
});

// ---- round-trip decoder (mirrors the encoder's spec steps) -----------------
function decode(text) {
  const { VERSION_M, buildFunctionMatrix, dataMask, MASKS } = _internal;
  void buildFunctionMatrix;
  const m = qrMatrix(text);
  const n = m.length, version = (n - 17) / 4;
  const bits = [];
  for (let i = 0; i <= 5; i++) bits[i] = m[i][8];
  bits[6] = m[7][8]; bits[7] = m[8][8]; bits[8] = m[8][7];
  for (let i = 9; i <= 14; i++) bits[i] = m[8][14 - i];
  let v = 0; for (let i = 14; i >= 0; i--) v = (v << 1) | bits[i];
  const maskIdx = ((v ^ 0b101010000010010) >> 10) & 0b111;

  const isData = dataMask(version), maskFn = MASKS[maskIdx];
  const um = m.map((row, r) => row.map((val, c) => (isData[r][c] && maskFn(r, c) ? val ^ 1 : val)));
  const stream = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < n; vert++) { const row = upward ? n - 1 - vert : vert; for (let j = 0; j < 2; j++) { const cc = right - j; if (isData[row][cc]) stream.push(um[row][cc]); } }
  }
  const cw = []; for (let i = 0; i + 8 <= stream.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | stream[i + j]; cw.push(b); }
  const info = VERSION_M[version];
  const blocks = []; for (const [count, dlen] of info.blocks) for (let b = 0; b < count; b++) blocks.push({ dlen, data: [] });
  const maxData = Math.max(...blocks.map((b) => b.dlen));
  let idx = 0;
  for (let i = 0; i < maxData; i++) for (const blk of blocks) if (i < blk.dlen) blk.data.push(cw[idx++]);
  const data = []; for (const blk of blocks) data.push(...blk.data);
  const bs = []; for (const b of data) for (let i = 7; i >= 0; i--) bs.push((b >> i) & 1);
  let p = 0; const take = (k) => { let x = 0; for (let i = 0; i < k; i++) x = (x << 1) | bs[p++]; return x; };
  const mode = take(4), len = take(version <= 9 ? 8 : 16), out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return { version, mode, text: Buffer.from(out).toString("utf8") };
}

test("encode → decode round-trips real otpauth URIs and edge strings", () => {
  const cases = [
    "otpauth://totp/Headcount%20HQ:ada@acme.co?secret=JBSWY3DPEHPK3PXP&issuer=Headcount%20HQ&algorithm=SHA1&digits=6&period=30",
    "otpauth://totp/Headcount%20HQ:someone.long@example-company.com?secret=OKYI6PVGEEX6Z2QW7ABCDE234567FGHIJ&issuer=Headcount%20HQ&algorithm=SHA1&digits=6&period=30",
    "HELLO WORLD", "a", "https://x.co/" + "y".repeat(60),
  ];
  for (const t of cases) {
    const d = decode(t);
    assert.equal(d.mode, 4, "byte mode");
    assert.equal(d.text, t, `payload for len ${t.length}`);
  }
});

test("qrSvg is self-contained SVG, no external refs, and empties gracefully on overflow", () => {
  const svg = qrSvg("otpauth://totp/x?secret=ABCDEF");
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /<path d="M/);
  // The xmlns is a spec identifier, never dereferenced; what matters is no fetchable ref.
  assert.ok(!/\b(href|src|xlink:href)=/.test(svg) && !/url\(/.test(svg), "no external references (CSP-safe)");
  assert.equal(qrSvg("z".repeat(100000)), "", "too-large content renders nothing rather than throwing");
});
