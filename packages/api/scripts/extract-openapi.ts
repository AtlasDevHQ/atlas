/**
 * Extract the OpenAPI spec from the API and write it to apps/docs/openapi.json.
 *
 * Uses a minimal Hono fetch to invoke the merged spec endpoint without starting
 * a server. Database/auth modules use lazy initialization, so no connections
 * are opened at import time. Safe to run in CI.
 *
 * Run: bun packages/api/scripts/extract-openapi.ts
 */

import * as fs from "fs";
import * as path from "path";

// Import the full app — the merged OpenAPI endpoint lives on the app instance.
// @ts-expect-error — Bun resolves .ts imports at runtime
const { app } = await import("../src/api/index.ts");

const req = new Request("http://localhost/api/v1/openapi.json");
const res = await app.fetch(req);

if (!res.ok) {
  const body = await res.text();
  console.error(`OpenAPI route returned HTTP ${res.status}:\n${body}`);
  process.exit(1);
}

const spec = (await res.json()) as Record<string, unknown>;

// Sanity check: must look like an OpenAPI spec
if (!spec || spec.openapi !== "3.1.0" || !spec.paths) {
  console.error(
    "Extracted spec is not a valid OpenAPI 3.1.0 document:",
    JSON.stringify(spec, null, 2).slice(0, 500),
  );
  process.exit(1);
}

const outPath = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "docs", "openapi.json");
try {
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");
} catch (err) {
  console.error(
    `Failed to write OpenAPI spec to ${outPath}:`,
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}

console.log(`Wrote OpenAPI spec to ${outPath}`);
