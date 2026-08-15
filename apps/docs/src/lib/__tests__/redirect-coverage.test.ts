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

/**
 * Redirect-coverage test — `deploy/docs/Caddyfile` vs the maps in
 * `@/lib/redirects`. Two move sets, one guard: the `/self-hosted` section split
 * (#4267) and the `brain-*` -> `atlas-*` guide rename (#5083). `apps/docs`
 * builds with `output: "export"`, so Next's `redirects()` is off and the
 * Caddyfile is the only thing standing between a moved page and a 404.
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
 * Also unit-tests `canonicalForSelfHostedMount` — the one branching piece of
 * logic in this slice, and a stated deliverable (canonical tags).
 *
 * Self-contained: read-only reads of the Caddyfile + a content/ filesystem walk;
 * no bundler, no network, no git-at-runtime (CI checks out shallow).
 */

// src/lib/__tests__ -> apps/docs
const DOCS_ROOT = join(import.meta.dir, "../../..");
const CONTENT_SELF_HOSTED = join(DOCS_ROOT, "content/self-hosted");
const CONTENT_DOCS = join(DOCS_ROOT, "content/docs");
const CONTENT = join(DOCS_ROOT, "content");
const CONTENT_SHARED_GUIDES = join(DOCS_ROOT, "content/shared/guides");
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

// Normalize a Caddyfile line so `redir <from> <to> 308` matches regardless of
// the file's tab indentation / internal spacing.
const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

const caddyLines: string[] = (() => {
  if (!existsSync(CADDYFILE)) {
    throw new Error(
      `Caddyfile not found at ${CADDYFILE} — redirect-coverage test cannot verify the /self-hosted redirects`,
    );
  }
  return readFileSync(CADDYFILE, "utf8").split("\n").map(normalize);
})();

function hasRedir(from: string, to: string): boolean {
  return caddyLines.includes(`redir ${from} ${to} 308`);
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

// The subset of the above contributed by the #5083 guide rename. The #4267
// sweep uses it to hand resolution of those targets to the #5083 block, whose
// pages live under content/shared/ where `pageResolves` (a content/self-hosted
// lookup) cannot find them.
const ATLAS_GUIDE_REDIRECT_PAIRS: ReadonlySet<string> = new Set(
  ATLAS_GUIDE_REDIRECTS.flatMap(({ from, to }) => [
    `${from} -> ${to}`,
    `${from}/ -> ${to}/`,
  ]),
);

// A renamed guide's target resolves iff the shared source file is on disk —
// one file per stem, mounted at both prefixes, so the mount is irrelevant here.
function sharedGuideResolves(stem: string): boolean {
  return existsSync(join(CONTENT_SHARED_GUIDES, `atlas-${stem}.mdx`));
}

// A `/self-hosted` URL (bare or trailing-slash) resolves to a real page iff the
// section has a leaf `<slug>.mdx` or a section-index `<slug>/index.mdx`. The
// twelve frozen slugs are all leaves today; the index arm keeps the check honest
// if a future appended slug maps to a section landing page.
function pageResolves(selfHostedUrl: string): boolean {
  const slug = selfHostedUrl
    .replace(/^\/self-hosted\/?/, "")
    .replace(/\/$/, "");
  if (slug === "") return existsSync(join(CONTENT_SELF_HOSTED, "index.mdx"));
  return (
    existsSync(join(CONTENT_SELF_HOSTED, `${slug}.mdx`)) ||
    existsSync(join(CONTENT_SELF_HOSTED, slug, "index.mdx"))
  );
}

function walk(dir: string): string[] {
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
        expect(existsSync(join(CONTENT_DOCS, `${slug}.mdx`))).toBe(false);
      });
    });
  }

  test("every /self-hosted redirect the Caddyfile serves is mapped and resolves (no stale/stray line)", () => {
    const redirLine = /^redir (\S+) (\S+) 308$/;
    // Collect offenders (rather than asserting per-line) so a real failure names
    // the exact Caddyfile line instead of a bare `false !== true`.
    const unmapped: string[] = []; // hand-added stray or mismatched from/to
    const unresolved: string[] = []; // stale 308 -> a page that no longer exists
    for (const line of caddyLines) {
      const match = redirLine.exec(line);
      if (!match) continue;
      const [, redirFrom, redirTo] = match;
      // Every line that lands anywhere in the /self-hosted section, whatever
      // put it there (mcp-hosted etc. target other prefixes and are out of
      // scope). Membership is checked against the UNION of this module's maps,
      // not just #4267's: #5083 added `/self-hosted/guides/brain-* ->
      // /self-hosted/guides/atlas-*` lines, which target this section but are
      // declared by the OTHER map. Filtering them out of the sweep instead
      // would leave them swept by nothing; checking them against the union
      // keeps the sweep's coverage of the section total.
      if (!redirTo.startsWith("/self-hosted")) continue;
      // The line must be one some map declares — as a PAIR, so a redirect
      // pointing at the wrong (but individually known) target still fails ...
      if (!DECLARED_REDIRECT_PAIRS.has(`${redirFrom} -> ${redirTo}`)) {
        unmapped.push(line);
        continue;
      }
      // ... and must resolve to a real page (catches a stale 308 -> 404 left
      // behind after a page is deleted from both the map and disk). Guide
      // renames land on a content/shared page mounted here, which
      // `pageResolves` cannot see, so they are resolved by the #5083 block.
      if (ATLAS_GUIDE_REDIRECT_PAIRS.has(`${redirFrom} -> ${redirTo}`)) continue;
      if (!pageResolves(redirTo)) unresolved.push(line);
    }
    expect(unmapped).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test("no moved content/self-hosted page is missing from the redirect map", () => {
    const mapped = new Set<string>(MOVED_SELF_HOSTED_SLUGS);
    const orphans: string[] = [];
    for (const file of walk(CONTENT_SELF_HOSTED)) {
      if (!file.endsWith(".mdx")) continue;
      // Forward-slash the relative path so it matches map slugs on any OS.
      const rel = relative(CONTENT_SELF_HOSTED, file).split(sep).join("/");
      if (BORN_UNDER_SELF_HOSTED.has(rel)) continue;
      const slug = rel.replace(/\.mdx$/, "");
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
 * The seven Company Atlas guides kept `brain-*` FILENAMES after taking the new
 * noun in their titles, so `/guides/brain-sources` served a page titled
 * "Company Atlas — Sources". Renaming the files moves the published URLs, and
 * `output: "export"` means Caddy — not Next — has to carry the 308s.
 *
 * The trap this block exists for is the SECOND mount. These pages live in
 * `content/shared/`, which `src/lib/source.ts` feeds into the site-root loader
 * AND the `/self-hosted` loader, so each rename retires TWO live URLs. The
 * mount coverage is checked against the two sections' `guides/meta.json` navs
 * rather than restated here, so a section that lists a stem and has no redirect
 * for it fails.
 */
const GUIDE_NAV_BY_MOUNT: ReadonlyArray<{
  readonly mount: string;
  readonly metaPath: string;
}> = [
  { mount: "", metaPath: join(CONTENT_DOCS, "guides/meta.json") },
  {
    mount: "/self-hosted",
    metaPath: join(CONTENT_SELF_HOSTED, "guides/meta.json"),
  },
];

function guideNavPages(metaPath: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
  const pages =
    typeof parsed === "object" && parsed !== null && "pages" in parsed
      ? (parsed as { pages: unknown }).pages
      : undefined;
  if (!Array.isArray(pages)) {
    throw new Error(
      `${metaPath} has no \`pages\` array — the guide nav cannot be checked for renamed stems`,
    );
  }
  return pages.filter((p): p is string => typeof p === "string");
}

describe("brain-* -> atlas-* guide renames (#5083)", () => {
  test("the map is one entry per stem per mount, both URLs derived", () => {
    expect(RENAMED_ATLAS_GUIDE_STEMS.length).toBeGreaterThan(0);
    expect(ATLAS_GUIDE_REDIRECTS.length).toBe(
      RENAMED_ATLAS_GUIDE_STEMS.length * SHARED_MOUNT_PREFIXES.length,
    );
    // Distinct `from`s: a mount prefix duplicated in the source array would
    // otherwise pass the count check with two identical halves.
    expect(new Set(ATLAS_GUIDE_REDIRECTS.map((r) => r.from)).size).toBe(
      ATLAS_GUIDE_REDIRECTS.length,
    );
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
        expect(sharedGuideResolves(stem)).toBe(true);
      });

      test("the brain-named source file is gone (redirect can't shadow it)", () => {
        expect(
          existsSync(join(CONTENT_SHARED_GUIDES, `brain-${stem}.mdx`)),
        ).toBe(false);
      });
    });
  }

  test("every section nav that lists a renamed guide lists the atlas-* stem and has a redirect for its mount", () => {
    const redirectedFrom = new Set(ATLAS_GUIDE_REDIRECTS.map((r) => r.from));
    const staleNavEntries: string[] = [];
    const mountsMissingRedirect: string[] = [];
    for (const { mount, metaPath } of GUIDE_NAV_BY_MOUNT) {
      const pages = guideNavPages(metaPath);
      for (const stem of RENAMED_ATLAS_GUIDE_STEMS) {
        if (pages.includes(`brain-${stem}`)) {
          staleNavEntries.push(`${metaPath}: brain-${stem}`);
        }
        // A section that does NOT serve this guide owes no redirect; one that
        // does owes a pair for its own mount.
        if (!pages.includes(`atlas-${stem}`)) continue;
        if (!redirectedFrom.has(`${mount}/guides/brain-${stem}`)) {
          mountsMissingRedirect.push(`${mount}/guides/brain-${stem}`);
        }
      }
    }
    expect(staleNavEntries).toEqual([]);
    expect(mountsMissingRedirect).toEqual([]);
  });

  test("every brain-guide redirect the Caddyfile serves is mapped (no stale/stray line)", () => {
    const redirLine = /^redir (\S+) (\S+) 308$/;
    const unmapped: string[] = [];
    for (const line of caddyLines) {
      const match = redirLine.exec(line);
      if (!match) continue;
      const [, redirFrom, redirTo] = match;
      // Scope: anything originating from a brain-named guide URL, on any mount.
      if (!/(^|\/)guides\/brain-/.test(redirFrom)) continue;
      if (!DECLARED_REDIRECT_PAIRS.has(`${redirFrom} -> ${redirTo}`)) {
        unmapped.push(line);
      }
    }
    expect(unmapped).toEqual([]);
  });

  test("no page under content/ still links to a /guides/brain-* URL", () => {
    // The rename is only finished when nothing inside the docs still points at
    // the retired URL: a 308 keeps an EXTERNAL link alive, but an internal one
    // that has to bounce is a link we simply failed to update.
    const offenders: string[] = [];
    for (const file of walk(CONTENT)) {
      if (!file.endsWith(".mdx") && !file.endsWith(".json")) continue;
      const text = readFileSync(file, "utf8");
      for (const stem of RENAMED_ATLAS_GUIDE_STEMS) {
        if (text.includes(`/guides/brain-${stem}`)) {
          offenders.push(`${relative(CONTENT, file)} -> /guides/brain-${stem}`);
        }
      }
    }
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
