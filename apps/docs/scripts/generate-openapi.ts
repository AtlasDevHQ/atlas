/**
 * Generate MDX API reference docs from the OpenAPI spec.
 *
 * Prerequisites: Run `bun packages/api/scripts/extract-openapi.ts` first
 * to extract the spec to apps/docs/openapi.json.
 *
 * Run: cd apps/docs && bun ./scripts/generate-openapi.ts
 */

import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";
import * as fs from "fs";
import * as path from "path";

const docsRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(docsRoot, "content", "docs", "api-reference");
const specPath = path.join(docsRoot, "openapi.json");

if (!fs.existsSync(specPath)) {
  console.error(
    "openapi.json not found. Run `bun packages/api/scripts/extract-openapi.ts` first.",
  );
  process.exit(1);
}

// Validate spec contents before passing to fumadocs
let spec: unknown;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
} catch {
  console.error("openapi.json is not valid JSON. Re-run extraction.");
  process.exit(1);
}

if (!spec || typeof spec !== "object" || !("openapi" in spec)) {
  console.error("openapi.json does not contain a valid OpenAPI spec.");
  process.exit(1);
}

// Clean output directory before regenerating
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true });
}
fs.mkdirSync(outputDir, { recursive: true });

const openapi = createOpenAPI({
  input: ["./openapi.json"],
});

try {
  await generateFiles({
    input: openapi,
    output: outputDir,
    per: "operation",
    groupBy: "tag",
    includeDescription: true,
  });
} catch (err) {
  console.error(
    "Failed to generate API reference docs:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}

console.log(`Generated API reference docs in ${outputDir}`);
