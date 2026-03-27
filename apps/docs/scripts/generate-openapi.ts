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
} catch (err) {
  console.error(
    "Failed to read or parse openapi.json. Re-run extraction.",
    err instanceof Error ? err.message : String(err),
  );
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

// Normalize tag names: replace em dashes and special chars with hyphens
// "Admin — Connections" → "admin-connections" (not "admin-—-connections")
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s*[—–]\s*/g, "-") // em/en dash → hyphen
    .replace(/\s+/g, "-");

try {
  await generateFiles({
    input: openapi,
    output: outputDir,
    per: "operation",
    groupBy: "tag",
    includeDescription: true,
    slugify,
  });
} catch (err) {
  console.error(
    "Failed to generate API reference docs:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}

// --- Write meta.json files for sidebar structure ---

try {
  // Read tag order (and optional x-displayName overrides) from the OpenAPI spec
  const openAPISpec = spec as {
    tags?: Array<{ name: string; description?: string; "x-displayName"?: string }>;
  };
  const tags = openAPISpec.tags ?? [];

  if (tags.length === 0) {
    console.warn(
      "Warning: OpenAPI spec has no 'tags' array. " +
        "Sidebar ordering will use filesystem order and auto-generated titles.",
    );
  }

  // Discover generated tag directories (fallback if spec has no tags array)
  const tagDirs = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Must match the custom slugify passed to generateFiles above
  const toSlug = slugify;

  // Ordered page list: use spec tag order, then append any extras
  const orderedSlugs = tags.map((t) => toSlug(t.name));
  const unmatchedTags = orderedSlugs.filter((s) => !tagDirs.includes(s));
  if (unmatchedTags.length > 0) {
    console.warn(
      `Warning: ${unmatchedTags.length} spec tag(s) did not match generated directories: ` +
        `${unmatchedTags.join(", ")}. These will be excluded from sidebar ordering. ` +
        `Generated directories: ${tagDirs.join(", ")}`,
    );
  }

  const extraTags = tagDirs.filter((d) => !orderedSlugs.includes(d));
  const pages = [...orderedSlugs.filter((s) => tagDirs.includes(s)), ...extraTags];

  if (pages.length === 0) {
    console.error(
      "No API tag directories found in output. The OpenAPI spec may have untagged operations " +
        "or generateFiles may have changed its output structure. Check: " + outputDir,
    );
    process.exit(1);
  }

  // Root meta.json — makes api-reference a separate sidebar tab (isolated from main docs navigation)
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
    // Fallback for directories not in spec tags: title-case the slug
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

  console.log(
    `Generated API reference docs in ${outputDir} ` +
      `(${tagDirs.length} tag directories, ${pages.length} sidebar entries)`,
  );
} catch (err) {
  console.error(
    "Failed to generate sidebar meta.json files:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
