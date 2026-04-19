"use client";

import { useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { useAtlasConfig } from "@/ui/context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RotateCcw, GitCompare, X, ChevronDown } from "lucide-react";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import type {
  SemanticEntityVersionSummary,
  SemanticEntityVersionDetail,
} from "@useatlas/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VersionListResponse {
  versions: SemanticEntityVersionSummary[];
  total: number;
}

interface VersionDetailResponse {
  version: SemanticEntityVersionDetail;
}

interface EntityVersionHistoryProps {
  entityName: string;
  onRollback: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Diff computation (client-side YAML comparison)
// ---------------------------------------------------------------------------

interface DiffItem {
  section: string;
  type: "added" | "removed" | "changed";
  name: string;
  detail?: string;
}

function computeDiff(oldYaml: string, newYaml: string): DiffItem[] {
  try {
    // Dynamic import not available in sync function — parse manually
    // YAML is simple enough for basic parsing: we use JSON-based comparison
    // after server returns parsed YAML. But since server returns raw YAML strings,
    // we do a simple line-based parse for the structured sections.
    const oldObj = parseSimpleYaml(oldYaml);
    const newObj = parseSimpleYaml(newYaml);
    const items: DiffItem[] = [];

    const sections = ["dimensions", "measures", "joins", "query_patterns"] as const;
    const labels: Record<string, string> = {
      dimensions: "Dimension",
      measures: "Measure",
      joins: "Join",
      query_patterns: "Pattern",
    };

    for (const section of sections) {
      const oldArr = (oldObj[section] ?? []) as Array<{ name?: string }>;
      const newArr = (newObj[section] ?? []) as Array<{ name?: string }>;
      const oldMap = new Map(oldArr.map((d) => [d.name ?? "", d]));
      const newMap = new Map(newArr.map((d) => [d.name ?? "", d]));
      const label = labels[section];

      // Added
      for (const [name] of newMap) {
        if (name && !oldMap.has(name)) {
          items.push({ section: label, type: "added", name });
        }
      }
      // Removed
      for (const [name] of oldMap) {
        if (name && !newMap.has(name)) {
          items.push({ section: label, type: "removed", name });
        }
      }
      // Changed (same name but different content)
      for (const [name, newItem] of newMap) {
        if (name && oldMap.has(name)) {
          const oldItem = oldMap.get(name);
          if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
            items.push({ section: label, type: "changed", name });
          }
        }
      }
    }

    // Check description
    if ((oldObj.description ?? "") !== (newObj.description ?? "")) {
      items.push({ section: "Meta", type: "changed", name: "description", detail: `"${String(oldObj.description ?? "")}" → "${String(newObj.description ?? "")}"` });
    }

    // Check table
    if ((oldObj.table ?? "") !== (newObj.table ?? "")) {
      items.push({ section: "Meta", type: "changed", name: "table", detail: `"${String(oldObj.table ?? "")}" → "${String(newObj.table ?? "")}"` });
    }

    return items;
  } catch (err) {
    console.warn("Failed to compute diff between versions:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Minimal YAML-to-object parser that handles the semantic entity format.
 * Uses js-yaml loaded via dynamic import in the browser would require async;
 * instead we JSON.parse a simple transform for the flat structure.
 * Falls back to empty object on failure.
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  try {
    // Use a lightweight approach: semantic YAML is simple enough for basic parsing.
    // We detect array items by "- name:" pattern and group by top-level keys.
    const result: Record<string, unknown> = {};
    const lines = yamlStr.split("\n");
    let currentKey = "";
    let currentArray: Record<string, unknown>[] = [];
    let currentItem: Record<string, unknown> | null = null;

    for (const line of lines) {
      // Top-level key (no indentation)
      const topMatch = line.match(/^(\w[\w_]*):\s*(.*)/);
      if (topMatch) {
        // Save previous array
        if (currentKey && currentArray.length > 0) {
          if (currentItem) currentArray.push(currentItem);
          result[currentKey] = currentArray;
        }
        const [, key, value] = topMatch;
        if (value && !value.startsWith("\n")) {
          result[key] = value.replace(/^['"]|['"]$/g, "");
        }
        currentKey = key;
        currentArray = [];
        currentItem = null;
        continue;
      }

      // Array item start "  - name: ..."
      const itemMatch = line.match(/^\s+-\s+(\w+):\s*(.*)/);
      if (itemMatch) {
        if (currentItem) currentArray.push(currentItem);
        const [, k, v] = itemMatch;
        currentItem = { [k]: v.replace(/^['"]|['"]$/g, "") };
        continue;
      }

      // Continuation "    key: value"
      const contMatch = line.match(/^\s{4,}(\w+):\s*(.*)/);
      if (contMatch && currentItem) {
        const [, k, v] = contMatch;
        const trimmed = v.replace(/^['"]|['"]$/g, "");
        if (trimmed === "true") currentItem[k] = true;
        else if (trimmed === "false") currentItem[k] = false;
        else currentItem[k] = trimmed;
      }
    }

    // Save last array
    if (currentKey && currentArray.length > 0) {
      if (currentItem) currentArray.push(currentItem);
      result[currentKey] = currentArray;
    } else if (currentKey && currentItem) {
      currentArray.push(currentItem);
      result[currentKey] = currentArray;
    }

    return result;
  } catch (err) {
    // intentionally non-fatal: best-effort parser for diff; caller handles gracefully
    console.warn("YAML parse failed for diff:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

// ---------------------------------------------------------------------------
// Diff display
// ---------------------------------------------------------------------------

function DiffBadge({ type }: { type: "added" | "removed" | "changed" }) {
  const styles = {
    added: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    removed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    changed: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  };
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${styles[type]}`}>{type}</Badge>;
}

function DiffView({ oldYaml, newYaml }: { oldYaml: string; newYaml: string }) {
  const items = computeDiff(oldYaml, newYaml);

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        No structural differences found between these versions.
      </div>
    );
  }

  // Group by section
  const grouped = new Map<string, DiffItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.section) ?? [];
    existing.push(item);
    grouped.set(item.section, existing);
  }

  return (
    <div className="space-y-3">
      {[...grouped.entries()].map(([section, sectionItems]) => (
        <div key={section}>
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">{section}s</h4>
          <div className="space-y-1">
            {sectionItems.map((item) => (
              <div key={`${item.section}-${item.name}-${item.type}`} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <DiffBadge type={item.type} />
                <span className="font-mono text-xs">{item.name}</span>
                {item.detail && <span className="text-xs text-muted-foreground">{item.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EntityVersionHistory({ entityName, onRollback }: EntityVersionHistoryProps) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const [compareIds, setCompareIds] = useState<[string | null, string | null]>([null, null]);
  const [compareData, setCompareData] = useState<{ a: SemanticEntityVersionDetail | null; b: SemanticEntityVersionDetail | null }>({ a: null, b: null });
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<SemanticEntityVersionSummary | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<VersionListResponse>(
    `/api/v1/admin/semantic/entities/${encodeURIComponent(entityName)}/versions?limit=${pageSize}&offset=${page * pageSize}`,
    { deps: [entityName, page] },
  );

  const { mutate: mutateRollback, saving: rollingBack, error: rollbackError, reset: resetRollback } = useAdminMutation({
    method: "POST",
  });

  const versions = data?.versions ?? [];
  const total = data?.total ?? 0;
  const hasMore = (page + 1) * pageSize < total;

  // Toggle version for comparison
  const toggleCompare = (id: string) => {
    setCompareData({ a: null, b: null });
    setCompareIds(([a, b]) => {
      if (a === id) return [b, null];
      if (b === id) return [a, null];
      if (a === null) return [id, b];
      if (b === null) return [a, id];
      // Both slots full — replace the older selection
      return [b, id];
    });
  };

  // Fetch comparison data when both IDs are set
  const fetchOpts: RequestInit = { credentials: isCrossOrigin ? "include" : "same-origin" };

  const handleCompare = async () => {
    const [idA, idB] = compareIds;
    if (!idA || !idB) return;

    setCompareLoading(true);
    setCompareError(null);
    try {
      const [rawA, rawB] = await Promise.all([
        fetch(`${apiUrl}/api/v1/admin/semantic/entities/versions/${idA}`, fetchOpts),
        fetch(`${apiUrl}/api/v1/admin/semantic/entities/versions/${idB}`, fetchOpts),
      ]);
      if (!rawA.ok || !rawB.ok) {
        const failedRes = !rawA.ok ? rawA : rawB;
        const body = await failedRes.json().catch(() => ({})) as Record<string, unknown>;
        setCompareError(typeof body.message === "string" ? body.message : `Failed to fetch version details (HTTP ${failedRes.status}).`);
        return;
      }
      const [resA, resB] = await Promise.all([
        rawA.json() as Promise<VersionDetailResponse>,
        rawB.json() as Promise<VersionDetailResponse>,
      ]);
      // Order: older first (lower version number = a)
      const a = resA.version;
      const b = resB.version;
      if (a.versionNumber < b.versionNumber) {
        setCompareData({ a, b });
      } else {
        setCompareData({ a: b, b: a });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.debug("Failed to fetch versions for comparison:", msg);
      setCompareError(msg || "Failed to fetch versions for comparison. Check your connection and try again.");
    } finally {
      setCompareLoading(false);
    }
  };

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    const result = await mutateRollback({
      path: `/api/v1/admin/semantic/entities/${encodeURIComponent(entityName)}/rollback`,
      body: { versionId: rollbackTarget.id } as Record<string, unknown>,
    });
    if (result.ok) {
      setRollbackTarget(null);
      refetch();
      onRollback();
    }
  };

  const clearComparison = () => {
    setCompareIds([null, null]);
    setCompareData({ a: null, b: null });
    setCompareError(null);
  };

  if (loading) return <LoadingState message="Loading version history..." />;
  if (error) return <div className="p-6"><ErrorBanner message={error.message} /></div>;
  if (versions.length === 0) {
    return (
      <EmptyState icon={RotateCcw} message="No version history">
        <p className="mt-1 text-xs">
          Version history is recorded each time you save an entity through the editor.
        </p>
      </EmptyState>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-4">
        {/* Comparison banner */}
        {(compareIds[0] || compareIds[1]) && (
          <Card>
            <CardContent className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2 text-sm">
                <GitCompare className="size-4 text-muted-foreground" />
                <span>
                  {compareIds[0] && compareIds[1]
                    ? `Comparing v${versions.find((v) => v.id === compareIds[0])?.versionNumber ?? "?"} ↔ v${versions.find((v) => v.id === compareIds[1])?.versionNumber ?? "?"}`
                    : "Select another version to compare"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {compareIds[0] && compareIds[1] && (
                  <Button size="sm" variant="outline" onClick={handleCompare} disabled={compareLoading} className="gap-1 text-xs">
                    <GitCompare className="size-3" />
                    {compareLoading ? "Loading..." : "Compare"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={clearComparison} className="text-xs">
                  <X className="size-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Compare error */}
        {compareError && (
          <ErrorBanner message={compareError} />
        )}

        {/* Diff view */}
        {compareData.a && compareData.b && (
          <Card>
            <CardContent className="py-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  Changes: v{compareData.a.versionNumber} → v{compareData.b.versionNumber}
                </h3>
                <Button size="sm" variant="ghost" onClick={clearComparison} className="text-xs gap-1">
                  <X className="size-3" /> Close
                </Button>
              </div>
              <DiffView oldYaml={compareData.a.yamlContent} newYaml={compareData.b.yamlContent} />
            </CardContent>
          </Card>
        )}

        {/* Version list */}
        <div className="space-y-2">
          {versions.map((version, idx) => {
            const isLatest = page === 0 && idx === 0;
            const isSelected = compareIds[0] === version.id || compareIds[1] === version.id;

            return (
              <Card key={version.id} className={isSelected ? "ring-2 ring-primary" : ""}>
                <CardContent className="flex items-center gap-3 py-3">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleCompare(version.id)}
                    aria-label={`Select v${version.versionNumber} for comparison`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={isLatest ? "default" : "secondary"} className="text-[10px]">
                        v{version.versionNumber}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{relativeTime(version.createdAt)}</span>
                      {version.authorLabel && (
                        <span className="text-xs text-muted-foreground">by {version.authorLabel}</span>
                      )}
                      {isLatest && (
                        <Badge variant="outline" className="text-[10px] text-green-600 border-green-200 dark:text-green-400 dark:border-green-800">
                          current
                        </Badge>
                      )}
                    </div>
                    {version.changeSummary && (
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">{version.changeSummary}</p>
                    )}
                  </div>
                  {!isLatest && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        resetRollback();
                        setRollbackTarget(version);
                      }}
                      className="gap-1 text-xs shrink-0"
                    >
                      <RotateCcw className="size-3" />
                      Restore
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Pagination */}
        {(hasMore || page > 0) && (
          <div className="flex items-center justify-center gap-2 pt-2">
            {page > 0 && (
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} className="text-xs">
                Previous
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
            </span>
            {hasMore && (
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} className="gap-1 text-xs">
                More <ChevronDown className="size-3" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Rollback confirmation */}
      <AlertDialog open={rollbackTarget !== null} onOpenChange={(open) => { if (!open) setRollbackTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore version {rollbackTarget?.versionNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite the current entity with the content from version {rollbackTarget?.versionNumber}.
              A new version will be created recording this rollback. This action can be undone by restoring a newer version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rollbackError && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {friendlyError(rollbackError)}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRollback();
              }}
              disabled={rollingBack}
            >
              {rollingBack ? "Restoring..." : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
