#!/usr/bin/env bun
/**
 * check-docs-links.ts — docs internal-link + anchor gate (#4480).
 *
 * Validates, purely from source MDX (no `next build`), that every internal
 * link in `apps/docs/content/**` resolves to a real page and every `#anchor`
 * fragment resolves to a real heading on its target page. The `apps/docs`
 * production build passes with broken internal links, so without this gate
 * link rot ships silently (surfaced by the #4477 review panel, which had to
 * verify anchors by hand).
 *
 * TREE-MOUNTING RULES (mirrors apps/docs/src/lib/source.ts):
 *   - root mount `/`            = content/docs + content/shared
 *   - `/self-hosted` mount      = content/self-hosted + content/shared
 *   A shared page renders on BOTH mounts from the one real file. Links are
 *   resolved against the mount their URL addresses: `/self-hosted/...` links
 *   against the self-hosted mount, everything else against the root mount.
 *
 * AUDIENCE AWARENESS: a link inside a `<WhenSelfHosted>` block only renders on
 * the self-hosted mount (and vice versa), so it is only checked there — and a
 * link inside e.g. `<WhenSelfHosted>` in a saas-only page renders nowhere and
 * is skipped. (Exception: `<AudienceLink>` hrefs are always checked, each on
 * its own mount, even inside a `<When…>` block — deliberately over-strict; see
 * the extraction comment.) Anchor targets are computed per mount with the SAME
 * `stripInactiveAudienceBlocks` the llms/toc surfaces use, so a heading that
 * is stripped on a mount is not a valid anchor there.
 *
 * ANCHOR PARITY: heading ids are computed with `github-slugger@2.0.0`, pinned
 * exactly at the root so it resolves to the one lockfile entry fumadocs-core's
 * heading-id pass uses (`^2.0.0`, fumadocs-core 16.9.3) — including the
 * duplicate `-1`/`-2` suffixes and the `--` double-dash cases
 * (`Data Center / Server` → `data-center--server`). Fumadocs' custom-id
 * syntax (`## Heading [#custom-id]`) is honored. The fixture suite's
 * double-dash / `-1`-suffix cases are the real parity lock: they catch a
 * slugging divergence regardless of how the versions drift.
 *
 * OUT OF SCOPE: external URLs (flaky — a separate audit concern), `href={...}`
 * JSX expressions and `[x](</path with spaces>)` angle-bracket destinations
 * (neither form exists in content today; not statically extracted), and
 * anchors on generated `api-reference` pages (their body is a JSX
 * `<APIPage>`; page existence is still checked).
 *
 * Exit 0 = clean; exit 1 with one `file:line: message` per violation.
 * `--content-dir <dir>` overrides the content root (used by the adversarial
 * fixture test in scripts/__tests__/check-docs-links.test.sh).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, posix, sep } from "node:path";
import GithubSlugger from "github-slugger";
// Reused from the docs app (a pure string helper, no bundler deps) so per-mount
// anchor computation can never diverge from the rendered site's audience strip.
import { stripInactiveAudienceBlocks } from "../apps/docs/src/lib/audience-markdown";

type Tree = "docs" | "shared" | "self-hosted";
type Audience = "saas" | "self-hosted";

interface Page {
  readonly tree: Tree;
  /** Collection-relative virtual path without extension, e.g. "guides/foo". */
  readonly virtualPath: string;
  /** Absolute file path on disk. */
  readonly file: string;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
  /** Dedup key into violationMounts (same finding on both mounts → one row). */
  readonly key: string;
}

// Site routes that exist outside the content trees (app router routes /
// public/ assets). Links to these are valid but have no MDX source, so they
// are existence-allowlisted and anchor checks are skipped.
const NON_CONTENT_ROUTES = new Set([
  "/llms.txt",
  "/llms-full.txt",
  "/robots.txt",
  "/api/search",
]);

const repoRoot = resolve(import.meta.dir, "..");

function parseArgs(): { contentDir: string } {
  const idx = process.argv.indexOf("--content-dir");
  if (idx === -1) return { contentDir: join(repoRoot, "apps/docs/content") };
  const value = process.argv[idx + 1];
  // A present-but-valueless flag must not silently fall back to the real
  // content tree — in the fixture harness that would validate the wrong dir.
  if (!value || value.startsWith("-")) {
    console.error("[docs-links] --content-dir requires a directory argument");
    process.exit(2);
  }
  return { contentDir: resolve(value) };
}

const { contentDir } = parseArgs();

function relToRepo(file: string): string {
  return file.startsWith(repoRoot + sep)
    ? file.slice(repoRoot.length + 1)
    : file;
}

// ── page discovery ───────────────────────────────────────────────────────────

function walkMdx(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  // withFileTypes does not follow directory symlinks — no unbounded recursion.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMdx(full));
    else if (entry.name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

function collectTree(tree: Tree): Page[] {
  const root = join(contentDir, tree);
  return walkMdx(root).map((file) => ({
    tree,
    virtualPath: file
      .slice(root.length + 1)
      .split(sep)
      .join("/")
      .replace(/\.mdx$/, ""),
    file,
  }));
}

const docsPages = collectTree("docs");
const sharedPages = collectTree("shared");
const selfHostedPages = collectTree("self-hosted");

/** Mount a collection-relative virtual path at a baseUrl, collapsing a
 * trailing `/index` (a folder landing renders at the folder URL) — mirrors
 * how the fumadocs loader turns a file path into a URL. */
function mountUrl(baseUrl: string, virtualPath: string): string {
  const noIndex = virtualPath.replace(/(^|\/)index$/, "");
  const path = noIndex === "" ? "" : `/${noIndex}`;
  const url = `${baseUrl}${path}`;
  return url === "" ? "/" : url;
}

/** One of the two URL spaces. `name`/`audience` pair 1:1 by construction —
 * `MOUNTS` below is the single statement of that mapping, so absolute-link
 * routing (`mountFor`) and relative-link routing (`MOUNTS[audience]`) can
 * never disagree. */
interface Mount {
  readonly name: "root" | "/self-hosted";
  readonly audience: Audience;
  readonly byUrl: ReadonlyMap<string, Page>;
  readonly byVirtualPath: ReadonlyMap<string, Page>;
}

// Two different source files claiming one URL on the same mount — the
// taxonomy build gate rejects un-marked cross-audience duplicates, but a
// silent last-writer-wins here would make anchor checks run against the
// wrong file's headings. Collected during index build (before the violation
// machinery exists), reported with the other violations.
const urlCollisions: { page: Page; message: string }[] = [];

/** URL → page, and virtual path (ext-stripped) → page, for one mount. */
function buildMount(baseUrl: string, collections: readonly Page[][]) {
  const byUrl = new Map<string, Page>();
  const byVirtualPath = new Map<string, Page>();
  for (const pages of collections) {
    for (const p of pages) {
      const url = mountUrl(baseUrl, p.virtualPath);
      const prior = byUrl.get(url);
      if (prior && prior.file !== p.file) {
        urlCollisions.push({
          page: p,
          message: `duplicate URL claim — "${url || "/"}" is also served by ${relToRepo(prior.file)} on this mount`,
        });
      }
      byUrl.set(url, p);
      byVirtualPath.set(p.virtualPath, p);
    }
  }
  return { byUrl, byVirtualPath };
}

const MOUNTS: Record<Audience, Mount> = {
  saas: {
    name: "root",
    audience: "saas",
    ...buildMount("", [docsPages, sharedPages]),
  },
  "self-hosted": {
    name: "/self-hosted",
    audience: "self-hosted",
    ...buildMount("/self-hosted", [selfHostedPages, sharedPages]),
  },
};

/** The mounts a source file renders on (drives which links exist at all). */
function fileAudiences(tree: Tree): readonly Audience[] {
  if (tree === "docs") return ["saas"];
  if (tree === "self-hosted") return ["self-hosted"];
  return ["saas", "self-hosted"];
}

// ── anchor targets: heading slugs per (file, audience) ──────────────────────

/** Strip YAML frontmatter (a `# comment` inside it would false-match the
 * ATX-heading scan). */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/** Does this line close the given open fence? CommonMark: same character, at
 * least as long as the opener, nothing but whitespace after (info strings are
 * only legal on the OPENING fence) — so a ``` line inside a ```` block stays
 * inside. */
function closesFence(line: string, fence: string): boolean {
  const m = FENCE_OPEN.exec(line);
  return (
    m !== null &&
    m[1][0] === fence[0] &&
    m[1].length >= fence.length &&
    line.slice(m.index + m[0].length).trim() === ""
  );
}

/** Remove fenced code blocks line-wise (a `# comment` in a ```bash block is
 * not a heading; a `](/x)` in an example is not a link). */
function removeFencedBlocks(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Fumadocs custom heading id: `## Heading text [#custom-id]`.
const CUSTOM_HEADING_ID = /\[#([^[\]\s]+)\][ \t]*$/;

/**
 * A heading's rendered TEXT CONTENT — what the Fumadocs heading-id pass feeds
 * `github-slugger` (mdast inline parse, then flatten to text). Inline code,
 * links, images, and emphasis reduce to their inner text. NOTE: `_`-emphasis
 * only delimits at word boundaries in markdown, so a mid-word underscore
 * (`start_trial`) is kept — the docs app's `normalizeHeadingText` is NOT
 * reusable here because it strips all underscores (fine for its symmetric
 * title-to-title comparison, wrong for slug input).
 */
function headingTextContent(raw: string): string {
  const flattened = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/`([^`]*)`/g, "$1") // inline code → content
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // *em* / **strong**
    .replace(/(?<![A-Za-z0-9])_{1,3}([^_]+)_{1,3}(?![A-Za-z0-9])/g, "$1");
  // Strip raw inline JSX/HTML tags to a fixpoint: removing one tag can expose
  // another spanning the removal (`<<b>i>` → `<i>`), so one pass is not enough
  // (CodeQL js/incomplete-multi-character-sanitization; here it's slug
  // fidelity, not sanitization — the output feeds github-slugger, never HTML).
  let out = flattened;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>\n]+>/g, "");
  } while (out !== prev);
  return out.replace(/\s+/g, " ").trim();
}

const slugCache = new Map<string, Set<string>>();

/** Heading anchors that actually render on `audience`'s mount for this page:
 * audience-strip first (a heading inside an inactive `<When…>` block has no
 * anchor on this mount), then slug every ATX heading outside code fences with
 * a fresh per-page GithubSlugger (duplicate headings get `-1`, `-2`, … exactly
 * as the rendered ids do). */
function headingSlugs(page: Page, audience: Audience): Set<string> {
  const key = `${page.file}\u0000${audience}`;
  const cached = slugCache.get(key);
  if (cached) return cached;

  // CRLF-normalize before stripFrontmatter (its pattern is LF-anchored, like
  // the strip's own internal normalization).
  const raw = readFileSync(page.file, "utf8").replace(/\r\n/g, "\n");
  // Throws ResidualAudienceTagError on a malformed audience block — but any
  // such page already fails the docs build itself (every SSG page render runs
  // this same strip via filterTocByAudience in section-docs-page.tsx), so let
  // it propagate. The build strips PROCESSED markdown while we strip raw
  // source — a divergence there fails loud here, never silent.
  const scoped = stripInactiveAudienceBlocks(stripFrontmatter(raw), audience);
  const noFences = removeFencedBlocks(scoped);

  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  for (const m of noFences.matchAll(
    /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
  )) {
    const text = m[2];
    const custom = CUSTOM_HEADING_ID.exec(text);
    if (custom) {
      slugs.add(custom[1]);
      continue;
    }
    slugs.add(slugger.slug(headingTextContent(text)));
  }
  slugCache.set(key, slugs);
  return slugs;
}

/** Generated fumadocs-openapi pages render through a JSX `<APIPage>` — their
 * headings are not statically derivable, so anchor checks are skipped. */
function isGeneratedApiReference(page: Page): boolean {
  return page.tree === "docs" && page.virtualPath.startsWith("api-reference/");
}

// ── link extraction (line-aware) ─────────────────────────────────────────────

interface FoundLink {
  readonly line: number;
  readonly target: string;
  /** Mounts this occurrence renders on. */
  readonly audiences: readonly Audience[];
}

// Markdown link/image target: `](target)` or `](target "title")`.
const MD_LINK = /\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
// Reference-style link definition: `[label]: target` ([^label]: footnotes excluded).
const REF_DEF = /^ {0,3}\[[^\]^]+\]:[ \t]*(\S+)/;
// Literal href attribute (JSX or HTML), double- or single-quoted.
// `href={...}` expressions are skipped (not statically resolvable).
const HREF_ATTR = /\bhref=(?:"([^"]+)"|'([^']+)')/g;
// <AudienceLink saas="…" selfHosted="…"> — each attr is a link on that mount.
const AUDIENCE_LINK_TAG = /<AudienceLink\b([^>]*)>/g;

function audienceLinkAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

function intersect(
  a: readonly Audience[],
  b: readonly Audience[],
): Audience[] {
  return a.filter((x) => b.includes(x));
}

/** Scan one file for links, tracking line numbers, fenced code, MDX comments,
 * and `<WhenSaaS>` / `<WhenSelfHosted>` block scope (block-form tags on their
 * own lines — the only form the audience strip supports). */
function extractLinks(page: Page): FoundLink[] {
  const lines = readFileSync(page.file, "utf8").split(/\r?\n/);
  const links: FoundLink[] = [];
  const mounts = fileAudiences(page.tree);

  let inFrontmatter = false;
  let fence: string | null = null;
  let inComment = false;
  // Innermost-wins is enough: the strip doesn't support nested audience blocks.
  const audienceStack: Audience[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;

    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }

    // Multi-line MDX comments {/* … */}.
    if (inComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inComment = false;
    }

    // Fenced code blocks (``` / ~~~) — links inside are examples, not links.
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    // Audience block boundaries (open/close on their own line, per the strip).
    const tagMatch = /^[ \t]*<(\/?)(WhenSaaS|WhenSelfHosted)(?:\s[^>]*)?>[ \t]*$/.exec(
      line,
    );
    if (tagMatch) {
      const audience: Audience =
        tagMatch[2] === "WhenSaaS" ? "saas" : "self-hosted";
      if (tagMatch[1] === "/") {
        const at = audienceStack.lastIndexOf(audience);
        if (at !== -1) audienceStack.splice(at, 1);
      } else {
        audienceStack.push(audience);
      }
      continue;
    }

    // Mask within-line MDX comments, then open a multi-line one if present,
    // then mask inline code spans (a `` `](/not-a-link)` `` mention).
    line = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const commentStart = line.indexOf("{/*");
    if (commentStart !== -1) {
      line = line.slice(0, commentStart);
      inComment = true;
    }
    line = line.replace(/`[^`]*`/g, "``");

    const blockAudiences =
      audienceStack.length === 0
        ? mounts
        : intersect(mounts, [audienceStack[audienceStack.length - 1]]);

    // <AudienceLink> carries one href per mount; validate each on its own
    // mount regardless of the enclosing block (the component resolves itself).
    // Deliberately over-strict: one nested in an inactive <When…> block never
    // renders, but its href is still checked — fails toward a spurious CI
    // error, never toward a missed break.
    for (const m of line.matchAll(AUDIENCE_LINK_TAG)) {
      const saasHref = audienceLinkAttr(m[1], "saas");
      const shHref = audienceLinkAttr(m[1], "selfHosted");
      if (saasHref) links.push({ line: lineNo, target: saasHref, audiences: ["saas"] });
      if (shHref)
        links.push({ line: lineNo, target: shHref, audiences: ["self-hosted"] });
    }
    // Mask the AudienceLink tags so their attrs aren't re-extracted below.
    const masked = line.replace(AUDIENCE_LINK_TAG, "<AudienceLink>");

    if (blockAudiences.length === 0) continue; // renders on no mount

    for (const m of masked.matchAll(MD_LINK)) {
      links.push({ line: lineNo, target: m[1], audiences: blockAudiences });
    }
    const refDef = REF_DEF.exec(masked);
    if (refDef) {
      links.push({ line: lineNo, target: refDef[1], audiences: blockAudiences });
    }
    for (const m of masked.matchAll(HREF_ATTR)) {
      links.push({
        line: lineNo,
        target: m[1] ?? m[2],
        audiences: blockAudiences,
      });
    }
  }
  return links;
}

// ── validation ───────────────────────────────────────────────────────────────

const violations: Violation[] = [];
// A shared page renders on both mounts, so the same broken link can fail
// twice; merge into one row with both mounts named.
const violationMounts = new Map<string, Set<Audience>>();

function violation(
  page: Page,
  line: number,
  message: string,
  mount?: Audience,
): void {
  const key = `${page.file}\u0000${line}\u0000${message}`;
  const existing = violationMounts.get(key);
  if (existing) {
    if (mount) existing.add(mount);
    return;
  }
  violationMounts.set(key, new Set(mount ? [mount] : []));
  violations.push({ file: relToRepo(page.file), line, message, key });
}

// Index-build collisions become ordinary violations now that the machinery exists.
for (const c of urlCollisions) violation(c.page, 1, c.message);

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function normalizePath(path: string): string {
  const noQuery = path.split("?")[0];
  return noQuery.length > 1 ? noQuery.replace(/\/+$/, "") : noQuery;
}

/** The mount an absolute URL addresses (relative links route via MOUNTS[audience]). */
function mountFor(path: string): Mount {
  return MOUNTS[
    path === "/self-hosted" || path.startsWith("/self-hosted/")
      ? "self-hosted"
      : "saas"
  ];
}

function checkAnchor(
  page: Page,
  line: number,
  link: string,
  target: Page,
  audience: Audience,
  fragment: string,
): void {
  if (isGeneratedApiReference(target)) return; // JSX body — no static headings
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    violation(page, line, `malformed anchor "${link}" — bad %-encoding`, audience);
    return;
  }
  if (!headingSlugs(target, audience).has(decoded)) {
    const where =
      target.file === page.file
        ? "this page"
        : relToRepo(target.file);
    violation(
      page,
      line,
      `broken anchor "${link}" — no heading with slug "#${decoded}" on ${where}`,
      audience,
    );
  }
}

for (const page of [...docsPages, ...sharedPages, ...selfHostedPages]) {
  for (const found of extractLinks(page)) {
    const { target, line, audiences } = found;
    if (target === "" || isExternal(target)) continue;

    const hashAt = target.indexOf("#");
    const rawPath = hashAt === -1 ? target : target.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : target.slice(hashAt + 1);

    if (rawPath === "") {
      // Same-page anchor: must survive on every mount this occurrence renders on.
      for (const audience of audiences) {
        checkAnchor(page, line, target, page, audience, fragment);
      }
      continue;
    }

    if (rawPath.startsWith("/")) {
      const path = normalizePath(rawPath);
      if (NON_CONTENT_ROUTES.has(path)) continue;
      const mount = mountFor(path);
      const targetPage = mount.byUrl.get(path);
      if (!targetPage) {
        violation(
          page,
          line,
          `broken link "${target}" — no page at "${path}"`,
          mount.audience,
        );
        continue;
      }
      if (fragment !== "") {
        checkAnchor(page, line, target, targetPage, mount.audience, fragment);
      }
      continue;
    }

    // Relative link — fumadocs' createRelativeLink resolves it against the
    // page's virtual FILE path within the mount's merged collection (audience
    // + shared share one flat namespace), optionally with an .mdx extension.
    const base = posix.dirname(page.virtualPath);
    const resolved = posix
      .join(base, normalizePath(rawPath))
      .replace(/\.mdx?$/, "");
    if (resolved.startsWith("..")) {
      violation(
        page,
        line,
        `broken link "${target}" — resolves outside the content tree`,
      );
      continue;
    }
    for (const audience of audiences) {
      const mount = MOUNTS[audience];
      const targetPage =
        mount.byVirtualPath.get(resolved) ??
        mount.byVirtualPath.get(`${resolved}/index`);
      if (!targetPage) {
        violation(
          page,
          line,
          `broken link "${target}" — resolves to "${resolved}", not a page`,
          audience,
        );
        continue;
      }
      if (fragment !== "") {
        checkAnchor(page, line, target, targetPage, audience, fragment);
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const totalPages = docsPages.length + sharedPages.length + selfHostedPages.length;
if (totalPages === 0) {
  console.error(`[docs-links] FAIL: no MDX pages found under ${contentDir}`);
  process.exit(1);
}

if (violations.length > 0) {
  violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  for (const v of violations) {
    const mounts = [...(violationMounts.get(v.key) ?? [])];
    const suffix =
      mounts.length === 0
        ? ""
        : mounts.length === 1
          ? ` (${MOUNTS[mounts[0]].name} mount)`
          : ` (both mounts)`;
    console.error(`${v.file}:${v.line}: ${v.message}${suffix}`);
  }
  console.error(
    `[docs-links] FAIL: ${violations.length} broken internal link(s)/anchor(s) across ${totalPages} pages`,
  );
  process.exit(1);
}

console.log(
  `[docs-links] PASS: internal links + anchors resolve across ${totalPages} pages (root + /self-hosted mounts)`,
);
