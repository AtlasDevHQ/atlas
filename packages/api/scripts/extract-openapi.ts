/**
 * Extract the OpenAPI spec from the API route module and write it to apps/docs/openapi.json.
 *
 * Uses a minimal Hono fetch to invoke the route handler without starting a server
 * or loading any database drivers. Only the openapi route module is imported.
 *
 * Run: bun packages/api/scripts/extract-openapi.ts
 */

import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";

// Import only the openapi route — this pulls in Zod schemas but NOT database
// drivers, auth middleware, or the agent. Safe to run in CI.
// @ts-expect-error — Bun resolves .ts imports at runtime
const { openapi } = await import("../src/api/routes/openapi.ts");

const app = new Hono();
app.route("/api/v1/openapi.json", openapi);

const req = new Request("http://localhost/api/v1/openapi.json");
const res = await app.fetch(req);
const spec = await res.json();

const outPath = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "docs", "openapi.json");
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");

console.log(`Wrote OpenAPI spec to ${outPath}`);
