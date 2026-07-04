import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  SELF_HOSTED_REDIRECTS,
  MOVED_SELF_HOSTED_SLUGS,
  canonicalForSelfHostedMount,
} from "@/lib/redirects";

/**
 * Redirect-coverage test (PRD #4257 slice #4267).
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
    const expectedFrom = new Set<string>();
    const expectedTo = new Set<string>();
    for (const { from, to } of SELF_HOSTED_REDIRECTS) {
      expectedFrom.add(from).add(`${from}/`);
      expectedTo.add(to).add(`${to}/`);
    }
    const redirLine = /^redir (\S+) (\S+) 308$/;
    // Collect offenders (rather than asserting per-line) so a real failure names
    // the exact Caddyfile line instead of a bare `false !== true`.
    const unmapped: string[] = []; // hand-added stray or mismatched from/to
    const unresolved: string[] = []; // stale 308 -> a page that no longer exists
    for (const line of caddyLines) {
      const match = redirLine.exec(line);
      if (!match) continue;
      const [, redirFrom, redirTo] = match;
      // Only this slice's block (mcp-hosted etc. target other prefixes).
      if (!redirTo.startsWith("/self-hosted")) continue;
      // The line must be one the map declares ...
      if (!expectedFrom.has(redirFrom) || !expectedTo.has(redirTo)) {
        unmapped.push(line);
        continue;
      }
      // ... and must resolve to a real page (catches a stale 308 -> 404 left
      // behind after a page is deleted from both the map and disk).
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
