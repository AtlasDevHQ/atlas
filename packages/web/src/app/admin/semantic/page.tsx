"use client";

import { useEffect, useState, useCallback } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Database, BookOpen, BarChart3, FileText } from "lucide-react";
import { EntityList, type EntitySummary } from "@/ui/components/admin/entity-list";
import { EntityDetail, type EntityData } from "@/ui/components/admin/entity-detail";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { friendlyError, type FetchError } from "@/ui/hooks/use-admin-fetch";

// ── Types ─────────────────────────────────────────────────────────

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
}

interface CatalogMeta {
  name?: string;
  description?: string;
  use_for?: string[];
  common_questions?: string[];
}

// ── Shared sub-components ─────────────────────────────────────────

const TAB_TRIGGER_CLASS =
  "gap-1.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent";

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{count}</Badge>;
}

export default function SemanticPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityData | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [catalog, setCatalog] = useState<CatalogMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const fetchOpts: RequestInit = {
    credentials: isCrossOrigin ? "include" : "same-origin",
  };

  // Fetch entity list
  useEffect(() => {
    let cancelled = false;
    async function fetchEntities() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/semantic/entities`, fetchOpts);
        if (!res.ok) {
          if (!cancelled) setError({ message: `HTTP ${res.status}`, status: res.status });
          return;
        }
        const data = await res.json();
        if (!cancelled) setEntities(data);
      } catch (err) {
        if (!cancelled) {
          setError({
            message: err instanceof Error ? err.message : "Failed to load entities",
          });
        }
      }
    }
    fetchEntities().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl]);

  // Fetch glossary, metrics, catalog in parallel
  useEffect(() => {
    let cancelled = false;
    async function fetchMeta() {
      const [glossaryRes, metricsRes, catalogRes] = await Promise.allSettled([
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
      if (glossaryRes.status === "fulfilled") setGlossary(glossaryRes.value);
      else console.warn("Glossary fetch failed:", glossaryRes.reason);
      if (metricsRes.status === "fulfilled") setMetrics(metricsRes.value);
      else console.warn("Metrics fetch failed:", metricsRes.reason);
      if (catalogRes.status === "fulfilled") setCatalog(catalogRes.value);
      else console.warn("Catalog fetch failed:", catalogRes.reason);
    }
    fetchMeta();
    return () => { cancelled = true; };
  }, [apiUrl]);

  // Fetch entity detail
  const handleSelectEntity = useCallback(async (name: string) => {
    setSelectedName(name);
    setSelectedEntity(null);
    setDetailError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/semantic/entities/${encodeURIComponent(name)}`, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSelectedEntity(data);
    } catch (err) {
      setDetailError(
        `Failed to load details for "${name}": ${err instanceof Error ? err.message : "Network error"}`
      );
    }
  }, [apiUrl]);

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
        <p className="text-sm text-muted-foreground">Browse entities, glossary, metrics, and catalog</p>
      </div>

      <Tabs defaultValue="entities" className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b px-6">
          <TabsList className="h-10 bg-transparent p-0">
            <TabsTrigger value="entities" className={TAB_TRIGGER_CLASS}>
              <Database className="size-3.5" />
              Entities
              <CountBadge count={entities.length} />
            </TabsTrigger>
            <TabsTrigger value="glossary" className={TAB_TRIGGER_CLASS}>
              <BookOpen className="size-3.5" />
              Glossary
              <CountBadge count={glossary.length} />
            </TabsTrigger>
            <TabsTrigger value="metrics" className={TAB_TRIGGER_CLASS}>
              <BarChart3 className="size-3.5" />
              Metrics
              <CountBadge count={metrics.length} />
            </TabsTrigger>
            <TabsTrigger value="catalog" className={TAB_TRIGGER_CLASS}>
              <FileText className="size-3.5" />
              Catalog
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Entities tab — master/detail */}
        <TabsContent value="entities" className="mt-0 flex-1 overflow-hidden">
          {loading ? (
            <LoadingState message="Loading entities..." />
          ) : error?.status && [401, 403, 404].includes(error.status) ? (
            <FeatureGate status={error.status as 401 | 403 | 404} feature="Semantic Layer" />
          ) : error ? (
            <ErrorBanner message={friendlyError(error)} />
          ) : (
            <div className="flex h-full">
              <EntityList
                entities={entities}
                selectedName={selectedName}
                onSelect={handleSelectEntity}
                className="w-80 shrink-0 border-r"
              />
              <div className="flex-1 overflow-hidden">
                {detailError ? (
                  <ErrorBanner message={detailError} />
                ) : selectedEntity ? (
                  <EntityDetail entity={selectedEntity} />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Database className="mx-auto size-10 opacity-50" />
                      <p className="mt-3 text-sm">Select an entity to view details</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Glossary tab */}
        <TabsContent value="glossary" className="mt-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-6">
              {glossary.length === 0 ? (
                <EmptyState icon={BookOpen} message="No glossary terms found">
                  <p className="mt-1 text-xs">Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a glossary</p>
                </EmptyState>
              ) : (
                <div className="space-y-3">
                  {glossary.map((term) => (
                    <Card key={term.term} className="shadow-none">
                      <CardHeader className="py-3 pb-1">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          {term.term}
                          {term.ambiguous && (
                            <Badge variant="outline" className="text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700 text-[10px]">
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
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Metrics tab */}
        <TabsContent value="metrics" className="mt-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-6">
              {metrics.length === 0 ? (
                <EmptyState icon={BarChart3} message="No metrics found">
                  <p className="mt-1 text-xs">Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate metrics</p>
                </EmptyState>
              ) : (
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
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Catalog tab */}
        <TabsContent value="catalog" className="mt-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-6">
              {!catalog ? (
                <EmptyState icon={FileText} message="No catalog metadata found">
                  <p className="mt-1 text-xs">Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a catalog</p>
                </EmptyState>
              ) : (
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
                          <li key={q} className="text-sm text-muted-foreground">• {q}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
