/**
 * Self-hosted section redirect map — reviewed SSOT (PRD #4257, slice #4267).
 *
 * When slice #4264 (PR #4283) un-tabbed the docs portal, twelve self-hosted-only
 * pages MOVED from the site root into the new `/self-hosted/*` section. Their old
 * root URLs must keep working — external / customer-help-center inbound links and
 * SEO both depend on it — so `deploy/docs/Caddyfile` 308-redirects each old URL to
 * its `/self-hosted` counterpart, following the existing `mcp-hosted` prior art.
 *
 * This module is the single source of truth for that move set. It is exactly the
 * git-renamed set from the 3b merge (commit 60f51bb49): every slug below is a
 *   content/docs/<slug>.mdx  ->  content/self-hosted/<slug>.mdx
 * rename. Verify / regenerate with (the pathspec must span BOTH the old and new
 * trees, or git records each move as an Add, not a Rename, and reports nothing;
 * the `.mdx$` filter drops the two `meta.json` section-nav renames, which are
 * config, not pages, and carry no redirect):
 *   git log --diff-filter=R --find-renames --name-status \
 *     -- apps/docs/content/docs apps/docs/content/self-hosted \
 *     | grep -E 'self-hosted/.*\.mdx$'
 * Because the move is a clean prefix — old `/<slug>` -> new `/self-hosted/<slug>`
 * — the new URL is *derived* from the slug, never hand-typed, so old and new can
 * never disagree.
 *
 * Only these moved on-prem pages get redirects. SaaS pages stay at the site root
 * and the API reference stays at `/api-reference/*` (both unchanged) — see the
 * locked decisions in #4257.
 *
 * Drift guards (why this can't silently rot):
 *  - `source-partition.test.ts` asserts every slug here now lives under
 *    content/self-hosted/ and no longer under content/docs/.
 *  - `redirect-coverage.test.ts` asserts the Caddyfile carries a bare +
 *    trailing-slash 308 for each entry, that each target resolves to a real page
 *    (no 404), that the old root file is gone (no shadowed live page), and that
 *    no *other* moved page under content/self-hosted/ is missing from this map.
 */

/**
 * Old-root slugs of the self-hosted-only pages relocated by slice #4264 (PR
 * #4283). FROZEN to that move set — v0.0.42 moves no further pages (3a moved
 * nothing; 3c added `/self-hosted` mounts of shared pages that KEPT their root
 * URLs; the `/api-reference -> /api` move, #4261, was dropped). A later slice
 * that genuinely moves more pages appends its own entries here.
 */
export const MOVED_SELF_HOSTED_SLUGS = [
  "getting-started/quick-start",
  "deployment/deploy",
  "deployment/authentication",
  "deployment/cache-configuration",
  "frameworks/overview",
  "frameworks/react-vite",
  "frameworks/nuxt",
  "frameworks/sveltekit",
  "frameworks/tanstack-start",
  "guides/self-hosted-models",
  "contributing/ci",
  "contributing/eval-harness",
] as const;

export interface DocRedirect {
  /** Slug shared by the old and new URL (the clean-prefix move). */
  readonly slug: string;
  /**
   * Pre-split public URL at the site root, no trailing slash. The `/${string}`
   * template type makes the leading slash a compile error to omit.
   */
  readonly from: `/${string}`;
  /**
   * Post-split URL under the `/self-hosted` section, no trailing slash. The
   * `/self-hosted/${string}` template type makes a target outside the section a
   * compile error — the prefix invariant is enforced, not just documented.
   */
  readonly to: `/self-hosted/${string}`;
}

/**
 * old root URL -> new `/self-hosted` URL, derived from the clean-prefix move.
 * The Caddyfile emits a bare (`from` -> `to`) and a trailing-slash
 * (`from/` -> `to/`) 308 for each entry, matching the `mcp-hosted` prior art;
 * file_server then handles the bare -> trailing 301 at the destination.
 */
export const SELF_HOSTED_REDIRECTS: readonly DocRedirect[] =
  MOVED_SELF_HOSTED_SLUGS.map((slug) => ({
    slug,
    from: `/${slug}`,
    to: `/self-hosted/${slug}`,
  }));

/**
 * Canonical URL for a page rendered under the `/self-hosted` mount (#4267).
 *
 * A self-hosted-only page's canonical home IS its `/self-hosted` URL — its old
 * root URL now 308-redirects here, so crawlers should index the `/self-hosted`
 * one. A SHARED page, though, is mounted into BOTH the site root and
 * `/self-hosted` from a single source file, so the site-root mount is its
 * canonical home (the PRD's clean, KB-linkable SaaS surface); for it this
 * returns the stripped root URL, so the split doesn't dilute the page across two
 * duplicate URLs. `absolutePath` under `content/shared/` is the reliable
 * shared-mount signal (the same seam `source-partition.test` keys on).
 *
 * `absolutePath` is falsy only if Fumadocs fails to populate it — a build-time
 * anomaly that would silently mis-canonicalize a shared page, so surface it
 * (matching `githubEditPath` in `mdx-links.ts`) and fall back to the safe
 * self-hosted-only assumption.
 */
export function canonicalForSelfHostedMount(
  url: string,
  absolutePath: string | undefined,
): string {
  if (!absolutePath) {
    console.warn(
      `[docs] canonicalForSelfHostedMount: page ${url} has no absolutePath; ` +
        "treating as self-hosted-only for canonical (may mis-canonicalize a shared page)",
    );
  }
  const isSharedMount = absolutePath?.includes("content/shared/") ?? false;
  if (!isSharedMount) return url;
  // Shared mount -> canonical is the site-root URL: strip the leading
  // `/self-hosted` segment (anchored + boundary-aware so a hypothetical
  // `/self-hostedX` can't match); `/self-hosted` itself maps back to `/`.
  return url.replace(/^\/self-hosted(?=\/|$)/, "") || "/";
}
