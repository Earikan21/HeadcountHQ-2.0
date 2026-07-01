/**
 * Minimal, safe server-side HTML rendering with no template engine.
 *
 * `html` is a tagged template that escapes every ${value} to prevent XSS —
 * EXCEPT values that are themselves trusted HTML (another `html` result, or a
 * value wrapped in `raw(...)`). It returns a `Safe` object so fragments can be
 * nested inside one another without being double-escaped. Coerce to a string
 * (String(x) / x.toString()) when handing the final HTML to the response.
 */

class Safe {
  constructor(s) { this.__raw = s; }
  toString() { return this.__raw; }
}

/** Mark a trusted HTML string (or unwrap a Safe) so `html` won't escape it. */
export function raw(value) {
  if (value instanceof Safe) return value;
  if (value && typeof value === "object" && "__raw" in value) return new Safe(value.__raw);
  return new Safe(value == null ? "" : String(value));
}

/** Escape a value for safe insertion into HTML text/attributes. */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderValue(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Safe) return v.__raw;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  if (typeof v === "object" && "__raw" in v) return v.__raw;
  return esc(v);
}

/** Tagged template returning a Safe (trusted) HTML fragment. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new Safe(out);
}

export { Safe };
