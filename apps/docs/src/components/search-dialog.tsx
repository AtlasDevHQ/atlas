"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";

export default function DefaultSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ type: "static" });
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
      </SearchDialogContent>
    </SearchDialog>
  );
}
