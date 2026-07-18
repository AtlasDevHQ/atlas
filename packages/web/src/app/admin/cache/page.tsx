"use client";

import { useState } from "react";
import { z } from "zod";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { HardDrive, Trash2, Activity, Database, Clock, Target, Settings2 } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

// Per-caller payload (#4549): `scope` is self-describing — "workspace" means
// the caller's org bucket (maxSize null: fleet capacity is platform framing),
// "platform" means fleet totals + resolved capacity. `since: null` while
// enabled is the warming state; rates are null when there's nothing to rate;
// `entryCount: null` means the count is structurally unavailable (plugin
// cache backend) — rendered as "unavailable", never a confident 0.
const CacheStatsResponseSchema = z.object({
  scope: z.enum(["workspace", "platform"]),
  enabled: z.boolean(),
  ttl: z.number(),
  since: z.number().nullable(),
  hits: z.number(),
  misses: z.number(),
  hitRate: z.number().nullable(),
  windowHitRate: z.number().nullable(),
  windowTotal: z.number(),
  entryCount: z.number().nullable(),
  maxSize: z.number().nullable(),
});

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

function formatSince(sinceMs: number): string {
  return new Date(sinceMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

// ── Configuration Card (workspace enable + TTL) ───────────────────
// Dedicated-surface controls (#4545): ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL
// are workspace-scoped, hidden from the generic settings page
// (saasVisible:false) but written through this page (saasWritable:true) via
// PUT /admin/settings/{key}. Seeded from the RESOLVED values the stats
// endpoint returns; the parent re-mounts this via `key` when those change
// after a save, so local input state stays in sync without an effect.
function CacheConfigCard({
  enabled,
  ttlMs,
  isSaas,
  onChanged,
}: {
  enabled: boolean;
  ttlMs: number;
  isSaas: boolean;
  onChanged: () => void;
}) {
  const [ttlInput, setTtlInput] = useState(String(ttlMs));

  const saveEnabled = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_CACHE_ENABLED",
    method: "PUT",
    invalidates: onChanged,
  });
  const saveTtl = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_CACHE_TTL",
    method: "PUT",
    invalidates: onChanged,
  });

  const configError = combineMutationErrors([saveEnabled.error, saveTtl.error]);
  function clearConfigError() {
    saveEnabled.clearError();
    saveTtl.clearError();
  }

  const ttlNum = Number(ttlInput);
  const ttlValid = ttlInput.trim() !== "" && Number.isFinite(ttlNum) && ttlNum >= 1;
  const ttlDirty = ttlValid && ttlNum !== ttlMs;

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="size-4" />
          Configuration
        </CardTitle>
        <CardDescription>
          Enable caching and tune how long results stay fresh for this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <MutationErrorSurface
          error={configError}
          feature="Cache"
          onRetry={clearConfigError}
        />

        {/* Enable toggle — the action a disabled workspace acts on, in place
            of env-var copy a SaaS admin cannot use. */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="cache-enabled" className="text-sm font-medium">
              Query caching
            </Label>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? "Identical queries return cached results within the TTL."
                : "Caching is off for this workspace — every query hits the database."}
            </p>
          </div>
          <Switch
            id="cache-enabled"
            checked={enabled}
            disabled={saveEnabled.saving}
            aria-label="Enable query caching for this workspace"
            onCheckedChange={(next) =>
              void saveEnabled.mutate({ body: { value: String(next) } })
            }
          />
        </div>

        {/* TTL editor */}
        <div className="space-y-2">
          <Label htmlFor="cache-ttl" className="text-sm font-medium">
            Cache TTL (milliseconds)
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="cache-ttl"
              type="number"
              min={1}
              step={1000}
              value={ttlInput}
              disabled={saveTtl.saving}
              onChange={(e) => setTtlInput(e.target.value)}
              className="max-w-[220px]"
            />
            <Button
              variant="outline"
              disabled={!ttlDirty || saveTtl.saving}
              onClick={() => void saveTtl.mutate({ body: { value: String(ttlNum) } })}
            >
              {saveTtl.saving ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Currently {formatTtl(ttlMs)}. Applies to newly cached results.
            {!isSaas &&
              " You can also set ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL via environment variables."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function CachePage() {
  const [flushMessage, setFlushMessage] = useState<string | null>(null);

  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/cache/stats",
    { schema: CacheStatsResponseSchema },
  );

  const { mutate: flush, saving: flushing, error: flushError, clearError: clearFlushError } =
    useAdminMutation<{ ok: boolean; flushed: number; message: string }>({
      path: "/api/v1/admin/cache/flush",
      method: "POST",
      invalidates: refetch,
    });

  const isPlatform = data?.scope === "platform";

  async function handleFlush() {
    if (flushing || !data) return;
    setFlushMessage(null);
    // Workspace admins purge only their org's entries; platform admins clear
    // the whole fleet (the dialog below disclosed the blast radius). A 409
    // (cache disabled) or 403 flows into MutationErrorSurface via the hook —
    // the success banner only ever renders on a true 200.
    const result = await flush({ body: { scope: isPlatform ? "fleet" : "workspace" } });
    if (result.ok && result.data) {
      const count = result.data.flushed;
      setFlushMessage(`Flushed ${count} ${count === 1 ? "entry" : "entries"}`);
    }
  }

  const totalQueries = data ? data.hits + data.misses : 0;
  // Warming: caching is on but no access has ever been recorded — render an
  // honest "warming up" panel instead of a 0.0% rate that reads as broken.
  const warming = data ? data.enabled && data.since === null : false;
  const fillPercent = data && data.maxSize !== null && data.maxSize > 0 && data.entryCount !== null
    ? (data.entryCount / data.maxSize) * 100
    : 0;
  const flushDisabledReason = data
    ? !data.enabled
      ? "Cache is disabled"
      // null entryCount = count unavailable (plugin backend) — the cache may
      // well be warm, so flushing stays allowed; only a known-zero disables.
      : data.entryCount === 0
        ? "Cache is empty"
        : null
    : null;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Cache</h1>
        <p className="text-sm text-muted-foreground">
          Query result cache statistics and management
        </p>
      </div>

      <ErrorBoundary>
        <TooltipProvider>
          <MutationErrorSurface
            error={flushError}
            feature="Cache"
            onRetry={clearFlushError}
          />
          {flushMessage && (
            <div
              role="status"
              aria-live="polite"
              className="mb-6 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
            >
              {flushMessage}
            </div>
          )}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Cache"
            onRetry={refetch}
            loadingMessage="Loading cache stats..."
            emptyIcon={HardDrive}
            emptyTitle="No cache data available"
            isEmpty={!data}
          >
            {data && <div className="space-y-6">
              {/* Workspace enable + TTL controls. `key` re-seeds the card's
                  local input state from the resolved server values after a
                  save. */}
              <CacheConfigCard
                key={`${data.enabled}-${data.ttl}`}
                enabled={data.enabled}
                ttlMs={data.ttl}
                isSaas={isSaas}
                onChanged={refetch}
              />

              {/* Stats + flush are meaningful only when caching is on. When
                  disabled, the Configuration card's toggle is the whole page
                  — no env-var copy a SaaS admin cannot act on. */}
              {data.enabled && <>
              {/* Hit Rate Card — or an honest warming panel when the cache
                  has never recorded an access (a 0.0% rate over an empty bar
                  reads as broken, not as new). */}
              {warming ? (
                <Card className="shadow-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Target className="size-4" />
                      Hit Rate
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm font-medium">Warming up</p>
                    <p className="text-sm text-muted-foreground">
                      Caching is on, but no queries have consulted it yet.
                      Statistics appear after the first query runs
                      {isPlatform ? " in any workspace." : " in this workspace."}
                    </p>
                  </CardContent>
                </Card>
              ) : (
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Target className="size-4" />
                    Hit Rate
                  </CardTitle>
                  <CardDescription>
                    Cache effectiveness across {totalQueries.toLocaleString()} total {totalQueries === 1 ? "query" : "queries"}
                    {isPlatform ? " (all workspaces)" : " in this workspace"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-bold tracking-tight">
                      {data.hitRate === null ? "—" : formatPercent(data.hitRate)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {data.since === null ? "hit rate" : `since ${formatSince(data.since)}`}
                    </span>
                    <span className="text-sm text-muted-foreground" aria-hidden="true">·</span>
                    <span className="text-sm text-muted-foreground">
                      {data.windowHitRate === null
                        ? "no recent activity"
                        : `${formatPercent(data.windowHitRate)} last hour`}
                    </span>
                  </div>
                  <Progress
                    value={(data.hitRate ?? 0) * 100}
                    className="h-2"
                    aria-label={`Lifetime cache hit rate ${data.hitRate === null ? "unavailable" : formatPercent(data.hitRate)}`}
                  />
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
              )}

              {/* Storage Card. Workspace admins see their org's live entry
                  count only — capacity (maxSize) and the fill gauge are fleet
                  framing reserved for the platform view. */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="size-4" />
                    Storage
                  </CardTitle>
                  <CardDescription>
                    {isPlatform
                      ? "Cache capacity and configuration"
                      : "This workspace's cached entries"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className={`grid grid-cols-1 gap-6 ${isPlatform ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                    <StatItem
                      label="Entries"
                      value={data.entryCount === null
                        ? "—"
                        : data.maxSize !== null
                          ? `${data.entryCount.toLocaleString()} / ${data.maxSize.toLocaleString()}`
                          : data.entryCount.toLocaleString()}
                      icon={HardDrive}
                      description={data.entryCount === null
                        ? "Entry count unavailable for this cache backend"
                        : data.maxSize !== null
                          ? "Live entries vs. the configured capacity"
                          : "Live cached results owned by this workspace"}
                    />
                    {isPlatform && (
                      <StatItem
                        label="Fill"
                        value={`${fillPercent.toFixed(1)}%`}
                        icon={Activity}
                        description="How much of the cache's capacity is in use"
                      />
                    )}
                    <StatItem
                      label="TTL"
                      value={formatTtl(data.ttl)}
                      icon={Clock}
                      description="How long a cached result stays fresh before it expires"
                    />
                  </div>
                  {isPlatform && (
                    <Progress
                      value={fillPercent}
                      className="h-2"
                      aria-label={`Cache fill ${fillPercent.toFixed(1)}%`}
                    />
                  )}
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
                    {isPlatform
                      ? "Remove every workspace's cached query results in this region. Queries hit the database directly until the cache is repopulated."
                      : "Remove this workspace's cached query results. Queries hit the database directly until the cache is repopulated."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AlertDialog>
                    {flushDisabledReason ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* span wrapper: disabled buttons don't fire pointer
                              events in Safari/Firefox, so the tooltip trigger
                              must sit on an enabled element. tabIndex makes
                              the explanation keyboard-reachable — Radix opens
                              the tooltip on focus (#4549 a11y). */}
                          <span className="inline-block" tabIndex={0}>
                            <Button variant="destructive" disabled>
                              Flush Cache
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{flushDisabledReason}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" disabled={flushing}>
                          Flush Cache
                        </Button>
                      </AlertDialogTrigger>
                    )}
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{isPlatform ? "Flush every workspace's cache?" : "Flush cache?"}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {isPlatform ? (
                            <>
                              This clears EVERY workspace in this region —{" "}
                              {data.entryCount === null
                                ? "all cached entries"
                                : `all ${data.entryCount.toLocaleString()} cached ${data.entryCount === 1 ? "entry" : "entries"}`}
                              , not just your own workspace&apos;s.
                              Subsequent queries will be slower for every tenant until their caches warm up again.
                            </>
                          ) : (
                            <>
                              This will remove{" "}
                              {data.entryCount === null
                                ? "all of your organization's cached entries"
                                : `${data.entryCount.toLocaleString()} of your organization's cached ${data.entryCount === 1 ? "entry" : "entries"}`}
                              . Subsequent queries will be slower until the cache warms up again.
                            </>
                          )}
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
              </>}
            </div>}
          </AdminContentWrapper>
        </TooltipProvider>
      </ErrorBoundary>
    </div>
  );
}
