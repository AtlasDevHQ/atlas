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
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Puzzle, Loader2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminFetch, useInProgressSet, friendlyError } from "@/ui/hooks/use-admin-fetch";

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
  apiUrl,
  credentials,
}: {
  plugin: PluginDescription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiUrl: string;
  credentials: RequestCredentials;
}) {
  const [schema, setSchema] = useState<ConfigSchemaField[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [manageable, setManageable] = useState(false);

  async function loadSchema() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(plugin.id)}/schema`,
        { credentials },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PluginSchemaResponse = await res.json();
      setSchema(data.schema);
      setValues(data.values);
      setManageable(data.manageable);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (next) loadSchema();
    else {
      setSchema([]);
      setValues({});
      setError(null);
      setSuccess(null);
    }
    onOpenChange(next);
  }

  function updateValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(plugin.id)}/config`,
        {
          method: "PUT",
          credentials,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        const msg = data.details
          ? `${data.message} ${(data.details as string[]).join(" ")}`
          : data.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setSuccess(data.message ?? "Configuration saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {plugin.name}</DialogTitle>
          <DialogDescription>
            {manageable
              ? "Update plugin configuration. Changes take effect on restart."
              : "Configuration is read-only without an internal database."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error && !success ? (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
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
            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          {manageable && schema.length > 0 && (
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
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
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const checking = useInProgressSet();
  const toggling = useInProgressSet();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [configPlugin, setConfigPlugin] = useState<PluginDescription | null>(null);

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

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
          <p className="text-sm text-muted-foreground">Manage installed plugins</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Plugins" />
      </div>
    );
  }

  async function handleHealthCheck(id: string) {
    checking.start(id);
    setMutationError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(id)}/health`, {
        method: "POST",
        credentials,
      });
      if (!res.ok) throw new Error(`Health check failed (HTTP ${res.status})`);
      await refetch();
    } catch (err) {
      setMutationError(
        `Health check failed for "${id}": ${err instanceof Error ? err.message : "Network error"}`,
      );
    } finally {
      checking.stop(id);
    }
  }

  async function handleToggle(id: string, enable: boolean) {
    toggling.start(id);
    setMutationError(null);
    try {
      const action = enable ? "enable" : "disable";
      const res = await fetch(
        `${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(id)}/${action}`,
        { method: "POST", credentials },
      );
      if (!res.ok) throw new Error(`Failed to ${action} plugin (HTTP ${res.status})`);
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Toggle failed");
    } finally {
      toggling.stop(id);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">Manage installed plugins</p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
        {mutationError && (
          <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
        )}

        {loading ? (
          <LoadingState message="Loading plugins..." />
        ) : displayPlugins.length === 0 && !error ? (
          <EmptyState icon={Puzzle} message="No plugins installed" />
        ) : displayPlugins.length > 0 ? (
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
                        disabled={checking.has(plugin.id)}
                        onClick={() => handleHealthCheck(plugin.id)}
                      >
                        {checking.has(plugin.id) ? (
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
                        disabled={toggling.has(plugin.id) || !manageable}
                        title={
                          !manageable
                            ? "Requires internal database"
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
        ) : null}
      </div>

      {configPlugin && (
        <ConfigDialog
          plugin={configPlugin}
          open={!!configPlugin}
          onOpenChange={(open) => !open && setConfigPlugin(null)}
          apiUrl={apiUrl}
          credentials={credentials}
        />
      )}
    </div>
  );
}
