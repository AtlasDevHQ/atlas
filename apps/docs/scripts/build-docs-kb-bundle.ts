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
import { join, dirname } from "node:path";
import { Glob } from "bun";
import { stripInactiveAudienceBlocks } from "../src/lib/audience-markdown";
import type { Audience } from "../src/lib/audience";

const DOCS_ROOT = join(import.meta.dir, "..");
const CONTENT_DIR = join(DOCS_ROOT, "content");

interface Args {
  audience: Audience;
  out: string;
  includeApiReference: boolean;
  /** When set, build from a DEPLOYED docs site's `llms.txt` + `.mdx` twins over
   * HTTP instead of the local `content/` tree — no build, bodies byte-faithful
   * to `getText("processed")`. Value is the site base URL. */
  fromDeployed?: string;
}

function parseArgs(argv: string[]): Args {
  let audience: Audience = "saas";
  let out = join(process.cwd(), "docs-kb-bundle.tar.gz");
  let includeApiReference = false;
  let fromDeployed: string | undefined;
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
    } else if (a === "--from-deployed") {
      const v = argv[++i];
      if (!v || !/^https?:\/\//.test(v)) {
        throw new Error(`--from-deployed needs an http(s) base URL, got "${v}"`);
      }
      fromDeployed = v.replace(/\/$/, "");
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { audience, out, includeApiReference, fromDeployed };
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

/**
 * Drop MDX module syntax (top-level `import …` / `export …`) so the body reads
 * as prose — mirroring what fumadocs' `getText("processed")` removes. Must be
 * FENCE-AWARE: `import`/`export` lines inside a ``` code block are code
 * *examples* (e.g. the SDK reference's `import type { AtlasClient } …`), not
 * module syntax — stripping them corrupts the example, and a multi-line one
 * would leave a dangling `} from "…"`. So only column-0 ESM statements OUTSIDE a
 * fence are removed, consuming continuation lines of a multi-line statement.
 */
function stripMdxModuleLines(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence: string | null = null; // the opening fence's marker while open

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0].repeat(3); // open (track char)
      else if (marker.startsWith(fence)) fence = null; // close on same char
      out.push(line);
      continue;
    }
    // A real MDX ESM statement is at column 0 and outside any fence.
    if (fence === null && /^(import|export)\s/.test(line)) {
      // Consume continuation lines ONLY when the line clearly opens a multi-line
      // construct (trailing `{`/`(`/`[`/`,`) — so a single-line `export default
      // Foo` with no terminator can never run the scan away into the prose that
      // follows. The corpus has no top-level multi-line ESM today (all such
      // statements live inside fences, handled above); this stays correct if one
      // is added later.
      if (/[{([,]\s*$/.test(line)) {
        i++;
        while (i < lines.length && !/([)}\]]|["'`]|;)\s*;?\s*$/.test(lines[i])) i++;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "");
}

/**
 * True when the processed body carries no ingestable prose — a page whose
 * content is entirely component-rendered at build time (e.g. `changelog.mdx` is
 * just `<ChangelogTimeline />`). Such a page ingests as a contentless KB doc, so
 * we skip it. Conservative: any fenced code block counts as content, and only a
 * body with almost no text once JSX/HTML tags are removed is treated as empty.
 */
function isContentless(body: string): boolean {
  if (/```[\s\S]*?```/.test(body)) return false; // a code-only page is content
  const text = body
    .replace(/<[^>]+>/g, " ") // drop JSX / HTML tags
    .replace(/\s+/g, " ")
    .trim();
  return text.length < 16;
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

interface Summary {
  written: number;
  skippedApiRef: number;
  skippedEmpty: number;
  skippedAudience: number;
}

function emptySummary(): Summary {
  return { written: 0, skippedApiRef: 0, skippedEmpty: 0, skippedAudience: 0 };
}

/** Should this content path be excluded from the bundle? The 473 auto-generated
 * OpenAPI stubs are `<APIPage>` shells with no prose — worthless as KB content
 * and a waste of the doc-count cap. Shared across both modes. */
function isApiReference(path: string): boolean {
  return path.startsWith("api-reference/") || path.startsWith("/api-reference/");
}

/** LOCAL mode: build from the repo `content/` tree, approximating the processed
 * surface (fence-aware ESM strip + audience strip). */
async function collectLocal(staging: string, args: Args): Promise<Summary> {
  const summary = emptySummary();
  for (const section of sectionsFor(args.audience)) {
    const sectionDir = join(CONTENT_DIR, section);
    const glob = new Glob("**/*.mdx");
    for await (const rel of glob.scan(sectionDir)) {
      if (!args.includeApiReference && section === "docs" && isApiReference(rel)) {
        summary.skippedApiRef++;
        continue;
      }

      const raw = await Bun.file(join(sectionDir, rel)).text();
      const { fm, body } = splitFrontmatter(raw);

      let processed: string;
      try {
        // Fail-soft per file (mirrors `renderLlmsFullText`): a residual
        // audience tag throws; skip rather than abort the whole bundle.
        processed = stripInactiveAudienceBlocks(stripMdxModuleLines(body), args.audience);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  skip (audience strip) ${section}/${rel}: ${msg}`);
        summary.skippedAudience++;
        continue;
      }

      if (isContentless(processed)) {
        summary.skippedEmpty++;
        continue;
      }

      // Provenance tags make the bundle's origin legible in the review UI.
      const tags = [...new Set(["docs-portal", section, ...(fm.tags ?? [])])];
      const outRel = join(section, rel.replace(/\.mdx$/, ".md"));
      await writeDoc(staging, outRel, renderOkf(fm, tags, processed));
      summary.written++;
    }
  }
  return summary;
}

const FETCH_CONCURRENCY = 8;

interface IndexEntry {
  title: string;
  path: string;
  description?: string;
}

/**
 * Parse a deployed `llms.txt` index (`- [Title](url): description` lines) into
 * page entries. Reads each link's URL PATH — not the host — because the index
 * absolutizes every URL to the hardcoded `docs.useatlas.dev` regardless of which
 * deployment served it, so we re-root the path onto the `--from-deployed` base.
 */
function parseLlmsIndex(indexText: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of indexText.split("\n")) {
    const m = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*\S))?\s*$/.exec(line);
    if (!m) continue;
    const [, title, url, description] = m;
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.startsWith("/") ? url : `/${url}`;
    }
    out.push({ title: title.trim(), path, description: description?.trim() || undefined });
  }
  return out;
}

/** `getLLMText` prepends `# Title (url)` to every twin; drop that leading H1
 * (the title goes into OKF frontmatter) so the body starts at real content. */
function stripTwinHeading(body: string): string {
  return body.replace(/^#\s+.*(?:\r?\n)+/, "");
}

/** Map a deployed page path to a bundle-relative `.md` path. A section-index
 * path (trailing slash) becomes `<section>/index.md`. */
function deployedOutRel(path: string): string {
  return `${path.replace(/^\//, "").replace(/\/$/, "/index")}.md`;
}

/** DEPLOYED mode: build from a live site's `llms.txt` index + per-page `.mdx`
 * twins over HTTP. Twins are already audience-resolved by `getLLMText`, so no
 * re-strip; descriptions come from the index (the twins carry none). */
async function collectDeployed(staging: string, args: Args, base: string): Promise<Summary> {
  const indexPath = args.audience === "saas" ? "/llms.txt" : "/self-hosted/llms.txt";
  const indexUrl = `${base}${indexPath}`;

  const res = await fetch(indexUrl);
  if (!res.ok) {
    throw new Error(`Fetch ${indexUrl} → ${res.status} ${res.statusText}`);
  }
  const index = parseLlmsIndex(await res.text());
  if (index.length === 0) throw new Error(`No pages parsed from ${indexUrl}`);

  const summary = emptySummary();
  const pages = index.filter((p) => {
    if (p.path === "/" || p.path === indexPath) return false;
    if (!args.includeApiReference && isApiReference(p.path)) {
      summary.skippedApiRef++;
      return false;
    }
    return true;
  });

  // Bounded-concurrency fetch pool. `cursor++` and the `summary` mutations are
  // safe under Bun's single-threaded event loop (no interleaving mid-statement).
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < pages.length; i = cursor++) {
      const p = pages[i];
      const twinUrl = `${base}${p.path}.mdx`;
      let body: string;
      try {
        const r = await fetch(twinUrl);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        body = stripTwinHeading(await r.text());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  skip (fetch) ${p.path}.mdx: ${msg}`);
        continue;
      }
      if (isContentless(body)) {
        summary.skippedEmpty++;
        continue;
      }
      const okf = renderOkf(
        { title: p.title, description: p.description },
        ["docs-portal", "deployed"],
        body,
      );
      await writeDoc(staging, deployedOutRel(p.path), okf);
      summary.written++;
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return summary;
}

/** Write one staged doc, creating parent dirs. */
async function writeDoc(staging: string, outRel: string, okf: string): Promise<void> {
  const outAbs = join(staging, outRel);
  await mkdir(dirname(outAbs), { recursive: true });
  await writeFile(outAbs, okf, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staging = await mkdtemp(join(tmpdir(), "docs-kb-"));

  try {
    const summary = args.fromDeployed
      ? await collectDeployed(staging, args, args.fromDeployed)
      : await collectLocal(staging, args);

    if (summary.written === 0) {
      throw new Error("No documents collected — nothing to bundle.");
    }

    // Tar the staged tree so archive paths are the OKF tree at the root.
    await mkdir(dirname(args.out), { recursive: true });
    const proc = Bun.spawn(["tar", "-czf", args.out, "-C", staging, "."], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`tar exited with code ${code}`);

    const bytes = (await Bun.file(args.out).stat()).size;
    console.log("");
    console.log(`Bundle:    ${args.out}`);
    console.log(
      args.fromDeployed
        ? `Source:    ${args.fromDeployed}  (deployed llms.txt + .mdx twins, ${args.audience})`
        : `Source:    local content/  (${args.audience}: ${sectionsFor(args.audience).join(", ")})`,
    );
    console.log(`Documents: ${summary.written}`);
    console.log(`Size:      ${(bytes / 1_000_000).toFixed(2)} MB`);
    if (summary.skippedApiRef > 0) console.log(`Skipped:   ${summary.skippedApiRef} api-reference stubs`);
    if (summary.skippedEmpty > 0) console.log(`Skipped:   ${summary.skippedEmpty} contentless (component-only) pages`);
    if (summary.skippedAudience > 0) console.log(`Skipped:   ${summary.skippedAudience} files (audience strip)`);
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
