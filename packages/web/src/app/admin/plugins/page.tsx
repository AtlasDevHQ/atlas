"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Puzzle,
  Loader2,
  Settings2,
  FileCode2,
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

function toHealthStatus(status: PluginDescription["status"]) {
  if (status === "healthy") return "healthy" as const;
  if (status === "registered" || status === "initializing") return "unknown" as const;
  return "down" as const;
}

function switchTitle(manageable: boolean, enabled: boolean, deployMode: DeployMode): string {
  if (!manageable) {
    return deployMode === "saas" ? "Configuration unavailable" : "Requires internal database";
  }
  return enabled ? "Disable plugin" : "Enable plugin";
}

// ── Shared: Loaded Plugin Card ───────────────────────────────────

function LoadedPluginCard({
  plugin,
  deployMode,
  manageable,
  checkMutating,
  toggleMutating,
  onHealthCheck,
  onToggle,
  onConfigure,
}: {
  plugin: PluginDescription;
  deployMode: DeployMode;
  manageable: boolean;
  checkMutating: boolean;
  toggleMutating: boolean;
  onHealthCheck: () => void;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
}) {
  return (
    <Card
      className={cn(
        "shadow-none transition-opacity",
        !plugin.enabled && "opacity-60",
      )}
    >
      <CardHeader className="py-3 pb-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="truncate">{plugin.name}</span>
          <Badge variant="outline" className="text-[10px]">
            {plugin.types.join(", ")}
          </Badge>
          {!plugin.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
            <HealthBadge status={toHealthStatus(plugin.status)} />
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={checkMutating}
              onClick={onHealthCheck}
            >
              {checkMutating ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              Health
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onConfigure}
              title="Configure"
            >
              <Settings2 className="size-3.5" />
            </Button>
            <Switch
              size="sm"
              checked={plugin.enabled}
              onCheckedChange={onToggle}
              disabled={toggleMutating || !manageable}
              title={switchTitle(manageable, plugin.enabled, deployMode)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Config Dialog (existing plugins) ─────────────────────────────

function ConfigDialog({
  plugin,
  open,
  onOpenChange,
  deployMode,
}: {
  plugin: PluginDescription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployMode: DeployMode;
}) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [schema, setSchema] = useState<ConfigSchemaField[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [manageable, setManageable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const saveMutation = useAdminMutation<{ message?: string; details?: string[] }>({
    method: "PUT",
  });

  async function loadSchema() {
    setLoading(true);
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
      setManageable(data.manageable);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (next) loadSchema();
    else {
      setSchema([]);
      setValues({});
      setLoadError(null);
      setSuccess(null);
      saveMutation.reset();
    }
    onOpenChange(next);
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {plugin.name}</DialogTitle>
          <DialogDescription>
            {manageable
              ? deployMode === "saas"
                ? "Update plugin configuration. Changes take effect shortly."
                : "Update plugin configuration. Changes take effect on restart."
              : "Configuration is read-only without an internal database."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError && !success ? (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </div>
        ) : schema.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            This plugin does not expose a config schema.
            {Object.keys(values).length > 0 && (
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-muted p-3 text-left text-xs">
                {JSON.stringify(values, null, 2)}
              </pre>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {schema.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`cfg-${field.key}`} className="text-sm">
                  {field.label ?? field.key}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>

                {field.type === "boolean" ? (
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`cfg-${field.key}`}
                      checked={Boolean(values[field.key])}
                      onCheckedChange={(v) => updateValue(field.key, v)}
                      disabled={!manageable}
                    />
                    <span className="text-xs text-muted-foreground">
                      {values[field.key] ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                ) : field.type === "select" && field.options ? (
                  <Select
                    value={String(values[field.key] ?? "")}
                    onValueChange={(v) => updateValue(field.key, v)}
                    disabled={!manageable}
                  >
                    <SelectTrigger id={`cfg-${field.key}`}>
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
                    id={`cfg-${field.key}`}
                    type={field.type === "number" ? "number" : field.secret ? "password" : "text"}
                    value={String(values[field.key] ?? "")}
                    onChange={(e) =>
                      updateValue(
                        field.key,
                        field.type === "number" ? Number(e.target.value) : e.target.value,
                      )
                    }
                    placeholder={field.secret ? "••••••" : undefined}
                    disabled={!manageable}
                  />
                )}

                {field.description && (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                )}
              </div>
            ))}
            {success && (
              <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                {success}
              </div>
            )}
            {saveMutation.error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {saveMutation.error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          {manageable && schema.length > 0 && (
            <Button onClick={handleSave} disabled={saveMutation.saving}>
              {saveMutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Self-hosted Plugins View ─────────────────────────────────────

function SelfHostedPlugins() {
  const [configPlugin, setConfigPlugin] = useState<PluginDescription | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const checkMutation = useAdminMutation({ method: "POST" });
  const toggleMutation = useAdminMutation({ method: "POST" });

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/plugins",
    { schema: PluginListResponseSchema },
  );

  const displayPlugins = data?.plugins ?? [];
  const manageable = data?.manageable ?? false;

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
      {mutationError && (
        <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
      )}

      <div className="mb-4 flex items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <FileCode2 className="size-3.5 shrink-0" />
        <span>Manage plugins via <code className="font-mono">atlas.config.ts</code></span>
      </div>

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {displayPlugins.map((plugin) => (
            <LoadedPluginCard
              key={plugin.id}
              plugin={plugin}
              deployMode="self-hosted"
              manageable={manageable}
              checkMutating={checkMutation.isMutating(plugin.id)}
              toggleMutating={toggleMutation.isMutating(plugin.id)}
              onHealthCheck={() => handleHealthCheck(plugin.id)}
              onToggle={(enabled) => handleToggle(plugin.id, enabled)}
              onConfigure={() => setConfigPlugin(plugin)}
            />
          ))}
        </div>
      </AdminContentWrapper>

      {configPlugin && (
        <ConfigDialog
          plugin={configPlugin}
          open={!!configPlugin}
          onOpenChange={(open) => !open && setConfigPlugin(null)}
          deployMode="self-hosted"
        />
      )}
    </>
  );
}

// ── Main Page ────────────────────────────────────────────────────

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
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          Manage installed plugins
        </p>
      </div>

      <ErrorBoundary>
        <SelfHostedPlugins />
      </ErrorBoundary>
    </div>
  );
}
