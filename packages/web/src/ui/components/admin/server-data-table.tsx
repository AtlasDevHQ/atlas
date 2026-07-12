"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Row, Table as TanstackTable } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { ExpandableDataTable } from "@/components/data-table/data-table-expandable";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import type { FeatureName } from "@/ui/components/admin/feature-registry";
import type { FetchError } from "@/ui/hooks/use-admin-fetch";

/** Empty-state copy for `ServerDataTable`, forwarded to `AdminContentWrapper`. */
export interface ServerDataTableEmptyState {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

interface ServerDataTableBaseProps<TData> {
  /** The table instance from `useServerDataTable`. */
  table: TanstackTable<TData>;
  loading: boolean;
  error: FetchError | null;
  /** Whether the fetched page has zero rows (drives the empty state). */
  isEmpty: boolean;
  onRetry: () => void;
  /** Feature name for enterprise / MFA / role-gated error routing. */
  feature?: FeatureName;
  loadingMessage?: string;
  emptyState: ServerDataTableEmptyState;
  /** Whether page-owned filters are active — switches the empty copy to "No matches". */
  hasFilters?: boolean;
  onClearFilters?: () => void;
  /**
   * Custom toolbar content that *replaces* the default sort list (include your
   * own `<DataTableSortList table={table} />` if you still want sorting).
   * Defaults to just the sort list.
   */
  toolbar?: ReactNode;
}

/**
 * Expandable-table variant: renders via `ExpandableDataTable` with per-row
 * detail. Mutually exclusive with the plain variant's `onRowClick` / `actionBar`
 * — the render tree only threads one or the other.
 */
interface ServerDataTableExpandableProps<TData> {
  expandable: {
    onRowClick?: (row: Row<TData>) => void;
    isRowExpanded?: (row: Row<TData>) => boolean;
    renderExpandedRow?: (row: Row<TData>) => ReactNode;
  };
  onRowClick?: never;
  actionBar?: never;
}

/** Plain-table variant: renders via `DataTable`, with optional row-click + bulk bar. */
interface ServerDataTablePlainProps<TData> {
  expandable?: never;
  /**
   * Plain row-click (e.g. open a detail sheet). Fires on pointer click and on
   * keyboard Enter/Space, so the event is a `MouseEvent` or a `KeyboardEvent`;
   * guards that inspect the row's nested controls read only `event.target`.
   */
  onRowClick?: (
    row: Row<TData>,
    event: React.MouseEvent | React.KeyboardEvent,
  ) => void;
  /** Bulk action bar rendered by `DataTable` when rows are selected. */
  actionBar?: ReactNode;
}

/**
 * Render half of the server-data-table module — the loading/error/empty gate
 * (`AdminContentWrapper`) wrapped around the `<DataTable>` (or
 * `<ExpandableDataTable>`) render tree and its sort toolbar. Pair it with the
 * `table` a `useServerDataTable` call returns; the page keeps only its own
 * filters, stats, and bulk actions.
 */
export type ServerDataTableProps<TData> = ServerDataTableBaseProps<TData> &
  (ServerDataTableExpandableProps<TData> | ServerDataTablePlainProps<TData>);

export function ServerDataTable<TData>(props: ServerDataTableProps<TData>) {
  const {
    table,
    loading,
    error,
    isEmpty,
    onRetry,
    feature,
    loadingMessage,
    emptyState,
    hasFilters,
    onClearFilters,
    toolbar,
    expandable,
    onRowClick,
    actionBar,
  } = props;

  const toolbarNode = (
    <DataTableToolbar table={table}>
      {toolbar ?? <DataTableSortList table={table} />}
    </DataTableToolbar>
  );

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature={feature}
      onRetry={onRetry}
      loadingMessage={loadingMessage}
      emptyIcon={emptyState.icon}
      emptyTitle={emptyState.title}
      emptyDescription={emptyState.description}
      emptyAction={emptyState.action}
      isEmpty={isEmpty}
      hasFilters={hasFilters}
      onClearFilters={onClearFilters}
    >
      {expandable ? (
        <ExpandableDataTable
          table={table}
          onRowClick={expandable.onRowClick}
          isRowExpanded={expandable.isRowExpanded}
          renderExpandedRow={expandable.renderExpandedRow}
        >
          {toolbarNode}
        </ExpandableDataTable>
      ) : (
        <DataTable table={table} onRowClick={onRowClick} actionBar={actionBar}>
          {toolbarNode}
        </DataTable>
      )}
    </AdminContentWrapper>
  );
}
