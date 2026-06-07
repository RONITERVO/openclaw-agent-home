// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { collectSnapshot } from "./server.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicDir = join(rootDir, "public");
const routeBase = "/__openclaw__/agent-home";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function serveAgentHomeRoute(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (url.pathname === routeBase) {
    response.writeHead(302, { location: `${routeBase}/` });
    response.end();
    return true;
  }

  if (url.pathname === `${routeBase}/api/snapshot`) {
    const snapshot = await collectSnapshot({ force: url.searchParams.get("force") === "1" });
    sendJson(response, 200, snapshot);
    return true;
  }

  if (url.pathname === `${routeBase}/api/health`) {
    sendJson(response, 200, { ok: true });
    return true;
  }

  const prefix = `${routeBase}/`;
  if (!url.pathname.startsWith(prefix)) return false;

  const relativePath = url.pathname.slice(prefix.length) || "index.html";
  const target = normalize(join(publicDir, decodeURIComponent(relativePath)));
  if (!target.startsWith(publicDir)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return true;
  }

  try {
    const data = await readFile(target);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(target)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
  return true;
}

export default definePluginEntry({
  id: "agent-home",
  name: "Agent Home Display",
  description: "Zero-click ambient second-screen status display for OpenClaw agents.",
  register(api) {
    api.registerGatewayMethod("agentHome.snapshot", async ({ params, respond }) => {
      try {
        respond(true, await collectSnapshot({ force: Boolean(params?.force) }));
      } catch (error) {
        respond(false, {
          code: "AGENT_HOME_SNAPSHOT_FAILED",
          message: String(error?.message || error),
        });
      }
    }, { scope: "operator.read" });

    api.registerHttpRoute({
      path: routeBase,
      auth: "gateway",
      match: "prefix",
      handler: serveAgentHomeRoute,
    });
  },
});
