"use client";

import type { ColumnDef } from "@tanstack/react-table";
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
import { DataTable } from "@/components/data-table/data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDemoReadonly } from "@/ui/hooks/use-demo-readonly";
import { useMode } from "@/ui/hooks/use-mode";
import { useModeStatus } from "@/ui/hooks/use-mode-status";
import { DeveloperEmptyState } from "@/ui/components/admin/developer-empty-state";
import { PublishedContextWrapper } from "@/ui/components/admin/published-context-wrapper";
import { DEMO_CONNECTION_ID, getConnectionColumns } from "./columns";
import { useDataTable } from "@/hooks/use-data-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cable, Loader2, Plus, Pencil, Trash2, Eye, EyeOff, Activity, ChevronDown, ChevronUp, Droplets, Check, X } from "lucide-react";
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
import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
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
  onSuccess: () => void;
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editId,
  editDetail,
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

  const defaultValues = isEdit && editDetail
    ? { id: editId!, dbType: editDetail.dbType, url: "", schema: editDetail.schema ?? "", description: editDetail.description ?? "" }
    : { id: "", dbType: "postgres", url: "", schema: "", description: "" };

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
  const [expanded, setExpanded] = useState(true);
  const [drainTarget, setDrainTarget] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const drainMutation = useAdminMutation<{ drained?: boolean; message?: string }>({
    method: "POST",
  });

  async function fetchMetrics() {
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/connections/pool`, { credentials });
      if (!res.ok) return;
      const data = await res.json();
      if (!cancelledRef.current) setMetrics(data.metrics ?? []);
    } catch (err) {
      console.warn("Pool stats fetch failed:", err instanceof Error ? err.message : String(err));
    } finally {
      if (!cancelledRef.current) setPoolLoading(false);
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    fetchMetrics();
    return () => { cancelledRef.current = true; };
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

  if (poolLoading || !metrics || metrics.length === 0) return null;

  return (
    <>
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <Activity className="size-4" />
          Pool Stats
          {expanded ? <ChevronUp className="ml-auto size-4" /> : <ChevronDown className="ml-auto size-4" />}
        </button>
        {expanded && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

// ── Page ──────────────────────────────────────────────────────────

/** Tooltip text when connection mutations are blocked by published-mode demo readonly. */
const DEMO_READONLY_TOOLTIP = "Switch to developer mode to manage connections";

export default function ConnectionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const { readOnly: demoReadOnly } = useDemoReadonly();
  const { mode } = useMode();
  const { data: modeStatus } = useModeStatus();
  const inDevMode = mode === "developer";
  // Dev-mode empty signal: admin is in developer mode but has not drafted a
  // connection yet. The empty + published-context UIs only render when this
  // is true — in published mode the page keeps its existing behavior. Gate
  // on `modeStatus !== null` so admins with drafts don't see the empty
  // state flash while `/api/v1/mode` is in flight.
  const showDevNoDrafts =
    inDevMode && modeStatus !== null
      ? (modeStatus.draftCounts?.connections ?? 0) === 0
      : false;

  const testMutation = useAdminMutation<ConnectionHealth>({ method: "POST" });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, "success" | "error">>({});
  const testTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDetail, setEditDetail] = useState<ConnectionDetail | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const { data: connections, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/connections",
    { schema: ConnectionsResponseSchema },
  );

  const [localConnections, setLocalConnections] = useState<ConnectionInfo[] | null>(null);
  const displayConnections = localConnections ?? connections ?? [];

  // Data table columns (actions column uses component callbacks)
  const columns: ColumnDef<ConnectionInfo>[] = (() => {
    const base = getConnectionColumns();
    const actionsCol: ColumnDef<ConnectionInfo> = {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const conn = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={testMutation.isMutating(conn.id)}
              onClick={() => testConnection(conn.id)}
              aria-label={testMutation.isMutating(conn.id) ? `Testing connection ${conn.id}…` : undefined}
              className={cn(
                testStatus[conn.id] === "success" && "border-green-500 text-green-600 dark:text-green-400",
                testStatus[conn.id] === "error" && "border-destructive text-destructive",
              )}
            >
              {testMutation.isMutating(conn.id) ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : testStatus[conn.id] === "success" ? (
                <><Check className="mr-1 size-3.5" /> OK</>
              ) : testStatus[conn.id] === "error" ? (
                <><X className="mr-1 size-3.5" /> Fail</>
              ) : (
                "Test"
              )}
            </Button>
            {conn.id !== "default" && (() => {
              // Demo connections are read-only in published mode — the only
              // way to edit/delete them is to drop into developer mode. Show
              // a tooltip explaining why the action is disabled.
              const rowReadOnly = demoReadOnly && conn.id === DEMO_CONNECTION_ID;
              const editBtn = (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEdit(conn.id)}
                  disabled={loadingDetail || rowReadOnly}
                  aria-label={`Edit connection ${conn.id}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              );
              const deleteBtn = (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(conn.id)}
                  disabled={rowReadOnly}
                  aria-label={`Delete connection ${conn.id}`}
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              );
              return rowReadOnly ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>{editBtn}</span>
                    </TooltipTrigger>
                    <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>{deleteBtn}</span>
                    </TooltipTrigger>
                    <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <>
                  {editBtn}
                  {deleteBtn}
                </>
              );
            })()}
          </div>
        );
      },
      enableSorting: false,
      enableHiding: false,
      size: 180,
    };
    return [...base, actionsCol];
  })();

  const { table: connTable } = useDataTable({
    data: displayConnections,
    columns,
    pageCount: 1,
    initialState: { pagination: { pageIndex: 0, pageSize: 100 } },
    getRowId: (row) => row.id,
  });

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

  function handleAdd() {
    setEditId(null);
    setEditDetail(null);
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

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">Manage datasource connections</p>
        </div>
        {demoReadOnly ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button onClick={handleAdd} size="sm" disabled>
                    <Plus className="mr-2 size-4" />
                    Add Connection
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button onClick={handleAdd} size="sm">
            <Plus className="mr-2 size-4" />
            Add Connection
          </Button>
        )}
      </div>

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
          emptyAction={{ label: "Add connection", onClick: handleAdd }}
          // In dev-mode-no-drafts we short-circuit to DeveloperEmptyState
          // instead of the generic empty state so the CTA language matches
          // "start building" rather than "add a connection".
          isEmpty={displayConnections.length === 0 && !showDevNoDrafts}
        >
          {showDevNoDrafts && displayConnections.length === 0 ? (
            <DeveloperEmptyState
              icon={Cable}
              title="Connect your first database to start building."
              description="Add a connection in developer mode, then publish it when you're ready."
              action={{ label: "Add connection", onClick: handleAdd }}
            />
          ) : showDevNoDrafts ? (
            <PublishedContextWrapper
              resourceLabel="connection"
              action={{ label: "Create draft", onClick: handleAdd }}
            >
              <DataTable table={connTable}>
                <DataTableToolbar table={connTable} />
              </DataTable>
            </PublishedContextWrapper>
          ) : (
            <DataTable table={connTable}>
              <DataTableToolbar table={connTable} />
            </DataTable>
          )}
        </AdminContentWrapper>
      </div>
      </ErrorBoundary>

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editId={editId}
        editDetail={editDetail}
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
