"use client";

import { Fragment } from "react";
import { flexRender, type Row, type Table as TanstackTable } from "@tanstack/react-table";
import type * as React from "react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getColumnPinningStyle } from "@/lib/data-table";
import { cn } from "@/lib/utils";

interface ExpandableDataTableProps<TData> extends React.ComponentProps<"div"> {
  table: TanstackTable<TData>;
  /** Called when a row is clicked. */
  onRowClick?: (row: Row<TData>) => void;
  /** Render content below an expanded row. Return null to skip. */
  renderExpandedRow?: (row: Row<TData>) => React.ReactNode;
  /** Check if a row is currently expanded. */
  isRowExpanded?: (row: Row<TData>) => boolean;
}

export function ExpandableDataTable<TData>({
  table,
  onRowClick,
  renderExpandedRow,
  isRowExpanded,
  children,
  className,
  ...props
}: ExpandableDataTableProps<TData>) {
  const colCount = table.getAllColumns().length;

  return (
    <div
      className={cn("flex w-full flex-col gap-2.5 overflow-auto", className)}
      {...props}
    >
      {children}
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    style={{
                      ...getColumnPinningStyle({ column: header.column }),
                    }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => {
                const expanded = isRowExpanded?.(row) ?? false;
                const expandedContent = expanded
                  ? renderExpandedRow?.(row)
                  : null;

                return (
                  <Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() && "selected"}
                      className={onRowClick ? "cursor-pointer" : undefined}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          style={{
                            ...getColumnPinningStyle({ column: cell.column }),
                          }}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                    {expandedContent && (
                      <TableRow>
                        <TableCell colSpan={colCount} className="bg-muted/30 p-4">
                          {expandedContent}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} />
    </div>
  );
}
