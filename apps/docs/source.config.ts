import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { transformerMetaHighlight } from "@shikijs/transformers";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

// Extend the default page frontmatter with the two audience-taxonomy fields
// (PRD #4257, slice #4260). Both are OPTIONAL and applied to every section
// collection so `page.data.audience` / `page.data.fork` are readable by the
// build-time gate in `src/lib/source.ts`.
//
// The `audience` value set is the SSOT `AUDIENCE_CLASSES` in
// `src/lib/audience-taxonomy.ts` — kept in sync here as a literal because a
// fumadocs config module must not pull the `@/` app graph into its own bundle.
// A `keep-in-sync` unit test (`__tests__/audience-taxonomy.test.ts`) asserts the
// two lists never drift.
const audienceDocSchema = pageSchema.extend({
  // Optional explicit classification. When present it MUST agree with the file's
  // content-root directory (enforced by validateContentTaxonomy) — a mismatch is
  // a hard "ambiguous" build error.
  audience: z.enum(["saas-only", "self-hosted-only", "shared"]).optional(),
  // Fork marker: a stable key shared by two files that INTENTIONALLY diverge per
  // audience (a deliberate fork, not a forgotten single-source). Both members of
  // a cross-audience duplicate must carry the same key or the build fails.
  fork: z.string().optional(),
});

// SaaS / Cloud docs — served at the site root (`docs.useatlas.dev/…`). This is
// the default section and its URLs are unchanged by the segmentation (PRD #4257
// keeps SaaS at root so shared/help-center links don't break). The generated
// `api-reference/` tree lives inside this collection and stays at
// `/api-reference/*`, untouched.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: audienceDocSchema,
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
    schema: audienceDocSchema,
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
    schema: audienceDocSchema,
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
