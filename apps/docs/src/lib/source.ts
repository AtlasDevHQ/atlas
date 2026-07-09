import { docs, selfHosted, shared } from "@/../.source/server";
import { openapiPlugin } from "fumadocs-openapi/server";
import type { InferPageType } from "fumadocs-core/source";
import { buildSectionSource } from "@/lib/compose";
import {
  validateContentTaxonomy,
  type ContentEntry,
} from "@/lib/audience-taxonomy";

// SaaS / Cloud docs at the site root (`/`). Existing `content/docs` — including
// the generated `api-reference/` tree at `/api-reference/*` — plus the shared
// concept pages, concatenated into one flat source. Existing root URLs are
// unchanged; the shared pages are the only additions. `openapiPlugin` stays so
// the API reference renders exactly as before.
export const source = buildSectionSource({
  audience: docs,
  shared,
  baseUrl: "/",
  plugins: [openapiPlugin()],
});

// Self-hosted / on-prem docs at `/self-hosted`. Self-hosted-only content plus
// the SAME `shared` collection — one source file per shared fact, mounted here
// and at the root (full presence, single source).
export const selfHostedSource = buildSectionSource({
  audience: selfHosted,
  shared,
  baseUrl: "/self-hosted",
});

/**
 * A page from either human section. Both sections share the same frontmatter
 * schema, so the shared renderer can accept a page from either mount.
 */
export type SectionPage = InferPageType<typeof source>;

function toEntry(page: SectionPage): ContentEntry {
  return {
    absolutePath: page.absolutePath ?? "",
    audience: page.data.audience,
    fork: page.data.fork,
  };
}

/**
 * Build-time taxonomy gate (PRD #4257, slice #4260). Every real page from both
 * human sections is fed through `validateContentTaxonomy`, which throws — and so
 * fails `next build` — on any orphan/invalid/ambiguous classification or
 * un-marked cross-audience duplicate. Runs once at module init; `getPages()` is the union
 * of the two mounts, so a `shared` page appears twice and is deduped by source
 * file inside the validator.
 */
validateContentTaxonomy([
  ...source.getPages().map(toEntry),
  ...selfHostedSource.getPages().map(toEntry),
]);
