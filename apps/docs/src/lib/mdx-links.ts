import { createRelativeLink } from "fumadocs-ui/mdx";
import type { LoaderConfig, LoaderOutput, Page } from "fumadocs-core/source";
import type { ComponentProps, FC } from "react";

/**
 * Typed wrapper around fumadocs' `createRelativeLink`.
 *
 * Each section source concatenates two collections
 * (`toFumadocsSource([...audience, ...shared], …)`), which yields a UNION
 * `PageData`. `createRelativeLink`'s `source` parameter sits in a contravariant
 * position (its internal `resolveHref`), so the concrete `LoaderOutput` a route
 * holds is not assignable to the function's generic `LoaderOutput<C>` — a
 * compile-only artifact; the runtime resolution is correct (spike #4258 caveat
 * #2). Localize the single unavoidable cast here so route/render code never
 * scatters `as unknown as` casts.
 */
export function createSectionRelativeLink<C extends LoaderConfig>(
  source: LoaderOutput<C>,
  page: Page,
): FC<ComponentProps<"a">> {
  // Widen to the base config here — the single localized cast (see JSDoc above).
  return createRelativeLink(source as unknown as LoaderOutput<LoaderConfig>, page);
}

/**
 * Repo-relative path (from the monorepo root) of a page's real source file, for
 * the "Edit on GitHub" / last-updated links.
 *
 * A page's `absolutePath` is the ONE real file on disk — for a shared page it is
 * `content/shared/…` on BOTH the root and `/self-hosted` mounts, so both mounts
 * link to the same editable source (spike #4258 caveat #1). This replaces the
 * old hardcoded `content/docs/${page.path}`, which pointed every shared page at
 * a non-existent `content/docs/*` twin.
 *
 * fumadocs-mdx reports `absolutePath` relative to `apps/docs`
 * (e.g. `content/docs/guides/slack.mdx`); we defensively also accept an absolute
 * path that merely contains `apps/docs/`.
 */
export function githubEditPath(absolutePath: string | undefined): string {
  if (!absolutePath) {
    // Fumadocs always populates absolutePath; a missing one is a build-time
    // anomaly. Surface it rather than silently emitting a bare directory path.
    console.warn(
      "[docs] githubEditPath: page has no absolutePath; edit link will be degraded",
    );
    return "apps/docs/";
  }
  const marker = "apps/docs/";
  const idx = absolutePath.indexOf(marker);
  return idx >= 0 ? absolutePath.slice(idx) : `apps/docs/${absolutePath}`;
}
