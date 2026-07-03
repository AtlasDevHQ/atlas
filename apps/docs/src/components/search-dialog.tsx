"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  TagsList,
  TagsListItem,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { useState } from "react";
import { SEARCH_SECTIONS, type SearchSection } from "@/lib/search-index";

// Human labels for each section facet. Typed as `Record<SearchSection, …>`, so
// this is exhaustive and rename-safe against the `SearchSection` SSOT: adding or
// renaming a section in `@/lib/search-index` is a compile error here. The facet
// value the dialog sends to `useDocsSearch` is a `SEARCH_SECTIONS` entry — the
// exact string `buildSearchIndexes` stamps onto the index — so the two can't
// drift behind a comment.
const SECTION_LABELS: Record<SearchSection, string> = {
  saas: "SaaS / Cloud",
  "self-hosted": "Self-Hosted",
  api: "API Reference",
};

export default function DefaultSearchDialog(props: SharedProps) {
  // `tag` is `string` because `TagsList.onTagChange` yields `string | undefined`;
  // at runtime it only ever holds a `SearchSection` value (the rendered items
  // below) or undefined (cleared) — the rename-safety lives in `SECTION_LABELS`.
  const [tag, setTag] = useState<string | undefined>();
  // `tag` filters the combined static index by section facet. When undefined the
  // search spans every section (the default); the `deps` array re-queries when it
  // changes so results update as the reader narrows to a section.
  const { search, setSearch, query } = useDocsSearch(
    { type: "static", tag },
    [tag],
  );
  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        {query.error ? (
          // fumadocs caches the rejected fetch promise by URL, so reopening
          // the dialog re-awaits the same failure. A full page reload is the
          // only reliable recovery — surface that to the user.
          <div
            role="alert"
            className="border-t border-fd-border px-4 py-3 text-sm text-fd-muted-foreground"
          >
            <p className="font-medium text-fd-foreground">
              Search index failed to load.
            </p>
            <p className="mt-1">Reload the page to try again.</p>
          </div>
        ) : (
          <SearchDialogList
            items={query.data !== "empty" ? query.data : null}
          />
        )}
        <SearchDialogFooter>
          {/* Optional section scoping: pick a section to narrow, clear to go
              global. `allowClear` lets the reader return to an all-section
              search after scoping. Rendered from the `SEARCH_SECTIONS` SSOT so a
              new section shows up automatically. */}
          <TagsList tag={tag} onTagChange={setTag} allowClear>
            {SEARCH_SECTIONS.map((value) => (
              <TagsListItem key={value} value={value}>
                {SECTION_LABELS[value]}
              </TagsListItem>
            ))}
          </TagsList>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
