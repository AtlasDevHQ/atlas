"use client";

import { useState } from "react";
import { useQueryStates } from "nuqs";
import { schemaDiffSearchParams } from "./search-params";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { StatCard } from "@/ui/components/admin/stat-card";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  GitCompareArrows,
  CheckCircle2,
  Plus,
  Minus,
  RefreshCw,
  ChevronDown,
  AlertTriangle,
  ArrowRightLeft,
  Terminal,
} from "lucide-react";
import type { SemanticTableDiff, ConnectionInfo } from "@/ui/lib/types";
import { ConnectionsResponseSchema, SemanticDiffResponseSchema } from "@/ui/lib/admin-schemas";
import { useMode } from "@/ui/hooks/use-mode";
import { useModeStatus } from "@/ui/hooks/use-mode-status";
import { DeveloperEmptyState } from "@/ui/components/admin/developer-empty-state";

// ---------------------------------------------------------------------------

export default function SchemaDiffPage() {
  const [{ connection: connectionId }, setParams] = useQueryStates(schemaDiffSearchParams);
  const setConnectionId = (id: string) => setParams({ connection: id });

  const { data: connectionsData } = useAdminFetch(
    "/api/v1/admin/connections",
    { schema: ConnectionsResponseSchema },
  );

  const { data: diff, loading, error, refetch } = useAdminFetch(
    `/api/v1/admin/semantic/diff?connection=${encodeURIComponent(connectionId)}`,
    { schema: SemanticDiffResponseSchema, deps: [connectionId] },
  );

  const { mode } = useMode();
  const { data: modeStatus } = useModeStatus();
  const inDevMode = mode === "developer";
  const connectionDrafts = modeStatus?.draftCounts?.connections ?? 0;
  // Schema diff is meaningful only against a developer-mode (draft)
  // connection. If the admin toggled into dev mode but hasn't drafted one
  // yet, short-circuit the generic "no diff data" empty state with a
  // message that names the root cause.
  const showDevNoConnection = inDevMode && connectionDrafts === 0;

  const multipleConnections = connectionsData && connectionsData.length > 1;

  const hasDrift = diff ? diff.summary.new > 0 || diff.summary.removed > 0 || diff.summary.changed > 0 : false;

  return (
    <PageShell connectionSelector={multipleConnections ? (
      <ConnectionSelector
        connections={connectionsData!}
        value={connectionId}
        onChange={setConnectionId}
      />
    ) : null}>
      {showDevNoConnection && !diff && !loading && !error ? (
        <DeveloperEmptyState
          icon={GitCompareArrows}
          title="Nothing to diff — no developer mode connection yet."
          description="Create a draft connection to compare its schema against the semantic layer."
          action={{ label: "Go to connections", href: "/admin/connections" }}
        />
      ) : (
      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Schema Diff"
        onRetry={refetch}
        loadingMessage="Computing schema diff..."
        emptyIcon={GitCompareArrows}
        emptyTitle="No diff data available"
        isEmpty={!diff}
      >
      {diff && <ErrorBoundary>
        <div className="space-y-6 p-6">
          {/* Summary stats */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="New Tables"
              value={diff.summary.new}
              icon={<Plus className="size-4" />}
              description="In DB, not in YAML"
              className={diff.summary.new > 0 ? "border-green-500/50 bg-green-50/50 dark:bg-green-950/20" : undefined}
            />
            <StatCard
              title="Removed Tables"
              value={diff.summary.removed}
              icon={<Minus className="size-4" />}
              description="In YAML, not in DB"
              className={diff.summary.removed > 0 ? "border-red-500/50 bg-red-50/50 dark:bg-red-950/20" : undefined}
            />
            <StatCard
              title="Changed Tables"
              value={diff.summary.changed}
              icon={<ArrowRightLeft className="size-4" />}
              description="Column-level drift"
              className={diff.summary.changed > 0 ? "border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20" : undefined}
            />
            <StatCard
              title="Unchanged"
              value={diff.summary.unchanged}
              icon={<CheckCircle2 className="size-4" />}
              description="In sync"
            />
          </div>

          {/* No drift — success message */}
          {!hasDrift && (
            <Card className="border-green-500/50 bg-green-50/50 shadow-none dark:bg-green-950/20">
              <CardContent className="flex items-center gap-3 py-6">
                <CheckCircle2 className="size-5 text-green-600 dark:text-green-400" />
                <div>
                  <p className="text-sm font-medium text-green-800 dark:text-green-300">
                    Semantic layer is in sync
                  </p>
                  <p className="text-xs text-green-700/80 dark:text-green-400/80">
                    All {diff.summary.unchanged} entities match their database schema.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* New tables */}
          {diff.newTables.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Plus className="size-4 text-green-600 dark:text-green-400" />
                New Tables
                <Badge variant="secondary" className="text-xs">{diff.newTables.length}</Badge>
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {diff.newTables.map((table) => (
                  <Card key={table} className="border-green-500/30 shadow-none">
                    <CardContent className="py-3">
                      <p className="text-sm font-mono font-medium">{table}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        In database but not in semantic layer
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Terminal className="size-3.5 shrink-0" />
                <span>
                  Run <code className="rounded bg-muted px-1 py-0.5 font-mono">atlas init --update</code> to
                  add these tables to the semantic layer.
                </span>
              </div>
            </section>
          )}

          {/* Removed tables */}
          {diff.removedTables.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Minus className="size-4 text-red-600 dark:text-red-400" />
                Removed Tables
                <Badge variant="secondary" className="text-xs">{diff.removedTables.length}</Badge>
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {diff.removedTables.map((table) => (
                  <Card key={table} className="border-red-500/30 shadow-none">
                    <CardContent className="py-3">
                      <p className="text-sm font-mono font-medium">{table}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        In semantic layer but not in database
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-md border border-red-500/20 bg-red-50/30 px-3 py-2 text-xs text-red-700 dark:bg-red-950/10 dark:text-red-400">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>
                  These entity YAML files reference tables that no longer exist in the database.
                  Consider removing the stale entity files.
                </span>
              </div>
            </section>
          )}

          {/* Changed tables */}
          {diff.tableDiffs.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <ArrowRightLeft className="size-4 text-amber-600 dark:text-amber-400" />
                Changed Tables
                <Badge variant="secondary" className="text-xs">{diff.tableDiffs.length}</Badge>
              </h2>
              <div className="space-y-2">
                {diff.tableDiffs.map((td) => (
                  <ChangedTableCard key={td.table} diff={td} />
                ))}
              </div>
            </section>
          )}

          {/* Warnings */}
          {diff.warnings && diff.warnings.length > 0 && (
            <section>
              <div className="space-y-1.5">
                {diff.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-50/30 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/10 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Refresh button */}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="size-3.5" />
              Re-run Diff
            </Button>
          </div>
        </div>
      </ErrorBoundary>}
      </AdminContentWrapper>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PageShell({
  children,
  connectionSelector,
}: {
  children: React.ReactNode;
  connectionSelector?: React.ReactNode;
}) {
  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schema Diff</h1>
          <p className="text-sm text-muted-foreground">
            Compare database schema against semantic layer entities
          </p>
        </div>
        {connectionSelector}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ConnectionSelector({
  connections,
  value,
  onChange,
}: {
  connections: ConnectionInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48">
        <SelectValue placeholder="Select connection" />
      </SelectTrigger>
      <SelectContent>
        {connections.map((conn) => (
          <SelectItem key={conn.id} value={conn.id}>
            {conn.id}
            {conn.dbType && (
              <span className="ml-1 text-muted-foreground">({conn.dbType})</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChangedTableCard({ diff }: { diff: SemanticTableDiff }) {
  const [open, setOpen] = useState(false);
  const changeCount = diff.addedColumns.length + diff.removedColumns.length + diff.typeChanges.length;

  return (
    <Card className="border-amber-500/30 shadow-none">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer py-3 hover:bg-muted/30">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span className="font-mono">{diff.table}</span>
                <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                  {changeCount} {changeCount === 1 ? "change" : "changes"}
                </Badge>
              </CardTitle>
              <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Change</TableHead>
                  <TableHead>Column</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.addedColumns.map((col) => (
                  <TableRow key={`add-${col.name}`}>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] text-green-700 dark:text-green-400 border-green-300 dark:border-green-700">
                        added
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{col.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      type: {col.type} (in DB, missing from YAML)
                    </TableCell>
                  </TableRow>
                ))}
                {diff.removedColumns.map((col) => (
                  <TableRow key={`rm-${col.name}`}>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] text-red-700 dark:text-red-400 border-red-300 dark:border-red-700">
                        removed
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{col.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      type: {col.type} (in YAML, missing from DB)
                    </TableCell>
                  </TableRow>
                ))}
                {diff.typeChanges.map((tc) => (
                  <TableRow key={`type-${tc.name}`}>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                        type
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tc.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      YAML: <code className="rounded bg-muted px-1">{tc.yamlType}</code>
                      {" → "}
                      DB: <code className="rounded bg-muted px-1">{tc.dbType}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
