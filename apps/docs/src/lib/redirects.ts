/**
 * Docs redirect maps — the reviewed SSOT `deploy/docs/Caddyfile` is kept in
 * lockstep with. Two independent move sets live here: the `/self-hosted`
 * section split (PRD #4257, slice #4267) below, and the `brain-*` -> `atlas-*`
 * guide rename (#5083, ADR-0038 Layer 1) further down.
 *
 * `apps/docs` builds with `output: "export"`, so Next's `redirects()` is
 * disabled and Caddy — not the app — owns every redirect. That is why a move
 * here needs a docs-service DEPLOY, not just a merge.
 *
 * ── /self-hosted section split (#4267) ───────────────────────────────────────
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
 * Guide stems renamed `brain-*` -> `atlas-*` by #5083 (ADR-0038 Layer 1).
 *
 * ADR-0038 renamed the PRODUCT noun from *Company Brain* to *Company Atlas*.
 * The guides took the new noun in their titles and prose; their filenames — and
 * so their published URLs — did not, leaving `/guides/brain-sources` serving a
 * page titled "Company Atlas — Sources". This move finishes that: the file is
 * `atlas-<stem>.mdx`, the URL is `/guides/atlas-<stem>`, and every old URL
 * 308s.
 *
 * ⚠️ SEVEN stems, not the six #5083 enumerated. `brain-vocabulary` landed after
 * that issue was written (#5158, PR #5218) with the same "Company Atlas — …"
 * title and the same `brain-*` filename, so it is a member of exactly the class
 * this move closes. Renaming six of seven would leave one published
 * `/guides/brain-*` URL behind and reopen the defect one page over.
 *
 * The rename is the ONLY change to these pages — frontmatter, prose and
 * headings are already correct (#5081 did that half).
 */
export const RENAMED_ATLAS_GUIDE_STEMS = [
  "sources",
  "conflicts",
  "corrections",
  "temporal-model",
  "connector-authoring",
  "chat-webhook",
  "vocabulary",
] as const;

/**
 * Mount prefixes the renamed guides are served under.
 *
 * These pages live in `content/shared/`, which `src/lib/source.ts` feeds into
 * BOTH loaders — the site root (`baseUrl: "/"`) and the on-prem section
 * (`baseUrl: "/self-hosted"`). So each rename retires TWO live URLs, not one,
 * and `/self-hosted/guides/brain-sources` was as reachable as
 * `/guides/brain-sources` (both `guides/meta.json` files listed the `brain-*`
 * stems). A redirect set covering only the root mount would 404 half the
 * inbound links it exists to save.
 *
 * `""` is the root mount; the array order is the emission order in the
 * Caddyfile block.
 */
export const SHARED_MOUNT_PREFIXES = ["", "/self-hosted"] as const;

export type SharedMountPrefix = (typeof SHARED_MOUNT_PREFIXES)[number];

export interface GuideRenameRedirect {
  /** The `brain-`/`atlas-` suffix shared by the old and new slug. */
  readonly stem: string;
  /** Which shared mount this pair belongs to (`""` = site root). */
  readonly mount: SharedMountPrefix;
  /** Retired public URL, no trailing slash. */
  readonly from: `/${string}`;
  /** Live public URL, no trailing slash. */
  readonly to: `/${string}`;
}

/**
 * old URL -> new URL for every renamed guide, on every mount that serves it.
 *
 * Both sides are DERIVED from one stem, so the pair can never disagree about
 * which page it is talking about — the same discipline `SELF_HOSTED_REDIRECTS`
 * uses. The Caddyfile emits a bare (`from` -> `to`) and a trailing-slash
 * (`from/` -> `to/`) 308 per entry; `redirect-coverage.test.ts` fails if any of
 * the four lines per stem is missing, if a target 404s, or if the old file is
 * still on disk.
 *
 * The root mount is spelled `""`, so `${mount}/guides/…` supplies the leading
 * slash on its own and the `/${string}` field types hold in every arm without a
 * per-mount branch — TypeScript distributes the template over the prefix union.
 */
export const ATLAS_GUIDE_REDIRECTS: readonly GuideRenameRedirect[] =
  SHARED_MOUNT_PREFIXES.flatMap((mount) =>
    RENAMED_ATLAS_GUIDE_STEMS.map((stem) => ({
      stem,
      mount,
      from: `${mount}/guides/brain-${stem}`,
      to: `${mount}/guides/atlas-${stem}`,
    })),
  );

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
