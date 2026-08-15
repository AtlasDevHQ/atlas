/**
 * Docs redirect maps — the reviewed SSOT for the redirect blocks in
 * `deploy/docs/Caddyfile`. Two independent move sets live here: the
 * `/self-hosted` section split (PRD #4257, slice #4267) below, and the
 * `brain-*` -> `atlas-*` guide rename (#5083, ADR-0038 Layer 1) further down.
 *
 * `apps/docs` builds with `output: "export"`, so Next's `redirects()` is
 * disabled and Caddy owns every redirect. The Caddyfile is baked into the docs
 * image, so a move here is inert until that image rebuilds — Railway watches
 * `deploy/docs/**` and `apps/docs/**`, so merging to `main` is what ships it.
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
 *    Its reverse sweep also rejects a `redir` it cannot parse, one carrying a
 *    status other than 308, and one whose two endpoints belong to different
 *    entries — each of which was, at some point, a way to ship a bad redirect
 *    past a green suite.
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

export type MovedSelfHostedSlug = (typeof MOVED_SELF_HOSTED_SLUGS)[number];

export interface DocRedirect {
  /** Slug shared by the old and new URL (the clean-prefix move). */
  readonly slug: MovedSelfHostedSlug;
  /**
   * Pre-split public URL at the site root, no trailing slash. Pinned to the
   * move set: a `from` naming a slug outside it is a compile error.
   */
  readonly from: `/${MovedSelfHostedSlug}`;
  /**
   * Post-split URL under the `/self-hosted` section, no trailing slash. A
   * target outside the section, or one naming a different page than `from`
   * does, is a compile error.
   *
   * The looser `/self-hosted/${string}` this used to carry pinned the section
   * but not the slug, so an entry whose two endpoints named DIFFERENT pages
   * compiled clean. That is the same hole `GuideRenameRedirect` was tightened
   * out of below; closing one member of a two-member class is not closing it.
   */
  readonly to: `/self-hosted/${MovedSelfHostedSlug}`;
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
 * so their published URLs — did not, leaving `/guides/brain-<stem>` serving a
 * page titled "Company Atlas — …". This move finishes that: the file is
 * `atlas-<stem>.mdx`, the URL is `/guides/atlas-<stem>`, and every old URL
 * 308s.
 *
 * ⚠️ SEVEN stems, not the six #5083 enumerated. `brain-vocabulary` landed after
 * that issue was written (#5158, PR #5218) with the same "Company Atlas — …"
 * title and the same `brain-*` filename, so it is a member of exactly the class
 * this move closes. Renaming six of seven would leave one published
 * `/guides/brain-*` URL behind.
 *
 * That near-miss is also why `redirect-coverage.test.ts` guards the CLASS
 * rather than this list: a stem-list guard would greet the next such guide the
 * same way it greeted this one — silently.
 *
 * Beyond their internal link targets, these pages are unchanged: frontmatter,
 * prose and headings already took the new noun in PR #5084.
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
 * (`baseUrl: "/self-hosted"`). So each rename retires two live URLs:
 * `/self-hosted/guides/brain-<stem>` was as reachable as its site-root twin,
 * and a redirect set covering only the root mount would 404 half the inbound
 * links it exists to save.
 *
 * `redirect-coverage.test.ts` pins this list to the `baseUrl`s `source.ts`
 * actually mounts `shared` under, so it cannot quietly disagree with them.
 *
 * The mount list is NOT read off `guides/meta.json`: that file orders the
 * sidebar, while `compose.ts` concatenates the whole `shared` collection into
 * each section's source and the routes enumerate over the FILES. A page is
 * served at both URLs whether or not either nav lists it.
 *
 * `""` is the root mount; the array order is the emission order in the
 * Caddyfile block.
 */
export const SHARED_MOUNT_PREFIXES = ["", "/self-hosted"] as const;

export type SharedMountPrefix = (typeof SHARED_MOUNT_PREFIXES)[number];
export type RenamedAtlasGuideStem = (typeof RENAMED_ATLAS_GUIDE_STEMS)[number];

export interface GuideRenameRedirect {
  /** The `brain-`/`atlas-` suffix shared by the old and new slug. */
  readonly stem: RenamedAtlasGuideStem;
  /** Which shared mount this pair belongs to (`""` = site root). */
  readonly mount: SharedMountPrefix;
  /**
   * Retired public URL, no trailing slash.
   *
   * The template pins the mount, the `/guides/` section and the `brain-`
   * prefix, so an entry that names a stem outside the move set — or points at
   * the wrong section — is a compile error, the same discipline `DocRedirect`
   * applies above. "No trailing slash" stops being documentation-only too: no
   * stem ends in `/`.
   */
  readonly from: `${SharedMountPrefix}/guides/brain-${RenamedAtlasGuideStem}`;
  /**
   * Live public URL, no trailing slash.
   *
   * The `atlas-` prefix is pinned for the reason the loose type was not enough:
   * under `/${string}` both `to: brain-${stem}` — a 308 straight back to the
   * retired URL, i.e. a redirect LOOP in production — and a target outside
   * `/guides` compiled without complaint.
   */
  readonly to: `${SharedMountPrefix}/guides/atlas-${RenamedAtlasGuideStem}`;
}

/**
 * old URL -> new URL for every renamed guide, on every mount that serves it.
 *
 * Both sides are DERIVED from one stem, so the pair can never disagree about
 * which page it is talking about — the same discipline `SELF_HOSTED_REDIRECTS`
 * uses. The Caddyfile emits a bare (`from` -> `to`) and a trailing-slash
 * (`from/` -> `to/`) 308 per entry; `redirect-coverage.test.ts` fails if any of
 * the four lines per stem is missing, if one of them is not a 308, if a target
 * 404s, if a `brain-*` guide is still on disk, if a section nav still lists
 * one, or if a retired URL survives in the docs content, the docs source,
 * `apps/www`, `packages/web` or the three READMEs the scan names. It does NOT
 * walk the whole repo — a reference under `packages/api` or `scripts` is
 * outside it, so a rename still owes a grep.
 *
 * The root mount is spelled `""`, so `${mount}/guides/…` supplies the leading
 * slash on its own and the template literal types hold in every arm without a
 * per-mount branch — TypeScript distributes the template over the prefix union.
 * That distribution is load-bearing on the annotation below staying put: an
 * un-annotated `const` widens to `string` and stops satisfying the field types.
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
