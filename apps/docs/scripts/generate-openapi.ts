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

// --- Write meta.json files for sidebar structure ---

// Read tag order and display names from the OpenAPI spec
const openAPISpec = spec as {
  tags?: Array<{ name: string; description?: string; "x-displayName"?: string }>;
};
const tags = openAPISpec.tags ?? [];

// Discover generated tag directories (fallback if spec has no tags array)
const tagDirs = fs
  .readdirSync(outputDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Convert tag name to directory slug (e.g. "Scheduled Tasks" → "scheduled-tasks")
const toSlug = (name: string) =>
  name.toLowerCase().replace(/\s+/g, "-");

// Ordered page list: use spec tag order, then append any extras
const orderedSlugs = tags.map((t) => toSlug(t.name));
const extraTags = tagDirs.filter((d) => !orderedSlugs.includes(d));
const pages = [...orderedSlugs.filter((s) => tagDirs.includes(s)), ...extraTags];

// Root meta.json — makes api-reference a sidebar tab (dropdown)
const rootMeta = {
  title: "API Reference",
  root: true,
  pages,
};
fs.writeFileSync(
  path.join(outputDir, "meta.json"),
  JSON.stringify(rootMeta, null, 2) + "\n",
);

// Per-tag meta.json — friendly titles
const tagTitleMap: Record<string, string> = {};
for (const tag of tags) {
  tagTitleMap[toSlug(tag.name)] = tag["x-displayName"] ?? tag.name;
}

for (const dir of tagDirs) {
  const tagDir = path.join(outputDir, dir);
  const title =
    tagTitleMap[dir] ??
    dir
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const tagMeta: Record<string, unknown> = { title };
  fs.writeFileSync(
    path.join(tagDir, "meta.json"),
    JSON.stringify(tagMeta, null, 2) + "\n",
  );
}

console.log(`Generated API reference docs in ${outputDir}`);
