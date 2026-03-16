"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { HardDrive, Trash2, Loader2, Activity, Database, Clock, Target } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface CacheStatsResponse {
  enabled: boolean;
  hits: number;
  misses: number;
  hitRate: number;
  missRate: number;
  entryCount: number;
  maxSize: number;
  ttl: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function formatTtl(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ── Stat Card ─────────────────────────────────────────────────────

function StatItem({
  label,
  value,
  icon: Icon,
  description,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function CachePage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [flushing, setFlushing] = useState(false);
  const [flushMessage, setFlushMessage] = useState<string | null>(null);
  const [flushError, setFlushError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<CacheStatsResponse>(
    "/api/v1/admin/cache/stats",
    { transform: (json) => json as CacheStatsResponse },
  );

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Cache</h1>
          <p className="text-sm text-muted-foreground">Query result cache statistics</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Cache" />
      </div>
    );
  }

  async function handleFlush() {
    setFlushing(true);
    setFlushError(null);
    setFlushMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/cache/flush`, {
        method: "POST",
        credentials,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setFlushMessage(`Flushed ${body.flushed} ${body.flushed === 1 ? "entry" : "entries"}`);
      refetch();
    } catch (err) {
      setFlushError(err instanceof Error ? err.message : "Failed to flush cache");
    } finally {
      setFlushing(false);
    }
  }

  const totalQueries = data ? data.hits + data.misses : 0;
  const fillPercent = data && data.maxSize > 0 ? (data.entryCount / data.maxSize) * 100 : 0;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Cache</h1>
        <p className="text-sm text-muted-foreground">
          Query result cache statistics and management
        </p>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
          {flushError && (
            <ErrorBanner message={flushError} onRetry={() => setFlushError(null)} />
          )}
          {flushMessage && (
            <div className="mb-6 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
              {flushMessage}
            </div>
          )}

          {loading ? (
            <LoadingState message="Loading cache stats..." />
          ) : data ? (
            <div className="space-y-6">
              {/* Disabled notice */}
              {!data.enabled && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                  Query caching is disabled. Set{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono text-xs">ATLAS_CACHE_ENABLED=true</code>{" "}
                  to enable.
                </div>
              )}

              {/* Hit Rate Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Target className="size-4" />
                    Hit Rate
                  </CardTitle>
                  <CardDescription>
                    Cache effectiveness across {totalQueries.toLocaleString()} total {totalQueries === 1 ? "query" : "queries"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-bold tracking-tight">
                      {formatPercent(data.hitRate)}
                    </span>
                    <span className="text-sm text-muted-foreground">hit rate</span>
                  </div>
                  <Progress value={data.hitRate * 100} className="h-2" />
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Hits</p>
                      <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                        {data.hits.toLocaleString()}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Misses</p>
                      <p className="text-lg font-semibold text-muted-foreground">
                        {data.misses.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Size & Config Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="size-4" />
                    Storage
                  </CardTitle>
                  <CardDescription>
                    Cache capacity and configuration
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-6">
                    <StatItem
                      label="Entries"
                      value={`${data.entryCount.toLocaleString()} / ${data.maxSize.toLocaleString()}`}
                      icon={HardDrive}
                    />
                    <StatItem
                      label="Fill"
                      value={`${fillPercent.toFixed(1)}%`}
                      icon={Activity}
                    />
                    <StatItem
                      label="TTL"
                      value={formatTtl(data.ttl)}
                      icon={Clock}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{data.entryCount.toLocaleString()} entries</span>
                      <span>{data.maxSize.toLocaleString()} max</span>
                    </div>
                    <Progress value={fillPercent} className="h-2" />
                  </div>
                </CardContent>
              </Card>

              {/* Flush Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Trash2 className="size-4" />
                    Flush Cache
                  </CardTitle>
                  <CardDescription>
                    Remove all cached query results. New queries will hit the database directly until the cache is repopulated.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        disabled={flushing || !data.enabled || data.entryCount === 0}
                      >
                        {flushing && <Loader2 className="mr-1 size-3 animate-spin" />}
                        Flush Cache
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Flush cache?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove {data.entryCount.toLocaleString()} cached{" "}
                          {data.entryCount === 1 ? "entry" : "entries"}. Subsequent queries will be slower until the cache warms up again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleFlush}>
                          Flush
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardContent>
              </Card>
            </div>
          ) : !error ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <HardDrive className="mb-3 size-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No cache data available</p>
            </div>
          ) : null}
        </div>
      </ErrorBoundary>
    </div>
  );
}
