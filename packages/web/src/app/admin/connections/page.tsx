"use client";

import { z } from "zod";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDemoReadonly } from "@/ui/hooks/use-demo-readonly";
import { useDevModeNoDrafts } from "@/ui/hooks/use-dev-mode-no-drafts";
import { DeveloperEmptyState } from "@/ui/components/admin/developer-empty-state";
import { PublishedContextWrapper } from "@/ui/components/admin/published-context-wrapper";
import { DemoBadge, DraftBadge } from "@/ui/components/admin/mode-badges";
import { DEMO_CONNECTION_ID } from "./columns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Cable,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  Activity,
  ChevronDown,
  ChevronUp,
  Droplets,
  Check,
  X,
  Database,
  Snowflake,
  Cloud,
  HardDrive,
  RefreshCw,
} from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription as FormDesc,
} from "@/components/form-dialog";
import {
  useState,
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import {
  DB_TYPES,
  type ConnectionHealth,
  type ConnectionInfo,
  type ConnectionDetail,
  type PoolMetrics,
} from "@/ui/lib/types";
import { ConnectionsResponseSchema } from "@/ui/lib/admin-schemas";

// ── Connection Form Dialog ───────────────────────────────────────

const connectionCreateSchema = z.object({
  id: z
    .string()
    .min(1, "Connection ID is required")
    .regex(/^[a-z][a-z0-9_-]*$/, "Lowercase letters, numbers, hyphens, underscores. Must start with a letter."),
  dbType: z.string().min(1, "Database type is required"),
  url: z.string().min(1, "Connection URL is required"),
  schema: z.string(),
  description: z.string(),
});

const connectionEditSchema = z.object({
  id: z.string(),
  dbType: z.string(),
  url: z.string(), // empty string is valid on edit — empty means keep current URL
  schema: z.string(),
  description: z.string(),
});

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
  editDetail?: ConnectionDetail | null;
  /**
   * Preselect the dbType dropdown when opening in create mode. Lets a
   * "+ Connect" click from a Snowflake CompactRow open the dialog already
   * pointed at Snowflake so the admin isn't walked into Postgres
   * URL-syntax validation on Snowflake input. Ignored on edit — the edit
   * path always derives dbType from the existing ConnectionDetail so the
   * dropdown stays locked to the real value.
   */
  initialDbType?: string;
  onSuccess: () => void;
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editId,
  editDetail,
  initialDbType,
  onSuccess,
}: ConnectionFormProps) {
  const isEdit = !!editId;
  const [showUrl, setShowUrl] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const testMutation = useAdminMutation<{ status: string; latencyMs?: number; message?: string }>({
    path: "/api/v1/admin/connections/test",
    method: "POST",
  });

  const saveMutation = useAdminMutation({
    invalidates: onSuccess,
  });

  const schema = isEdit ? connectionEditSchema : connectionCreateSchema;

  // Only the default `dbType` value changes when `initialDbType` is present —
  // schema validation, submit payload, and every other form field stay
  // byte-for-byte identical to the pre-revamp form.
  const defaultValues = isEdit && editDetail
    ? { id: editId!, dbType: editDetail.dbType, url: "", schema: editDetail.schema ?? "", description: editDetail.description ?? "" }
    : { id: "", dbType: initialDbType ?? "postgres", url: "", schema: "", description: "" };

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setShowUrl(false);
      setTestResult(null);
      testMutation.reset();
      saveMutation.reset();
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit(values: z.infer<typeof connectionCreateSchema | typeof connectionEditSchema>) {
    const path = isEdit
      ? `/api/v1/admin/connections/${encodeURIComponent(editId!)}`
      : `/api/v1/admin/connections`;
    const method = isEdit ? "PUT" as const : "POST" as const;

    const body: Record<string, unknown> = {};
    if (!isEdit) {
      body.id = values.id;
      body.url = values.url;
      if (values.description) body.description = values.description;
      if (values.schema) body.schema = values.schema;
    } else {
      if (values.url) body.url = values.url;
      body.description = values.description;
      body.schema = values.schema || undefined;
    }

    await saveMutation.mutate({
      path,
      method,
      body,
      onSuccess: () => onOpenChange(false),
    });
  }

  async function handleTest(url: string, schemaVal: string) {
    if (!url) {
      setTestResult({ ok: false, message: "Enter a connection URL first." });
      return;
    }
    setTestResult(null);
    const data = await testMutation.mutate({
      body: { url, schema: schemaVal || undefined },
      onSuccess: (d) => {
        if (!d) return;
        setTestResult({
          ok: d.status === "healthy",
          message: d.status === "healthy"
            ? `Connected (${d.latencyMs}ms)`
            : d.message || "Connection unhealthy",
        });
      },
    });
    if (!data.ok) {
      setTestResult({ ok: false, message: "Connection test failed" });
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={isEdit ? "Edit Connection" : "Add Connection"}
      description={
        isEdit
          ? "Update the connection configuration. Leave URL empty to keep the current one."
          : "Add a new datasource connection."
      }
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel={isEdit ? "Save Changes" : "Add Connection"}
      saving={saveMutation.saving}
      serverError={saveMutation.error}
      className="sm:max-w-md"
      extraFooter={(form) => (
        <Button
          type="button"
          variant="outline"
          onClick={() => handleTest(form.getValues("url"), form.getValues("schema"))}
          disabled={testMutation.saving || !form.watch("url")}
        >
          {testMutation.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Test
        </Button>
      )}
    >
      {(form) => (
        <>
          {!isEdit && (
            <FormField
              control={form.control}
              name="id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Connection ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. warehouse"
                      {...field}
                      onChange={(e) => field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                    />
                  </FormControl>
                  <FormDesc>Lowercase letters, numbers, hyphens, underscores.</FormDesc>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="dbType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Database Type</FormLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {DB_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Connection URL</FormLabel>
                <div className="relative">
                  <FormControl>
                    <Input
                      type={showUrl ? "text" : "password"}
                      placeholder={isEdit ? "(unchanged)" : "postgresql://user:pass@host:5432/dbname"}
                      className="pr-10"
                      {...field}
                    />
                  </FormControl>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() => setShowUrl(!showUrl)}
                    aria-label={showUrl ? "Hide connection URL" : "Show connection URL"}
                  >
                    {showUrl ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                {isEdit && editDetail?.maskedUrl && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Current: {editDetail.maskedUrl}
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          {form.watch("dbType") === "postgres" && (
            <FormField
              control={form.control}
              name="schema"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schema</FormLabel>
                  <FormControl>
                    <Input placeholder="public" {...field} />
                  </FormControl>
                  <FormDesc>
                    PostgreSQL schema (sets search_path). Leave empty for &quot;public&quot;.
                  </FormDesc>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Optional description shown in the agent system prompt"
                    rows={2}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {testResult && (
            <div
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                testResult.ok
                  ? "bg-green-500/10 text-green-700 dark:text-green-400"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              {testResult.message}
            </div>
          )}
        </>
      )}
    </FormDialog>
  );
}

// ── Delete Confirmation ──────────────────────────────────────────

interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string | null;
  onSuccess: () => void;
}

function DeleteConnectionDialog({
  open,
  onOpenChange,
  connectionId,
  onSuccess,
}: DeleteDialogProps) {
  const deleteMutation = useAdminMutation({
    method: "DELETE",
    invalidates: onSuccess,
  });

  async function handleDelete() {
    if (!connectionId) return;
    await deleteMutation.mutate({
      path: `/api/v1/admin/connections/${encodeURIComponent(connectionId)}`,
      onSuccess: () => onOpenChange(false),
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Connection</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the connection{" "}
            <span className="font-mono font-semibold">{connectionId}</span>?
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteMutation.error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {deleteMutation.error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.saving}
          >
            {deleteMutation.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Pool Stats Section ────────────────────────────────────────────

function PoolBar({ active, idle, total }: { active: number; idle: number; total: number }) {
  if (total === 0) return <div className="h-2 w-full rounded-full bg-muted" />;
  const activePct = Math.round((active / total) * 100);
  const idlePct = Math.round((idle / total) * 100);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="bg-violet-500 transition-all" style={{ width: `${activePct}%` }} />
      <div className="bg-emerald-400 transition-all" style={{ width: `${idlePct}%` }} />
    </div>
  );
}

function PoolStatsSection({ onError }: { onError: (msg: string) => void }) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [metrics, setMetrics] = useState<PoolMetrics[] | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolFetchError, setPoolFetchError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [drainTarget, setDrainTarget] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const drainMutation = useAdminMutation<{ drained?: boolean; message?: string }>({
    method: "POST",
  });

  async function fetchMetrics() {
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/connections/pool`, { credentials });
      if (!res.ok) {
        // Pool stats are ancillary — don't block the page on a failure,
        // but never silently drop a non-2xx: log for operators and surface
        // a bounded InlineError inside the expanded shell so admins know
        // the numbers they see may be stale.
        const message = `HTTP ${res.status} ${res.statusText || ""}`.trim();
        console.warn("pool metrics fetch failed", {
          status: res.status,
          statusText: res.statusText,
        });
        if (!cancelledRef.current) setPoolFetchError(message);
        return;
      }
      const data = await res.json();
      if (!cancelledRef.current) {
        setMetrics(data.metrics ?? []);
        setPoolFetchError(null);
        setLastFetchedAt(new Date());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("pool metrics fetch failed", { error: message });
      if (!cancelledRef.current) setPoolFetchError(message);
    } finally {
      if (!cancelledRef.current) {
        setPoolLoading(false);
        setRefreshing(false);
      }
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await fetchMetrics();
  }

  useEffect(() => {
    cancelledRef.current = false;
    fetchMetrics();
    return () => { cancelledRef.current = true; };
    // Pool stats are a point-in-time snapshot by design — no interval here.
    // Admins refresh manually via the Refresh button (fix #5); avoids
    // background fetch churn on a page that's usually open for seconds.
  }, [apiUrl, credentials]);

  async function handleDrain(id: string) {
    const result = await drainMutation.mutate({
      path: `/api/v1/admin/connections/${encodeURIComponent(id)}/drain`,
      onSuccess: (data) => {
        if (!data?.drained) {
          onError(data?.message || "Drain failed");
        }
        fetchMetrics();
      },
    });
    if (!result.ok) {
      // Error already set in hook — surface it via onError
      onError("Drain request failed");
    }
    setDrainTarget(null);
  }

  // Pool stats are ancillary — hide the whole section when we've never
  // successfully fetched them. If a later refresh fails, we keep showing
  // the cached metrics and surface the error inline instead.
  if (poolLoading) return null;
  if ((!metrics || metrics.length === 0) && !poolFetchError) return null;

  return (
    <>
      <div className="rounded-xl border bg-card/40 px-3.5 py-2.5">
        <div className="flex w-full items-center gap-2 text-sm font-medium text-muted-foreground">
          <button
            type="button"
            className="flex flex-1 items-center gap-2 text-left hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <Activity className="size-4" />
            Pool stats
            {/* Snapshot wording — we deliberately don't pretend this is a
                live feed (fix #5). The Refresh button below triggers a
                re-fetch when admins want a fresh sample. */}
            <span className="ml-auto flex items-center gap-2 text-xs font-mono tabular-nums">
              {metrics && metrics.length > 0
                ? `${metrics.length} ${metrics.length === 1 ? "pool" : "pools"} · snapshot`
                : poolFetchError
                ? "unavailable"
                : "—"}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh pool stats"
            className="h-7 px-2"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "Collapse pool stats" : "Expand pool stats"}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        </div>
        {expanded && poolFetchError && (
          <div className="mt-3">
            <InlineError>Pool stats unavailable: {poolFetchError}</InlineError>
          </div>
        )}
        {expanded && lastFetchedAt && (
          <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
            Snapshot taken {formatDateTime(lastFetchedAt)}
          </p>
        )}
        {expanded && metrics && metrics.length > 0 && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {metrics.map((m) => (
              <Card key={m.connectionId} className="shadow-none">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    <span className="font-mono">{m.connectionId}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{m.dbType}</span>
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDrainTarget(m.connectionId)}
                    aria-label={`Drain pool ${m.connectionId}`}
                    className="h-7 px-2"
                  >
                    <Droplets className="size-3.5" />
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {m.pool && (
                      <div>
                        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                          <span>Active: {m.pool.activeCount} / Idle: {m.pool.idleCount}</span>
                          <span>Total: {m.pool.totalSize}</span>
                        </div>
                        <PoolBar active={m.pool.activeCount} idle={m.pool.idleCount} total={m.pool.totalSize} />
                        {m.pool.waitingCount > 0 && (
                          <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                            {m.pool.waitingCount} waiting
                          </p>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-lg font-semibold tabular-nums">{m.totalQueries}</p>
                        <p className="text-xs text-muted-foreground">Queries</p>
                      </div>
                      <div>
                        <p className={cn("text-lg font-semibold tabular-nums", m.totalErrors > 0 && "text-destructive")}>
                          {m.totalErrors}
                        </p>
                        <p className="text-xs text-muted-foreground">Errors</p>
                      </div>
                      <div>
                        <p className="text-lg font-semibold tabular-nums">{m.avgQueryTimeMs}ms</p>
                        <p className="text-xs text-muted-foreground">Avg time</p>
                      </div>
                    </div>
                    {m.consecutiveFailures > 0 && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">
                        {m.consecutiveFailures} consecutive failures
                      </p>
                    )}
                    {m.lastDrainAt && (
                      <p className="text-xs text-muted-foreground">
                        Last drain: {new Date(m.lastDrainAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!drainTarget} onOpenChange={(open) => !open && setDrainTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drain Connection Pool</AlertDialogTitle>
            <AlertDialogDescription>
              This will close all connections in the{" "}
              <span className="font-mono font-semibold">{drainTarget}</span> pool and recreate it.
              Active queries may fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={drainMutation.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => drainTarget && handleDrain(drainTarget)}
              disabled={drainMutation.saving}
            >
              {drainMutation.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Drain & Recreate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Shared Design Primitives ─────────────────────────────────────
// Local copies of admin/integrations primitives (PR #1538). Promote to
// @/ui/components/admin/ once a third page reuses them — tracked as #1551.

// `"unhealthy"` is a connections-page-specific addition on top of the
// admin/integrations primitive set — a configured connection that's currently
// down must not visually collapse into "disconnected" (which reads as "never
// set up"). It gets a destructive-tinted dot (no pulse — pulse is reserved for
// the positive "live" signal) so admins notice a real outage immediately.
type StatusKind = "connected" | "disconnected" | "unavailable" | "unhealthy";

function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" &&
          "bg-muted-foreground/20 outline-1 outline-dashed outline-muted-foreground/30",
        kind === "unhealthy" &&
          "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_15%,transparent)]",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  unavailable: "Unavailable",
  unhealthy: "Unhealthy",
};

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

function ConnectionShell({
  icon: Icon,
  title,
  titleBadge,
  description,
  status,
  statusLabel,
  children,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  titleBadge?: ReactNode;
  description: string;
  status: StatusKind;
  statusLabel?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      aria-label={`${typeof title === "string" ? title : "Connection"}: ${STATUS_LABEL[status]}`}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 backdrop-blur-[1px] transition-colors",
        "hover:border-border/80",
        status === "connected" && "border-primary/20",
        status === "unhealthy" && "border-destructive/30",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}
      {status === "unhealthy" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-destructive to-transparent opacity-70"
        />
      )}

      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status === "unhealthy" && "border-destructive/30 text-destructive",
            status !== "connected" &&
              status !== "unhealthy" &&
              "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {titleBadge}
            {status === "connected" && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                {statusLabel ?? "Live"}
              </span>
            )}
            {status === "unhealthy" && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-destructive">
                <StatusDot kind="unhealthy" />
                {statusLabel ?? "Unhealthy"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
      </header>

      {children != null && (
        <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>
      )}

      {actions && (
        <footer className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "unavailable" && "opacity-60",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </h3>
          <StatusDot kind={status} className="shrink-0" />
          <span className="sr-only">Status: {STATUS_LABEL[status]}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate",
          !mono && "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DetailList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-1.5 divide-y divide-border/50">
      {children}
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

// ── Provider mapping ─────────────────────────────────────────────

/** Map a dbType value to the icon used in the compact row and shell header. */
function iconForDbType(dbType: string): ComponentType<{ className?: string }> {
  switch (dbType) {
    case "postgres":
    case "mysql":
    case "duckdb":
      return Database;
    case "snowflake":
      return Snowflake;
    case "clickhouse":
    case "bigquery":
      return Cloud;
    case "salesforce":
      return HardDrive;
    default:
      return Database;
  }
}

/** Human-friendly one-line description shown under the provider name. */
function descriptionForDbType(dbType: string): string {
  switch (dbType) {
    case "postgres":
      return "Open-source OLTP — the default Atlas connection";
    case "mysql":
      return "MySQL / MariaDB OLTP instance";
    case "clickhouse":
      return "Column-store analytics warehouse";
    case "snowflake":
      return "Cloud data warehouse";
    case "duckdb":
      return "Embedded analytical SQL engine";
    case "salesforce":
      return "CRM objects via SOQL";
    case "bigquery":
      return "Google Cloud warehouse";
    default:
      return "Datasource connection";
  }
}

function labelForDbType(dbType: string): string {
  return DB_TYPES.find((t) => t.value === dbType)?.label ?? dbType;
}

/** Short human label for a connection's health.status. */
function healthLabel(status: ConnectionHealth["status"]): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "unhealthy":
      return "Unhealthy";
    default:
      return status;
  }
}

/**
 * Map a connection's reported health status to a visual StatusKind.
 *
 * Explicit switch (not a ternary) so a new enum value in `HealthStatus`
 * surfaces as a TypeScript error here instead of silently falling through
 * to "connected" with a Live badge. Missing / unknown health is treated as
 * "disconnected" (muted) rather than "connected" — we only claim Live when
 * the server has actually confirmed the pool is healthy or degraded.
 */
function healthToStatus(
  health: ConnectionHealth["status"] | undefined,
): StatusKind {
  switch (health) {
    case "healthy":
    case "degraded":
      return "connected";
    case "unhealthy":
      return "unhealthy";
    case undefined:
      return "disconnected";
    default: {
      // Exhaustiveness guard — if `HealthStatus` grows a new variant this
      // assignment fails to compile until the switch is updated.
      const _exhaustive: never = health;
      void _exhaustive;
      return "disconnected";
    }
  }
}

// ── Page ──────────────────────────────────────────────────────────

/** Tooltip text when connection mutations are blocked by published-mode demo readonly. */
const DEMO_READONLY_TOOLTIP = "Switch to developer mode to manage connections";

export default function ConnectionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const { readOnly: demoReadOnly } = useDemoReadonly();
  const showDevNoDrafts = useDevModeNoDrafts(["connections"]);

  const testMutation = useAdminMutation<ConnectionHealth>({ method: "POST" });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, "success" | "error">>({});
  const testTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDetail, setEditDetail] = useState<ConnectionDetail | null>(null);
  const [createDbType, setCreateDbType] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const { data: connections, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/connections",
    { schema: ConnectionsResponseSchema },
  );

  const [localConnections, setLocalConnections] = useState<ConnectionInfo[] | null>(null);
  const displayConnections = localConnections ?? connections ?? [];

  if (connections && localConnections !== null && connections !== localConnections) {
    setLocalConnections(null);
  }

  async function testConnection(id: string) {
    setMutationError(null);
    // Clear any previous timer for this connection
    if (testTimers.current[id]) clearTimeout(testTimers.current[id]);
    setTestStatus((prev) => { const next = { ...prev }; delete next[id]; return next; });

    const result = await testMutation.mutate({
      path: `/api/v1/admin/connections/${encodeURIComponent(id)}/test`,
      itemId: id,
      onSuccess: (data) => {
        setLocalConnections((prev) =>
          (prev ?? displayConnections).map((c) =>
            c.id === id ? { ...c, health: data } : c
          )
        );
      },
    });

    const status = result.ok ? "success" : "error";
    setTestStatus((prev) => ({ ...prev, [id]: status }));
    testTimers.current[id] = setTimeout(() => {
      setTestStatus((prev) => { const next = { ...prev }; delete next[id]; return next; });
    }, 3000);

    if (!result.ok) {
      setMutationError(`Connection test failed for "${id}"`);
    }
  }

  function handleAdd(dbType?: string) {
    setEditId(null);
    setEditDetail(null);
    // Callers that don't pass a dbType (e.g. the hero CTA) get the dialog's
    // built-in Postgres default; the provider CompactRow passes its own
    // dbType so the admin isn't re-routed into Postgres URL validation.
    setCreateDbType(dbType);
    setFormOpen(true);
  }

  async function handleEdit(id: string) {
    setMutationError(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(id)}`,
        { credentials }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const detail: ConnectionDetail = await res.json();
      setEditId(id);
      setEditDetail(detail);
      setFormOpen(true);
    } catch (err) {
      setMutationError(
        `Failed to load connection details: ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      setLoadingDetail(false);
    }
  }

  function handleDelete(id: string) {
    setDeleteId(id);
    setDeleteOpen(true);
  }

  function handleMutationSuccess() {
    refetch();
  }

  // Group connections by dbType so each provider gets a row and each existing
  // connection gets its own IntegrationShell under that provider. Then append
  // any plugin-registered dbTypes that don't appear in DB_TYPES so they still
  // surface in the UI.
  const byType = new Map<string, ConnectionInfo[]>();
  for (const c of displayConnections) {
    const list = byType.get(c.dbType) ?? [];
    list.push(c);
    byType.set(c.dbType, list);
  }
  const providerOrder: string[] = [
    ...DB_TYPES.map((t) => t.value),
    ...Array.from(byType.keys()).filter((k) => !DB_TYPES.some((t) => t.value === k)),
  ];

  const stats = {
    live: displayConnections.filter((c) => c.health?.status === "healthy").length,
    total: displayConnections.length,
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">Connections</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(stats.live > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(stats.live).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(stats.total).padStart(2, "0")} live
          </p>
        </div>
        <div className="flex items-end justify-between gap-6">
          <p className="max-w-xl text-sm text-muted-foreground">
            Datasources Atlas can query. Each provider below is either connected or
            ready to connect.
          </p>
          {demoReadOnly ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button onClick={() => handleAdd()} size="sm" disabled>
                      <Plus className="mr-2 size-4" />
                      Add connection
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button onClick={() => handleAdd()} size="sm">
              <Plus className="mr-2 size-4" />
              Add connection
            </Button>
          )}
        </div>
      </header>

      <ErrorBoundary>
        <div className="space-y-6">
          {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}
          {testMutation.error && !mutationError && <ErrorBanner message={testMutation.error} onRetry={testMutation.clearError} />}

          <PoolStatsSection onError={setMutationError} />

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Connections"
            onRetry={refetch}
            loadingMessage="Loading connections..."
            emptyIcon={Cable}
            emptyTitle="No datasource connections"
            emptyDescription="Add a connection to start querying your data"
            emptyAction={{ label: "Add connection", onClick: () => handleAdd() }}
            // Show the generic "No datasource connections" empty state for a
            // plain admin who has zero connections — the CompactRow provider
            // menu is useful, but a new admin deserves the focused onboarding
            // CTA, not a list of 6 "Connect" buttons. In dev-mode-no-drafts we
            // short-circuit below to DeveloperEmptyState / PublishedContextWrapper
            // so the CTA language matches "start building" / "create draft"
            // rather than "add a connection".
            isEmpty={!loading && displayConnections.length === 0 && !showDevNoDrafts}
          >
            {showDevNoDrafts && displayConnections.length === 0 ? (
              <DeveloperEmptyState
                icon={Cable}
                title="Connect your first database to start building."
                description="Add a connection in developer mode, then publish it when you're ready."
                action={{ kind: "button", label: "Add connection", onClick: () => handleAdd() }}
              />
            ) : showDevNoDrafts ? (
              <PublishedContextWrapper
                resourceLabel={{ singular: "connection", plural: "connections" }}
                action={{ kind: "button", label: "Create draft", onClick: () => handleAdd() }}
              >
                <section>
                  <SectionHeading title="Datasources" description="Providers Atlas can read from" />
                  <div className="space-y-2">
                    {providerOrder.map((dbType) => {
                      const conns = byType.get(dbType) ?? [];
                      return (
                        <ProviderBlock
                          key={dbType}
                          dbType={dbType}
                          connections={conns}
                          demoReadOnly={demoReadOnly}
                          loadingDetail={loadingDetail}
                          testMutation={testMutation}
                          testStatus={testStatus}
                          onTest={testConnection}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onAdd={handleAdd}
                        />
                      );
                    })}
                  </div>
                </section>
              </PublishedContextWrapper>
            ) : (
              <section>
                <SectionHeading title="Datasources" description="Providers Atlas can read from" />
                <div className="space-y-2">
                  {providerOrder.map((dbType) => {
                    const conns = byType.get(dbType) ?? [];
                    return (
                      <ProviderBlock
                        key={dbType}
                        dbType={dbType}
                        connections={conns}
                        demoReadOnly={demoReadOnly}
                        loadingDetail={loadingDetail}
                        testMutation={testMutation}
                        testStatus={testStatus}
                        onTest={testConnection}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onAdd={handleAdd}
                      />
                    );
                  })}
                </div>
              </section>
            )}
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editId={editId}
        editDetail={editDetail}
        initialDbType={createDbType}
        onSuccess={handleMutationSuccess}
      />

      <DeleteConnectionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        connectionId={deleteId}
        onSuccess={handleMutationSuccess}
      />
    </div>
  );
}

// ── Provider Block ───────────────────────────────────────────────

/**
 * Renders one provider (dbType). When connections of this type exist, each
 * becomes a full IntegrationShell with a DetailList and action footer. When
 * there are none, a CompactRow prompts the admin to connect one.
 */
function ProviderBlock({
  dbType,
  connections,
  demoReadOnly,
  loadingDetail,
  testMutation,
  testStatus,
  onTest,
  onEdit,
  onDelete,
  onAdd,
}: {
  dbType: string;
  connections: ConnectionInfo[];
  demoReadOnly: boolean;
  loadingDetail: boolean;
  testMutation: ReturnType<typeof useAdminMutation<ConnectionHealth>>;
  testStatus: Record<string, "success" | "error">;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Receives the provider's `dbType` so the create dialog can preselect it. */
  onAdd: (dbType: string) => void;
}) {
  const Icon = iconForDbType(dbType);
  const label = labelForDbType(dbType);
  const description = descriptionForDbType(dbType);

  if (connections.length === 0) {
    return (
      <CompactRow
        icon={Icon}
        title={label}
        description={description}
        status="disconnected"
        action={
          demoReadOnly ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" variant="outline" disabled>
                      <Plus className="mr-1.5 size-3.5" />
                      Connect
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onAdd(dbType)}>
              <Plus className="mr-1.5 size-3.5" />
              Connect
            </Button>
          )
        }
      />
    );
  }

  return (
    <>
      {connections.map((conn) => (
        <ConnectionCard
          key={conn.id}
          conn={conn}
          icon={Icon}
          providerLabel={label}
          providerDescription={description}
          demoReadOnly={demoReadOnly}
          loadingDetail={loadingDetail}
          testMutation={testMutation}
          testStatus={testStatus}
          onTest={onTest}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// ── Connection Card (one existing connection) ───────────────────

function ConnectionCard({
  conn,
  icon,
  providerLabel,
  providerDescription,
  demoReadOnly,
  loadingDetail,
  testMutation,
  testStatus,
  onTest,
  onEdit,
  onDelete,
}: {
  conn: ConnectionInfo;
  icon: ComponentType<{ className?: string }>;
  providerLabel: string;
  providerDescription: string;
  demoReadOnly: boolean;
  loadingDetail: boolean;
  testMutation: ReturnType<typeof useAdminMutation<ConnectionHealth>>;
  testStatus: Record<string, "success" | "error">;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const health = conn.health?.status;
  const status = healthToStatus(health);
  // The pill label tracks the precise health state rather than the visual
  // StatusKind: "degraded" still renders the teal/connected shell but the
  // pill should say "Degraded" so admins don't miss the warning.
  const pillLabel =
    health === "degraded"
      ? "Degraded"
      : health === "unhealthy"
      ? "Unhealthy"
      : "Live";
  const isDemo = conn.id === DEMO_CONNECTION_ID;
  const rowReadOnly = demoReadOnly && isDemo;
  const isDraft = conn.status === "draft";
  const isDefault = conn.id === "default";
  const testing = testMutation.isMutating(conn.id);
  const testBadge = testStatus[conn.id];

  // Build a titleBadge strip that keeps the demo / draft affordances intact.
  const badges =
    isDemo || isDraft ? (
      <span className="flex shrink-0 items-center gap-1">
        {isDemo && <DemoBadge />}
        {isDraft && <DraftBadge />}
      </span>
    ) : null;

  const testButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={testing}
      onClick={() => onTest(conn.id)}
      aria-label={testing ? `Testing connection ${conn.id}…` : undefined}
      className={cn(
        testBadge === "success" && "border-green-500 text-green-600 dark:text-green-400",
        testBadge === "error" && "border-destructive text-destructive",
      )}
    >
      {testing ? (
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
      ) : testBadge === "success" ? (
        <Check className="mr-1.5 size-3.5" />
      ) : testBadge === "error" ? (
        <X className="mr-1.5 size-3.5" />
      ) : null}
      {testing
        ? "Testing…"
        : testBadge === "success"
        ? "OK"
        : testBadge === "error"
        ? "Failed"
        : "Test"}
    </Button>
  );

  const editButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onEdit(conn.id)}
      disabled={loadingDetail || rowReadOnly}
      aria-label={`Edit connection ${conn.id}`}
    >
      <Pencil className="mr-1.5 size-3.5" />
      Edit
    </Button>
  );

  const deleteButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onDelete(conn.id)}
      disabled={rowReadOnly}
      aria-label={`Delete connection ${conn.id}`}
      className="text-destructive hover:text-destructive"
    >
      <Trash2 className="mr-1.5 size-3.5" />
      Delete
    </Button>
  );

  const manageButtons = isDefault ? null : rowReadOnly ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{editButton}</span>
        </TooltipTrigger>
        <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{deleteButton}</span>
        </TooltipTrigger>
        <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    <>
      {editButton}
      {deleteButton}
    </>
  );

  return (
    <ConnectionShell
      icon={icon}
      title={<span className="font-mono">{conn.id}</span>}
      titleBadge={badges}
      description={conn.description || providerDescription}
      status={status}
      statusLabel={pillLabel}
      actions={
        <>
          {testButton}
          {manageButtons}
        </>
      }
    >
      {/* Surface the backend-provided failure reason for unhealthy connections
          before anything else in the body — otherwise ConnectionHealth.message
          silently disappears and the admin has to click "Test" to rediscover
          why the pool is down. */}
      {status === "unhealthy" && conn.health?.message ? (
        <InlineError>{conn.health.message}</InlineError>
      ) : null}

      <DetailList>
        <DetailRow label="Provider" value={providerLabel} />
        {conn.description ? (
          <DetailRow label="Description" value={conn.description} truncate />
        ) : null}
        {conn.health?.latencyMs != null ? (
          <DetailRow
            label="Latency"
            value={<span className="tabular-nums">{conn.health.latencyMs}ms</span>}
            mono
          />
        ) : null}
        {conn.health?.status ? (
          <DetailRow
            label="Health"
            value={
              <span
                className={cn(
                  conn.health.status === "healthy" && "text-primary",
                  conn.health.status === "degraded" &&
                    "text-amber-600 dark:text-amber-400",
                  conn.health.status === "unhealthy" && "text-destructive",
                )}
              >
                {healthLabel(conn.health.status)}
              </span>
            }
          />
        ) : (
          // Don't leave admins guessing when the health probe hasn't reported
          // yet — explicitly say the status is unknown rather than omitting
          // the row and letting them assume everything's fine.
          <DetailRow
            label="Health"
            value={<span className="text-muted-foreground">Status unknown</span>}
          />
        )}
        {conn.health?.checkedAt ? (
          <DetailRow label="Last tested" value={formatDateTime(conn.health.checkedAt)} />
        ) : null}
      </DetailList>
    </ConnectionShell>
  );
}
