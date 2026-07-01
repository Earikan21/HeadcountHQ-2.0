import http from "node:http";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/database.js";
import { migrateToLatest } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";

/** Start a fully-migrated app on an ephemeral port; returns { base, server, db }.
 *  Pass envOverrides to exercise optional config (e.g. AI_IMPORT_API_KEY). */
export async function startTestServer(envOverrides = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-secret-0123456789abcdef",
    DATABASE_PATH: ":memory:",
    COOKIE_SECURE: "false",
    ...envOverrides,
  });
  const db = openDb(":memory:");
  migrateToLatest(db);
  const server = buildApp({ config, db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    server,
    db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

/** HTTP client over node:http (no keep-alive, no global pool) with a cookie
 *  jar + automatic CSRF. Avoids the undici/global-fetch pool that deadlocks
 *  under the test runner. */
export function makeClient(base) {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const u0 = new URL(base);

  function request(method, path, { headers = {}, body = null } = {}) {
    const u = new URL(path, base);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: u0.hostname, port: u0.port, path: u.pathname + u.search, method, headers, agent: false },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const setc = res.headers["set-cookie"] || [];
            for (const c of setc) {
              const pair = c.split(";")[0];
              const i = pair.indexOf("=");
              const k = pair.slice(0, i).trim();
              const v = pair.slice(i + 1);
              if (v === "") delete jar[k];
              else jar[k] = decodeURIComponent(v);
            }
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode,
              headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null, raw: res.headers },
              text: async () => text,
              body: text,
            });
          });
        }
      );
      req.on("error", reject);
      if (body != null) req.write(body);
      req.end();
    });
  }

  async function get(path) {
    return request("GET", path, { headers: { cookie: cookieHeader() } });
  }
  async function post(path, data = {}) {
    const form = new URLSearchParams();
    if (!("_csrf" in data) && jar.hq_csrf) form.set("_csrf", jar.hq_csrf);
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) v.forEach((x) => form.append(k, x));
      else form.set(k, v);
    }
    const bodyStr = form.toString();
    return request("POST", path, {
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(bodyStr),
      },
      body: bodyStr,
    });
  }
  async function upload(path, fields = {}, file = null) {
    const boundary = "----hcqtest" + Math.random().toString(16).slice(2);
    const all = { ...fields };
    if (!("_csrf" in all) && jar.hq_csrf) all._csrf = jar.hq_csrf;
    const parts = [];
    for (const [k, v] of Object.entries(all)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (file) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: text/csv\r\n\r\n`));
      parts.push(Buffer.from(file.content, "utf8"));
      parts.push(Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    return request("POST", path, {
      headers: {
        cookie: cookieHeader(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length,
      },
      body,
    });
  }
  return { jar, get, post, upload };
}
