import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  SELF_HOSTED_REDIRECTS,
  MOVED_SELF_HOSTED_SLUGS,
  ATLAS_GUIDE_REDIRECTS,
  RENAMED_ATLAS_GUIDE_STEMS,
  SHARED_MOUNT_PREFIXES,
  canonicalForSelfHostedMount,
} from "@/lib/redirects";
import type { SharedMountPrefix } from "@/lib/redirects";

/**
 * Redirect-coverage test — `deploy/docs/Caddyfile` vs the maps in
 * `@/lib/redirects`. Two move sets, one guard: the `/self-hosted` section split
 * (#4267) and the `brain-*` -> `atlas-*` guide rename (#5083). `apps/docs`
 * builds with `output: "export"`, so Next's `redirects()` is off and the
 * Caddyfile is the only redirect layer.
 *
 * ── /self-hosted section split (PRD #4257 slice #4267) ───────────────────────
 *
 * Slice #4264 (PR #4283) MOVED twelve self-hosted-only pages from the site root
 * into the new `/self-hosted/*` section. This test guards that no pre-split
 * on-prem URL 404s after the move — in BOTH directions:
 *
 *   forward (map -> Caddyfile / disk):
 *     - the captured pre-split URL set is `SELF_HOSTED_REDIRECTS` — the checked-in
 *       SSOT derived from the 3b git renames (see `@/lib/redirects`), *not* a list
 *       hand-typed here that could drift;
 *     - every captured old URL has a bare + trailing-slash 308 entry in the real
 *       `deploy/docs/Caddyfile` pointing at its `/self-hosted` counterpart;
 *     - every redirect target resolves to a real page on disk (no 404);
 *     - the old root file is gone, so a redirect can't shadow a still-live page.
 *
 *   reverse (Caddyfile / disk -> map):
 *     - every `/self-hosted` `redir` the Caddyfile actually serves is one the map
 *       declares AND points at a real page — so a stale line left behind after a
 *       page is deleted, or a hand-added stray, can't silently 308 -> 404;
 *     - no moved page under content/self-hosted/ is missing from the map (a new
 *       file there that isn't an acknowledged born-here page fails).
 *
 * Also unit-tests `canonicalForSelfHostedMount` — #4267's one branching piece
 * of logic, and a stated deliverable (canonical tags).
 *
 * Serving behaviour itself is NOT covered here, and cannot be: these are
 * filesystem and text reads, so they prove the Caddyfile says the right thing,
 * never that Caddy does it. #5083 validated that once by hand — `next build`,
 * then `caddy:2-alpine` over the real `out/`, 44/44 URLs — and standing that up
 * per-CI-run to re-prove 28 static lines is not worth the fixture.
 *
 * Self-contained: read-only reads of the Caddyfile, `source.ts`, and a
 * filesystem walk; no bundler, no network, no git-at-runtime (CI checks out
 * shallow).
 */

// src/lib/__tests__ -> apps/docs
const DOCS_ROOT = join(import.meta.dir, "../../..");
const CONTENT_SELF_HOSTED = join(DOCS_ROOT, "content/self-hosted");
const CONTENT_DOCS = join(DOCS_ROOT, "content/docs");
const CONTENT = join(DOCS_ROOT, "content");
const CONTENT_SHARED = join(DOCS_ROOT, "content/shared");
const CONTENT_SHARED_GUIDES = join(CONTENT_SHARED, "guides");
const SOURCE_TS = join(DOCS_ROOT, "src/lib/source.ts");
// apps/docs -> repo root. The retired-link sweep reaches beyond apps/docs
// because the docs are deep-linked from the product: the admin console and the
// marketing site both hardcode docs.useatlas.dev/guides/… URLs, and a 308 that
// keeps an EXTERNAL link alive does not excuse one of ours pointing at a URL we
// retired ourselves.
const REPO_ROOT = join(DOCS_ROOT, "../..");
const LINK_SCAN_ROOTS: readonly string[] = [
  CONTENT,
  join(DOCS_ROOT, "src"),
  join(REPO_ROOT, "apps/www/src"),
  join(REPO_ROOT, "apps/www/content"),
  join(REPO_ROOT, "packages/web/src"),
];
// READMEs live at repo/package roots, so they are named rather than walked —
// a directory walk that reached them would have to cross node_modules.
const README_FILES: readonly string[] = [
  "README.md",
  "packages/react/README.md",
  "deploy/docs/README.md",
];
// apps/docs -> repo root -> deploy/docs/Caddyfile
const CADDYFILE = join(DOCS_ROOT, "../../deploy/docs/Caddyfile");

// Pages physically under content/self-hosted/ that were BORN there (there was no
// `/self-hosted` before the split, so they have no pre-split URL and need no
// redirect). Paths are relative to content/self-hosted/, forward-slash. Every
// other .mdx under content/self-hosted/ MUST be a moved page in the redirect map
// — a new file here that is neither allow-listed nor mapped fails the
// completeness test, forcing either a redirect entry or an explicit born-here
// acknowledgement.
const BORN_UNDER_SELF_HOSTED = new Set([
  "index.mdx",
  // #4282 — self-hosted operator sections extracted from three of the six saas
  // pages the slice split (the rung-4 extractions; the other three used the
  // `<WhenSelfHosted>` conditional and produced no file). Born here (the on-prem
  // content had no pre-split /self-hosted URL of its own — it lived inline on a
  // SaaS page), so they need no redirect.
  "guides/self-hosted-billing.mdx",
  "guides/self-serve-signup.mdx",
  "deployment/load-testing.mdx",
]);

// A file fumadocs publishes as a page.
//
// ⚠️ `.md` TOO, not just `.mdx`. `fumadocs-mdx`'s `SupportedFormats.doc` is
// `["mdx", "md"]` and it globs `**/*.{mdx,md}` unless a collection overrides
// `files` — `source.config.ts` overrides it on none of the three. An
// `.mdx`-only guard tests the EXTENSION the known guides happen to use,
// which is the enumeration bug this file exists to close, one level further
// down again: a `brain-lineage.md` publishes two live retired URLs.
const PAGE_EXT = /\.mdx?$/;

// Normalize a Caddyfile line so `redir <from> <to> 308` matches regardless of
// the file's tab indentation / internal spacing.
//
// Trailing `#` comments are STRIPPED, because Caddy strips them too. Verified
// with `caddy adapt`: `redir <a> <b> 308 # note` adapts to a live 308. Left in
// place, that fourth token makes the line unreadable to `REDIR_LINE`, and an
// unparseable `redir` used to be skipped by every sweep — so a stray or
// inverted redirect could ship simply by carrying a comment. No redirect here
// carries one today; this file is nearly half comment lines, which is what
// makes appending one a plausible edit.
const normalize = (line: string): string =>
  line
    .trim()
    .replace(/(^|\s)#.*$/, "$1")
    .trim()
    .replace(/\s+/g, " ");

const caddyLines: string[] = (() => {
  if (!existsSync(CADDYFILE)) {
    throw new Error(
      `Caddyfile not found at ${CADDYFILE} — redirect-coverage test cannot verify the docs redirects`,
    );
  }
  return readFileSync(CADDYFILE, "utf8").split("\n").map(normalize);
})();

function hasRedir(from: string, to: string): boolean {
  return caddyLines.includes(`redir ${from} ${to} 308`);
}

// `redir <from> <to> [status]`. The status is OPTIONAL in the pattern and
// CAPTURED rather than required, so a 301/302/`permanent` line is something the
// reverse sweeps can see and reject. Requiring `308` here instead would make
// the exact line that shadows a correct redirect invisible to them — Caddy
// keeps source order among handlers of one directive, and this Caddyfile
// already documents that it depends on that ordering.
const REDIR_LINE = /^redir (\S+) (\S+)(?: (\S+))?$/;

// A URL that lands anywhere in the `/self-hosted` section, on either endpoint.
// Anchored + boundary-aware so a hypothetical `/self-hostedX` path can't match.
const touchesSelfHosted = (url: string): boolean =>
  /^\/self-hosted(?=[/?#]|$)/.test(url);

// A retired guide URL, matched as a CLASS: a stem-list guard cannot see a
// guide added after the list was written. See `RENAMED_ATLAS_GUIDE_STEMS`.
//
// The stem class is `[A-Za-z0-9._-]` and not `[a-z0-9-]`, which enumerated the
// characters today's stems happen to use: a link to `brain-M4_notes`, or to
// the `.mdx` twin of a retired URL, would have matched nothing.
const RETIRED_GUIDE_URL = /(^|\/)guides\/brain-[A-Za-z0-9._-]+/;

// Any guide URL this move touches — retired OR live. The reverse sweeps scope
// on this rather than on the retired half alone: a stray line BETWEEN two live
// guides (`/guides/atlas-sources -> /guides/atlas-conflicts`) is neither
// retired nor `/self-hosted`, so scoping on those two would drop it, leaving
// the fourteen URLs this move CREATES unguarded against a typo.
const GUIDE_URL = /(^|\/)guides\/(?:brain|atlas)-[A-Za-z0-9._-]+/;

// Is this content file published under a retired `brain-*` URL segment?
//
// ⚠️ Keyed on the published PATH SEGMENTS, not on the filename. Matching
// `brain-*.mdx` instead tests the SHAPE the known guides happen to have — a
// leaf file — and fumadocs also serves `<seg>/index.mdx` as the page for
// `<seg>`, a shape `content/shared/` already uses (agent-auth, comparisons,
// semantic-layer, five under plugins/). So a retired stem authored as
// `<stem>/index.mdx` would publish two live URLs and a filename guard would
// report nothing: the enumeration bug this guard exists to close, one level
// down.
//
// Case-insensitive, matching `RETIRED_GUIDE_URL`'s widened class — a
// capitalised stem is the same defect wearing different capitals.
function retiredGuideSegments(relPath: string): readonly string[] {
  const segments = relPath.replace(PAGE_EXT, "").split("/");
  // `<seg>/index` is the page for `<seg>`, so the trailing `index` is not a URL
  // segment of its own; dropping it also stops it masking its parent.
  if (segments.at(-1) === "index") segments.pop();
  return segments.filter((seg) => /^brain-/i.test(seg));
}

// Every (from -> to) pair ANY map in `@/lib/redirects` declares, bare and
// trailing-slash, keyed as one string so the reverse sweeps compare the PAIR
// rather than the two endpoints independently — a redirect whose `from` and
// `to` are each known but belong to different entries is still a bug.
const DECLARED_REDIRECT_PAIRS: ReadonlySet<string> = new Set(
  [...SELF_HOSTED_REDIRECTS, ...ATLAS_GUIDE_REDIRECTS].flatMap(({ from, to }) => [
    `${from} -> ${to}`,
    `${from}/ -> ${to}/`,
  ]),
);

// Does a page exist at `<root>/<slug>`, in either shape fumadocs publishes?
const pageAt = (root: string, slug: string): boolean =>
  existsSync(join(root, `${slug}.mdx`)) ||
  existsSync(join(root, `${slug}.md`)) ||
  existsSync(join(root, slug, "index.mdx")) ||
  existsSync(join(root, slug, "index.md"));

// A renamed guide's target resolves iff its shared source file is on disk. The
// slug is derived from the redirect's own `to` rather than re-derived from the
// stem: re-deriving would check the file the entry SHOULD point at instead of
// the one it does, so a malformed target would still find a real page.
// One file per stem serves both mounts, so the mount prefix is stripped.
function sharedGuideResolves(to: string): boolean {
  const slug = to.replace(/^.*\/guides\//, "").replace(/\/$/, "");
  return pageAt(CONTENT_SHARED_GUIDES, slug);
}

// A `/self-hosted` URL (bare or trailing-slash) resolves to a real page iff one
// of the collections that loader is composed from publishes it.
//
// BOTH collections, not just `content/self-hosted`: `src/lib/source.ts` builds
// the section from the on-prem files AND `content/shared`, so a redirect
// targeting a shared page mounted here resolves through the shared arm. The
// twelve #4267 slugs are all on-prem leaves; the shared arm is what lets this
// sweep judge the #5083 guide redirects itself instead of exempting them.
function pageResolves(selfHostedUrl: string): boolean {
  // Guard the contract rather than trusting it. Since the sweep widened to
  // "either endpoint", this is reachable with a non-/self-hosted `to`, where
  // the prefix strip silently no-ops and the answer would come from the wrong
  // mount's tree — a false "resolves", which is the direction that ships a 404.
  if (!touchesSelfHosted(selfHostedUrl)) {
    throw new Error(
      `pageResolves called with a non-/self-hosted URL (${selfHostedUrl}) — it resolves against ` +
        "content/self-hosted + content/shared and would answer for the wrong mount",
    );
  }
  const slug = selfHostedUrl
    .replace(/^\/self-hosted\/?/, "")
    .replace(/\/$/, "");
  if (slug === "") return existsSync(join(CONTENT_SELF_HOSTED, "index.mdx"));
  return [CONTENT_SELF_HOSTED, CONTENT_SHARED].some((root) =>
    pageAt(root, slug),
  );
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(
      `${dir} not found — this walk cannot verify that no retired brain-* guide or link survives there`,
    );
  }
  const out: string[] = [];
  // `withFileTypes` skips a per-entry statSync and does NOT follow directory
  // symlinks, so a stray symlink under content/ can't drive unbounded recursion.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("self-hosted redirect coverage (#4267)", () => {
  test("the move set is non-empty and derived 1:1 from the moved slugs", () => {
    expect(MOVED_SELF_HOSTED_SLUGS.length).toBeGreaterThan(0);
    expect(SELF_HOSTED_REDIRECTS.length).toBe(MOVED_SELF_HOSTED_SLUGS.length);
  });

  for (const { slug, from, to } of SELF_HOSTED_REDIRECTS) {
    describe(`/${slug}`, () => {
      test("is a clean /self-hosted prefix move (new URL derived, not typed)", () => {
        expect(from).toBe(`/${slug}`);
        expect(to).toBe(`/self-hosted/${slug}`);
      });

      test("has a bare-path 308 redirect in the Caddyfile", () => {
        expect(hasRedir(from, to)).toBe(true);
      });

      test("has a trailing-slash 308 redirect in the Caddyfile", () => {
        expect(hasRedir(`${from}/`, `${to}/`)).toBe(true);
      });

      test("target resolves to a real /self-hosted page (no 404)", () => {
        expect(pageResolves(to)).toBe(true);
      });

      test("old root page is gone (redirect can't shadow a live page)", () => {
        // `pageAt`, not a bare `<slug>.mdx`: this check has to see every shape
        // fumadocs publishes, or a page restored at the old URL as `.md` or as
        // `<slug>/index.mdx` shadows the redirect while the test stays green.
        expect(pageAt(CONTENT_DOCS, slug)).toBe(false);
      });
    });
  }

  test("every /self-hosted redirect the Caddyfile serves is mapped, 308, and resolves (no stale/stray/shadowing line)", () => {
    // Collect offenders (rather than asserting per-line) so a real failure names
    // the exact Caddyfile line instead of a bare `false !== true`.
    const unmapped: string[] = []; // hand-added stray or mismatched from/to
    const unresolved: string[] = []; // stale 308 -> a page that no longer exists
    const wrongStatus: string[] = []; // a 301/302/permanent line on the same path
    const unparsed: string[] = []; // a `redir` this sweep could not read at all
    for (const line of caddyLines) {
      const match = REDIR_LINE.exec(line);
      if (!match) {
        // An unreadable `redir` is a FINDING, never a skip. A silent `continue`
        // here is how a line Caddy happily serves ends up judged by nothing —
        // the same shape as filtering on the status, one step earlier.
        if (line.startsWith("redir ")) unparsed.push(line);
        continue;
      }
      const [, redirFrom, redirTo, status] = match;
      // Every line that TOUCHES the /self-hosted section on either endpoint,
      // whatever put it there (mcp-hosted etc. sit outside it entirely).
      // Membership is checked against the UNION of this module's maps, not just
      // #4267's: #5083 added `/self-hosted/guides/brain-* ->
      // /self-hosted/guides/atlas-*` lines, which land in this section but are
      // declared by the OTHER map. Filtering them out of the sweep instead
      // would leave them swept by nothing.
      if (!touchesSelfHosted(redirFrom) && !touchesSelfHosted(redirTo)) continue;
      // The status is CAPTURED, not used as the scope filter. Filtering on
      // `308` would make a `redir /deployment/deploy /elsewhere 302` invisible
      // to this sweep — and Caddy keeps source order among handlers of one
      // directive, so a non-308 line placed above the real one SHADOWS it while
      // the `hasRedir` checks above still find their 308 further down.
      if (status !== "308") {
        wrongStatus.push(line);
        continue;
      }
      // The line must be one some map declares — as a PAIR, so a redirect
      // pointing at the wrong (but individually known) target still fails ...
      if (!DECLARED_REDIRECT_PAIRS.has(`${redirFrom} -> ${redirTo}`)) {
        unmapped.push(line);
        continue;
      }
      // ... and must resolve to a real page (catches a stale 308 -> 404 left
      // behind after a page is deleted from both the map and disk).
      if (!pageResolves(redirTo)) unresolved.push(line);
    }
    expect(unparsed).toEqual([]);
    expect(wrongStatus).toEqual([]);
    expect(unmapped).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test("no moved content/self-hosted page is missing from the redirect map", () => {
    const mapped = new Set<string>(MOVED_SELF_HOSTED_SLUGS);
    const orphans: string[] = [];
    for (const file of walk(CONTENT_SELF_HOSTED)) {
      if (!PAGE_EXT.test(file)) continue;
      // Forward-slash the relative path so it matches map slugs on any OS.
      const rel = relative(CONTENT_SELF_HOSTED, file).split(sep).join("/");
      if (BORN_UNDER_SELF_HOSTED.has(rel)) continue;
      const slug = rel.replace(PAGE_EXT, "");
      if (!mapped.has(slug)) orphans.push(slug);
    }
    // Any orphan is either a page that moved from root without a redirect, or a
    // newly born-here page that needs allow-listing. Either way: review it.
    expect(orphans).toEqual([]);
  });
});

/**
 * brain-* -> atlas-* guide-rename coverage (#5083, ADR-0038 Layer 1).
 *
 * The Company Atlas guides kept `brain-*` FILENAMES after taking the new
 * noun in their titles, so `/guides/brain-<stem>` served a page titled
 * "Company Atlas — …". Renaming the files moves the published URLs, and
 * `output: "export"` means Caddy carries the 308s.
 *
 * The trap this block exists for is the SECOND mount. These pages live in
 * `content/shared/`, which `src/lib/source.ts` feeds into the site-root loader
 * AND the `/self-hosted` loader, so each rename retires two live URLs.
 *
 * ⚠️ **Mount coverage is NOT read off `guides/meta.json`.** An earlier cut did
 * exactly that and was wrong about how fumadocs routes: `compose.ts`
 * concatenates the whole `shared` collection into each section's source, and
 * the page routes enumerate over the collection's FILES. `meta.json` orders the
 * sidebar; it does not decide whether a URL is served. So a nav-gated check
 * fails OPEN — delete a stem from `self-hosted/guides/meta.json`, a plausible
 * nav tidy, and the redirect obligation for a still-live URL evaporates. The
 * mount set is instead pinned to the loaders in `source.ts`, and the nav is
 * checked only for what it genuinely owns: a stale `brain-*` sidebar entry.
 *
 * The guards below are written against the CLASS (`brain-*`), not the known
 * stems — `brain-vocabulary` inherited this defect after #5083 was filed, and
 * a stem-list guard cannot see a guide added after the list was written.
 */

// Each shared mount's guide nav. `Record<SharedMountPrefix, …>` rather than an
// array of pairs, so a mount added to `SHARED_MOUNT_PREFIXES` is a compile
// error here ("property is missing") instead of a mount this file silently
// stops checking.
const GUIDE_NAV_META: Readonly<Record<SharedMountPrefix, string>> = {
  "": join(CONTENT_DOCS, "guides/meta.json"),
  "/self-hosted": join(CONTENT_SELF_HOSTED, "guides/meta.json"),
};

function guideNavPages(metaPath: string): readonly string[] {
  // Existence is checked SEPARATELY from parsing. With the read inside the try,
  // an ENOENT surfaced as "is not valid JSON", pointing whoever reads it at a
  // trailing comma in a file that is not there — and that is reachable:
  // fumadocs accepts `meta.yaml` too, so converting a nav renames it rather
  // than corrupting it.
  if (!existsSync(metaPath)) {
    throw new Error(
      `${metaPath} does not exist — the guide nav cannot be checked for retired stems. ` +
        "fumadocs also accepts meta.yaml; if the nav was converted, update GUIDE_NAV_META",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    // `JSON.parse` reports the offending token and nothing about the file, so a
    // trailing comma in either nav would fail with no way to tell them apart.
    throw new Error(
      `${metaPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — the guide nav cannot be checked for retired stems`,
    );
  }
  const pages =
    typeof parsed === "object" && parsed !== null && "pages" in parsed
      ? parsed.pages
      : undefined;
  if (!Array.isArray(pages)) {
    throw new Error(
      `${metaPath} has no \`pages\` array — the guide nav cannot be checked for retired stems`,
    );
  }
  const entries: readonly unknown[] = pages;
  // THROW rather than filter. Membership below is decided by string
  // comparison, so a silently dropped entry reads as "this nav doesn't mention
  // that stem" — the answer that makes the check pass. fumadocs' own
  // `metaSchema` types `pages` as string-only, so a non-string here means the
  // nav is malformed, not that this reader has to cope with it.
  const strings = entries.filter((p): p is string => typeof p === "string");
  if (strings.length !== entries.length) {
    const nonStrings = entries.filter((p) => typeof p !== "string");
    throw new Error(
      `${metaPath} has ${nonStrings.length} non-string \`pages\` entr${nonStrings.length === 1 ? "y" : "ies"} (${JSON.stringify(nonStrings)}) — nav membership cannot be decided from strings alone`,
    );
  }
  // Narrowed by the predicate above rather than asserted, so the return type is
  // proven by the filter instead of promised by a cast.
  return strings;
}

describe("brain-* -> atlas-* guide renames (#5083)", () => {
  test("the map is one entry per stem per mount, both URLs derived", () => {
    expect(RENAMED_ATLAS_GUIDE_STEMS.length).toBeGreaterThan(0);
    expect(ATLAS_GUIDE_REDIRECTS.length).toBe(
      RENAMED_ATLAS_GUIDE_STEMS.length * SHARED_MOUNT_PREFIXES.length,
    );
    // An absolute floor as well as the internal-consistency product above.
    // Shrinking every factor together — `SHARED_MOUNT_PREFIXES`, the Caddyfile
    // block, `GUIDE_NAV_META`'s navs and `source.ts` — keeps the product true
    // and reds nothing else; only the floor catches it. A retired-URL set can
    // only ever grow.
    expect(ATLAS_GUIDE_REDIRECTS.length).toBeGreaterThanOrEqual(14);
    // Distinct `from`s: a mount prefix duplicated in the source array would
    // otherwise pass the count check with two identical halves.
    expect(new Set(ATLAS_GUIDE_REDIRECTS.map((r) => r.from)).size).toBe(
      ATLAS_GUIDE_REDIRECTS.length,
    );
  });

  test("the mount set is the one `source.ts` actually mounts `shared` under", () => {
    // The seven `/self-hosted` guide redirects (14 Caddyfile lines) rest on a
    // premise no other
    // assertion holds: that `shared` is fed into the /self-hosted loader. Drop
    // that argument in `source.ts` and those 308s point at 404s while every
    // other test here stays green — so read the premise instead of restating
    // it. Text-scanned rather than imported: `source.ts` pulls in the generated
    // `.source/server` bundle, which is a build artifact this test must not
    // depend on.
    //
    // ⚠️ Read PER CALL SITE, not as two whole-file counts. The first cut
    // compared `matchAll(/baseUrl:/)` against `match(/\bshared,/g).length` —
    // two global tallies that a single COMMENT mentioning `shared,` rebalances.
    // Under that spelling, dropping `shared` from the /self-hosted loader and
    // adding one such comment left the suite fully green, so the falsifier
    // recorded for this very assertion held only by lexical accident. Anchoring
    // on `buildSectionSource({…})` reads the mount and its `shared` argument
    // out of the SAME object, which is the discipline the redirect maps
    // themselves use for `from`/`to`.
    const src = readFileSync(SOURCE_TS, "utf8");
    // Comments are stripped from each body before it is read, because a comment
    // INSIDE the object literal is the remaining way to fake a `shared`
    // argument. Measured, both forms: a `//` and a `/* */` mentioning `shared,`
    // where the argument used to be each kept this assertion green with the
    // argument gone.
    //
    // `//` preceded by `:` is left alone so a `https://` inside a string is not
    // read as a comment. The block-comment strip is safe HERE because it runs
    // per captured body; run over the whole file it would corrupt it, since a
    // line comment above these loaders contains `/api-reference/*` whose `/*`
    // opens a block that swallows both call sites (measured: 2 sites -> 0).
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const loaders = [...src.matchAll(/buildSectionSource\(\{([\s\S]*?)\}\)/g)]
      .map(([, body]) => stripComments(body))
      .map((body) => ({
        baseUrl: /baseUrl:\s*["'`]([^"'`]*)["'`]/.exec(body)?.[1] ?? null,
        mountsShared: /(^|[\s,{])shared\s*[,}]/.test(body),
      }));
    expect(loaders.length).toBeGreaterThan(0);
    // A loader whose `baseUrl` this scan cannot read (computed, or a template
    // with a substitution) is a BLIND SPOT, not a pass — fail rather than
    // silently drop it from the comparison.
    expect(loaders.filter((l) => l.baseUrl === null)).toEqual([]);
    const sharedMounts = loaders
      .filter((l) => l.mountsShared)
      // `source.ts` spells the site root "/"; a mount PREFIX carries no
      // trailing slash, so the root prefix is the empty string.
      .map((l) => (l.baseUrl === "/" ? "" : l.baseUrl));
    // Every loader that mounts `shared` must have a redirect prefix, and every
    // prefix must be such a loader. Set equality, so both directions fail.
    expect([...sharedMounts].sort()).toEqual([...SHARED_MOUNT_PREFIXES].sort());
  });

  for (const { stem, mount, from, to } of ATLAS_GUIDE_REDIRECTS) {
    describe(`${mount || "/"} :: ${stem}`, () => {
      test("both URLs are derived from the stem, not hand-typed", () => {
        expect(from).toBe(`${mount}/guides/brain-${stem}`);
        expect(to).toBe(`${mount}/guides/atlas-${stem}`);
      });

      test("has a bare-path 308 redirect in the Caddyfile", () => {
        expect(hasRedir(from, to)).toBe(true);
      });

      test("has a trailing-slash 308 redirect in the Caddyfile", () => {
        expect(hasRedir(`${from}/`, `${to}/`)).toBe(true);
      });

      test("target resolves to a real shared guide (no 404)", () => {
        expect(sharedGuideResolves(to)).toBe(true);
      });
    });
  }

  test("no page is published under a brain-* URL segment (the class, not the stem list)", () => {
    const survivors: string[] = [];
    let sharedGuidesScanned = 0;
    for (const file of walk(CONTENT)) {
      if (!PAGE_EXT.test(file)) continue;
      const rel = relative(CONTENT, file).split(sep).join("/");
      if (rel.startsWith("shared/guides/")) sharedGuidesScanned += 1;
      if (retiredGuideSegments(rel).length > 0) survivors.push(rel);
    }
    // Vacuity floor on the population this guard EXISTS for, not on the whole
    // walk: `content/docs` alone is ~578 pages, so a bare `> 100` stays green
    // with all of `content/shared` — where every renamed guide lives — missing.
    expect(sharedGuidesScanned).toBeGreaterThanOrEqual(
      RENAMED_ATLAS_GUIDE_STEMS.length,
    );
    // Any survivor is published under a retired segment on both mounts. It is
    // either a rename this move missed or a new page named under the retired
    // noun; both need the same fix.
    expect(survivors).toEqual([]);
  });

  test("every atlas-* shared guide is a registered rename or an acknowledged born-atlas page", () => {
    // The mirror of the survivor scan, and the discipline #4267 already has
    // (`BORN_UNDER_SELF_HOSTED` + its orphan sweep) that this move set lacked.
    // Without it, a guide renamed correctly ON DISK but never added to
    // `RENAMED_ATLAS_GUIDE_STEMS` retires two live URLs with no redirect and no
    // signal — the stem list is hand-maintained, so something has to check it.
    const registered = new Set<string>(RENAMED_ATLAS_GUIDE_STEMS);
    const onDisk = readdirSync(CONTENT_SHARED_GUIDES)
      .filter((f) => /^atlas-/.test(f) && PAGE_EXT.test(f))
      .map((f) => f.replace(/^atlas-/, "").replace(PAGE_EXT, ""));
    expect(onDisk.length).toBeGreaterThanOrEqual(
      RENAMED_ATLAS_GUIDE_STEMS.length,
    );
    // A guide authored as `atlas-*` from the start never had a retired URL and
    // would be listed here deliberately. There are none today.
    const BORN_ATLAS_GUIDES = new Set<string>();
    expect(
      onDisk.filter((s) => !registered.has(s) && !BORN_ATLAS_GUIDES.has(s)),
    ).toEqual([]);
  });

  test("no section nav still lists a brain-* stem, and the Caddyfile covers every mount", () => {
    const staleNavEntries: string[] = [];
    const mountsMissingRedirect: string[] = [];

    // Nav hygiene — the one thing meta.json genuinely owns. Matched as a class,
    // so an entry for a guide outside the move set is caught too. fumadocs also
    // accepts `./stem` and `folder/stem` forms, so the match is not anchored to
    // the bare spelling; the `[(]` arm catches a markdown link entry, whose
    // stem sits after an opening parenthesis rather than at the start.
    for (const mount of SHARED_MOUNT_PREFIXES) {
      const metaPath = GUIDE_NAV_META[mount];
      for (const page of guideNavPages(metaPath)) {
        if (/(^|[/(])brain-/i.test(page)) {
          staleNavEntries.push(`${metaPath}: ${page}`);
        }
      }
    }

    // Mount coverage, checked against the CADDYFILE. Checking it against
    // `ATLAS_GUIDE_REDIRECTS` instead — the obvious spelling — asserts nothing
    // at all: that array IS `mounts × stems`, so the loop would compare the
    // cross-product with itself and could never report a miss.
    for (const stem of RENAMED_ATLAS_GUIDE_STEMS) {
      for (const mount of SHARED_MOUNT_PREFIXES) {
        const from = `${mount}/guides/brain-${stem}`;
        const to = `${mount}/guides/atlas-${stem}`;
        if (!hasRedir(from, to) || !hasRedir(`${from}/`, `${to}/`)) {
          mountsMissingRedirect.push(from);
        }
      }
    }

    expect(staleNavEntries).toEqual([]);
    expect(mountsMissingRedirect).toEqual([]);
  });

  test("every guide redirect the Caddyfile serves is mapped and 308 (no stale/stray/inverted line)", () => {
    const unmapped: string[] = [];
    const wrongStatus: string[] = [];
    const unparsed: string[] = [];
    for (const line of caddyLines) {
      const match = REDIR_LINE.exec(line);
      if (!match) {
        if (line.startsWith("redir ")) unparsed.push(line);
        continue;
      }
      const [, redirFrom, redirTo, status] = match;
      // EITHER endpoint, and the LIVE URLs as well as the retired ones
      // (`GUIDE_URL`, not `RETIRED_GUIDE_URL`). Scoping on the retired half
      // alone leaves two gaps: an INVERTED pair — target retired, source live,
      // which composes with the real line into an infinite redirect loop — and
      // a stray line between two live guides, which touches nothing retired at
      // all and so would be swept by neither this nor the /self-hosted sweep.
      // (Written without spelling the offending path out: the retired-link scan
      // below reads this file too, and a quotation is indistinguishable from an
      // assertion to a lexical guard.)
      if (!GUIDE_URL.test(redirFrom) && !GUIDE_URL.test(redirTo)) continue;
      if (status !== "308") {
        wrongStatus.push(line);
        continue;
      }
      if (!DECLARED_REDIRECT_PAIRS.has(`${redirFrom} -> ${redirTo}`)) {
        unmapped.push(line);
      }
    }
    expect(unparsed).toEqual([]);
    expect(wrongStatus).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  test("nothing in the docs, the marketing site or the admin UI links to a retired guide URL", () => {
    // A 308 keeps an EXTERNAL link alive; an internal one that has to bounce is
    // a link we simply failed to update. The scan reaches past apps/docs
    // because the product deep-links the docs — /admin and apps/www both
    // hardcode docs.useatlas.dev/guides/… URLs, and an absolute URL still
    // contains the retired path.
    const offenders: string[] = [];
    const atlasStemsSeen = new Set<string>();
    const scan = (file: string, label: string): void => {
      const text = readFileSync(file, "utf8");
      const retired = text.match(new RegExp(RETIRED_GUIDE_URL, "g"));
      if (retired) {
        offenders.push(`${label} -> ${[...new Set(retired)].join(", ")}`);
      }
      for (const m of text.matchAll(/(?:^|\/)guides\/atlas-([A-Za-z0-9._-]+)/g)) {
        atlasStemsSeen.add(m[1]);
      }
    };
    for (const root of LINK_SCAN_ROOTS) {
      for (const file of walk(root)) {
        if (!/\.(mdx?|tsx?|json)$/.test(file)) continue;
        scan(file, relative(REPO_ROOT, file));
      }
    }
    // The READMEs are named individually rather than walked: they sit at repo
    // and package roots, so reaching them by directory would mean walking the
    // whole tree past node_modules. `packages/react/README.md` is the one that
    // matters most — it SHIPS TO NPM, where a retired link is frozen into a
    // published tarball and the 308 is the only thing keeping it alive.
    for (const rel of README_FILES) {
      const file = join(REPO_ROOT, rel);
      // A moved/renamed README must fail loudly; skipping it silently would
      // retire the guard along with the path.
      if (!existsSync(file)) {
        throw new Error(
          `${rel} not found — the retired-link scan cannot check it; update README_FILES`,
        );
      }
      scan(file, rel);
    }
    // Positive control. `expect(offenders).toEqual([])` passes just as happily
    // over zero files as over a clean tree, so assert the scanner read text it
    // COULD have matched — and assert it saw EVERY stem, not a count of
    // occurrences: one guide links several siblings, so a count-based floor is
    // satisfied by reading a single file.
    expect([...atlasStemsSeen].sort()).toEqual(
      [...RENAMED_ATLAS_GUIDE_STEMS].sort(),
    );
    expect(offenders).toEqual([]);
  });
});

describe("canonicalForSelfHostedMount (#4267)", () => {
  test("a self-hosted-only page canonicalizes to its own /self-hosted URL", () => {
    expect(
      canonicalForSelfHostedMount(
        "/self-hosted/deployment/authentication",
        "content/self-hosted/deployment/authentication.mdx",
      ),
    ).toBe("/self-hosted/deployment/authentication");
  });

  test("a shared page canonicalizes back to its site-root URL", () => {
    expect(
      canonicalForSelfHostedMount(
        "/self-hosted/changelog",
        "content/shared/changelog.mdx",
      ),
    ).toBe("/changelog");
  });

  test("a shared page mounted at the bare /self-hosted root maps back to /", () => {
    expect(
      canonicalForSelfHostedMount("/self-hosted", "content/shared/index.mdx"),
    ).toBe("/");
  });

  test("a missing absolutePath falls back to self-hosted-only (no crash)", () => {
    // Falls back to the safe assumption; the fn also warns (build-time anomaly).
    expect(canonicalForSelfHostedMount("/self-hosted/docker", undefined)).toBe(
      "/self-hosted/docker",
    );
    expect(canonicalForSelfHostedMount("/self-hosted/docker", "")).toBe(
      "/self-hosted/docker",
    );
  });

  test("does not strip a look-alike /self-hostedX prefix", () => {
    // Boundary-anchored: only the `/self-hosted` segment is a mount prefix, so a
    // self-hosted-only page whose slug itself starts with `self-hosted` is safe.
    expect(
      canonicalForSelfHostedMount(
        "/self-hosted/self-hosted-models",
        "content/self-hosted/guides/self-hosted-models.mdx",
      ),
    ).toBe("/self-hosted/self-hosted-models");
  });
});
