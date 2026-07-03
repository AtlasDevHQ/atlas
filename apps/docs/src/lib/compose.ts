import { loader } from "fumadocs-core/source";
import type { DocMethods, MetaMethods } from "fumadocs-mdx/runtime/types";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import type {
  LoaderPluginOption,
  MetaData,
  PageData,
} from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement, type ReactElement } from "react";

/**
 * Resolve a lucide icon name (from a page's `icon:` frontmatter) to a React
 * element. Shared by every section loader so icons render identically.
 */
export function icon(name?: string): ReactElement | undefined {
  if (name && name in icons)
    return createElement(icons[name as keyof typeof icons]);
  return undefined;
}

/**
 * A Fumadocs docs collection reduced to the two entry arrays a loader source is
 * composed from. `defineDocs(...)` collections satisfy this (their `.docs` /
 * `.meta` are exactly these shapes), and synthetic test fixtures can too.
 */
export interface CollectionLike<
  Doc extends DocMethods & PageData = DocMethods & PageData,
  Meta extends MetaMethods & MetaData = MetaMethods & MetaData,
> {
  readonly docs: readonly Doc[];
  readonly meta: readonly Meta[];
}

/**
 * Compose one docs section from an audience-owned collection plus the shared
 * collection by CONCATENATING their entries into a single flat Fumadocs source
 * (the composition shape validated by spike #4258). The same `shared`
 * collection can be fed into more than one section loader; each mount renders
 * the shared pages at its own `baseUrl` from the one real file on disk — full
 * presence, single source, so there is nothing to drift.
 *
 * This helper deliberately imports NO generated `.source/server`, so it is
 * unit-testable with synthetic collection fixtures (see `compose.test.ts`).
 * Importing `.source/server` pulls in `*.mdx?collection=…` modules that only
 * the Next bundler can resolve — a plain `bun test` cannot load them.
 *
 * The return type is left inferred (not widened to `LoaderOutput<LoaderConfig>`)
 * so callers keep the rich per-page data type — `InferPageType<typeof source>`
 * still resolves `body` / `toc` / `getText` for the llms + OG consumers.
 */
export function buildSectionSource<
  Doc extends DocMethods & PageData,
  Meta extends MetaMethods & MetaData,
>(opts: {
  audience: CollectionLike<Doc, Meta>;
  shared: CollectionLike<Doc, Meta>;
  baseUrl: string;
  plugins?: LoaderPluginOption[];
}) {
  return loader({
    baseUrl: opts.baseUrl,
    source: toFumadocsSource(
      [...opts.audience.docs, ...opts.shared.docs],
      [...opts.audience.meta, ...opts.shared.meta],
    ),
    plugins: opts.plugins,
    icon,
  });
}
