"use client";

import * as React from "react";
import { useQueryState, parseAsInteger } from "nuqs";
import type {
  ColumnDef,
  Table as TanstackTable,
  TableOptions,
} from "@tanstack/react-table";
import type { z } from "zod";
import { getSortingStateParser } from "@/lib/parsers";
import type { ExtendedColumnSort } from "@/types/data-table";
import { useDataTable } from "@/hooks/use-data-table";
import { useAdminFetch, type FetchError } from "@/ui/hooks/use-admin-fetch";

/**
 * Full server-data-table module for admin pages (`useServerDataTable`).
 *
 * `useDataTable` owns the table instance and *writes* pagination to `?page=`
 * (1-indexed) + `?perPage=` and sorting to `?sort=`. The fetch, however, needs
 * those values to build its request URL — and it can't read them off the table
 * instance without a circular dependency (the table needs `pageCount`, which is
 * derived from the fetched `total`). This hook closes that loop in one place:
 * it reads the same nuqs keys with the same parsers `useDataTable` writes,
 * derives `offset`, runs the fetch through `useAdminFetch`, computes
 * `pageCount` from the response `total`, and constructs the `useDataTable`
 * instance itself.
 *
 * This hook now backs six server-paginated admin pages. `audit` and `sessions`
 * already consumed its shallow, binding-only form (the fetch ran through
 * `useAdminFetch`); the deepening pulled in four more — `learned-patterns`,
 * `scheduled-tasks`, `scheduled-tasks/runs`, and `users` — each of which had
 * hand-rolled the whole dance: a hand-rolled `offset`, a raw `fetch()` effect
 * (some with a manual `refetchKey` cache-buster), `useState`
 * list/total/loading/error, the `pageCount = Math.ceil(total / perPage)`
 * derivation, the `useDataTable(...)` call, and the `<DataTable>` render tree.
 * All of that now lives here (render in the sibling `ServerDataTable`
 * component); a page supplies `columns`, `buildPath`, and `select`, and keeps
 * only its own filters, stats, and row/bulk actions.
 *
 * The returned `page`/`perPage`/`offset`/`sorting` mirror what `useDataTable`
 * holds, so a page can rebuild its request URL (or a CSV-export URL) from one
 * source of truth. `table` is the same instance the page passes to
 * `ServerDataTable`, so pages that need selection or programmatic pagination
 * (`table.setPageIndex(0)`) read it here.
 */

interface ServerDataTableCommonOptions<TData> {
  /**
   * Build the request path from the URL-state-derived pagination/sort values
   * plus whatever filters the page owns. Called on every render with the
   * current binding; keep it pure.
   */
  buildPath: (binding: ServerDataTableBinding<TData>) => string;
  /**
   * Column defs. The hook derives the sortable-id set from these (so an
   * invalid `?sort=` reverts to `defaultSorting`) and builds the table.
   */
  columns: ColumnDef<TData>[];
  /** Stable row identity for selection / expansion (usually `(row) => row.id`). */
  getRowId?: TableOptions<TData>["getRowId"];
  /**
   * Default page size — seeds both the first fetch and the table's
   * `initialState.pagination.pageSize` so they agree.
   */
  defaultPerPage: number;
  /**
   * Default sorting — seeds both the `?sort=` read and the table's
   * `initialState.sorting`. Omit for tables whose fetch doesn't depend on
   * sort.
   */
  defaultSorting?: ExtendedColumnSort<TData>[];
  /** Mirrors `useAdminFetch`'s `enabled` — skip the fetch when false. */
  enabled?: boolean;
}

/** The rows + grand total a `select` extracts from a list response. */
export interface ServerDataTableSelection<TData> {
  rows: TData[];
  total: number;
}

/**
 * Schema-validated variant (preferred — mirrors the `useAdminFetch` guidance):
 * the response is runtime-validated against `schema` before `select` sees it,
 * so wire drift surfaces as a `schema_mismatch` error instead of a silently
 * empty table, and `select` receives the typed, validated response.
 *
 * Pass the response type explicitly
 * (`useServerDataTable<Row, z.infer<typeof Schema>>`) — omit it and `TResponse`
 * defaults to `unknown`, degrading `select`'s parameter to `unknown` (manual
 * narrowing) even though validation still runs.
 */
interface ValidatedServerDataTableOptions<TData, TResponse>
  extends ServerDataTableCommonOptions<TData> {
  schema: z.ZodType<TResponse>;
  /**
   * Extract this page's rows and grand `total` from the validated response.
   * Each list endpoint uses a different key (`{ users }`, `{ rows }`, …), so
   * the caller states it here. Keep it pure — it runs on every render.
   */
  select: (response: TResponse) => ServerDataTableSelection<TData>;
}

/**
 * Unvalidated variant for pages that predate wire schemas: the raw JSON reaches
 * `select` as `unknown`, so `select` must narrow it itself. Coupling `schema`'s
 * absence to an `unknown` `select` param — rather than letting a concrete
 * `TResponse` through unvalidated — keeps a "typed but never validated" config
 * from compiling.
 */
interface UnvalidatedServerDataTableOptions<TData>
  extends ServerDataTableCommonOptions<TData> {
  schema?: undefined;
  /**
   * Extract this page's rows and grand `total` from the raw (unvalidated)
   * JSON. Narrow the `unknown` yourself. Keep it pure — it runs on every
   * render.
   */
  select: (response: unknown) => ServerDataTableSelection<TData>;
}

export type UseServerDataTableOptions<TData, TResponse = unknown> =
  | ValidatedServerDataTableOptions<TData, TResponse>
  | UnvalidatedServerDataTableOptions<TData>;

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

export interface UseServerDataTableResult<TData>
  extends ServerDataTableBinding<TData> {
  /**
   * The `useDataTable` instance — pass to `ServerDataTable`, and read here for
   * selection or programmatic pagination (`table.setPageIndex(0)`).
   */
  table: TanstackTable<TData>;
  /** The current page's rows (empty until the fetch resolves). */
  rows: TData[];
  /** Grand total across all pages, from the response's `total`. */
  total: number;
  /** `Math.max(1, Math.ceil(total / perPage))`. */
  pageCount: number;
  /** True while the initial fetch for the current path is in flight. */
  loading: boolean;
  /** Fetch error (list-load failures), or null. */
  error: FetchError | null;
  /** Re-run the current fetch. */
  refetch: () => void;
}

/** Stable empty-rows reference so an unresolved fetch doesn't churn the table. */
const EMPTY_ROWS: never[] = [];

export function useServerDataTable<TData, TResponse = unknown>(
  opts: UseServerDataTableOptions<TData, TResponse>,
): UseServerDataTableResult<TData> {
  const { columns, defaultPerPage, defaultSorting } = opts;

  // Derive the sortable-id set from the columns — the same set `useDataTable`
  // derives internally — so the hook's `?sort=` read and the table agree.
  const sortColumnIds = React.useMemo(
    () => new Set(columns.map((c) => c.id).filter(Boolean) as string[]),
    [columns],
  );

  // Read the exact nuqs keys + parsers `useDataTable` writes, so page and
  // table share one source of truth without a circular dependency on the
  // table instance.
  const [page] = useQueryState("page", parseAsInteger.withDefault(1));
  const [perPage] = useQueryState(
    "perPage",
    parseAsInteger.withDefault(defaultPerPage),
  );
  const [sorting] = useQueryState(
    "sort",
    getSortingStateParser<TData>(sortColumnIds).withDefault(
      defaultSorting ?? [],
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
  const fetchState = useAdminFetch<TResponse>(path, {
    schema: opts.schema,
    enabled: opts.enabled,
  });

  // Both option variants produce a `ServerDataTableSelection` from the fetched
  // value; the validated variant typed it as `TResponse`, the unvalidated one
  // as `unknown`. Widen to `unknown` for the single call site.
  const select = opts.select as (
    response: unknown,
  ) => ServerDataTableSelection<TData>;
  const selected = fetchState.data != null ? select(fetchState.data) : null;
  const rows = selected?.rows ?? EMPTY_ROWS;
  const total = selected?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  const { table } = useDataTable<TData>({
    data: rows,
    columns,
    pageCount,
    initialState: {
      sorting: defaultSorting ?? [],
      pagination: { pageIndex: 0, pageSize: defaultPerPage },
    },
    getRowId: opts.getRowId,
  });

  return {
    ...binding,
    table,
    rows,
    total,
    pageCount,
    loading: fetchState.loading,
    error: fetchState.error,
    refetch: fetchState.refetch,
  };
}
