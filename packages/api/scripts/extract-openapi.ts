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

// Enable all conditional route groups so the spec includes every endpoint.
// These are checked at import time; no real connections are opened because
// database/auth modules use lazy initialization.
process.env.ATLAS_ACTIONS_ENABLED ??= "true";
process.env.ATLAS_SCHEDULER_ENABLED ??= "true";
process.env.ATLAS_DEMO_ENABLED ??= "true";
process.env.STRIPE_SECRET_KEY ??= "sk_extract_openapi_placeholder";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_extract_openapi_placeholder";
process.env.SLACK_SIGNING_SECRET ??= "extract_openapi_placeholder";
process.env.TEAMS_APP_ID ??= "extract_openapi_placeholder";

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

// Deduplicate trailing-slash paths (e.g. "/api/v1/admin/roles" and "/api/v1/admin/roles/").
// Some Hono route registrations produce both variants with identical content.
const paths = spec.paths as Record<string, unknown>;
let deduped = 0;
for (const key of Object.keys(paths)) {
  if (key.endsWith("/") && key.length > 1) {
    const canonical = key.slice(0, -1);
    if (canonical in paths) {
      delete paths[key];
      deduped++;
    }
  }
}
if (deduped > 0) {
  console.log(`Removed ${deduped} duplicate trailing-slash path(s)`);
}

// Auto-generate operationId for operations that lack one.
// Without operationId, fumadocs-openapi falls back to using the full URL path
// as the filename (e.g. api/v1/admin/settings/key/put.mdx), creating deeply
// nested directories that break the sidebar and cause routing errors.
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const usedOperationIds = new Set<string>();
let generated = 0;

function toOperationId(method: string, urlPath: string): string {
  // Strip /api/v1/ prefix, replace {param} and :param with "by-param"
  const stripped = urlPath
    .replace(/^\/api\/v1\//, "")
    .replace(/^\/api\//, "")
    .replace(/\{([^}]+)\}/g, "by-$1")
    .replace(/:([^/]+)/g, "by-$1");
  const segments = stripped.split("/").filter(Boolean);
  // camelCase: method + PascalCase segments
  const pascal = segments
    .map((s) =>
      s
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(""),
    )
    .join("");
  return method + pascal;
}

for (const [urlPath, methods] of Object.entries(paths)) {
  const pathItem = methods as Record<string, Record<string, unknown>>;
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    if (op.operationId) {
      usedOperationIds.add(op.operationId as string);
      continue;
    }
    let id = toOperationId(method, urlPath);
    // Deduplicate if collision
    let suffix = 2;
    const base = id;
    while (usedOperationIds.has(id)) {
      id = `${base}${suffix++}`;
    }
    op.operationId = id;
    usedOperationIds.add(id);
    generated++;
  }
}
if (generated > 0) {
  console.log(`Auto-generated ${generated} operationId(s)`);
}

// Ensure all tags used by operations are listed in spec.tags.
// The static Auth/Widget tags are already there, but Hono-generated routes
// add tags that aren't in the top-level tags array.
const existingTags = new Set(
  ((spec.tags as Array<{ name: string }>) ?? []).map((t) => t.name),
);
const usedTags = new Set<string>();
for (const methods of Object.values(paths)) {
  const pathItem = methods as Record<string, Record<string, unknown>>;
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    for (const tag of (op.tags as string[]) ?? []) usedTags.add(tag);
  }
}
const missingTags = [...usedTags].filter((t) => !existingTags.has(t)).sort();
if (missingTags.length > 0) {
  const tags = (spec.tags ?? []) as Array<{ name: string }>;
  for (const name of missingTags) tags.push({ name });
  spec.tags = tags;
  console.log(`Added ${missingTags.length} missing tag(s) to spec.tags`);
}

const outPath = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "docs", "openapi.json");
try {
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");
} catch (err) {
  console.error(
    `Failed to write OpenAPI spec to ${outPath}:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}

console.log(`Wrote OpenAPI spec to ${outPath}`);
