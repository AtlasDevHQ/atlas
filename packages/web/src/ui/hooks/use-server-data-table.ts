"use client";

import { useQueryState, parseAsInteger } from "nuqs";
import type { z } from "zod";
import { getSortingStateParser } from "@/lib/parsers";
import type { ExtendedColumnSort } from "@/types/data-table";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";

/**
 * Binds a server-paginated admin table's URL state (nuqs) to its server fetch
 * (`useAdminFetch`).
 *
 * `useDataTable` owns the table instance and *writes* pagination to `?page=`
 * (1-indexed) + `?perPage=` and sorting to `?sort=`. The fetch, however, needs
 * those values to build its request URL — and it can't read them off the table
 * instance without a circular dependency (the table needs `pageCount`, which is
 * derived from the fetched `total`). The historical workaround was to re-read
 * `page`/`perPage`/`sort` via `useQueryState` *next to* the table using the
 * exact same parsers `useDataTable` uses, derive `offset`, and feed that into
 * `useAdminFetch`. That dance was triplicated across the audit/sessions admin
 * pages.
 *
 * This hook owns that binding once: it reads the same nuqs keys with the same
 * parsers `useDataTable` writes, derives `offset`, and runs the fetch through
 * `useAdminFetch`. The page keeps the table-shaping work (`useDataTable`,
 * columns, filters); only the URL-state↔fetch seam moves here.
 *
 * The returned `page`/`perPage`/`offset`/`sorting` mirror what `useDataTable`
 * holds, so the page can build the request URL (and any filters) from one
 * source of truth.
 */
export interface UseServerDataTableOptions<TData, TResponse> {
  /**
   * Build the request path from the URL-state-derived pagination/sort values
   * plus whatever filters the page owns. Called on every render with the
   * current binding; keep it pure.
   */
  buildPath: (binding: ServerDataTableBinding<TData>) => string;
  /** Zod schema for runtime response validation (preferred). */
  schema: z.ZodType<TResponse>;
  /**
   * Default page size — must match the `useDataTable` `initialState.pagination
   * .pageSize` for the same table so the first fetch and the table agree.
   */
  defaultPerPage: number;
  /**
   * Default sorting — must match the `useDataTable` `initialState.sorting` for
   * the same table. Omit for tables whose fetch doesn't depend on sort
   * (the `?sort=` param is still read so it stays in sync, but pass the
   * column ids to keep an invalid `?sort=` from leaking through).
   */
  defaultSorting?: ExtendedColumnSort<TData>[];
  /**
   * Column ids the `?sort=` parser will accept — the same set
   * `useDataTable` derives from its columns. An unknown id reverts to
   * `defaultSorting`.
   */
  sortColumnIds: Set<string> | string[];
  /** Mirrors `useAdminFetch`'s `enabled` — skip the fetch when false. */
  enabled?: boolean;
}

export interface ServerDataTableBinding<TData> {
  /** 1-indexed page, read from `?page=`. */
  page: number;
  /** Page size, read from `?perPage=`. */
  perPage: number;
  /** `(page - 1) * perPage`. */
  offset: number;
  /** Sorting state, read from `?sort=`. */
  sorting: ExtendedColumnSort<TData>[];
  /** Convenience: the first sort column's id, or undefined. */
  sortId?: string;
  /** Convenience: the first sort column's direction, or undefined. */
  sortDesc?: boolean;
}

export function useServerDataTable<TData, TResponse>(
  opts: UseServerDataTableOptions<TData, TResponse>,
) {
  // Read the exact nuqs keys + parsers `useDataTable` writes, so page and
  // table share one source of truth without a circular dependency on the
  // table instance.
  const [page] = useQueryState("page", parseAsInteger.withDefault(1));
  const [perPage] = useQueryState(
    "perPage",
    parseAsInteger.withDefault(opts.defaultPerPage),
  );
  const [sorting] = useQueryState(
    "sort",
    getSortingStateParser<TData>(opts.sortColumnIds).withDefault(
      opts.defaultSorting ?? [],
    ),
  );

  const offset = (page - 1) * perPage;
  const binding: ServerDataTableBinding<TData> = {
    page,
    perPage,
    offset,
    sorting,
    sortId: sorting[0]?.id,
    sortDesc: sorting[0]?.desc,
  };

  const path = opts.buildPath(binding);
  const fetchState = useAdminFetch(path, {
    schema: opts.schema,
    enabled: opts.enabled,
  });

  return {
    ...binding,
    data: fetchState.data,
    loading: fetchState.loading,
    error: fetchState.error,
    refetch: fetchState.refetch,
  };
}
