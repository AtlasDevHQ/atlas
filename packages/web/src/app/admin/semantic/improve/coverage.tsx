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
 * Scale for large multi-connection groups (#4652): a 3-region group can be 350+
 * near-identical table rows in one scroll, so the view layers three composing
 * affordances — a table-name search + coverage-state filter bar (view-wide),
 * collapse-by-default connection sections that lead with their summary line
 * (auto-expanded while a filter is active, and for a lone connection), and
 * chunked incremental rendering so a long expanded list never mounts all its
 * rows at once. Filter/collapse state is plain `useState`, deliberately outside
 * the polled data path, so the profiling poll can't reset it.
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  Search,
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

/**
 * How many table rows a list mounts before offering "Show more" (#4652) — keeps
 * a ~119-table connection from rendering every row (and its column chips) at
 * once. Exported so the render tests aren't pinned to a magic number.
 */
export const COVERAGE_TABLE_PAGE_SIZE = 50;

/** True when the table survives the view-wide name search + state filter. */
function tableMatchesFilter(
  table: WireTableCoverage,
  query: string,
  stateFilter: TableCoverageState | null,
): boolean {
  if (stateFilter !== null && table.state !== stateFilter) return false;
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    table.table.toLowerCase().includes(needle) ||
    (table.entity !== null && table.entity.toLowerCase().includes(needle))
  );
}

/**
 * A connection's table rows, mounted in chunks of `COVERAGE_TABLE_PAGE_SIZE`
 * with a "Show more" tail (#4652). The parent keys this component by the filter
 * signature so a filter change resets the visible window without an effect.
 */
function CoverageTableList({
  tables,
  installId,
  onColumnAnchor,
  disabled,
}: {
  tables: WireTableCoverage[];
  installId: string;
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(COVERAGE_TABLE_PAGE_SIZE);
  const visible = tables.slice(0, visibleCount);
  const hidden = tables.length - visible.length;

  return (
    <div className="space-y-1.5">
      {visible.map((table) => (
        <CoverageTableRow
          key={table.table}
          table={table}
          installId={installId}
          onColumnAnchor={onColumnAnchor}
          disabled={disabled}
        />
      ))}
      {hidden > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-xs text-muted-foreground"
          onClick={() => setVisibleCount((count) => count + COVERAGE_TABLE_PAGE_SIZE)}
        >
          Show {Math.min(hidden, COVERAGE_TABLE_PAGE_SIZE)} more ({hidden} hidden)
        </Button>
      )}
    </div>
  );
}

/**
 * One connection's coverage section — its status + summary + table rows.
 *
 * Collapsed to its summary line by default (#4652) so a multi-connection group
 * never mounts N×119 rows at once; the caller opts a lone connection into
 * `defaultOpen`. An active search/state filter force-expands the section —
 * search results must be visible to be useful — and collapsing returns to the
 * user's manual choice once the filter clears.
 */
export function ConnectionCoverageSection({
  connection,
  onColumnAnchor,
  disabled,
  defaultOpen = false,
  query = "",
  stateFilter = null,
}: {
  connection: WireConnectionCoverage;
  onColumnAnchor: (req: ColumnAnchorRequest, label: string) => void;
  disabled: boolean;
  defaultOpen?: boolean;
  query?: string;
  stateFilter?: TableCoverageState | null;
}) {
  const { coverage } = connection;
  const [open, setOpen] = useState(defaultOpen);
  const filtering = query.trim() !== "" || stateFilter !== null;
  const expanded = open || filtering;
  const hasTables = connection.status === "ready" && coverage !== null && coverage.tables.length > 0;
  const filteredTables = hasTables
    ? coverage.tables.filter((table) => tableMatchesFilter(table, query, stateFilter))
    : [];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  /*
   * Label each row by the CONNECTION identity, not just the group: a group
   * with several members (e.g. a 3-region `g_prod` of `us-prod`/`eu-prod`/
   * `apac-prod`) otherwise renders as identical-looking duplicate rows. The
   * group is shown as shared context only when it differs from the
   * connection id — a connection with no explicit `group_id` defaults its
   * wire `group` to the `installId` (COALESCE), so the label is suppressed.
   */
  const identity = (
    <>
      <Database className="size-4 opacity-70" />
      <span className="font-mono font-medium">{connection.installId}</span>
      {connection.dbType && (
        <Badge variant="secondary" className="text-[10px]">
          {connection.dbType}
        </Badge>
      )}
      {connection.group !== connection.installId && (
        <span className="text-[11px] text-muted-foreground">
          group <span className="font-mono">{connection.group}</span>
        </span>
      )}
      {connection.freshness && (
        <span className="text-[11px] text-muted-foreground">{connection.freshness}</span>
      )}
    </>
  );

  return (
    <div className="space-y-2">
      {hasTables ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-md text-left text-sm hover:bg-muted/50"
        >
          <Chevron className="size-3.5 shrink-0 opacity-60" />
          {identity}
        </button>
      ) : (
        <div className="flex items-center gap-2 text-sm">{identity}</div>
      )}

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
          {/* The summary line stays visible while collapsed — it IS the collapsed view. */}
          <div className="flex flex-wrap items-center gap-3 pl-5.5 text-[11px] text-muted-foreground">
            <span className="text-green-600 dark:text-green-400">{coverage.summary.coveredTables} covered</span>
            <span className="text-yellow-600 dark:text-yellow-400">{coverage.summary.partialTables} partial</span>
            <span>{coverage.summary.uncoveredTables} uncovered</span>
            <span>· {coverage.summary.totalTables} tables</span>
            {filtering && hasTables && (
              <span>
                · {filteredTables.length} {filteredTables.length === 1 ? "match" : "matches"}
              </span>
            )}
          </div>
          {coverage.tables.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              This connection&rsquo;s baseline profile has no tables.
            </p>
          ) : !expanded ? null : filteredTables.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              No tables match the current filter.
            </p>
          ) : (
            // Keyed by the filter signature so a filter change resets the
            // "Show more" window instead of carrying a stale count over.
            <CoverageTableList
              key={`${query}\u0000${stateFilter ?? ""}`}
              tables={filteredTables}
              installId={connection.installId}
              onColumnAnchor={onColumnAnchor}
              disabled={disabled}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetching view
// ---------------------------------------------------------------------------

const STATE_FILTER_VALUES: readonly TableCoverageState[] = ["covered", "partial", "uncovered"];

/**
 * The view-wide search + coverage-state filter bar (#4652). Presentational —
 * exported for direct render-testing without driving the fetch.
 */
export function CoverageFilterBar({
  query,
  onQueryChange,
  stateFilter,
  onStateFilterChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  stateFilter: TableCoverageState | null;
  onStateFilterChange: (state: TableCoverageState | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter tables…"
          aria-label="Filter tables by name"
          className="h-8 pl-8 text-xs"
        />
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={1}
        value={stateFilter ?? ""}
        onValueChange={(value: string) => {
          const next = STATE_FILTER_VALUES.find((s) => s === value) ?? null;
          onStateFilterChange(next);
        }}
        aria-label="Filter tables by coverage state"
      >
        {STATE_FILTER_VALUES.map((state) => (
          <ToggleGroupItem key={state} value={state} className="h-8 text-xs">
            {STATE_META[state].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * The coverage view — fetches the per-connection overview and polls while any
 * connection is still profiling (the lazy backfill). `onColumnAnchor` launches a
 * column-anchored conversation; `disabled` mirrors the page's `isLoading` so a
 * click can't race an in-flight turn.
 *
 * Filter/collapse state lives here in plain `useState`, outside the polled data
 * path, so the 4s profiling poll re-fetch can't reset what the user typed.
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
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<TableCoverageState | null>(null);

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

        {connections.length > 0 && (
          <CoverageFilterBar
            query={query}
            onQueryChange={setQuery}
            stateFilter={stateFilter}
            onStateFilterChange={setStateFilter}
          />
        )}

        {connections.map((connection) => (
          <ConnectionCoverageSection
            key={connection.installId}
            connection={connection}
            onColumnAnchor={onColumnAnchor}
            disabled={disabled}
            // A lone connection opens straight away — collapse-by-default is
            // about not mounting N×119 rows for multi-connection groups (#4652).
            defaultOpen={connections.length === 1}
            query={query}
            stateFilter={stateFilter}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
