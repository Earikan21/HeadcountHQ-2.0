/**
 * Request body parsing for node:http with no dependencies. Handles
 * urlencoded forms, JSON, and multipart/form-data (file uploads). Enforces a
 * maximum size. Text fields land in ctx.body; uploaded files land in ctx.files
 * as { filename, contentType, data:Buffer }.
 */
export async function parseBody(req, ctx, maxBytes) {
  const raw = await readRaw(req, maxBytes);
  const type = String(req.headers["content-type"] || "");

  if (type.includes("application/json")) {
    try { ctx.body = JSON.parse(raw.toString("utf8") || "{}"); }
    catch { ctx.body = {}; }
    return;
  }
  if (type.includes("multipart/form-data")) {
    const m = type.match(/boundary=("?)([^";]+)\1/);
    if (m) parseMultipart(raw, m[2], ctx);
    return;
  }
  // default: urlencoded. Repeated keys (e.g. checkboxes) become arrays.
  const params = new URLSearchParams(raw.toString("utf8"));
  const body = {};
  for (const k of new Set(params.keys())) {
    const all = params.getAll(k);
    body[k] = all.length > 1 ? all : all[0];
  }
  ctx.body = body;
}

function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buf, boundary, ctx) {
  const body = {};
  const files = {};
  const delim = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buf, delim);
  for (const part of parts) {
    // Trim leading CRLF and ignore the trailing "--" / empty segments.
    let p = part;
    if (p.length >= 2 && p[0] === 0x0d && p[1] === 0x0a) p = p.subarray(2);
    if (p.length === 0 || (p.length >= 2 && p[0] === 0x2d && p[1] === 0x2d)) continue;

    const sep = indexOfBuffer(p, Buffer.from("\r\n\r\n"));
    if (sep === -1) continue;
    const headerText = p.subarray(0, sep).toString("utf8");
    let content = p.subarray(sep + 4);
    // Strip the trailing CRLF that precedes the next boundary.
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }
    const nameMatch = headerText.match(/name="([^"]*)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = headerText.match(/filename="([^"]*)"/i);
    if (fileMatch) {
      if (fileMatch[1]) {
        const ctMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
        files[name] = { filename: fileMatch[1], contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream", data: content };
      }
    } else {
      body[name] = content.toString("utf8");
    }
  }
  ctx.body = body;
  ctx.files = files;
}

function splitBuffer(buf, delim) {
  const out = [];
  let start = 0;
  let idx;
  while ((idx = indexOfBuffer(buf, delim, start)) !== -1) {
    out.push(buf.subarray(start, idx));
    start = idx + delim.length;
  }
  out.push(buf.subarray(start));
  return out;
}

function indexOfBuffer(buf, search, from = 0) {
  return buf.indexOf(search, from);
}
