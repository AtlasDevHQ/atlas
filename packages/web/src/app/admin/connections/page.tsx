"use client";

import { toast } from "sonner";
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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDemoReadonly } from "@/ui/hooks/use-demo-readonly";
import { DemoBadge, DraftBadge } from "@/ui/components/admin/mode-badges";
import { DEMO_CONNECTION_ID } from "./columns";
import {
  ENV_SENTINEL_NONE,
  ENV_SENTINEL_CREATE,
  shouldPromptGenerate,
  newGroupLabel,
} from "./generate-prompt";
import { wizardGenerateHref } from "../../wizard/wizard-generate-entry";
import { stripGroupPrefix, isAutoBackfilledSingleton, isEmptyBackfillOrphan } from "@/ui/lib/strip-group-prefix";
import { Badge } from "@/components/ui/badge";
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
  RefreshCw,
} from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { formatDialogError } from "./format-dialog-error";
import type { FetchError } from "@/ui/lib/fetch-error";
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
} from "react";
import {
  DetailList,
  DetailRow,
  InlineError,
  type StatusKind,
} from "@/ui/components/admin/compact";
import { CollapsibleRow } from "@/ui/components/admin/collapsible-row";
import {
  type ConnectionFormValues,
  connectionCreateSchema,
  connectionEditSchema,
  TestConnectionButton,
  NewEnvNameField,
  PostgresSchemaField,
} from "./connection-form-fields";
import {
  AddConnectionPicker,
  type DatasourceFormCandidate,
} from "./add-connection-picker";
import {
  CuratedInstallDialog,
  type CuratedCandidate,
} from "./curated-install-dialog";
import { FormInstallModal } from "../integrations/form-install-modal";
import { RestInstallDialog } from "./openapi-block";
import { DATABASE_PROVIDERS, iconForDbType, labelForDbType } from "./provider-meta";
import {
  AddDatasourceButton,
  countLine,
  SectionEmpty,
  SectionHeader,
} from "./section-header";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import {
  DB_TYPES,
  isBillable,
  type ConnectionHealth,
  type ConnectionInfo,
  type ConnectionDetail,
  type PoolMetrics,
} from "@/ui/lib/types";
import { ConnectionsResponseSchema } from "@/ui/lib/admin-schemas";
import { SalesforceProviderBlock } from "./salesforce-block";
import { OpenApiProviderBlock } from "./openapi-block";
import { useRouter, useSearchParams } from "next/navigation";

// ── Connection Form Dialog ───────────────────────────────────────

// `connectionCreateSchema` / `connectionEditSchema` and the derived
// `ConnectionFormValues` type live in ./connection-form-fields alongside the
// field components that consume them — the schema is the single source of
// truth for the form's value shape.

/** Wire shape for `/api/v1/admin/connection-groups` — subset of the
 * `ConnectionGroup` shape the dialog uses. Post-0096 cutover (#2744)
 * this is derived inline from the connections list rather than fetched
 * from the deleted `/admin/connection-groups` route; the shape stays
 * to keep the dialog prop contract unchanged. */
type EnvGroup = {
  id: string;
  name: string;
  status: "active" | "archived";
  memberCount: number;
  primaryConnectionId: string | null;
};

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
  /** Live list of envs (connection groups). Passed in so the dialog
   * doesn't re-fetch on every open — the parent fetch hits TanStack's
   * cache and the dialog's combobox renders pre-selected on first open. */
  envGroups: ReadonlyArray<EnvGroup>;
  onSuccess: () => void;
  /**
   * Called after a successful **create** that formed a *new* Connection group
   * (#3237 door 1). The parent surfaces an inline "Generate semantic layer?"
   * prompt. Not called on edit, or when the connection joined an existing
   * populated group.
   */
  onCreatedNewGroup?: (info: { connectionId: string; groupLabel: string }) => void;
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editId,
  editDetail,
  initialDbType,
  envGroups,
  onSuccess,
  onCreatedNewGroup,
}: ConnectionFormProps) {
  const isEdit = !!editId;
  const [showUrl, setShowUrl] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Captures the most recent failed-submit error as an authoritative
  // fallback to `saveMutation.error`. If the user closes mid-flight and
  // re-opens the dialog before the request settles, `handleOpenChange`
  // calls `saveMutation.reset()` (bumping the hook's generation) and the
  // late catch in `use-admin-mutation.ts` skips its `setError` write —
  // which would otherwise leave the dialog open with no banner. Reading
  // the discriminant from the `mutate()` return value is independent of
  // that generation gate, so the banner still renders.
  const [submitError, setSubmitError] = useState<FetchError | null>(null);

  const testMutation = useAdminMutation<{ status: string; latencyMs?: number; message?: string }>({
    path: "/api/v1/admin/connections/test",
    method: "POST",
  });

  const saveMutation = useAdminMutation({
    invalidates: onSuccess,
  });

  // Pin both branches to one value type so the form (and the extracted
  // watch-driven field components) carry a single `ConnectionFormValues`
  // rather than a `Create | Edit` union. `ConnectionFormValues` is
  // `z.infer<typeof connectionCreateSchema>`, so the create schema is the
  // source of truth; this annotation additionally fails the build if
  // `connectionEditSchema` drops a field the create schema declares.
  const schema: z.ZodType<ConnectionFormValues, ConnectionFormValues> = isEdit
    ? connectionEditSchema
    : connectionCreateSchema;

  // Env dropdown only surfaces user-named envs. Auto-`g_<id>` singletons
  // are hidden so the dropdown doesn't leak migration-0062's
  // implementation detail to single-DB admins. Same predicate the
  // Environments tab uses to collapse the auto-detected noise. Empty
  // backfill orphans (#2506) are also hidden — a ghost `g_<connId>`
  // group with zero members and a name matching a real connection id
  // is the exact confusion this dialog must not surface; migration
  // 0072 sweeps existing rows, this guards new surfaces.
  const selectableEnvs = envGroups.filter(
    (g) =>
      g.status !== "archived" &&
      !isAutoBackfilledSingleton(g) &&
      !isEmptyBackfillOrphan(g),
  );

  // Default env selection:
  //   - Edit + connection is currently in a selectable env → pre-select it.
  //   - Edit + connection is in an auto-singleton or null → `__none__`.
  //   - Create + workspace has exactly one selectable env → pre-select it.
  //   - Create + zero or many selectable envs → `__none__`.
  function resolveDefaultEnvSelection(): string {
    if (isEdit && editDetail) {
      const current = editDetail.groupId;
      if (current && selectableEnvs.some((g) => g.id === current)) return current;
      return ENV_SENTINEL_NONE;
    }
    if (selectableEnvs.length === 1) return selectableEnvs[0].id;
    return ENV_SENTINEL_NONE;
  }

  const defaultValues = isEdit && editDetail
    ? { id: editId!, dbType: editDetail.dbType, url: "", schema: editDetail.schema ?? "", description: editDetail.description ?? "", envSelection: resolveDefaultEnvSelection(), newGroupName: "" }
    : { id: "", dbType: initialDbType ?? "postgres", url: "", schema: "", description: "", envSelection: resolveDefaultEnvSelection(), newGroupName: "" };

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setShowUrl(false);
      setTestResult(null);
      testMutation.reset();
      saveMutation.reset();
      setSubmitError(null);
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

    // __none__ asymmetry: no-op on Create (server picks auto-singleton),
    // explicit null on Edit (server reattaches to g_<id>).
    if (values.envSelection === ENV_SENTINEL_CREATE) {
      body.newGroupName = values.newGroupName.trim();
    } else if (values.envSelection === ENV_SENTINEL_NONE) {
      if (isEdit) body.connectionGroupId = null;
    } else if (values.envSelection) {
      body.connectionGroupId = values.envSelection;
    }

    // Gate close-on-success on `result.ok` so a non-2xx leaves the
    // dialog open with the error inline (#2485). Capture `result.error`
    // into local state so the banner survives the close-then-reopen
    // race in use-admin-mutation.
    setSubmitError(null);
    const result = await saveMutation.mutate({ path, method, body });
    if (result.ok) {
      // A create that forms a new group is the one moment to offer generation
      // (#3237). Fire before closing so the parent's prompt opens as the form
      // dismisses; member-adds and edits stay silent (`shouldPromptGenerate`),
      // with /admin/semantic's empty state as the always-available way back in.
      if (onCreatedNewGroup && shouldPromptGenerate(isEdit, values.envSelection)) {
        onCreatedNewGroup({
          connectionId: values.id,
          groupLabel: newGroupLabel(values.envSelection, values.newGroupName, values.id),
        });
      }
      onOpenChange(false);
    } else {
      setSubmitError(result.error);
    }
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
      serverError={
        // Prefer the hook-level slot (covers concurrent retries cleanly)
        // and fall back to the locally-captured discriminant for the
        // close-then-reopen race documented on `submitError`.
        saveMutation.error
          ? formatDialogError(saveMutation.error)
          : submitError
            ? formatDialogError(submitError)
            : null
      }
      className="sm:max-w-md"
      extraFooter={(form) => (
        <TestConnectionButton
          form={form}
          saving={testMutation.saving}
          onTest={handleTest}
        />
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
            name="envSelection"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Environment</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full" data-testid="env-select-trigger">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {selectableEnvs.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {stripGroupPrefix(g.name)}
                      </SelectItem>
                    ))}
                    <SelectItem value={ENV_SENTINEL_CREATE} data-testid="env-select-create">
                      + Create new environment…
                    </SelectItem>
                    <SelectItem value={ENV_SENTINEL_NONE} data-testid="env-select-none">
                      (none — ungrouped)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormDesc>
                  Bundle connections that share a schema (e.g. prod replicas) so semantic
                  entities and dashboards apply everywhere.
                </FormDesc>
                <FormMessage />
              </FormItem>
            )}
          />

          <NewEnvNameField form={form} />

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
                    {/* Add mode offers only the types the URL form can
                        actually install (pg + mysql — the API rejects every
                        other scheme, #3377). Edit mode keeps the full list so
                        a legacy connection of an excluded type still displays
                        its label in the (disabled) trigger. */}
                    {(isEdit ? DB_TYPES.filter((t) => t.value !== "salesforce") : DATABASE_PROVIDERS).map(
                      (t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ),
                    )}
                    {/*
                      Salesforce intentionally not listed: it's not a URL-form
                      connection — installs happen via the OAuth dance on the
                      Salesforce row above (#2745). Picking it here would
                      create a `connections` row that immediately disappears
                      from the page (the Salesforce slot renders the OAuth
                      block instead) and that's never queryable because the
                      Salesforce adapter reads its install from
                      `workspace_plugins`, not `connections`.
                    */}
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

          <PostgresSchemaField form={form} />

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
    const result = await deleteMutation.mutate({
      path: `/api/v1/admin/connections/${encodeURIComponent(connectionId)}`,
      onSuccess: () => onOpenChange(false),
    });
    if (result.ok) {
      toast.success(`Deleted connection “${connectionId}”`);
    } else {
      const message = result.error instanceof Error ? result.error.message : "Delete failed";
      toast.error(`Couldn't delete “${connectionId}”`, { description: message });
    }
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
        <MutationErrorSurface
          error={deleteMutation.error}
          feature="Connections"
          variant="inline"
        />
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

// ── Provider mapping ─────────────────────────────────────────────
// Icon / label / description helpers live in ./provider-meta so the page
// (rendering connected DBs) and the Add picker (offering providers) share one
// source of truth.

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

/**
 * Tooltip text when editing a demo row is blocked in published mode.
 *
 * The backend's PUT handler returns 403 `demo_readonly` when atlas mode is
 * published and id is `__demo__` — the UI gate mirrors that so the form
 * doesn't lead the admin into a 403. Delete is treated differently because
 * the DELETE handler implements demo-hide as a per-org `archived` row that
 * shadows the canonical demo from this workspace; no shared mutation, so the
 * mode gate doesn't apply.
 */
const DEMO_EDIT_READONLY_TOOLTIP = "Switch to developer mode to edit the demo connection";

/**
 * Tooltip text when add/connect CTAs are blocked while a demo is active in
 * published mode. The fastest path out is to Delete the demo row (per-org
 * hide) — that flips `demoReadOnly` to false and re-enables Add immediately.
 */
const DEMO_ADD_READONLY_TOOLTIP = "Delete the demo connection or switch to developer mode to add a new one";

export default function ConnectionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const { readOnly: demoReadOnly } = useDemoReadonly();

  // Post-0096 cutover (#2744): the `?groupBy=environment` toggle and the
  // environments view it routed to are gone — there's no segmented control
  // or URL-driven view state here anymore. Group membership is surfaced
  // per-connection in the edit dialog (`newGroupName` on POST/PUT), and the
  // page renders one flat list split into type-grouped provider sections.

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
  // Inline "Generate semantic layer?" prompt shown after a create that forms a
  // new Connection group (#3237 door 1). Holds the connection to scope the
  // generate flow to; `null` when no prompt is pending.
  const [genPrompt, setGenPrompt] = useState<{ connectionId: string; groupLabel: string } | null>(null);

  // Add-connection picker + the REST install dialogs it routes to. The
  // picker replaces the old always-listed "Connect" provider rows.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customRestOpen, setCustomRestOpen] = useState(false);
  const [curatedCandidate, setCuratedCandidate] = useState<CuratedCandidate | null>(null);
  // Catalog datasource picked from the Add picker's form-install tiles
  // (ClickHouse, Snowflake, BigQuery, …) — opens the schema-driven
  // marketplace FormInstallModal (#3377).
  const [formInstallCandidate, setFormInstallCandidate] =
    useState<DatasourceFormCandidate | null>(null);
  // Bumped after a REST/curated install so the plugin-owned blocks
  // (OpenAPI, Salesforce) remount and refetch their own lists — their data
  // lives behind separate query keys from the `connections` fetch below.
  const [datasourceRefreshKey, setDatasourceRefreshKey] = useState(0);
  const refreshDatasources = () => setDatasourceRefreshKey((k) => k + 1);

  const { data: connections, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/connections",
    { schema: ConnectionsResponseSchema },
  );

  // ── OAuth callback toast handling for Salesforce (#2745) ────────────
  //
  // The Salesforce OAuth callback at `/api/v1/integrations/salesforce/callback`
  // redirects browsers here with `?installed=salesforce`, `?reconnect=salesforce`,
  // or `?error=salesforce&reason=<code>` (see `adminDestinationForPlatform`
  // in `packages/api/src/api/routes/integrations.ts`). Mirror the toast +
  // URL-cleanup pattern from `/admin/integrations` so the user sees a
  // success / reconnect / error toast and a refresh doesn't replay it.
  // Other platforms still land on `/admin/integrations`, so this handler
  // is intentionally scoped to the `salesforce` slug only.
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const installed = searchParams.get("installed");
    const reconnect = searchParams.get("reconnect");
    const errParam = searchParams.get("error");
    const reason = searchParams.get("reason");
    if (!installed && !reconnect && !errParam) return;

    if (installed === "salesforce") {
      toast.success("Salesforce connected");
      refetch();
    }
    if (reconnect === "salesforce") {
      toast.warning("Salesforce install completed but credentials didn't persist", {
        description: "Click Reconnect on the Salesforce row to retry the OAuth dance.",
      });
      refetch();
    }
    if (errParam === "salesforce") {
      const description =
        reason === "plan_upgrade_required"
          ? "Your workspace plan doesn't include Salesforce. Upgrade and try again."
          : reason === "invalid_state"
            ? "The install link expired. Click Connect on the Salesforce row to start again."
            : reason === "upstream_error"
              ? "Salesforce refused the OAuth code. Click Connect to retry — if the problem persists, check the connected-app credentials."
              : "Click Connect on the Salesforce row to retry.";
      toast.error("Couldn't connect Salesforce", { description });
    }

    // Strip the four callback keys; preserve any other params for future use.
    const next = new URLSearchParams(searchParams);
    for (const key of ["installed", "reconnect", "error", "reason"]) next.delete(key);
    const url = next.size > 0 ? `/admin/connections?${next.toString()}` : "/admin/connections";
    router.replace(url, { scroll: false });
  }, [searchParams, refetch, router]);

  // Post-0096 cutover (#2744 / ADR-0007): `/api/v1/admin/connection-groups`
  // is gone (collapsed into JSONB strings on each install). Derive the
  // env dropdown choices inline from the same connections list the page
  // already fetched — one entry per distinct non-null group_id.

  const [localConnections, setLocalConnections] = useState<ConnectionInfo[] | null>(null);
  // `useAdminFetch` is typed as `ConnectionInfo[]` but defense-in-depth
  // matters here: the TanStack Query cache is keyed by path, not by schema,
  // so any future admin page that fetches `/api/v1/admin/connections`
  // through a non-array-transforming schema would poison this page's cache
  // entry (see #2444 — `/admin/audit` parsed an object envelope and the
  // connections page crashed with "O is not iterable" when audit was
  // visited first). The known cross-schema caller was retired in that PR;
  // this guard keeps the page renderable if the class of bug recurs.
  const displayConnections: ConnectionInfo[] = Array.isArray(localConnections)
    ? localConnections
    : Array.isArray(connections)
      ? connections
      : [];
  if (connections != null && !Array.isArray(connections)) {
    console.warn(
      "[admin/connections] useAdminFetch returned non-array data — falling back to []. Another admin page is likely fetching /api/v1/admin/connections with a non-canonical schema (see #2444).",
      { typeof: typeof connections },
    );
  }

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
    // built-in Postgres default; the Add picker's database tile passes its own
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

  // Picker routing. A database pick opens the URL-form dialog pre-pointed at
  // that dbType; Custom REST and curated picks open their own install
  // dialogs (which then bump `datasourceRefreshKey` on success).
  function handlePickDatabase(dbType: string) {
    handleAdd(dbType);
  }
  function handleDatasourceInstalled() {
    setCustomRestOpen(false);
    setCuratedCandidate(null);
    refreshDatasources();
  }
  // Form-install tiles (ClickHouse / Snowflake / BigQuery / Elasticsearch).
  // Same refresh as the curated dialog, plus a `connections` refetch: post-
  // #3295 the install registers into ConnectionRegistry immediately, so the
  // new connection belongs in the main list without a reload.
  function handleFormInstallInstalled() {
    setFormInstallCandidate(null);
    handleDatasourceInstalled();
    refetch();
  }

  // Derive env-dropdown choices from the connections list — one entry
  // per distinct non-null group_id. Post-cutover (#2744 / ADR-0007)
  // there's no separate group lifecycle (status/primary/memberCount
  // are vestigial), so the dialog's singleton-preselect just counts
  // members and surfaces the group_id verbatim as the name. The shape
  // mirrors the legacy `/admin/connection-groups` wire response so the
  // dialog props stay unchanged.
  const envGroups: ReadonlyArray<EnvGroup> = (() => {
    const counts = new Map<string, number>();
    for (const conn of displayConnections) {
      if (!conn.groupId) continue;
      counts.set(conn.groupId, (counts.get(conn.groupId) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([id, memberCount]) => ({
      id,
      name: id,
      status: "active" as const,
      memberCount,
      primaryConnectionId: null,
    }));
  })();

  // "Live" mirrors the row rendering: ConnectionCard maps both `healthy` and
  // `degraded` to a connected (teal) row via `healthToStatus`, so both count as
  // live — otherwise a degraded row reads as connected while the rollup calls
  // it not-live. Unhealthy / unknown are excluded. Single predicate so the hero
  // stat and the Databases section count can't drift apart.
  const isLive = (c: ConnectionInfo) =>
    c.health?.status === "healthy" || c.health?.status === "degraded";

  // Header "X / Y live" mirrors the /admin/billing usage panel — the
  // lazy `default` fallback on self-hosted demo deploys reports
  // `billable: false` and stays out of both numerator and denominator
  // (#2490). `isBillable` encodes the wire-compat fallback for older
  // API servers that omit the field.
  const billableConnections = displayConnections.filter(isBillable);
  const stats = {
    live: billableConnections.filter(isLive).length,
    total: billableConnections.length,
  };

  // Databases section rollup — every row from `/admin/connections` is a SQL
  // (or legacy) database; REST APIs + Salesforce are separate sections.
  const dbLive = displayConnections.filter(isLive).length;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
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
            Databases and REST APIs Atlas can query — every datasource is read-only.
          </p>
          <div className="flex items-center gap-3">
          {demoReadOnly ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" disabled>
                      <Plus className="mr-2 size-4" />
                      Add connection
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{DEMO_ADD_READONLY_TOOLTIP}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button onClick={() => setPickerOpen(true)} size="sm" data-testid="add-connection-hero">
              <Plus className="mr-2 size-4" />
              Add connection
            </Button>
          )}
          </div>
        </div>
      </header>

      <ErrorBoundary>
        <div className="space-y-8">
          {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}
          {!mutationError && (
            <MutationErrorSurface
              error={testMutation.error}
              feature="Connections"
              onRetry={testMutation.clearError}
            />
          )}

          <PoolStatsSection onError={setMutationError} />

          {/*
            Connections aren't draft-publishable content the way prompts or
            entities are: CREATE in developer mode produces a draft, but UPDATE
            and DELETE are immediate, and the demo-hide flow is a per-org
            archived tombstone that doesn't go through publish. So we don't wrap
            in `<PublishedContextWrapper>` — doing so traps admins in
            dev-mode-no-drafts behind an `inert` overlay and prevents the very
            actions (test / hide demo / drain pool) that don't require drafting.

            Three category sections, each progressive-disclosure: connected
            items collapse to a one-line row and expand in place. The Add picker
            (hero + per-section button) is the single place new datasources are
            connected — there are no more always-listed "Connect" provider rows.
          */}
          <section>
            <SectionHeader
              title="Databases"
              count={loading ? undefined : countLine(displayConnections.length, dbLive)}
              action={
                <AddDatasourceButton
                  label="Add database"
                  onClick={() => setPickerOpen(true)}
                  demoReadOnly={demoReadOnly}
                  demoTooltip={DEMO_ADD_READONLY_TOOLTIP}
                  testId="add-database"
                />
              }
            />
            <AdminContentWrapper
              loading={loading}
              error={error}
              feature="Connections"
              onRetry={refetch}
              loadingMessage="Loading connections..."
              isEmpty={false}
            >
              {displayConnections.length === 0 ? (
                <SectionEmpty
                  icon={Cable}
                  title="No databases connected"
                  description="Connect Postgres, MySQL, Snowflake, and more."
                  action={
                    demoReadOnly ? null : (
                      <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                        <Plus className="mr-1.5 size-3.5" />
                        Add database
                      </Button>
                    )
                  }
                />
              ) : (
                <div className="space-y-2">
                  {displayConnections.map((conn) => (
                    <ConnectionCard
                      key={conn.id}
                      conn={conn}
                      icon={iconForDbType(conn.dbType)}
                      providerLabel={labelForDbType(conn.dbType)}
                      demoReadOnly={demoReadOnly}
                      loadingDetail={loadingDetail}
                      testMutation={testMutation}
                      testStatus={testStatus}
                      onTest={testConnection}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </AdminContentWrapper>
          </section>

          {/*
            REST APIs (OpenAPI / generic + curated candidates) and Salesforce
            are plugin-resolved (not in ConnectionRegistry.describe()), so they
            own their own fetch + section. Remounted on install via the
            `datasourceRefreshKey` key so their lists repaint.
          */}
          <OpenApiProviderBlock
            key={`rest-${datasourceRefreshKey}`}
            demoReadOnly={demoReadOnly}
            onAdd={() => setPickerOpen(true)}
            onChange={handleMutationSuccess}
          />

          <SalesforceProviderBlock
            key={`sf-${datasourceRefreshKey}`}
            demoReadOnly={demoReadOnly}
            onChange={handleMutationSuccess}
          />
        </div>
      </ErrorBoundary>

      <ConnectionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editId={editId}
        editDetail={editDetail}
        initialDbType={createDbType}
        envGroups={envGroups}
        onSuccess={handleMutationSuccess}
        onCreatedNewGroup={setGenPrompt}
      />

      {/* Inline-on-add → generate (#3237 door 1). Both onboarding doors route
          through `wizardGenerateHref` so they launch the one shared flow; the
          generate/save routes resolve the connection's group server-side, so
          the entities land in this new group. */}
      <AlertDialog open={genPrompt !== null} onOpenChange={(open) => { if (!open) setGenPrompt(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {/* groupLabel is already display-ready (the typed group name, or
                  the connection id for an auto-singleton) — never a synthetic
                  `g_<id>`, so no stripGroupPrefix. */}
              Generate a semantic layer for{" "}
              <span className="font-mono">{genPrompt?.groupLabel ?? ""}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Atlas profiles this database and builds editable YAML so the agent
              understands your schema and can write SQL on it. You can fine-tune
              or skip enrichment along the way — and do this any time later from
              the semantic layer page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = genPrompt;
                setGenPrompt(null);
                if (target) router.push(wizardGenerateHref(target.connectionId));
              }}
            >
              <Plus className="mr-1.5 size-3.5" />
              Generate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteConnectionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        connectionId={deleteId}
        onSuccess={handleMutationSuccess}
      />

      <AddConnectionPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        demoReadOnly={demoReadOnly}
        onPickDatabase={handlePickDatabase}
        onPickCustomRest={() => setCustomRestOpen(true)}
        onPickCuratedForm={setCuratedCandidate}
        onPickDatasourceForm={setFormInstallCandidate}
      />

      <RestInstallDialog
        open={customRestOpen}
        onOpenChange={setCustomRestOpen}
        onInstalled={handleDatasourceInstalled}
      />

      <CuratedInstallDialog
        candidate={curatedCandidate}
        open={curatedCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setCuratedCandidate(null);
        }}
        onInstalled={handleDatasourceInstalled}
      />

      {/* Schema-driven marketplace form-install for plugin datasources
          (ClickHouse / Snowflake / BigQuery / Elasticsearch, #3377) — the
          same modal Admin → Integrations uses, so install semantics
          (validation, secret encryption, edit-in-place) stay identical. */}
      {formInstallCandidate ? (
        <FormInstallModal
          open
          onOpenChange={(open) => {
            if (!open) setFormInstallCandidate(null);
          }}
          slug={formInstallCandidate.slug}
          name={formInstallCandidate.name}
          description={formInstallCandidate.description}
          configSchema={formInstallCandidate.configSchema}
          onInstalled={handleFormInstallInstalled}
        />
      ) : null}
    </div>
  );
}

// ── Connection Card (one existing connection) ───────────────────

function ConnectionCard({
  conn,
  icon,
  providerLabel,
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
  // Edit-only gate: PUT on `__demo__` returns 403 `demo_readonly` in
  // published mode (matched by the backend's `demoReadonly` check), so the
  // UI gate mirrors that. Delete uses a per-org `archived` tombstone insert
  // — no shared mutation — so it stays enabled in both modes. Without that
  // split, dogfood tenants got stuck unable to hide the demo: published
  // mode disabled the button and the dev-mode toggle then trapped them
  // behind the `<PublishedContextWrapper>` overlay.
  const editReadOnly = demoReadOnly && isDemo;
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
      disabled={loadingDetail || editReadOnly}
      aria-label={`Edit connection ${conn.id}`}
    >
      <Pencil className="mr-1.5 size-3.5" />
      Edit
    </Button>
  );

  // Delete is never gated by editReadOnly: even on the shared demo it is a
  // per-org tombstone, not a global mutation.
  const deleteButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onDelete(conn.id)}
      aria-label={`Delete connection ${conn.id}`}
      className="text-destructive hover:text-destructive"
    >
      <Trash2 className="mr-1.5 size-3.5" />
      Delete
    </Button>
  );

  // Wrap only the edit button in a tooltip when demo-readonly applies; the
  // delete button stays interactive in both modes (per-workspace hide).
  const manageButtons = isDefault ? null : editReadOnly ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{editButton}</span>
        </TooltipTrigger>
        <TooltipContent>{DEMO_EDIT_READONLY_TOOLTIP}</TooltipContent>
      </Tooltip>
      {deleteButton}
    </TooltipProvider>
  ) : (
    <>
      {editButton}
      {deleteButton}
    </>
  );

  const latencySummary =
    conn.health?.latencyMs != null ? `${conn.health.latencyMs}ms` : undefined;
  const meta = `${providerLabel}${
    conn.groupName ? ` · ${stripGroupPrefix(conn.groupName)}` : ""
  }`;

  return (
    <CollapsibleRow
      icon={icon}
      title={<span className="font-mono">{conn.id}</span>}
      titleText={conn.id}
      titleBadge={badges}
      meta={meta}
      status={status}
      statusLabel={pillLabel}
      summary={latencySummary}
      dataTestId={`connection-row-${conn.id}`}
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
        {conn.groupName != null ? (
          <DetailRow
            label="Environment"
            value={<Badge variant="outline">{stripGroupPrefix(conn.groupName)}</Badge>}
          />
        ) : null}
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
    </CollapsibleRow>
  );
}
