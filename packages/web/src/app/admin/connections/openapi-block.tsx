"use client";

/**
 * OpenAPI (generic REST) datasource render path for `/admin/connections`
 * (PRD #2868 slice 2, #2926). Parallel to {@link SalesforceProviderBlock}, but:
 *
 *  - **Multi-instance** — a workspace installs Twenty, Stripe, an internal
 *    service side by side. Each is its own Shell with its own actions.
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
import { z } from "zod";
import { toast } from "sonner";
import {
  ExternalLink,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
  Shell,
} from "@/ui/components/admin/compact";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { getApiUrl } from "@/lib/api-url";

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

const DatasourceSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  authKind: z.string(),
  openapiUrl: z.string().nullable(),
  baseUrlOverride: z.string().nullable(),
  representationMode: z.string(),
  specRefreshInterval: z.string(),
  status: z.string(),
  snapshot: SnapshotSchema,
  // Optional for back-compat with any cached/old list response; absent → no banner.
  lastRefresh: LastRefreshSchema.optional(),
});
type DatasourceSummary = z.infer<typeof DatasourceSummarySchema>;

const ListSchema = z.object({ datasources: z.array(DatasourceSummarySchema) });

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

interface OpenApiProviderBlockProps {
  readonly demoReadOnly: boolean;
  /** Fires after an install/uninstall so the parent page can refresh too. */
  readonly onChange: () => void;
}

/** Block for the OpenAPI (generic REST) datasources on `/admin/connections`. */
export function OpenApiProviderBlock({ demoReadOnly, onChange }: OpenApiProviderBlockProps) {
  const listQuery = useAdminFetch("/api/v1/admin/openapi-datasources", { schema: ListSchema });
  const [installOpen, setInstallOpen] = useState(false);

  const refresh = () => {
    listQuery.refetch();
    onChange();
  };

  if (listQuery.loading) {
    return (
      <CompactRow
        icon={Network}
        title="OpenAPI (Generic REST)"
        description="Loading…"
        status="disconnected"
        action={
          <Button size="sm" variant="outline" disabled>
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            Add
          </Button>
        }
      />
    );
  }

  if (listQuery.error) {
    return (
      <CompactRow
        icon={Network}
        title="OpenAPI (Generic REST)"
        description={friendlyErrorOrNull(listQuery.error) ?? "Failed to load REST datasources."}
        status="unhealthy"
        action={
          <Button size="sm" variant="outline" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const datasources = listQuery.data?.datasources ?? [];
  const addButton = (
    <Button
      size="sm"
      variant={datasources.length === 0 ? "default" : "outline"}
      disabled={demoReadOnly}
      onClick={() => setInstallOpen(true)}
      data-testid="openapi-add"
    >
      <Plus className="mr-1.5 size-3.5" />
      Add REST datasource
    </Button>
  );

  return (
    <div className="space-y-2">
      {datasources.length === 0 ? (
        <CompactRow
          icon={Network}
          title="OpenAPI (Generic REST)"
          description="Connect any REST API with an OpenAPI 3.x spec — Twenty, Stripe, an internal service."
          status="disconnected"
          action={addButton}
        />
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-medium text-muted-foreground">
              OpenAPI (Generic REST) — {datasources.length} connected
            </span>
            {addButton}
          </div>
          {datasources.map((ds) => (
            <OpenApiInstallCard key={ds.id} ds={ds} onChange={refresh} />
          ))}
        </>
      )}

      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={() => {
          setInstallOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

// ── Per-install card ─────────────────────────────────────────────────────────

function OpenApiInstallCard({ ds, onChange }: { ds: DatasourceSummary; onChange: () => void }) {
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
  const remove = useAdminMutation<{ deleted: boolean }>({
    path: `/api/v1/admin/openapi-datasources/${encodeURIComponent(ds.id)}`,
    method: "DELETE",
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

  async function handleDelete() {
    const result = await remove.mutate({});
    if (result.ok) {
      toast.success(`${ds.displayName} disconnected`);
    } else {
      toast.error(friendlyErrorOrNull(result.error) ?? "Couldn't disconnect");
    }
  }

  return (
    <>
      <Shell
        icon={Network}
        title={<span className="font-mono">{ds.displayName}</span>}
        titleText={ds.displayName}
        description={host ? `REST API · ${host}` : "REST API"}
        status="connected"
        statusLabel="Connected"
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
        </DetailList>

        {rediscover.error ? (
          <InlineError>{friendlyErrorOrNull(rediscover.error) ?? "Rediscover failed."}</InlineError>
        ) : null}
      </Shell>

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

function InstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const [openapiUrl, setOpenapiUrl] = useState("");
  const [authKind, setAuthKind] = useState<(typeof AUTH_KINDS)[number]>("bearer");
  const [authValue, setAuthValue] = useState("");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [authParamName, setAuthParamName] = useState("");
  const [baseUrlOverride, setBaseUrlOverride] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpenapiUrl("");
    setAuthKind("bearer");
    setAuthValue("");
    setAuthHeaderName("");
    setAuthParamName("");
    setBaseUrlOverride("");
    setDisplayName("");
    setError(null);
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { openapi_url: openapiUrl.trim(), auth_kind: authKind };
    if (authKind !== "none") body.auth_value = authValue;
    if (authKind === "apikey-header") body.auth_header_name = authHeaderName.trim();
    if (authKind === "apikey-query") body.auth_param_name = authParamName.trim();
    if (baseUrlOverride.trim()) body.base_url_override = baseUrlOverride.trim();
    if (displayName.trim()) body.display_name = displayName.trim();

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/${OPENAPI_SLUG}/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Install failed (${res.status})`;
        try {
          const b = (await res.json()) as {
            message?: string;
            fieldErrors?: Record<string, string[] | undefined>;
            requestId?: string;
          };
          // Surface the first field error (e.g. the spec-probe failure on
          // openapi_url) so the admin sees exactly what to fix.
          const firstField = b.fieldErrors ? Object.keys(b.fieldErrors)[0] : undefined;
          const firstErr = firstField ? b.fieldErrors?.[firstField]?.[0] : undefined;
          if (firstField && firstErr) message = `${firstField}: ${firstErr}`;
          else if (b.message) message = b.message;
          if (b.requestId) message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
        } catch {
          // intentionally ignored: non-JSON body → keep the status-only message.
        }
        setError(message);
        return;
      }
      toast.success("REST datasource connected");
      reset();
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a REST datasource</DialogTitle>
          <DialogDescription>
            Point Atlas at an OpenAPI 3.x spec URL. Atlas probes the spec on install; the agent then
            queries it read-only. The credential is encrypted at rest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="openapi-url">OpenAPI spec URL</Label>
            <Input
              id="openapi-url"
              placeholder="https://crm.example.com/rest/open-api/core"
              value={openapiUrl}
              onChange={(e) => setOpenapiUrl(e.target.value)}
              data-testid="openapi-url-input"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="openapi-auth-kind">Authentication</Label>
            <Select value={authKind} onValueChange={(v) => setAuthKind(v as (typeof AUTH_KINDS)[number])}>
              <SelectTrigger id="openapi-auth-kind" data-testid="openapi-auth-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTH_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {authKind !== "none" ? (
            <div className="space-y-1.5">
              <Label htmlFor="openapi-auth-value">
                {authKind === "basic" ? "username:password" : "Token / API key"}
              </Label>
              <Input
                id="openapi-auth-value"
                type="password"
                value={authValue}
                onChange={(e) => setAuthValue(e.target.value)}
                data-testid="openapi-auth-value"
              />
            </div>
          ) : null}

          {authKind === "apikey-header" ? (
            <div className="space-y-1.5">
              <Label htmlFor="openapi-header-name">API key header name</Label>
              <Input
                id="openapi-header-name"
                placeholder="X-API-Key"
                value={authHeaderName}
                onChange={(e) => setAuthHeaderName(e.target.value)}
              />
            </div>
          ) : null}

          {authKind === "apikey-query" ? (
            <div className="space-y-1.5">
              <Label htmlFor="openapi-param-name">API key query param</Label>
              <Input
                id="openapi-param-name"
                placeholder="api_key"
                value={authParamName}
                onChange={(e) => setAuthParamName(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="openapi-display-name">Display name (optional)</Label>
            <Input
              id="openapi-display-name"
              placeholder="Twenty CRM"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="openapi-base-url">Base URL override (optional)</Label>
            <Input
              id="openapi-base-url"
              placeholder="https://staging.example.com/rest"
              value={baseUrlOverride}
              onChange={(e) => setBaseUrlOverride(e.target.value)}
            />
          </div>

          {error ? <InlineError>{error}</InlineError> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || openapiUrl.trim().length === 0} data-testid="openapi-install-submit">
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <ExternalLink className="mr-1.5 size-3.5" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
