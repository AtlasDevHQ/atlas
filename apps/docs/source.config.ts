import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { transformerMetaHighlight } from "@shikijs/transformers";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";

// SaaS / Cloud docs — served at the site root (`docs.useatlas.dev/…`). This is
// the default section and its URLs are unchanged by the segmentation (PRD #4257
// keeps SaaS at root so shared/help-center links don't break). The generated
// `api-reference/` tree lives inside this collection and stays at
// `/api-reference/*`, untouched.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

// Self-hosted / on-prem docs — served at the new `/self-hosted/*` section
// (issue #4259). Fed into its own loader alongside the shared collection.
export const selfHosted = defineDocs({
  dir: "content/self-hosted",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

// Audience-agnostic concept pages authored ONCE and mounted into BOTH human
// section loaders (SaaS root + self-hosted) — full presence, single source.
// NOTE: content/shared/ intentionally has NO root meta.json: it is concatenated
// into another collection's flat source, and a second root meta.json collides
// on the virtual path "meta.json" (spike #4258 finding).
export const shared = defineDocs({
  dir: "content/shared",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      // Preserve Fumadocs' built-in code transformers (copy button, etc.)
      // before adding custom ones
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerMetaHighlight(),
      ],
    },
  },
});
