/**
 * A small, explicit router over node:http. Supports static path segments and
 * :params (e.g. "/requests/:id"). No dependency, no magic.
 */
export class Router {
  constructor() {
    /** @type {{method:string, parts:string[], handler:Function}[]} */
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, parts: split(pattern), handler });
    return this;
  }
  get(pattern, handler) { return this.add("GET", pattern, handler); }
  post(pattern, handler) { return this.add("POST", pattern, handler); }

  /** Find a matching route for the given method + pathname. */
  match(method, pathname) {
    const parts = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.parts[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

function split(p) {
  return p.split("/").filter((s) => s.length > 0);
}
