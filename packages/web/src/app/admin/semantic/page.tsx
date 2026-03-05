"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useAtlasConfig } from "@/ui/context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BookOpen, BarChart3, FileText, FolderOpen, Code, LayoutDashboard } from "lucide-react";
import { EntityDetail, type EntityData } from "@/ui/components/admin/entity-detail";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import {
  SemanticFileTree,
  type SemanticSelection,
} from "@/ui/components/admin/semantic-file-tree";
import { friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";

// ── Types ─────────────────────────────────────────────────────────

interface EntitySummary {
  table: string;
  description: string;
  columnCount: number;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  ambiguous?: boolean;
  tables?: string[];
}

interface MetricEntry {
  name: string;
  description?: string;
  sql: string;
  entity?: string;
  type?: string;
  file?: string;
}

interface CatalogMeta {
  name?: string;
  description?: string;
  use_for?: string[];
  common_questions?: string[];
}

// ── Content viewers ───────────────────────────────────────────────

function CatalogViewer({ catalog }: { catalog: CatalogMeta | null }) {
  if (!catalog) {
    return (
      <EmptyState icon={FileText} message="No catalog metadata found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a catalog
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      {catalog.name && (
        <div>
          <h3 className="text-sm font-semibold">Name</h3>
          <p className="mt-1 text-sm text-muted-foreground">{catalog.name}</p>
        </div>
      )}
      {catalog.description && (
        <div>
          <h3 className="text-sm font-semibold">Description</h3>
          <p className="mt-1 text-sm text-muted-foreground">{catalog.description}</p>
        </div>
      )}
      {catalog.use_for && catalog.use_for.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Use For</h3>
          <div className="flex flex-wrap gap-1.5">
            {catalog.use_for.map((use) => (
              <Badge key={use} variant="secondary">{use}</Badge>
            ))}
          </div>
        </div>
      )}
      {catalog.common_questions && catalog.common_questions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Common Questions</h3>
          <ul className="space-y-1.5">
            {catalog.common_questions.map((q) => (
              <li key={q} className="text-sm text-muted-foreground">- {q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GlossaryViewer({ glossary }: { glossary: GlossaryTerm[] }) {
  if (glossary.length === 0) {
    return (
      <EmptyState icon={BookOpen} message="No glossary terms found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a glossary
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {glossary.map((term) => (
        <Card key={term.term} className="shadow-none">
          <CardHeader className="py-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              {term.term}
              {term.ambiguous && (
                <Badge
                  variant="outline"
                  className="text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700 text-[10px]"
                >
                  ambiguous
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <p className="text-xs text-muted-foreground">{term.definition}</p>
            {term.tables && term.tables.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {term.tables.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function MetricsViewer({ metrics }: { metrics: MetricEntry[] }) {
  if (metrics.length === 0) {
    return (
      <EmptyState icon={BarChart3} message="No metrics found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate metrics
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {metrics.map((metric) => (
        <Card key={metric.name} className="shadow-none">
          <CardHeader className="py-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              {metric.name}
              {metric.entity && <Badge variant="secondary" className="text-[10px]">{metric.entity}</Badge>}
              {metric.type && <Badge variant="outline" className="text-[10px]">{metric.type}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            {metric.description && (
              <p className="mb-2 text-xs text-muted-foreground">{metric.description}</p>
            )}
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{metric.sql}</code>
            </pre>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Helpers to normalize API responses ────────────────────────────

function normalizeGlossary(raw: unknown): GlossaryTerm[] {
  if (!raw || !Array.isArray(raw)) return [];
  const terms: GlossaryTerm[] = [];
  for (const entry of raw) {
    const data = (entry as { data: unknown })?.data;
    if (Array.isArray(data)) {
      terms.push(...(data as GlossaryTerm[]));
    } else if (data && typeof data === "object") {
      const t = (data as { terms?: unknown }).terms;
      if (Array.isArray(t)) {
        terms.push(...(t as GlossaryTerm[]));
      } else if (t && typeof t === "object") {
        // terms is an object map: { MRR: { status, definition, ... }, ... }
        for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
          if (value && typeof value === "object") {
            const v = value as Record<string, unknown>;
            terms.push({
              term: name,
              definition: typeof v.definition === "string" ? v.definition
                : typeof v.note === "string" ? v.note : "",
              ambiguous: v.status === "ambiguous",
              tables: Array.isArray(v.tables) ? v.tables as string[]
                : Array.isArray(v.possible_mappings) ? v.possible_mappings as string[] : undefined,
            });
          }
        }
      }
    }
  }
  return terms;
}

function toMetricEntry(m: unknown): MetricEntry | null {
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  // YAML metrics use id/label; normalize to name
  const name = typeof r.name === "string" ? r.name
    : typeof r.label === "string" ? r.label
    : typeof r.id === "string" ? r.id : null;
  if (!name || typeof r.sql !== "string") return null;
  return {
    name,
    description: typeof r.description === "string" ? r.description : undefined,
    sql: r.sql,
    entity: typeof r.entity === "string" ? r.entity
      : (r.source && typeof r.source === "object" && typeof (r.source as Record<string, unknown>).entity === "string")
        ? (r.source as Record<string, unknown>).entity as string : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

function normalizeMetrics(raw: unknown): MetricEntry[] {
  if (!raw || !Array.isArray(raw)) return [];
  const metrics: MetricEntry[] = [];
  for (const entry of raw) {
    const e = entry as { data: unknown; file?: string };
    const data = e?.data;
    const fileName = typeof e?.file === "string" ? e.file : undefined;
    const items = Array.isArray(data) ? data
      : (data && typeof data === "object" && Array.isArray((data as { metrics?: unknown }).metrics))
        ? (data as { metrics: unknown[] }).metrics : null;
    if (items) {
      for (const m of items) {
        const parsed = toMetricEntry(m);
        if (parsed) {
          parsed.file = parsed.file ?? fileName;
          metrics.push(parsed);
        }
      }
    }
  }
  return metrics;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Map a selection to its raw YAML file path on the semantic/ directory. */
function selectionToRawPath(sel: SemanticSelection): string | null {
  if (!sel) return null;
  switch (sel.type) {
    case "catalog": return "catalog.yml";
    case "glossary": return "glossary.yml";
    case "entity": return `entities/${sel.name}.yml`;
    case "metrics": return sel.file ? `metrics/${sel.file}.yml` : null;
  }
}

type ViewMode = "pretty" | "yaml";

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(v) => { if (v) onChange(v as ViewMode); }}
    >
      <ToggleGroupItem value="pretty" className="gap-1.5 text-xs">
        <LayoutDashboard className="size-3" />
        Pretty
      </ToggleGroupItem>
      <ToggleGroupItem value="yaml" className="gap-1.5 text-xs">
        <Code className="size-3" />
        YAML
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function RawYamlViewer({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <pre className="p-6 text-xs leading-relaxed font-mono whitespace-pre-wrap">
        <code>{content}</code>
      </pre>
    </ScrollArea>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function SemanticPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityData | null>(null);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [catalog, setCatalog] = useState<CatalogMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SemanticSelection>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("pretty");
  const [rawYaml, setRawYaml] = useState<string | null>(null);
  const [rawYamlLoading, setRawYamlLoading] = useState(false);

  const fetchOpts: RequestInit = {
    credentials: isCrossOrigin ? "include" : "same-origin",
  };

  // Fetch all semantic data
  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      const [entitiesRes, glossaryRes, metricsRes, catalogRes] = await Promise.allSettled([
        fetch(`${apiUrl}/api/v1/admin/semantic/entities`, fetchOpts).then((r) => {
          if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/glossary`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/metrics`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/catalog`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      ]);

      if (cancelled) return;

      if (entitiesRes.status === "fulfilled") {
        const data = entitiesRes.value;
        setEntities(Array.isArray(data?.entities) ? data.entities : Array.isArray(data) ? data : []);
      } else {
        const err = entitiesRes.reason;
        setError({ message: err.message, status: err.status });
      }

      if (glossaryRes.status === "fulfilled") {
        const data = glossaryRes.value;
        setGlossary(normalizeGlossary(data?.glossary ?? data));
      }
      if (metricsRes.status === "fulfilled") {
        const data = metricsRes.value;
        setMetrics(normalizeMetrics(data?.metrics ?? data));
      }
      if (catalogRes.status === "fulfilled") {
        const data = catalogRes.value;
        setCatalog(data?.catalog ?? data ?? null);
      }
    }

    fetchAll().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiUrl]);

  // Fetch entity detail when an entity is selected
  const handleSelect = useCallback(
    async (sel: SemanticSelection) => {
      setSelection(sel);
      setDetailError(null);
      setSelectedEntity(null);
      setViewMode("pretty");
      setRawYaml(null);

      if (sel?.type === "entity") {
        try {
          const res = await fetch(
            `${apiUrl}/api/v1/admin/semantic/entities/${encodeURIComponent(sel.name)}`,
            fetchOpts,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          setSelectedEntity(data?.entity ?? data);
        } catch (err) {
          setDetailError(
            `Failed to load "${sel.name}": ${err instanceof Error ? err.message : "Network error"}`,
          );
        }
      }
    },
    [apiUrl],
  );

  // Fetch raw YAML when switching to YAML view
  useEffect(() => {
    if (viewMode !== "yaml" || !selection) return;
    if (rawYaml !== null) return; // already fetched

    const rawPath = selectionToRawPath(selection);
    if (!rawPath) {
      setRawYaml("# No YAML file for this selection");
      return;
    }

    let cancelled = false;
    setRawYamlLoading(true);
    fetch(`${apiUrl}/api/v1/admin/semantic/raw/${rawPath}`, fetchOpts)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => { if (!cancelled) setRawYaml(text); })
      .catch((err) => {
        if (!cancelled) setRawYaml(`# Failed to load: ${err instanceof Error ? err.message : "unknown error"}`);
      })
      .finally(() => { if (!cancelled) setRawYamlLoading(false); });

    return () => { cancelled = true; };
  }, [viewMode, selection, rawYaml, apiUrl]);

  const entityNames = useMemo(() => entities.map((e) => e.table).sort(), [entities]);
  const metricFileNames = useMemo(() => {
    const files = new Set<string>();
    for (const m of metrics) {
      if (m.file) files.add(m.file);
    }
    return [...files].sort();
  }, [metrics]);

  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
          <p className="text-sm text-muted-foreground">Browse entities, glossary, metrics, and catalog</p>
        </div>
        <LoadingState message="Loading semantic layer..." />
      </div>
    );
  }

  if (error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
          <p className="text-sm text-muted-foreground">Browse entities, glossary, metrics, and catalog</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Semantic Layer" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
          <p className="text-sm text-muted-foreground">Browse entities, glossary, metrics, and catalog</p>
        </div>
        <ErrorBanner message={friendlyError(error)} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
        <p className="text-sm text-muted-foreground">Browse entities, glossary, metrics, and catalog</p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        <SemanticFileTree
          entityNames={entityNames}
          metricFileNames={metricFileNames}
          hasCatalog={catalog !== null}
          hasGlossary={glossary.length > 0}
          selection={selection}
          onSelect={handleSelect}
          className="w-64 shrink-0 border-r"
        />

        {/* Content area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* View toggle bar — only shown when a file is selected */}
          {selection && !detailError && (
            <div className="flex items-center justify-end border-b px-4 py-2">
              <ViewToggle mode={viewMode} onChange={(m) => { setViewMode(m); }} />
            </div>
          )}

          <div className="flex-1 overflow-hidden">
          {detailError ? (
            <ErrorBanner message={detailError} />
          ) : !selection ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FolderOpen className="mx-auto size-10 opacity-50" />
                <p className="mt-3 text-sm">Select a file to view its contents</p>
              </div>
            </div>
          ) : viewMode === "yaml" ? (
            rawYamlLoading ? (
              <LoadingState message="Loading YAML..." />
            ) : rawYaml !== null ? (
              <RawYamlViewer content={rawYaml} />
            ) : (
              <LoadingState message="Loading YAML..." />
            )
          ) : selection.type === "entity" ? (
            selectedEntity ? (
              <EntityDetail entity={selectedEntity} />
            ) : (
              <LoadingState message={`Loading ${selection.name}...`} />
            )
          ) : (
            <ScrollArea className="h-full">
              <div className="p-6">
                {selection.type === "catalog" && <CatalogViewer catalog={catalog} />}
                {selection.type === "glossary" && <GlossaryViewer glossary={glossary} />}
                {selection.type === "metrics" && (
                  <MetricsViewer
                    metrics={selection.file
                      ? metrics.filter((m) => m.file === selection.file)
                      : metrics}
                  />
                )}
              </div>
            </ScrollArea>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
