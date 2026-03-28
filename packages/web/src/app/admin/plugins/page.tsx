"use client";

import { useState } from "react";
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
import { Puzzle, Loader2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";

// ── Types ─────────────────────────────────────────────────────────

interface PluginDescription {
  id: string;
  types: ("datasource" | "context" | "interaction" | "action" | "sandbox")[];
  version: string;
  name: string;
  status: "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";
  enabled: boolean;
}

interface PluginListResponse {
  plugins?: PluginDescription[];
  manageable?: boolean;
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

// ── Config Dialog ─────────────────────────────────────────────────

function ConfigDialog({
  plugin,
  open,
  onOpenChange,
  deployMode,
}: {
  plugin: PluginDescription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployMode: "saas" | "self-hosted";
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
      setLoadError(err instanceof Error ? err.message : "Failed to load config");
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

// ── Main Page ─────────────────────────────────────────────────────

export default function PluginsPage() {
  const checkMutation = useAdminMutation({ method: "POST" });
  const toggleMutation = useAdminMutation({ method: "POST" });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [configPlugin, setConfigPlugin] = useState<PluginDescription | null>(null);
  const { deployMode } = useDeployMode();

  const { data, loading, error, refetch } = useAdminFetch<{
    plugins: PluginDescription[];
    manageable: boolean;
  }>("/api/v1/admin/plugins", {
    transform: (json) => {
      const resp = json as PluginListResponse;
      return {
        plugins: resp.plugins ?? [],
        manageable: resp.manageable ?? false,
      };
    },
  });

  const displayPlugins = data?.plugins ?? [];
  const manageable = data?.manageable ?? false;

  async function handleHealthCheck(id: string) {
    setMutationError(null);
    const result = await checkMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/health`,
      itemId: id,
      onSuccess: () => refetch(),
    });
    if (!result.ok) {
      setMutationError(`Health check failed for "${id}"`);
    }
  }

  async function handleToggle(id: string, enable: boolean) {
    setMutationError(null);
    const action = enable ? "enable" : "disable";
    const result = await toggleMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/${action}`,
      itemId: id,
      onSuccess: () => refetch(),
    });
    if (!result.ok) {
      setMutationError(`Failed to ${action} plugin "${id}"`);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">Manage installed plugins</p>
      </div>

      <ErrorBoundary>
      <div>
        {mutationError && (
          <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Plugins"
          onRetry={refetch}
          loadingMessage="Loading plugins..."
          emptyIcon={Puzzle}
          emptyTitle="No plugins installed"
          emptyDescription="Plugins extend Atlas with additional datasources, tools, and integrations"
          isEmpty={displayPlugins.length === 0}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {displayPlugins.map((plugin) => (
              <Card
                key={plugin.id}
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
                        disabled={checkMutation.isMutating(plugin.id)}
                        onClick={() => handleHealthCheck(plugin.id)}
                      >
                        {checkMutation.isMutating(plugin.id) ? (
                          <Loader2 className="mr-1 size-3 animate-spin" />
                        ) : null}
                        Health
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => setConfigPlugin(plugin)}
                        title="Configure"
                      >
                        <Settings2 className="size-3.5" />
                      </Button>
                      <Switch
                        size="sm"
                        checked={plugin.enabled}
                        onCheckedChange={(checked) => handleToggle(plugin.id, checked)}
                        disabled={toggleMutation.isMutating(plugin.id) || !manageable}
                        title={
                          !manageable
                            ? deployMode === "saas"
                              ? "Configuration unavailable"
                              : "Requires internal database"
                            : plugin.enabled
                              ? "Disable plugin"
                              : "Enable plugin"
                        }
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </AdminContentWrapper>
      </div>
      </ErrorBoundary>

      {configPlugin && (
        <ConfigDialog
          plugin={configPlugin}
          open={!!configPlugin}
          onOpenChange={(open) => !open && setConfigPlugin(null)}
          deployMode={deployMode}
        />
      )}
    </div>
  );
}
