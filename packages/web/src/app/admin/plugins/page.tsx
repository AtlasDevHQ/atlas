"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
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
  Puzzle,
  Loader2,
  FileCode2,
  Database,
  BookMarked,
  MessageSquare,
  Zap,
  Box,
  Activity,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  PluginListResponseSchema,
} from "@/ui/lib/admin-schemas";
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

// ── Shared design primitives ──────────────────────────────────────
// Intentionally duplicated in several admin pages until the shape is stable
// enough to extract. Tracked in #1551.

type StatusKind = "connected" | "disconnected" | "unavailable";

const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Enabled",
  disconnected: "Disabled",
  unavailable: "Unavailable",
};

function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,_var(--primary)_15%,_transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" &&
          "bg-destructive/70 outline-1 outline-dashed outline-destructive/40",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
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

function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: ReactNode;
  status: StatusKind;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "unavailable" && "border-destructive/20",
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
          <StatusDot kind={status} />
          <span className="sr-only">Status: {STATUS_LABEL[status]}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function PluginShell({
  id,
  icon: Icon,
  title,
  description,
  status,
  trailing,
  onCollapse,
  children,
  actions,
  panelRef,
}: {
  id?: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: ReactNode;
  status: StatusKind;
  trailing?: ReactNode;
  onCollapse?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <section
      id={id}
      ref={panelRef}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 transition-colors",
        status === "connected" && "border-primary/20",
        status === "unavailable" && "border-destructive/20",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}
      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status === "disconnected" && "text-muted-foreground",
            status === "unavailable" && "border-destructive/30 text-destructive",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {trailing ? (
              <div className="ml-auto flex items-center gap-1.5">{trailing}</div>
            ) : status === "connected" ? (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                Live
              </span>
            ) : onCollapse ? (
              <button
                type="button"
                aria-label="Collapse"
                onClick={onCollapse}
                className="ml-auto -m-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
      </header>
      {children != null && (
        <div className="flex-1 space-y-4 px-4 pb-3 text-sm">{children}</div>
      )}
      {actions && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", mono ? "font-mono text-[11px]" : "font-medium")}>
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

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

/**
 * Progressive-disclosure helper. Auto-collapses once a plugin's state changes
 * (enable toggled, config saved) so a later re-expand doesn't sit under a
 * stale expanded=true flag. Clears the owning mutation's error on explicit
 * collapse so the X can never silently hide a failure.
 */
function useDisclosure(onCollapseCleanup?: () => void) {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const prev = useRef(false);

  useEffect(() => {
    if (expanded && !prev.current) {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), button[role="combobox"]:not([disabled])',
      );
      first?.focus();
    } else if (!expanded && prev.current) {
      triggerRef.current?.focus();
    }
    prev.current = expanded;
  }, [expanded]);

  const collapse = () => {
    setExpanded(false);
    onCollapseCleanup?.();
  };

  return { expanded, setExpanded, collapse, triggerRef, panelRef, panelId };
}

// ── Status mapping ────────────────────────────────────────────────

/**
 * Maps a plugin's (enabled, status) pair to a StatusKind for visual treatment.
 *
 *   enabled=false  → disconnected (muted dot, no emphasis)
 *   enabled=true, status=unhealthy → unavailable (destructive accent + inline-error)
 *   enabled=true, status=healthy|registered|initializing|teardown → connected
 */
function toStatusKind(plugin: PluginDescription): StatusKind {
  if (!plugin.enabled) return "disconnected";
  if (plugin.status === "unhealthy") return "unavailable";
  return "connected";
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
    useDisclosure(() => {
      saveMutation.reset();
      setLoadError(null);
      setSuccess(null);
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
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.message ?? `HTTP ${res.status}`);
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
    await saveMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(plugin.id)}/config`,
      body: values,
      onSuccess: (data) => {
        setSuccess(data?.message ?? "Configuration saved.");
      },
    });
  }

  if (!expanded) {
    return (
      <CompactRow
        icon={Icon}
        title={plugin.name}
        description={
          status === "unavailable"
            ? `${description} — ${statusSummary(plugin)}`
            : description
        }
        status={status}
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
    <PluginShell
      id={panelId}
      panelRef={panelRef}
      icon={Icon}
      title={plugin.name}
      description={description}
      status={status}
      onCollapse={collapse}
      trailing={
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {statusSummary(plugin)}
          </span>
          <Switch
            size="sm"
            checked={plugin.enabled}
            onCheckedChange={onToggle}
            disabled={toggleMutating || !manageable}
            title={switchTitle(manageable, plugin.enabled, deployMode)}
          />
        </div>
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
        <InlineError>{loadError}</InlineError>
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
    </PluginShell>
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

  // SaaS mode: plugins are managed via dedicated admin pages (Connections,
  // Integrations, Sandbox, etc.) — redirect to admin overview.
  if (deployMode === "saas") {
    router.replace("/admin");
    return null;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <ErrorBoundary>
        <SelfHostedPlugins />
      </ErrorBoundary>
    </div>
  );
}
