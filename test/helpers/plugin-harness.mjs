import { Readable } from "node:stream";
import { apply } from "../../lib/index.js";

/** Exercise the actual exported plugin and registered handler; no copied code. */
export function mountPlugin(context) {
  let handler;
  const bootEffects = [];
  apply({
    ...context,
    webServer: { register(route) { handler = route.handler; } },
    effect(fn, label) {
      if (label === "session-manager: http api") fn();
      else bootEffects.push(fn);
    },
  });
  return {
    async boot() { for (const effect of bootEffects) await effect(); },
    async request(path, body, method = "POST", raw) {
      const req = Readable.from([raw ?? JSON.stringify(body ?? {})]);
      req.method = method;
      req.url = "/session-manager/api" + path;
      let status;
      let data;
      await handler(req, { writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } });
      return { status, data };
    },
  };
}
