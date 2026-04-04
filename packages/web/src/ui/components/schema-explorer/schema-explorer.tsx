"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtlasConfig } from "../../context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Search,
  ArrowLeft,
  ArrowRight,
  Loader2,
  TableProperties,
  Eye,
  Columns3,
  Link2,
  Sparkles,
} from "lucide-react";
import type {
  SemanticEntitySummary,
  SemanticEntityDetail,
  Dimension,
  Join,
  Measure,
  QueryPattern,
} from "../../lib/types";
import { normalizeList } from "../../lib/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TypeFilter = "all" | "table" | "view";

/** Parse a server error response, extracting the message field if present. */
async function parseErrorResponse(r: Response): Promise<string> {
  try {
    const body = await r.json();
    if (typeof body?.message === "string") return body.message;
  } catch { /* intentionally ignored: response may not be JSON */ }
  return `HTTP ${r.status}`;
}

// ---------------------------------------------------------------------------
// Entity list
// ---------------------------------------------------------------------------

function EntityList({
  entities,
  search,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  onSelect,
}: {
  entities: SemanticEntitySummary[];
  search: string;
  onSearchChange: (v: string) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (v: TypeFilter) => void;
  onSelect: (name: string) => void;
}) {
  const filtered = entities.filter((e) => {
    const matchesSearch =
      !search ||
      e.table.toLowerCase().includes(search.toLowerCase()) ||
      e.description.toLowerCase().includes(search.toLowerCase());
    const matchesType =
      typeFilter === "all" ||
      (typeFilter === "view" ? e.type === "view" : e.type !== "view");
    return matchesSearch && matchesType;
  });

  const tableCount = entities.filter((e) => e.type !== "view").length;
  const viewCount = entities.filter((e) => e.type === "view").length;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-4 pb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tables..."
            className="h-8 pl-8 text-sm"
          />
        </div>
        {viewCount > 0 && (
          <ToggleGroup
            type="single"
            size="sm"
            value={typeFilter}
            onValueChange={(v) => { if (v) onTypeFilterChange(v as TypeFilter); }}
            className="justify-start"
          >
            <ToggleGroupItem value="all" className="h-6 px-2 text-xs">
              All ({entities.length})
            </ToggleGroupItem>
            <ToggleGroupItem value="table" className="h-6 px-2 text-xs">
              Tables ({tableCount})
            </ToggleGroupItem>
            <ToggleGroupItem value="view" className="h-6 px-2 text-xs">
              Views ({viewCount})
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>

      <Separator />

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
              {search ? "No matching entities" : "No entities found"}
            </p>
          ) : (
            filtered.map((entity) => (
              <button
                key={entity.table}
                onClick={() => onSelect(entity.table)}
                className="flex w-full min-w-0 items-start gap-2 overflow-hidden rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                {entity.type === "view" ? (
                  <Eye className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
                ) : (
                  <TableProperties className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {entity.table}
                    </span>
                    {entity.type === "view" && (
                      <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0">
                        view
                      </Badge>
                    )}
                  </div>
                  {entity.description && (
                    <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {entity.description}
                    </p>
                  )}
                  <div className="mt-1 flex gap-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                    <span>{entity.columnCount} cols</span>
                    {entity.joinCount > 0 && <span>{entity.joinCount} joins</span>}
                  </div>
                </div>
                <ArrowRight className="mt-1 size-3 shrink-0 text-zinc-300 dark:text-zinc-600" />
              </button>
            ))
          )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity detail
// ---------------------------------------------------------------------------

function EntityDetailView({
  entity,
  onBack,
  onNavigateEntity,
  onInsertQuery,
}: {
  entity: SemanticEntityDetail;
  onBack: () => void;
  onNavigateEntity: (name: string) => void;
  onInsertQuery: (description: string) => void;
}) {
  const dimensions = normalizeList(entity.dimensions, "name") as Dimension[];
  const joins = normalizeList(entity.joins, "to") as Join[];
  const measures = normalizeList(entity.measures, "name") as Measure[];
  const patterns = normalizeList(entity.query_patterns, "name") as QueryPattern[];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pb-3">
        <Button variant="ghost" size="icon" className="size-7" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold">{entity.table}</h3>
            {entity.type === "view" && (
              <Badge variant="outline" className="text-[10px]">view</Badge>
            )}
          </div>
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="space-y-5 p-4">
          {entity.description && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{entity.description}</p>
          )}

          {/* Columns */}
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              <Columns3 className="size-3" />
              Columns ({dimensions.length})
            </h4>
            <div className="rounded-md border">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-7 w-[30%] text-[10px]">Name</TableHead>
                    <TableHead className="h-7 w-[15%] text-[10px]">Type</TableHead>
                    <TableHead className="h-7 w-[35%] text-[10px] hidden sm:table-cell">Description</TableHead>
                    <TableHead className="h-7 w-[20%] text-[10px] hidden sm:table-cell">Samples</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dimensions.map((dim) => (
                    <TableRow key={dim.name}>
                      <TableCell className="py-1.5 font-mono text-[11px]">
                        <span className="flex items-center gap-1">
                          <span className="truncate">{dim.name}</span>
                          {dim.primary_key && (
                            <Badge className="shrink-0 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-[9px] px-1 py-0">
                              PK
                            </Badge>
                          )}
                          {dim.foreign_key && (
                            <Badge className="shrink-0 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 text-[9px] px-1 py-0">
                              FK
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Badge variant="secondary" className="font-mono text-[9px]">
                          {dim.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden py-1.5 text-[11px] text-zinc-500 sm:table-cell">
                        <span className="line-clamp-2">{dim.description || "—"}</span>
                      </TableCell>
                      <TableCell className="hidden py-1.5 text-[11px] text-zinc-400 sm:table-cell">
                        <span className="line-clamp-1">
                          {dim.sample_values?.length
                            ? dim.sample_values.slice(0, 3).join(", ")
                            : "—"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Joins */}
          {joins.length > 0 && (
            <section>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                <Link2 className="size-3" />
                Relationships ({joins.length})
              </h4>
              <div className="space-y-1.5">
                {joins.map((join, i) => (
                  <Card key={i} className="shadow-none">
                    <CardContent className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="shrink-0 text-[9px]">
                          {join.relationship || "many_to_one"}
                        </Badge>
                        <button
                          onClick={() => onNavigateEntity(join.to)}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {join.to}
                        </button>
                      </div>
                      {join.description && (
                        <p className="mt-1 text-[11px] text-zinc-500">{join.description}</p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {/* Measures */}
          {measures.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Measures ({measures.length})
              </h4>
              <div className="space-y-1">
                {measures.map((m) => (
                  <div key={m.name} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{m.name}</span>
                    <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
                      {m.sql}
                    </code>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Query patterns */}
          {patterns.length > 0 && (
            <section>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                <Sparkles className="size-3" />
                Query Patterns
              </h4>
              <div className="space-y-1.5">
                {patterns.map((p, i) => (
                  <button
                    key={`${p.name}-${i}`}
                    onClick={() => onInsertQuery(p.description)}
                    className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition-colors hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
                  >
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{p.name}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{p.description}</p>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main schema explorer panel
// ---------------------------------------------------------------------------

export function SchemaExplorer({
  open,
  onOpenChange,
  onInsertQuery,
  getHeaders,
  getCredentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertQuery: (text: string) => void;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}) {
  const { apiUrl } = useAtlasConfig();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  // Fetch entity list when the sheet opens. TanStack handles abort on close.
  const entityList = useQuery<SemanticEntitySummary[]>({
    queryKey: ["semantic", "entities"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${apiUrl}/api/v1/semantic/entities`, {
        headers: getHeaders(),
        credentials: getCredentials(),
        signal,
      });
      if (!res.ok) throw new Error(await parseErrorResponse(res));
      const data = await res.json();
      return Array.isArray(data?.entities) ? data.entities : [];
    },
    enabled: open,
    retry: false,
  });

  // Fetch entity detail when one is selected. Auto-cancels on selection change.
  // staleTime: 0 ensures fresh data on every selection (matches old behavior).
  const entityDetail = useQuery<SemanticEntityDetail>({
    queryKey: ["semantic", "entities", selectedName],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${apiUrl}/api/v1/semantic/entities/${encodeURIComponent(selectedName!)}`, {
        headers: getHeaders(),
        credentials: getCredentials(),
        signal,
      });
      if (!res.ok) throw new Error(await parseErrorResponse(res));
      const data = await res.json();
      return data?.entity ?? data;
    },
    enabled: !!selectedName,
    staleTime: 0,
    retry: false,
  });

  // Reset to list view on every open — prevents stale detail view on reopen
  useEffect(() => {
    if (open) setSelectedName(null);
  }, [open]);

  // Log query errors for developer observability (TanStack catches internally).
  useEffect(() => {
    if (entityList.error) console.warn("Schema explorer: failed to fetch entities:", entityList.error);
  }, [entityList.error]);
  useEffect(() => {
    if (entityDetail.error) console.warn("Schema explorer: failed to load entity:", entityDetail.error);
  }, [entityDetail.error]);

  // Derive state from queries for the existing UI
  const entities = entityList.data ?? [];
  const loading = entityList.isPending && open;
  const error = entityList.error ? (entityList.error instanceof Error ? entityList.error.message : "Failed to load schema") : null;
  const selectedEntity = entityDetail.data ?? null;
  const detailError = entityDetail.error ? (entityDetail.error instanceof Error ? entityDetail.error.message : "Failed to load entity") : null;

  function handleSelectEntity(name: string) {
    setSelectedName(name);
  }

  function handleBack() {
    setSelectedName(null);
  }

  function handleInsertQuery(description: string) {
    onInsertQuery(description);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-xl">
        <SheetHeader className="px-4 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <TableProperties className="size-4" />
            Schema Explorer
          </SheetTitle>
          <SheetDescription className="sr-only">
            Browse tables, columns, joins, and query patterns from the semantic layer
          </SheetDescription>
        </SheetHeader>

        <Separator className="mt-3" />

        <div className="flex-1 overflow-hidden pt-3">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin text-zinc-400" />
              <p className="text-xs text-zinc-400">Loading schema...</p>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4">
              <p className="text-center text-xs text-red-500">{error}</p>
            </div>
          ) : selectedName ? (
            detailError ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4">
                <p className="text-center text-xs text-red-500">{detailError}</p>
                <Button variant="ghost" size="sm" onClick={handleBack} className="text-xs">
                  <ArrowLeft className="mr-1 size-3" /> Back to list
                </Button>
              </div>
            ) : selectedEntity ? (
              <EntityDetailView
                entity={selectedEntity}
                onBack={handleBack}
                onNavigateEntity={handleSelectEntity}
                onInsertQuery={handleInsertQuery}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin text-zinc-400" />
                <p className="text-xs text-zinc-400">Loading {selectedName}...</p>
              </div>
            )
          ) : (
            <EntityList
              entities={entities}
              search={search}
              onSearchChange={setSearch}
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              onSelect={handleSelectEntity}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
