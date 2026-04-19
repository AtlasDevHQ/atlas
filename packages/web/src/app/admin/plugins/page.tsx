"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
  SectionHeading,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import {
  Puzzle,
  Loader2,
  FileCode2,
  Database,
  BookMarked,
  MessageSquare,
  Zap,
  Box,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  PluginListResponseSchema,
} from "@/ui/lib/admin-schemas";
import { extractFetchError, friendlyError } from "@/ui/lib/fetch-error";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import type { DeployMode } from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────

type PluginType = "datasource" | "context" | "interaction" | "action" | "sandbox";

interface PluginDescription {
  id: string;
  types: PluginType[];
  version: string;
  name: string;
  status: "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";
  enabled: boolean;
}

interface ConfigSchemaField {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  options?: string[];
  default?: unknown;
}

interface PluginSchemaResponse {
  id: string;
  schema: ConfigSchemaField[];
  values: Record<string, unknown>;
  hasSchema: boolean;
  manageable: boolean;
}

// Map plugin.types[0] → icon. Plugins can declare multiple types; we pick
// the most characteristic one for the row icon so the glyph reads at a glance.
const TYPE_ICON: Record<PluginType, ComponentType<{ className?: string }>> = {
  datasource: Database,
  context: BookMarked,
  interaction: MessageSquare,
  action: Zap,
  sandbox: Box,
};

function pickIcon(types: PluginType[]): ComponentType<{ className?: string }> {
  return TYPE_ICON[types[0] ?? "context"] ?? Puzzle;
}

function switchTitle(manageable: boolean, enabled: boolean, deployMode: DeployMode): string {
  if (!manageable) {
    return deployMode === "saas" ? "Configuration unavailable" : "Requires internal database";
  }
  return enabled ? "Disable plugin" : "Enable plugin";
}

// ── Status mapping ────────────────────────────────────────────────

// Plugin-specific sr-only label override: this page prefers enabled-semantics
// (Enabled/Disabled) over the default connected-semantics (Connected/Not
// connected) used by most other admin surfaces. Passed inline to CompactRow /
// Shell via their `statusLabel` prop.
const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Enabled",
  transitioning: "Transitioning",
  disconnected: "Disabled",
  unavailable: "Unavailable",
  ready: "Ready",
  unhealthy: "Unhealthy",
};

/**
 * Maps a plugin's (enabled, status) pair to a StatusKind for visual treatment.
 *
 *   enabled=false                               → disconnected (muted)
 *   enabled=true, status=unhealthy              → unavailable (destructive)
 *   enabled=true, status=initializing|teardown  → transitioning (amber)
 *   enabled=true, status=healthy|registered     → connected (teal + pulse)
 *
 * `initializing` and `teardown` are lifted out of `connected` so an operator
 * scanning a long list can spot a plugin stuck mid-transition at a glance.
 * `registered` stays on `connected` because it's the steady state for plugins
 * that don't expose a health probe.
 */
function toStatusKind(plugin: PluginDescription): StatusKind {
  if (!plugin.enabled) return "disconnected";
  switch (plugin.status) {
    case "unhealthy":
      return "unavailable";
    case "initializing":
    case "teardown":
      return "transitioning";
    case "healthy":
    case "registered":
      return "connected";
    default: {
      // Exhaustive guard — adding a new status variant surfaces as a TS error
      // here instead of rendering blank.
      const _exhaustive: never = plugin.status;
      void _exhaustive;
      return "disconnected";
    }
  }
}

function statusSummary(plugin: PluginDescription): string {
  if (!plugin.enabled) return "Disabled";
  switch (plugin.status) {
    case "healthy":
      return "Healthy";
    case "unhealthy":
      return "Unhealthy — health check failed";
    case "initializing":
      return "Initializing…";
    case "registered":
      return "Registered";
    case "teardown":
      return "Shutting down";
    default: {
      // Exhaustive guard — a new status variant surfaces as a TS error here
      // instead of rendering an empty caption.
      const _exhaustive: never = plugin.status;
      void _exhaustive;
      return "Unknown";
    }
  }
}

// ── Plugin Row (compact + expanded) ───────────────────────────────

function PluginRow({
  plugin,
  deployMode,
  manageable,
  checkMutating,
  toggleMutating,
  onHealthCheck,
  onToggle,
}: {
  plugin: PluginDescription;
  deployMode: DeployMode;
  manageable: boolean;
  checkMutating: boolean;
  toggleMutating: boolean;
  onHealthCheck: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const status = toStatusKind(plugin);
  const Icon = pickIcon(plugin.types);
  const description = `v${plugin.version} · ${plugin.types.join(", ")}`;

  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [schema, setSchema] = useState<ConfigSchemaField[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaLoaded, setSchemaLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configManageable, setConfigManageable] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const saveMutation = useAdminMutation<{ message?: string; details?: string[] }>({
    method: "PUT",
  });

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({
      onCollapseCleanup: () => {
        // Full reset on collapse — re-expanding should be a clean fetch rather
        // than reviving a stale edit buffer from a prior session. The old modal
        // Dialog behaved this way (loadSchema ran on every open); keep parity.
        saveMutation.reset();
        setLoadError(null);
        setSuccess(null);
        setSchema([]);
        setValues({});
        setSchemaLoaded(false);
        setConfigManageable(false);
      },
    });

  async function loadSchema() {
    setSchemaLoading(true);
    setLoadError(null);
    setSuccess(null);
    saveMutation.reset();
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(plugin.id)}/schema`,
        { credentials },
      );
      if (!res.ok) {
        // `extractFetchError` captures `{ message, requestId }` from JSON error
        // bodies; `friendlyError` preserves the requestId in the rendered
        // string so operators can correlate with server logs.
        const fetchErr = await extractFetchError(res);
        throw new Error(friendlyError(fetchErr));
      }
      const data: PluginSchemaResponse = await res.json();
      setSchema(data.schema);
      setValues(data.values);
      setConfigManageable(data.manageable);
      setSchemaLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSchemaLoading(false);
    }
  }

  function handleExpand() {
    setExpanded(true);
    if (!schemaLoaded && !schemaLoading) {
      void loadSchema();
    }
  }

  function updateValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSuccess(null);
    const result = await saveMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(plugin.id)}/config`,
      body: values,
      onSuccess: (data) => {
        setSuccess(data?.message ?? "Configuration saved.");
      },
    });
    // Auto-collapse on success so the user is returned to the CompactRow and
    // can see the updated status at a glance. This compounds the collapse-X
    // fix: even if the user ignores the X, a successful save gets them out.
    // Stale buffers are cleared by `useDisclosure`'s cleanup so re-expanding
    // fetches fresh values.
    if (result.ok) collapse();
  }

  if (!expanded) {
    return (
      <CompactRow
        icon={Icon}
        title={plugin.name}
        description={
          // Append the status caption when it carries info the StatusDot alone
          // can't convey — unavailable (why it failed) or transitioning
          // (initializing vs shutting down). Healthy/disabled are obvious from
          // the dot and don't need the extra text.
          status === "unavailable" || status === "transitioning"
            ? `${description} — ${statusSummary(plugin)}`
            : description
        }
        status={status}
        statusLabel={STATUS_LABEL[status]}
        action={
          <Button
            ref={triggerRef}
            size="sm"
            variant="outline"
            aria-expanded={false}
            aria-controls={panelId}
            onClick={handleExpand}
          >
            Configure
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Icon}
      title={plugin.name}
      description={description}
      status={status}
      statusLabel={STATUS_LABEL[status]}
      onCollapse={collapse}
      trailing={
        // Shell's header already wraps `trailing` in a flex container, so we
        // stay flat here — just the caption + Switch pair. Shell also renders
        // the X collapse button alongside trailing when `onCollapse` is
        // provided (the fixer pattern from #1560), so the user is never stuck.
        <>
          <span
            className={cn(
              "text-[10px] font-medium uppercase tracking-[0.08em]",
              status === "connected" && "text-primary",
              status === "transitioning" && "text-amber-600 dark:text-amber-400",
              status === "unavailable" && "text-destructive",
              status === "disconnected" && "text-muted-foreground",
            )}
          >
            {statusSummary(plugin)}
          </span>
          <Switch
            size="sm"
            checked={plugin.enabled}
            onCheckedChange={onToggle}
            disabled={toggleMutating || !manageable}
            title={switchTitle(manageable, plugin.enabled, deployMode)}
          />
        </>
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={checkMutating}
            onClick={onHealthCheck}
          >
            {checkMutating ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Activity className="mr-1.5 size-3.5" />
            )}
            Health check
          </Button>
          {configManageable && schema.length > 0 && (
            <Button size="sm" onClick={handleSave} disabled={saveMutation.saving}>
              {saveMutation.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Save
            </Button>
          )}
        </>
      }
    >
      <DetailList>
        <DetailRow label="ID" value={plugin.id} mono />
        <DetailRow label="Version" value={`v${plugin.version}`} mono />
        <DetailRow label="Types" value={plugin.types.join(", ")} />
        <DetailRow label="Status" value={statusSummary(plugin)} />
      </DetailList>

      {status === "unavailable" && (
        <InlineError>
          {plugin.name} failed its last health check. Run the health check below to retry,
          or disable the plugin until the underlying issue is resolved.
        </InlineError>
      )}

      {schemaLoading ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading configuration…
        </div>
      ) : loadError ? (
        <div className="space-y-2">
          <InlineError>{loadError}</InlineError>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadSchema()}
              disabled={schemaLoading}
            >
              {schemaLoading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Retry
            </Button>
          </div>
        </div>
      ) : schemaLoaded && schema.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This plugin does not expose a config schema.
          {Object.keys(values).length > 0 && (
            <>
              <br />
              <span className="mt-2 block">Current values:</span>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                {JSON.stringify(values, null, 2)}
              </pre>
            </>
          )}
        </p>
      ) : schemaLoaded ? (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {configManageable
              ? deployMode === "saas"
                ? "Changes take effect shortly."
                : "Changes take effect on restart."
              : "Configuration is read-only without an internal database."}
          </p>
          {schema.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`cfg-${plugin.id}-${field.key}`} className="text-xs">
                {field.label ?? field.key}
                {field.required && <span className="text-destructive"> *</span>}
              </Label>

              {field.type === "boolean" ? (
                <div className="flex items-center gap-2">
                  <Switch
                    id={`cfg-${plugin.id}-${field.key}`}
                    checked={Boolean(values[field.key])}
                    onCheckedChange={(v) => updateValue(field.key, v)}
                    disabled={!configManageable}
                  />
                  <span className="text-xs text-muted-foreground">
                    {values[field.key] ? "Enabled" : "Disabled"}
                  </span>
                </div>
              ) : field.type === "select" && field.options ? (
                <Select
                  value={String(values[field.key] ?? "")}
                  onValueChange={(v) => updateValue(field.key, v)}
                  disabled={!configManageable}
                >
                  <SelectTrigger id={`cfg-${plugin.id}-${field.key}`}>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`cfg-${plugin.id}-${field.key}`}
                  type={field.type === "number" ? "number" : field.secret ? "password" : "text"}
                  value={String(values[field.key] ?? "")}
                  onChange={(e) =>
                    updateValue(
                      field.key,
                      field.type === "number" ? Number(e.target.value) : e.target.value,
                    )
                  }
                  placeholder={field.secret ? "••••••" : undefined}
                  className={field.secret ? "font-mono text-sm" : undefined}
                  disabled={!configManageable}
                />
              )}

              {field.description && (
                <p className="text-[11px] text-muted-foreground">{field.description}</p>
              )}
            </div>
          ))}
          {success && (
            <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
              {success}
            </div>
          )}
          <InlineError>{saveMutation.error}</InlineError>
        </div>
      ) : null}
    </Shell>
  );
}

// ── Self-hosted Plugins View ──────────────────────────────────────

function SelfHostedPlugins() {
  const [mutationError, setMutationError] = useState<string | null>(null);
  const checkMutation = useAdminMutation({ method: "POST" });
  const toggleMutation = useAdminMutation({ method: "POST" });

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/plugins",
    { schema: PluginListResponseSchema },
  );

  const displayPlugins = data?.plugins ?? [];
  const manageable = data?.manageable ?? false;

  const stats = {
    installed: displayPlugins.length,
    enabled: displayPlugins.filter((p) => p.enabled).length,
  };

  async function handleHealthCheck(id: string) {
    setMutationError(null);
    const result = await checkMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/health`,
      itemId: id,
      onSuccess: () => refetch(),
    });
    if (!result.ok) setMutationError(`Health check failed for "${id}"`);
  }

  async function handleToggle(id: string, enable: boolean) {
    setMutationError(null);
    const action = enable ? "enable" : "disable";
    const result = await toggleMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/${action}`,
      itemId: id,
      onSuccess: () => refetch(),
    });
    if (!result.ok) setMutationError(`Failed to ${action} plugin "${id}"`);
  }

  return (
    <>
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">Plugins</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(stats.enabled > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(stats.enabled).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(stats.installed).padStart(2, "0")} enabled
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Plugins extend Atlas with additional datasources, tools, and integrations.
          Install new plugins through <code className="font-mono text-xs">atlas.config.ts</code>.
        </p>
      </header>

      {mutationError && (
        <div className="mb-6">
          <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
        </div>
      )}

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Plugins"
        onRetry={refetch}
        loadingMessage="Loading plugins..."
        emptyIcon={Puzzle}
        emptyTitle="No plugins installed"
        emptyDescription="Plugins extend Atlas with additional datasources, tools, and integrations. Add them in atlas.config.ts."
        isEmpty={displayPlugins.length === 0}
      >
        <section>
          <SectionHeading
            title="Installed"
            description="Loaded plugins. Expand to configure, health-check, or toggle."
          />
          <div className="space-y-2">
            {displayPlugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                deployMode="self-hosted"
                manageable={manageable}
                checkMutating={checkMutation.isMutating(plugin.id)}
                toggleMutating={toggleMutation.isMutating(plugin.id)}
                onHealthCheck={() => handleHealthCheck(plugin.id)}
                onToggle={(enabled) => handleToggle(plugin.id, enabled)}
              />
            ))}
          </div>
          <p className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground/80">
            <FileCode2 className="size-3 shrink-0" />
            Manage which plugins are installed via{" "}
            <code className="font-mono">atlas.config.ts</code>.
          </p>
        </section>
      </AdminContentWrapper>
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function PluginsPage() {
  const { deployMode } = useDeployMode();
  const router = useRouter();
  const isSaas = deployMode === "saas";

  // SaaS mode: plugins are managed via dedicated admin pages (Connections,
  // Integrations, Sandbox, etc.) — redirect to admin overview. Must live in
  // an effect so we don't setState on Router during render.
  useEffect(() => {
    if (isSaas) router.replace("/admin");
  }, [isSaas, router]);

  if (isSaas) return null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <ErrorBoundary>
        <SelfHostedPlugins />
      </ErrorBoundary>
    </div>
  );
}
