/**
 * Build a Knowledge Base ingest bundle from the docs portal content.
 *
 * Produces a `.tar.gz` OKF tree of clean markdown (one file = one document,
 * `title`/`description`/`tags` frontmatter) suitable for the KB upload-ingest
 * seam (`POST /api/v1/admin/knowledge/{slug}/ingest`, ADR-0028). This is a
 * throwaway staging-test helper — the intended production source for the same
 * content is the portal's own `llms-full.txt` / per-page `.mdx` twin surfaces.
 *
 * Faithfulness: the substantive, leak-safety-critical transform — resolving
 * `<WhenSaaS>` / `<WhenSelfHosted>` / `<AudienceLink>` for the target audience —
 * is done by importing the portal's OWN pure `stripInactiveAudienceBlocks`
 * (`src/lib/audience-markdown.ts`), the same function `getLLMText` uses. So a
 * SaaS bundle is structurally incapable of carrying self-hosted branches, exactly
 * like the deployed machine surface. What this DOESN'T replicate is fumadocs'
 * `getText("processed")` MDX pass; since that preserves custom component tags
 * verbatim anyway, the gap is minor (leftover `<Callout>`/`<Tabs>` tags), and we
 * strip MDX `import`/`export` module lines here so the body reads as prose.
 *
 * Mirrors the SaaS `source` composition (`src/lib/source.ts`): `content/docs`
 * (minus the auto-generated `api-reference/` stubs) + `content/shared`, scoped
 * to `"saas"`. Pass `--audience self-hosted` for the `content/self-hosted` +
 * `content/shared` surface instead.
 *
 *   bun run scripts/build-docs-kb-bundle.ts                       # SaaS bundle
 *   bun run scripts/build-docs-kb-bundle.ts --audience self-hosted
 *   bun run scripts/build-docs-kb-bundle.ts --out /tmp/kb.tar.gz --include-api-reference
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { Glob } from "bun";
import { stripInactiveAudienceBlocks } from "../src/lib/audience-markdown";
import type { Audience } from "../src/lib/audience";

const DOCS_ROOT = join(import.meta.dir, "..");
const CONTENT_DIR = join(DOCS_ROOT, "content");

interface Args {
  audience: Audience;
  out: string;
  includeApiReference: boolean;
}

function parseArgs(argv: string[]): Args {
  let audience: Audience = "saas";
  let out = join(process.cwd(), "docs-kb-bundle.tar.gz");
  let includeApiReference = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audience") {
      const v = argv[++i];
      if (v !== "saas" && v !== "self-hosted") {
        throw new Error(`--audience must be "saas" or "self-hosted", got "${v}"`);
      }
      audience = v;
    } else if (a === "--out") {
      out = argv[++i];
    } else if (a === "--include-api-reference") {
      includeApiReference = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { audience, out, includeApiReference };
}

/** The content collections composing each audience's surface (mirrors
 * `buildSectionSource` in `src/lib/source.ts`). `shared` is mounted into both. */
function sectionsFor(audience: Audience): string[] {
  return audience === "saas" ? ["docs", "shared"] : ["self-hosted", "shared"];
}

interface Frontmatter {
  title?: string;
  description?: string;
  tags?: string[];
}

/**
 * Split leading `---\n…\n---` frontmatter from the body and pull the scalar
 * fields we mirror into OKF. Deliberately minimal — the docs frontmatter is
 * clean (`title`/`description`, occasionally `audience`/`fork`/`tags`), so a
 * line-scan for top-level scalars beats pulling in a YAML dependency. Unparsed
 * fields are simply ignored; a missing title falls back to the first `# heading`
 * or the filename downstream (matching the ingest seam's own lenient behaviour).
 */
function splitFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const body = raw.slice(m[0].length);
  const fm: Frontmatter = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();
    if (key === "title" || key === "description") {
      fm[key] = unquote(rawVal);
    } else if (key === "tags") {
      fm.tags = parseTags(rawVal, lines, i);
    }
  }
  return { fm, body };
}

function unquote(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Handle both flow (`[a, b]`) and block (`\n  - a\n  - b`) YAML tag lists. */
function parseTags(inline: string, lines: string[], idx: number): string[] {
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((t) => unquote(t.trim()))
      .filter(Boolean);
  }
  const tags: string[] = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const item = /^\s*-\s*(.+)$/.exec(lines[j]);
    if (!item) break;
    tags.push(unquote(item[1].trim()));
  }
  return tags;
}

/** Drop MDX module syntax (`import …`, `export …`) so the body is prose. The
 * audience-strip runs after, on the same shape it expects (processed markdown
 * keeps component tags but not imports). */
function stripMdxModuleLines(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*(import|export)\s/.test(l))
    .join("\n")
    .replace(/^\n+/, "");
}

/** Serialize OKF frontmatter. String values are JSON-encoded (valid YAML
 * double-quoted scalars) so colons/quotes in descriptions can't break parsing. */
function renderOkf(fm: Frontmatter, tags: string[], body: string): string {
  const lines = ["---", "type: Document"];
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.description) lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  lines.push("---", "", body.trimEnd(), "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sections = sectionsFor(args.audience);

  const staging = await mkdtemp(join(tmpdir(), "docs-kb-"));
  let written = 0;
  let skippedApiRef = 0;
  let skippedAudience = 0;

  try {
    for (const section of sections) {
      const sectionDir = join(CONTENT_DIR, section);
      const glob = new Glob("**/*.mdx");
      for await (const rel of glob.scan(sectionDir)) {
        // The 473 auto-generated OpenAPI stubs are `<APIPage>` shells with no
        // prose — worthless as KB content and a waste of the doc-count cap.
        if (
          !args.includeApiReference &&
          section === "docs" &&
          rel.startsWith("api-reference/")
        ) {
          skippedApiRef++;
          continue;
        }

        const abs = join(sectionDir, rel);
        const raw = await Bun.file(abs).text();
        const { fm, body } = splitFrontmatter(raw);

        let processed: string;
        try {
          // Fail-soft per file (mirrors `renderLlmsFullText`): a residual
          // audience tag throws; skip rather than abort the whole bundle.
          processed = stripInactiveAudienceBlocks(
            stripMdxModuleLines(body),
            args.audience,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  skip (audience strip) ${section}/${rel}: ${msg}`);
          skippedAudience++;
          continue;
        }

        // Provenance tags make the bundle's origin legible in the review UI.
        const tags = [...new Set(["docs-portal", section, ...(fm.tags ?? [])])];
        const okf = renderOkf(fm, tags, processed);

        const outRel = join(section, rel.replace(/\.mdx$/, ".md"));
        const outAbs = join(staging, outRel);
        await mkdir(dirname(outAbs), { recursive: true });
        await writeFile(outAbs, okf, "utf8");
        written++;
      }
    }

    // Tar the staged tree so archive paths are `docs/…`, `shared/…` at the root.
    await mkdir(dirname(args.out), { recursive: true });
    const proc = Bun.spawn(
      ["tar", "-czf", args.out, "-C", staging, "."],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`tar exited with code ${code}`);

    const bytes = (await Bun.file(args.out).stat()).size;
    console.log("");
    console.log(`Bundle:    ${args.out}`);
    console.log(`Audience:  ${args.audience}  (sections: ${sections.join(", ")})`);
    console.log(`Documents: ${written}`);
    console.log(`Size:      ${(bytes / 1_000_000).toFixed(2)} MB`);
    if (skippedApiRef > 0) console.log(`Skipped:   ${skippedApiRef} api-reference stubs`);
    if (skippedAudience > 0) console.log(`Skipped:   ${skippedAudience} files (audience strip)`);
    console.log("");
    console.log("Caps: 1000 docs / 1 MB per doc / 25 MB per bundle.");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
