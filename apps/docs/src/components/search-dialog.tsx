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

/**
 * The section-facet values must match the `tag` stamped onto every index entry
 * in `@/lib/search-index` (`buildSearchIndexes`). Selecting one scopes search to
 * that section; the default (`undefined`) searches all three (PRD #4257 slice
 * #4262 — global search by default, optional section scoping).
 */
const SECTION_TAGS = [
  { value: "saas", label: "SaaS / Cloud" },
  { value: "self-hosted", label: "Self-Hosted" },
  { value: "api", label: "API Reference" },
] as const;

export default function DefaultSearchDialog(props: SharedProps) {
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
              search after scoping. */}
          <TagsList tag={tag} onTagChange={setTag} allowClear>
            {SECTION_TAGS.map((s) => (
              <TagsListItem key={s.value} value={s.value}>
                {s.label}
              </TagsListItem>
            ))}
          </TagsList>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
