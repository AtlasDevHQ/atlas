"use client";

/**
 * OpenAPI (generic REST) datasource render path for `/admin/connections`
 * (PRD #2868 slice 2, #2926). Parallel to {@link SalesforceProviderBlock}, but:
 *
 *  - **Multi-instance** — a workspace installs Twenty, Stripe, an internal
 *    service side by side. Each is its own CollapsibleRow with its own actions.
 *  - **Form install** — `POST /api/v1/integrations/openapi-generic/install-form`
 *    with the spec URL + auth (probed server-side; field errors surface inline).
 *  - **Per-install lifecycle** via `/api/v1/admin/openapi-datasources/{id}`:
 *    a "View operations" detail dialog (lists every discovered operation), a
 *    "Rediscover schema" re-probe, a representation-mode toggle, and uninstall.
 *
 * The credential (`auth_value`) is encrypted server-side and never returned, so
 * this component only ever renders non-secret metadata.
 */

import { useState } from "react";
import { type Control, useWatch } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import {
  AlertTriangle,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DetailList,
  DetailRow,
  InlineError,
} from "@/ui/components/admin/compact";
import { CollapsibleRow } from "@/ui/components/admin/collapsible-row";
import {
  AddDatasourceButton,
  countLine,
  DEMO_ADD_TOOLTIP,
  SectionEmpty,
  SectionHeader,
} from "./section-header";
import {
  FormDialog,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/form-dialog";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { getApiUrl } from "@/lib/api-url";
import { cn } from "@/lib/utils";
import { installFormErrorMessage } from "./install-form-error";

const OPENAPI_SLUG = "openapi-generic";

// ── Wire schemas ─────────────────────────────────────────────────────────────

const SnapshotSchema = z
  .object({
    title: z.string(),
    version: z.string(),
    openapiVersion: z.string(),
    operationCount: z.number(),
    probedAt: z.string(),
  })
  .nullable();

/**
 * Spec-drift roll-up counts from the last re-discovery (#2976) — the tallies the
 * card renders into a human summary. Mirrors the API's `DiffCounts`.
 */
const DriftCountsSchema = z.object({
  operationsAdded: z.number(),
  operationsRemoved: z.number(),
  operationsChanged: z.number(),
  schemasAdded: z.number(),
  schemasRemoved: z.number(),
  schemasChanged: z.number(),
  fieldsAdded: z.number(),
  fieldsRemoved: z.number(),
  fieldsRetyped: z.number(),
});

/**
 * Summary of the last spec re-discovery (#2976). `null` until the datasource has
 * been rediscovered at least once; `baseline` when there was no prior snapshot to
 * compare against; `unchanged` when a comparison ran and nothing moved.
 */
const LastRefreshSchema = z
  .object({
    previousProbedAt: z.string().nullable(),
    currentProbedAt: z.string(),
    baseline: z.boolean(),
    // Optional for back-compat with responses serialized before this field landed;
    // absent → treated as false (a clean baseline, not a dropped comparison).
    priorParseFailed: z.boolean().optional(),
    unchanged: z.boolean(),
    counts: DriftCountsSchema,
  })
  .nullable();
type DriftCounts = z.infer<typeof DriftCountsSchema>;

/**
 * One breaking change in the persisted drift signal (#2979) — a legible descriptor
 * the pill renders. Mirrors the API's `BreakingReason`. Non-strict so a future
 * reason kind doesn't fail validation; the pill shows whatever `detail` it carries.
 */
const BreakingReasonSchema = z.object({
  kind: z.string(),
  operationId: z.string().optional(),
  schema: z.string().optional(),
  path: z.string().optional(),
  detail: z.string(),
});

/**
 * The persisted breaking-change signal (#2979), raised by a SCHEDULED re-discovery
 * when the upstream spec removed/retyped something the agent relied on. `null` (or
 * absent) when there's no standing alert; `acknowledgedAt` is set once an admin
 * dismisses it (the pill then hides). Mirrors the API's `SpecDriftAlertSummary`.
 */
const DriftAlertSchema = z
  .object({
    raisedAt: z.string(),
    previousProbedAt: z.string().nullable(),
    currentProbedAt: z.string(),
    breakingCount: z.number(),
    reasons: z.array(BreakingReasonSchema),
    counts: DriftCountsSchema,
    acknowledgedAt: z.string().nullable(),
  })
  .nullable();

const DatasourceSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  authKind: z.string(),
  openapiUrl: z.string().nullable(),
  baseUrlOverride: z.string().nullable(),
  representationMode: z.string(),
  specRefreshInterval: z.string(),
  status: z.string(),
  // #3044 — cross-environment scope (ADR-0010). `null` ⇒ workspace-global.
  // Optional/nullable for back-compat with responses serialized before the field.
  groupId: z.string().nullable().optional(),
  snapshot: SnapshotSchema,
  // Optional for back-compat with any cached/old list response; absent → no banner.
  lastRefresh: LastRefreshSchema.optional(),
  // Persisted breaking-change signal (#2979). Optional for back-compat; absent → no pill.
  driftAlert: DriftAlertSchema.optional(),
});
type DatasourceSummary = z.infer<typeof DatasourceSummarySchema>;

const ListSchema = z.object({ datasources: z.array(DatasourceSummarySchema) });

/**
 * #3044 — the workspace's connection groups, for the per-datasource environment
 * picker. Sourced from `/api/v1/me/connection-groups` (admins can read it). Only
 * the id is load-bearing; `name` drives the human label. Extra response fields
 * (`restDatasources`, `reason`) are ignored by the non-strict object.
 */
const ConnectionGroupsSchema = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** Select sentinel for "no group" — shadcn `Select` items can't carry an empty value. */
const WORKSPACE_GLOBAL = "__workspace_global__";

const OperationSchema = z.object({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().nullable(),
});
const DetailSchema = DatasourceSummarySchema.extend({
  operations: z.array(OperationSchema),
  snapshotError: z.boolean(),
});

const AUTH_KINDS = ["none", "bearer", "basic", "apikey-header", "apikey-query"] as const;

/**
 * Auto-refresh presets the Select exposes (#2977). The agent's view of a spec
 * stays current without a manual click; `off` (default) never auto-refreshes.
 * The values mirror the API's `spec_refresh_interval` enum — a custom `"<N>h"`
 * interval set via `atlas.config.ts` is still rendered (see {@link formatRefreshLabel}).
 */
const REFRESH_INTERVAL_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const;

/** Human label for a stored interval value — a preset name, or "Every Nh" for a custom interval. */
function formatRefreshLabel(value: string): string {
  const preset = REFRESH_INTERVAL_OPTIONS.find((o) => o.value === value);
  if (preset) return preset.label;
  const custom = /^(\d+(?:\.\d+)?)h$/.exec(value);
  return custom ? `Every ${custom[1]}h` : value;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Render the spec-drift counts (#2976) into a human one-liner like
 * "2 new operations, 1 removed operation, 3 changed fields". Field-level changes
 * (added + removed + retyped, across operations and shared schemas) collapse to
 * "changed fields"; an attribute-only operation change (e.g. method) surfaces as
 * "changed operations" when no field moved. Empty → "no changes".
 */
function formatDriftSummary(c: DriftCounts): string {
  const fieldChanges = c.fieldsAdded + c.fieldsRemoved + c.fieldsRetyped;
  const parts: string[] = [];
  if (c.operationsAdded) parts.push(`${plural(c.operationsAdded, "new operation")}`);
  if (c.operationsRemoved) parts.push(`${plural(c.operationsRemoved, "removed operation")}`);
  if (c.schemasAdded) parts.push(`${plural(c.schemasAdded, "new schema")}`);
  if (c.schemasRemoved) parts.push(`${plural(c.schemasRemoved, "removed schema")}`);
  if (fieldChanges) parts.push(`${plural(fieldChanges, "changed field")}`);
  else if (c.operationsChanged) parts.push(`${plural(c.operationsChanged, "changed operation")}`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/** The card's "Last refresh" line, or `null` when the datasource hasn't been rediscovered yet. */
function driftLabel(lastRefresh: DatasourceSummary["lastRefresh"]): string | null {
  if (!lastRefresh) return null;
  if (lastRefresh.baseline) {
    // A dropped comparison (prior spec no longer parsed) is NOT a clean baseline —
    // real drift may have gone unseen, so say so rather than "Baseline recorded".
    return lastRefresh.priorParseFailed
      ? "Comparison unavailable — previous spec couldn't be read"
      : "Baseline recorded";
  }
  if (lastRefresh.unchanged) return "No changes";
  return formatDriftSummary(lastRefresh.counts);
}

/**
 * The breaking-drift pill's secondary line (#2979): up to two reason details, then
 * "+N more" against the TRUE total (`breakingCount`, which may exceed the capped
 * `reasons` sample). Falls back to a generic line if the sample is empty.
 */
function formatBreakingReasons(reasons: ReadonlyArray<{ detail: string }>, total: number): string {
  if (reasons.length === 0) return "Operations or fields the agent relied on changed.";
  const shown = reasons.slice(0, 2).map((r) => r.detail);
  const remaining = total - shown.length;
  return remaining > 0 ? `${shown.join("; ")}; +${remaining} more` : shown.join("; ");
}

interface OpenApiProviderBlockProps {
  readonly demoReadOnly: boolean;
  /** Opens the Add picker (the REST install dialogs are hosted by the page). */
  readonly onAdd: () => void;
  /** Fires after a per-row mutation (rediscover/delete) so the page refetches. */
  readonly onChange: () => void;
}

/** The "REST APIs" section on `/admin/connections` — OpenAPI/generic +
 *  curated candidates (Stripe, Notion, …) once installed. The install flow
 *  lives in the page's Add picker; this block renders the section + rows and
 *  owns per-row lifecycle (rediscover / representation / disconnect). */
export function OpenApiProviderBlock({ demoReadOnly, onAdd, onChange }: OpenApiProviderBlockProps) {
  const listQuery = useAdminFetch("/api/v1/admin/openapi-datasources", { schema: ListSchema });
  // #3044 — connection groups for the per-datasource environment picker. A
  // failure degrades to "no groups" (the picker offers only Workspace-global).
  const groupsQuery = useAdminFetch("/api/v1/me/connection-groups", {
    schema: ConnectionGroupsSchema,
  });

  const refresh = () => {
    // fire-and-forget: refresh list; callers don't await the refetch
    void listQuery.refetch();
    onChange();
  };

  const datasources = listQuery.data?.datasources ?? [];
  const addAction = (
    <AddDatasourceButton
      label="Add REST API"
      onClick={onAdd}
      demoReadOnly={demoReadOnly}
      demoTooltip={DEMO_ADD_TOOLTIP}
      testId="openapi-add"
    />
  );

  return (
    <section>
      <SectionHeader
        title="REST APIs"
        count={listQuery.loading || listQuery.error ? undefined : countLine(datasources.length)}
        action={addAction}
      />

      {listQuery.loading ? (
        <div className="flex items-center gap-2 rounded-xl border bg-card/40 px-3.5 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading REST datasources…
        </div>
      ) : listQuery.error ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-card/40 px-3.5 py-3">
          <span className="text-xs text-destructive">
            {friendlyErrorOrNull(listQuery.error) ?? "Failed to load REST datasources."}
          </span>
          <Button size="sm" variant="outline" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : datasources.length === 0 ? (
        <SectionEmpty
          icon={Network}
          title="No REST APIs connected"
          description="Connect Stripe, Notion, or any service with an OpenAPI 3.x spec."
          action={
            demoReadOnly ? null : (
              <Button size="sm" variant="outline" onClick={onAdd} data-testid="openapi-add-empty">
                <Plus className="mr-1.5 size-3.5" />
                Add REST API
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-2">
          {datasources.map((ds) => (
            <OpenApiInstallCard
              key={ds.id}
              ds={ds}
              groups={groupsQuery.data?.groups ?? []}
              onChange={refresh}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Per-install card ─────────────────────────────────────────────────────────

function OpenApiInstallCard({
  ds,
  groups,
  onChange,
}: {
  ds: DatasourceSummary;
  groups: ReadonlyArray<{ id: string; name: string }>;
  onChange: () => void;
}) {
  const [opsOpen, setOpsOpen] = useState(false);

  const rediscover = useAdminMutation<{
    rediscovered: boolean;
    operationCount: number;
    drift: z.infer<typeof LastRefreshSchema>;
  }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}/rediscover`,
    method: "POST",
    invalidates: onChange,
  });
  const setMode = useAdminMutation<{ updated: boolean; representationMode: string }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}`,
    method: "PATCH",
    invalidates: onChange,
  });
  const setRefresh = useAdminMutation<{ updated: boolean; specRefreshInterval: string }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}`,
    method: "PATCH",
    invalidates: onChange,
  });
  // #3044 — assign/clear the cross-environment scope (ADR-0010).
  const setGroup = useAdminMutation<{ updated: boolean; groupId: string | null }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}`,
    method: "PATCH",
    invalidates: onChange,
  });
  const remove = useAdminMutation<{ deleted: boolean }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}`,
    method: "DELETE",
    invalidates: onChange,
  });
  // #2979 — dismiss the persisted breaking-change pill.
  const acknowledgeDrift = useAdminMutation<{ acknowledged: boolean }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}/acknowledge-drift`,
    method: "POST",
    invalidates: onChange,
  });

  const host = (() => {
    const url = ds.baseUrlOverride ?? ds.openapiUrl;
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  // Spec-drift since the last re-discovery (#2976). `null` until rediscovered.
  const lastRefresh = ds.lastRefresh;
  const driftSummary = driftLabel(lastRefresh);
  // Emphasize the line when a real change moved OR the comparison was dropped
  // (prior spec unreadable) — both warrant the operator's attention.
  const driftIsChange = !!lastRefresh && !lastRefresh.baseline && !lastRefresh.unchanged;
  const driftNeedsAttention = driftIsChange || !!lastRefresh?.priorParseFailed;
  // #2979 — the persisted BREAKING signal, distinct from the transient `lastRefresh`
  // line above. Shown only while raised AND not yet acknowledged; a clean refresh or
  // an acknowledge clears it server-side and the pill disappears on the next fetch.
  const breakingAlert = ds.driftAlert && !ds.driftAlert.acknowledgedAt ? ds.driftAlert : null;
  const refreshedAt = (() => {
    if (!lastRefresh) return null;
    const d = new Date(lastRefresh.currentProbedAt);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
  })();

  async function handleRediscover() {
    const result = await rediscover.mutate({});
    if (result.ok) {
      // Lead with what moved (#2976) so the admin sees drift at the moment of
      // re-probe, not just the operation count.
      const drift = result.data?.drift;
      let summary: string;
      if (drift && !drift.baseline) {
        summary = drift.unchanged ? "no changes" : formatDriftSummary(drift.counts);
      } else if (drift?.priorParseFailed) {
        // A dropped comparison — don't imply a clean baseline.
        summary = "previous spec couldn't be read, drift comparison unavailable";
      } else {
        summary = `${result.data?.operationCount ?? 0} operations`;
      }
      toast.success(`Schema rediscovered — ${summary}`);
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Rediscover failed");
    }
  }

  async function handleToggleMode(toSemantic: boolean) {
    const representationMode = toSemantic ? "semantic-yaml" : "operation-graph";
    const result = await setMode.mutate({ body: { representationMode } });
    if (result.ok) {
      toast.success(`Representation set to ${representationMode}`);
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't change representation mode");
    }
  }

  async function handleSetRefresh(specRefreshInterval: string) {
    const result = await setRefresh.mutate({ body: { specRefreshInterval } });
    if (result.ok) {
      toast.success(
        specRefreshInterval === "off"
          ? "Auto-refresh disabled"
          : `Auto-refresh set to ${formatRefreshLabel(specRefreshInterval).toLowerCase()}`,
      );
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't change the refresh interval");
    }
  }

  async function handleSetGroup(nextValue: string) {
    // Sentinel → null clears the scope back to workspace-global.
    const groupId = nextValue === WORKSPACE_GLOBAL ? null : nextValue;
    const result = await setGroup.mutate({ body: { groupId } });
    if (result.ok) {
      toast.success(
        groupId === null
          ? `${ds.displayName} is now workspace-global`
          : `${ds.displayName} scoped to ${groupId}`,
      );
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't change the environment");
    }
  }

  async function handleDelete() {
    const result = await remove.mutate({});
    if (result.ok) {
      toast.success(`${ds.displayName} disconnected`);
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't disconnect");
    }
  }

  async function handleAcknowledgeDrift() {
    const result = await acknowledgeDrift.mutate({});
    if (result.ok) {
      toast.success("Drift alert dismissed");
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't dismiss the alert");
    }
  }

  // The per-row PATCH/DELETE mutations report success via toast, but each is
  // bound to a server value (the Switch/Selects below) that snaps back on a
  // failed write — so a bare toast lets the revert read as a silent no-op once
  // it fades. Surface a durable inline error too (rediscover already had one).
  const settingsError =
    setMode.error ??
    setRefresh.error ??
    setGroup.error ??
    remove.error ??
    acknowledgeDrift.error;

  return (
    <>
      <CollapsibleRow
        icon={Network}
        title={<span className="font-mono">{ds.displayName}</span>}
        titleText={ds.displayName}
        meta={host ? host : "REST API"}
        // A standing breaking-change alert flips the row amber + "Drift" so it's
        // visible while collapsed; a clean datasource reads as a teal "Connected".
        status={breakingAlert ? "transitioning" : "connected"}
        statusLabel={breakingAlert ? "Drift" : "Connected"}
        summary={ds.snapshot ? `${ds.snapshot.operationCount} ops` : undefined}
        dataTestId={`openapi-row-${ds.id}`}
        titleBadge={
          ds.status === "draft" ? (
            <Badge variant="outline" className="text-[10px]">
              Draft
            </Badge>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpsOpen(true)} data-testid="openapi-view-ops">
              View operations
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRediscover}
              disabled={rediscover.saving}
              data-testid="openapi-rediscover"
            >
              {rediscover.saving ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5" />
              )}
              Rediscover schema
            </Button>
            <DeleteDialog name={ds.displayName} deleting={remove.saving} onConfirm={handleDelete} />
          </>
        }
      >
        {breakingAlert ? (
          <div
            role="alert"
            data-testid="openapi-drift-alert"
            className={cn(
              "mb-2 flex items-start gap-2 rounded-md border px-3 py-2",
              "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">
                Upstream API changed — {plural(breakingAlert.breakingCount, "breaking change")}
              </p>
              <p className="mt-0.5 break-words text-[11px] text-amber-700/80 dark:text-amber-400/80">
                {formatBreakingReasons(breakingAlert.reasons, breakingAlert.breakingCount)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
              onClick={handleAcknowledgeDrift}
              disabled={acknowledgeDrift.saving}
              data-testid="openapi-drift-acknowledge"
            >
              {acknowledgeDrift.saving ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              Acknowledge
            </Button>
          </div>
        ) : null}
        <DetailList>
          {ds.openapiUrl ? <DetailRow label="Spec URL" value={ds.openapiUrl} mono truncate /> : null}
          {ds.baseUrlOverride ? (
            <DetailRow label="Base URL override" value={ds.baseUrlOverride} mono truncate />
          ) : null}
          <DetailRow label="Auth" value={ds.authKind} />
          <DetailRow
            label="Operations"
            value={ds.snapshot ? String(ds.snapshot.operationCount) : "—"}
          />
          {ds.snapshot ? (
            <DetailRow label="Spec" value={`${ds.snapshot.title} v${ds.snapshot.version}`} truncate />
          ) : null}
          {driftSummary ? (
            <DetailRow
              label="Last refresh"
              value={
                <span className="flex items-center gap-2" data-testid="openapi-drift-summary">
                  <span className={driftNeedsAttention ? "text-xs font-medium" : "text-xs text-muted-foreground"}>
                    {driftSummary}
                  </span>
                  {refreshedAt ? (
                    <span className="text-[11px] text-muted-foreground">· {refreshedAt}</span>
                  ) : null}
                </span>
              }
            />
          ) : null}
          <DetailRow
            label="Representation"
            value={
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">operation-graph</span>
                <Switch
                  checked={ds.representationMode === "semantic-yaml"}
                  disabled={setMode.saving}
                  onCheckedChange={handleToggleMode}
                  aria-label="Toggle representation mode"
                  data-testid="openapi-mode-toggle"
                />
                <span className="text-xs text-muted-foreground">semantic-yaml</span>
              </span>
            }
          />
          <DetailRow
            label="Auto-refresh"
            value={
              <Select
                value={ds.specRefreshInterval}
                disabled={setMode.saving || setRefresh.saving}
                onValueChange={handleSetRefresh}
              >
                <SelectTrigger
                  className="h-7 w-36 text-xs"
                  aria-label="Spec auto-refresh interval"
                  data-testid="openapi-refresh-interval"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFRESH_INTERVAL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                  {/* A custom "<N>h" interval (set via atlas.config.ts) isn't a preset —
                      surface it so the Select shows the live value rather than blanking. */}
                  {REFRESH_INTERVAL_OPTIONS.every((o) => o.value !== ds.specRefreshInterval) ? (
                    <SelectItem value={ds.specRefreshInterval}>
                      {formatRefreshLabel(ds.specRefreshInterval)}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            }
          />
          <DetailRow
            label="Environment"
            value={
              <span className="flex items-center gap-2">
                <Select
                  value={ds.groupId ?? WORKSPACE_GLOBAL}
                  disabled={setGroup.saving}
                  onValueChange={handleSetGroup}
                >
                  <SelectTrigger
                    className="h-7 w-44 text-xs"
                    aria-label="Environment scope"
                    data-testid="openapi-group-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={WORKSPACE_GLOBAL}>Workspace-global</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                    {/* Current scope points at a group not in the live list (no SQL
                        members yet, or the groups fetch failed) — surface it so the
                        Select shows the stored value rather than blanking. */}
                    {ds.groupId && !groups.some((g) => g.id === ds.groupId) ? (
                      <SelectItem value={ds.groupId}>{ds.groupId}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
                {ds.groupId ? null : (
                  <span className="text-[11px] text-muted-foreground">
                    available in every environment
                  </span>
                )}
              </span>
            }
          />
        </DetailList>

        {rediscover.error ? (
          <InlineError>{friendlyErrorOrNull(rediscover.error) ?? "Rediscover failed."}</InlineError>
        ) : null}
        {settingsError ? (
          <InlineError>{friendlyErrorOrNull(settingsError) ?? "Update failed."}</InlineError>
        ) : null}
      </CollapsibleRow>

      <OperationsDialog
        installId={ds.id}
        displayName={ds.displayName}
        open={opsOpen}
        onOpenChange={setOpsOpen}
      />
    </>
  );
}

// ── Operations detail dialog ─────────────────────────────────────────────────

function OperationsDialog({
  installId,
  displayName,
  open,
  onOpenChange,
}: {
  installId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useAdminFetch(`/api/v1/admin/openapi-datasources/${encodeURIComponent(installId)}`, {
    schema: DetailSchema,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{displayName} — discovered operations</DialogTitle>
          <DialogDescription>
            Every operation the agent can call on this REST datasource, read from the probed spec.
          </DialogDescription>
        </DialogHeader>

        {detail.loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading operations…
          </div>
        ) : detail.error ? (
          <InlineError>{friendlyErrorOrNull(detail.error) ?? "Failed to load operations."}</InlineError>
        ) : detail.data?.snapshotError ? (
          <InlineError>
            The cached schema couldn&apos;t be read. Use &ldquo;Rediscover schema&rdquo; to re-probe the spec.
          </InlineError>
        ) : (
          <div className="overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[44%]">Operation</TableHead>
                  <TableHead className="w-16">Method</TableHead>
                  <TableHead>Path</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail.data?.operations ?? []).map((op) => (
                  <TableRow key={op.operationId}>
                    <TableCell className="font-mono text-xs">
                      {op.operationId}
                      {op.summary ? (
                        <span className="block text-[11px] font-sans text-muted-foreground">{op.summary}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {op.method}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{op.path}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Install dialog ───────────────────────────────────────────────────────────

/**
 * Form value shape for the Custom REST API install (arch-win #91 / #4203).
 * `auth_kind` is a plain string (validated against {@link AUTH_KINDS} on the
 * server); every credential field is present-but-optional so the dialog can
 * carry them across auth-kind switches without churn — {@link buildRestInstallBody}
 * drops the ones the selected kind doesn't need. `RestFormValues` is derived
 * from the schema (`z.infer`) so the schema is the single source of truth — a
 * field added to one can't silently drift from the other.
 */
const restSchema = z.object({
  openapi_url: z.string().min(1, "OpenAPI spec URL is required"),
  auth_kind: z.string(),
  auth_value: z.string(),
  auth_header_name: z.string(),
  auth_param_name: z.string(),
  base_url_override: z.string(),
  display_name: z.string(),
});
type RestFormValues = z.infer<typeof restSchema>;

const REST_DEFAULTS: RestFormValues = {
  openapi_url: "",
  auth_kind: "bearer",
  auth_value: "",
  auth_header_name: "",
  auth_param_name: "",
  base_url_override: "",
  display_name: "",
};

/**
 * Assemble the `install-form` wire body from the form values, dropping the
 * credential fields the selected `auth_kind` doesn't use (so a stale value from
 * a previously-selected kind never leaks) and trimming/omitting blank optional
 * fields. Exported as a pure function so the conditional shaping — the most
 * substantive logic here — is unit-testable without rendering the dialog.
 */
export function buildRestInstallBody(values: RestFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    openapi_url: values.openapi_url.trim(),
    auth_kind: values.auth_kind,
  };
  if (values.auth_kind !== "none") body.auth_value = values.auth_value;
  if (values.auth_kind === "apikey-header") body.auth_header_name = values.auth_header_name.trim();
  if (values.auth_kind === "apikey-query") body.auth_param_name = values.auth_param_name.trim();
  if (values.base_url_override.trim()) body.base_url_override = values.base_url_override.trim();
  if (values.display_name.trim()) body.display_name = values.display_name.trim();
  return body;
}

/** Custom REST API install fields — the freeform OpenAPI-spec form body,
 *  rendered inside {@link FormDialog}. Auth-specific inputs disclose off the
 *  selected auth kind (none → no credential; bearer/basic → the secret;
 *  api-key kinds → the secret PLUS a header or query-param name) via a
 *  `useWatch` on `auth_kind`, mirroring the config-schema `showWhen` pattern
 *  the catalog form uses. */
function RestInstallFields({ control }: { control: Control<RestFormValues> }) {
  const authKind = useWatch({ control, name: "auth_kind" });
  return (
    <>
      <FormField
        control={control}
        name="openapi_url"
        render={({ field }) => (
          <FormItem>
            <FormLabel>OpenAPI spec URL</FormLabel>
            <FormControl>
              <Input
                placeholder="https://crm.example.com/rest/open-api/core"
                data-testid="openapi-url-input"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="auth_kind"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Authentication</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger data-testid="openapi-auth-kind">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {AUTH_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {authKind !== "none" ? (
        <FormField
          control={control}
          name="auth_value"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {authKind === "basic" ? "username:password" : "Token / API key"}
              </FormLabel>
              <FormControl>
                <Input type="password" data-testid="openapi-auth-value" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}

      {authKind === "apikey-header" ? (
        <FormField
          control={control}
          name="auth_header_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API key header name</FormLabel>
              <FormControl>
                <Input placeholder="X-API-Key" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}

      {authKind === "apikey-query" ? (
        <FormField
          control={control}
          name="auth_param_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API key query param</FormLabel>
              <FormControl>
                <Input placeholder="api_key" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}

      <FormField
        control={control}
        name="display_name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Display name (optional)</FormLabel>
            <FormControl>
              <Input placeholder="Twenty CRM" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="base_url_override"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Base URL override (optional)</FormLabel>
            <FormControl>
              <Input placeholder="https://staging.example.com/rest" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}

/** The freeform "Custom REST API" install dialog (OpenAPI spec URL + auth),
 *  riding the shared {@link FormDialog} primitive (arch-win #91 / #4203) — the
 *  same spine as `FormInstallModal` / `CuratedInstallDialog` / `ByotInstallModal`.
 *  Hosted by the connections page and opened from the Add picker. */
export function RestInstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  async function handleSubmit(values: RestFormValues): Promise<void> {
    const res = await fetch(`${getApiUrl()}/api/v1/integrations/${OPENAPI_SLUG}/install-form`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(buildRestInstallBody(values)),
    });
    if (!res.ok) {
      // Throw so FormDialog surfaces it as the shared root-level error banner.
      throw new Error(await installFormErrorMessage(res));
    }
    toast.success("REST datasource connected");
    onInstalled();
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect a REST datasource"
      description="Point Atlas at an OpenAPI 3.x spec URL. Atlas probes the spec on install; the agent then queries it read-only. The credential is encrypted at rest."
      schema={restSchema}
      defaultValues={REST_DEFAULTS}
      onSubmit={handleSubmit}
      submitLabel="Connect"
      submitTestId="openapi-install-submit"
      className="max-w-lg"
    >
      {(form) => <RestInstallFields control={form.control} />}
    </FormDialog>
  );
}

function DeleteDialog({
  name,
  deleting,
  onConfirm,
}: {
  name: string;
  deleting: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={deleting} data-testid="openapi-delete">
          {deleting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Trash2 className="mr-1.5 size-3.5" />}
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the REST datasource install for this workspace. The agent will stop querying
            this API. The encrypted credential is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
