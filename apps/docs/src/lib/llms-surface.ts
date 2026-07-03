import type { SectionPage } from "@/lib/source";
import type { Audience } from "@/lib/audience";
import { getLLMText } from "@/lib/get-llm-text";

/**
 * Section-aware machine-readable surfaces (PRD #4257, slice #4266).
 *
 * The docs portal serves the same three machine surfaces per human section —
 * `llms.txt` (index), `llms-full.txt` (full text), and per-page `.mdx` twins —
 * but each is sourced from ITS OWN section loader so the audiences never
 * cross-leak:
 *   - the root / SaaS surfaces come from `source` (saas + shared), audience
 *     `"saas"`;
 *   - the `/self-hosted` surfaces come from `selfHostedSource`
 *     (self-hosted + shared), audience `"self-hosted"`.
 *
 * Because a self-hosted-only page physically never enters `source`, the SaaS
 * `llms-full.txt` is structurally incapable of carrying self-hosted content —
 * the "don't feed a SaaS agent self-hosted instructions" guarantee, applied to
 * the machine output. Within a shared page, `getLLMText` additionally resolves
 * `<WhenSaaS>` / `<WhenSelfHosted>` to the surface's audience so the other
 * branch is stripped too (via `stripInactiveAudienceBlocks`).
 *
 * These helpers are the single source of the per-surface plumbing (base-URL
 * absolutization, the concat/error-handling loop, the twin slug/param shape) so
 * the root and self-hosted route handlers stay one-liners over the same logic.
 */

const LLMS_BASE_URL = "https://docs.useatlas.dev";

/**
 * Rewrite the root-relative markdown links fumadocs' `llms(...).index()` emits
 * (`](/…`) to absolute `https://docs.useatlas.dev/…` URLs for agent
 * consumption. The self-hosted index emits `](/self-hosted/…` links, which this
 * absolutizes to `…/self-hosted/…` all the same — the section prefix is part of
 * the path, so one replacement serves both mounts.
 */
export function absolutizeLlmsUrls(content: string): string {
  return content.replace(/\]\(\//g, `](${LLMS_BASE_URL}/`);
}

/**
 * Concatenate every page of a section source into one `llms-full.txt` body,
 * resolving each page to `audience` so no opposite-audience branch survives. A
 * per-page failure emits a visible placeholder rather than failing the whole
 * surface (the same fail-soft the root route used); `label` tags the log line.
 *
 * Fail-soft is safe here because it composes with the twin route: the
 * `<section>/llms.mdx/<slug>` route renders the SAME page set with NO catch, so
 * a DETERMINISTIC compile / audience-strip failure still fails `next build`
 * there and can't ship silently. This catch only degrades a non-deterministic
 * per-page failure — and the placeholder carries no page content, so even a
 * strip-failure page can't leak the opposite audience's branch.
 */
export async function renderLlmsFullText(
  pages: readonly SectionPage[],
  audience: Audience,
  label: string,
): Promise<string> {
  const results = await Promise.all(
    pages.map(async (page) => {
      try {
        return await getLLMText(page, audience);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${label}] ${page.url}: ${msg}`);
        return `# ${page.data.title} (${page.url})\n\n> Error: Could not load this page.`;
      }
    }),
  );
  return results.join("\n\n---\n\n");
}

/**
 * The trailing segment every markdown-twin URL carries on disk. Under
 * `output: 'export'` a flat catch-all writes `<slug>.body` files, which collide
 * when a slug both terminates as a page AND has children; forcing every twin
 * into a `<slug>/index.md` directory sidesteps that leaf-vs-parent collision.
 * Caddy rewrites the browser-facing `/<slug>.mdx` onto this on-disk path.
 */
export const MDX_TWIN_INDEX_SUFFIX = "index.md";

/**
 * Validate a twin request's slug (which must end in the `index.md` suffix) and
 * return the underlying page slug, or `null` when the request is not a
 * well-formed twin URL (the caller then `notFound()`s).
 */
export function twinPageSlug(slug: string[] | undefined): string[] | null {
  if (
    !slug ||
    slug.length === 0 ||
    slug[slug.length - 1] !== MDX_TWIN_INDEX_SUFFIX
  ) {
    return null;
  }
  return slug.slice(0, -1);
}

/**
 * Map a section's `generateParams()` output into the twin route's static params
 * by appending the `index.md` suffix to each slug — so the static export emits
 * one `…/<slug>/index.md` file per page.
 */
export function twinStaticParams(
  params: readonly { readonly slug?: string[] }[],
): { slug: string[] }[] {
  return params.map((p) => ({
    slug: [...(p.slug ?? []), MDX_TWIN_INDEX_SUFFIX],
  }));
}
