import { source, selfHostedSource } from "@/lib/source";
import { buildSearchIndexes } from "@/lib/search-index";
import { createSearchAPI } from "fumadocs-core/search/server";

export const revalidate = false;

// Combined static search index across all THREE docs sections (PRD #4257, slice
// #4262): the SaaS site-root tree + the `/api-reference/*` tree (both in the root
// `source`) and the `/self-hosted/*` tree (`selfHostedSource`). Each page is
// stamped with its `section` facet (`saas` | `self-hosted` | `api`) via
// `buildSearchIndexes`, so global search spans every section and the dialog can
// optionally scope to one. A `shared` page mounts in both human trees and so
// appears once per mount, each entry keeping the URL of the mount it links to.
//
// Still a static export: `createSearchAPI("advanced", …)` uses the same Orama
// engine as the previous `createFromSource(source)`, and its `staticGET` emits
// the index as static JSON — no runtime search server (paired with the client's
// `useDocsSearch({ type: "static" })`).
export const { staticGET: GET } = createSearchAPI("advanced", {
  indexes: buildSearchIndexes([
    ...source.getPages(),
    ...selfHostedSource.getPages(),
  ]),
});
