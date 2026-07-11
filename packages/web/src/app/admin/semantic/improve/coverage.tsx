"use client";

/**
 * The table/column coverage view (#4521, PRD #4502) — the column-anchored entry
 * from the physical schema.
 *
 * Browses each connection's physical schema (its baseline profile) matched
 * against the semantic store, showing per table/column whether coverage exists
 * and how good it is. Clicking a **covered** column starts a column-anchored
 * Improvement conversation (via `onColumnAnchor` → the page's `launchColumn`),
 * front-loading that column's profile, its dimension's YAML, and its coverage
 * state. **Uncovered** tables route to the enrich/wizard flow — per ADR-0032,
 * amendments refine, never grow: there is deliberately no "add entity from here"
 * affordance. A connection without a baseline reports `profiling`; the view shows
 * a loading state and polls until the backfill lands.
 *
 * The presentational pieces (`ConnectionCoverageSection`, `CoverageTableRow`) are
 * exported for direct render-testing without driving the fetch, mirroring how the
 * page exports `AnchorLaunchers` / `ActiveAnchorChip`.
 */

import { useEffect, useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { wizardGenerateHref } from "../../../wizard/wizard-generate-entry";
import {
  CheckCircle2,
  CircleSlash,
  CircleDashed,
  ChevronRight,
  ChevronDown,
  Loader2,
  Database,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Wire types — mirror the /coverage response (local, like the improve surface's
// other inline wire types; not @useatlas/*).
// ---------------------------------------------------------------------------

export type TableCoverageState = "covered" | "partial" | "uncovered";

export interface WireColumnCoverage {
  column: string;
  type: string;
  isPrimaryKey: boolean;
  covered: boolean;
  dimension: string | null;
  described: boolean;
  sampled: boolean;
}

export interface WireTableCoverage {
  table: string;
  rowCount: number;
  entity: string | null;
  group: string | null;
  state: TableCoverageState;
  columns: WireColumnCoverage[];
  coveredColumnCount: number;
  coverableColumnCount: number;
}

export interface WireCoverageMatrix {
  tables: WireTableCoverage[];
  summary: {
    coveredTables: number;
    partialTables: number;
    uncoveredTables: number;
    totalTables: number;
  };
}

export interface WireConnectionCoverage {
  installId: string;
  group: string;
  dbType: string | null;
  status: "ready" | "profiling" | "error";
  error: string | null;
  freshness: string | null;
  coverage: WireCoverageMatrix | null;
}

export interface CoverageOverviewResponse {
  connections: WireConnectionCoverage[];
  profiling: boolean;
}

/** The column anchor a covered-column click launches. */
export interface ColumnAnchorRequest {
  entity: string;
  column: string;
  /** The modeling entity's group, or null for the flat/default group. */
  group: string | null;
}

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

const STATE_META: Record<TableCoverageState, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  covered: { label: "covered", className: "text-green-600 dark:text-green-400", Icon: CheckCircle2 },
  partial: { label: "partial", className: "text-yellow-600 dark:text-yellow-400", Icon: CircleDashed },
  uncovered: { label: "uncovered", className: "text-muted-foreground", Icon: CircleSlash },
};

/** One physical table's coverage row, expandable to its columns. */
export function CoverageTableRow({
  table,
  installId,
  onColumnAnchor,
  disabled,
}: {
  table: WireTableCoverage;
  /** The connection install id — the enrich deep-link target for an uncovered table. */
  installId: string;
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meta = STATE_META[table.state];
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        <Chevron className="size-3.5 shrink-0 opacity-60" />
        <meta.Icon className={`size-4 shrink-0 ${meta.className}`} />
        <span className="font-mono text-xs">{table.table}</span>
        <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
          {meta.label}
        </Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {table.state === "uncovered"
            ? `${table.columns.length} ${table.columns.length === 1 ? "column" : "columns"}`
            : `${table.coveredColumnCount}/${table.coverableColumnCount} columns`}
          {" · "}
          {table.rowCount.toLocaleString("en-US")} rows
        </span>
      </button>

      {open && (
        <div className="border-t px-3 py-2">
          {table.state === "uncovered" ? (
            // ADR-0032 — an uncovered table grows through enrich, never an
            // amendment. There is no "add entity from here" affordance.
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                No entity models this table yet — coverage is grown through the enrich flow.
              </span>
              <Link href={wizardGenerateHref(installId)}>
                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                  <Sparkles className="size-3" />
                  Enrich
                </Button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {table.columns.map((col) => (
                <CoverageColumnChip
                  key={col.column}
                  col={col}
                  entity={table.entity}
                  group={table.group}
                  onColumnAnchor={onColumnAnchor}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One column chip. A *covered* column is a button that launches the column
 * anchor; every other column — uncovered, or a PK with no dimension — is a muted,
 * non-interactive marker. An uncovered column is covered by adding its dimension
 * to the entity that already exists (a refinement), or via enrich — never an
 * "add entity" amendment (ADR-0032).
 */
function CoverageColumnChip({
  col,
  entity,
  group,
  onColumnAnchor,
  disabled,
}: {
  col: WireColumnCoverage;
  entity: string | null;
  group: string | null;
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
}) {
  const quality: string[] = [];
  if (col.described) quality.push("described");
  if (col.sampled) quality.push("sampled");
  const title = col.covered
    ? `${col.column} (${col.type})${quality.length ? ` — ${quality.join(", ")}` : ""}`
    : `${col.column} (${col.type})${col.isPrimaryKey ? " — primary key" : " — uncovered"}`;

  if (col.covered && entity) {
    return (
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => onColumnAnchor({ entity, column: col.column, group }, `${entity}.${col.column}`)}
        className="inline-flex items-center gap-1 rounded border border-green-600/40 bg-green-600/5 px-1.5 py-0.5 font-mono text-[11px] text-green-700 hover:bg-green-600/10 disabled:opacity-50 dark:text-green-400"
      >
        <CheckCircle2 className="size-3" />
        {col.column}
        {col.described && <span className="opacity-60">·d</span>}
        {col.sampled && <span className="opacity-60">·s</span>}
      </button>
    );
  }

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
    >
      {col.isPrimaryKey ? "🔑" : <CircleSlash className="size-3" />}
      {col.column}
    </span>
  );
}

/** One connection's coverage section — its status + summary + table rows. */
export function ConnectionCoverageSection({
  connection,
  onColumnAnchor,
  disabled,
}: {
  connection: WireConnectionCoverage;
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
}) {
  const { coverage } = connection;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Database className="size-4 opacity-70" />
        <span className="font-medium">{connection.group}</span>
        {connection.dbType && (
          <Badge variant="secondary" className="text-[10px]">
            {connection.dbType}
          </Badge>
        )}
        {connection.freshness && (
          <span className="text-[11px] text-muted-foreground">{connection.freshness}</span>
        )}
      </div>

      {connection.status === "profiling" && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Profiling this connection&rsquo;s schema&hellip; this runs once, then the coverage appears here.
        </div>
      )}

      {connection.status === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{connection.error ?? "The baseline profile could not be built for this connection."}</span>
        </div>
      )}

      {connection.status === "ready" && coverage && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="text-green-600 dark:text-green-400">{coverage.summary.coveredTables} covered</span>
            <span className="text-yellow-600 dark:text-yellow-400">{coverage.summary.partialTables} partial</span>
            <span>{coverage.summary.uncoveredTables} uncovered</span>
            <span>· {coverage.summary.totalTables} tables</span>
          </div>
          {coverage.tables.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              This connection&rsquo;s baseline profile has no tables.
            </p>
          ) : (
            <div className="space-y-1.5">
              {coverage.tables.map((table) => (
                <CoverageTableRow
                  key={table.table}
                  table={table}
                  installId={connection.installId}
                  onColumnAnchor={onColumnAnchor}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetching view
// ---------------------------------------------------------------------------

/**
 * The coverage view — fetches the per-connection overview and polls while any
 * connection is still profiling (the lazy backfill). `onColumnAnchor` launches a
 * column-anchored conversation; `disabled` mirrors the page's `isLoading` so a
 * click can't race an in-flight turn.
 */
export function CoverageView({
  onColumnAnchor,
  disabled,
}: {
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
}) {
  const { data, loading, error, refetch } = useAdminFetch<CoverageOverviewResponse>(
    "/api/v1/admin/semantic-improve/coverage",
  );

  // Poll while any connection is still profiling — the lazy backfill lands
  // asynchronously, so re-fetch until `profiling` clears (or an error does).
  useEffect(() => {
    if (!data?.profiling) return;
    const id = setInterval(() => {
      void refetch();
    }, 4000);
    return () => clearInterval(id);
  }, [data?.profiling, refetch]);

  const connections = data?.connections ?? [];

  return (
    <ScrollArea className="min-h-0 flex-1 p-4">
      <div className="space-y-5">
        <MutationErrorSurface error={error} feature="Semantic Layer" onRetry={refetch} />

        {loading && connections.length === 0 && (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3 animate-spin" />
            Loading coverage&hellip;
          </div>
        )}

        {!loading && connections.length === 0 && !error && (
          <div className="py-12 text-center text-xs text-muted-foreground">
            No profilable connections yet. Add a database connection to see its coverage here.
          </div>
        )}

        {connections.map((connection) => (
          <ConnectionCoverageSection
            key={connection.installId}
            connection={connection}
            onColumnAnchor={onColumnAnchor}
            disabled={disabled}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
