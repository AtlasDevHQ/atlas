"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Puzzle,
  Loader2,
  Settings2,
  Search,
  Download,
  Trash2,
  Store,
  FileCode2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  PluginListResponseSchema,
  AvailablePluginsResponseSchema,
  type CatalogEntry,
} from "@/ui/lib/admin-schemas";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import type { DeployMode } from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────

const PLUGIN_TYPES = ["datasource", "context", "interaction", "action", "sandbox"] as const;
type PluginType = (typeof PLUGIN_TYPES)[number];

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

/** Marketplace-installed plugin with a guaranteed non-null installationId. */
type InstalledCatalogEntry = CatalogEntry & { installationId: string };

function toHealthStatus(status: PluginDescription["status"]) {
  if (status === "healthy") return "healthy" as const;
  if (status === "registered" || status === "initializing") return "unknown" as const;
  return "down" as const;
}

const TYPE_LABELS: Record<PluginType, string> = {
  datasource: "Datasource",
  context: "Context",
  interaction: "Interaction",
  action: "Action",
  sandbox: "Sandbox",
};

function switchTitle(manageable: boolean, enabled: boolean, deployMode: DeployMode): string {
  if (!manageable) {
    return deployMode === "saas" ? "Configuration unavailable" : "Requires internal database";
  }
  return enabled ? "Disable plugin" : "Enable plugin";
}

// ── Shared: Schema-driven Config Fields ──────────────────────────

function SchemaConfigFields({
  properties,
  values,
  onChange,
  idPrefix,
}: {
  properties: Record<string, Record<string, unknown>>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  idPrefix: string;
}) {
  return (
    <div className="space-y-4 py-2">
      {Object.entries(properties).map(([key, prop]) => {
        const fieldType = String(prop.type ?? "string");
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-${key}`} className="text-sm">
              {String(prop.title ?? key)}
            </Label>
            {fieldType === "boolean" ? (
              <div className="flex items-center gap-2">
                <Switch
                  id={`${idPrefix}-${key}`}
                  checked={Boolean(values[key])}
                  onCheckedChange={(v) => onChange(key, v)}
                />
              </div>
            ) : (
              <Input
                id={`${idPrefix}-${key}`}
                type={fieldType === "number" ? "number" : "text"}
                value={String(values[key] ?? "")}
                onChange={(e) =>
                  onChange(key, fieldType === "number" ? Number(e.target.value) : e.target.value)
                }
              />
            )}
            {typeof prop.description === "string" && (
              <p className="text-xs text-muted-foreground">{prop.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getSchemaProperties(configSchema: unknown): Record<string, Record<string, unknown>> {
  const schemaObj = configSchema as Record<string, unknown> | null;
  return (schemaObj?.properties ?? {}) as Record<string, Record<string, unknown>>;
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

// ── Marketplace Config Dialog (workspace-installed plugins) ──────

function MarketplaceConfigDialog({
  plugin,
  open,
  onOpenChange,
  onSaved,
}: {
  plugin: { installationId: string; name: string; config: unknown; configSchema: unknown };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(
    (plugin.config as Record<string, unknown>) ?? {},
  );

  const saveMutation = useAdminMutation({
    method: "PUT",
    path: `/api/v1/admin/plugins/marketplace/${encodeURIComponent(plugin.installationId)}/config`,
    invalidates: onSaved,
  });

  function handleOpenChange(next: boolean) {
    if (next) {
      setValues((plugin.config as Record<string, unknown>) ?? {});
      saveMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleSave() {
    const result = await saveMutation.mutate({ body: { config: values } });
    if (result.ok) handleOpenChange(false);
  }

  const properties = getSchemaProperties(plugin.configSchema);
  const hasFields = Object.keys(properties).length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {plugin.name}</DialogTitle>
          <DialogDescription>
            Update plugin configuration. Changes take effect immediately.
          </DialogDescription>
        </DialogHeader>

        {!hasFields ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Enter configuration as JSON key-value pairs.
            </p>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={JSON.stringify(values, null, 2)}
              onChange={(e) => {
                try {
                  setValues(JSON.parse(e.target.value) as Record<string, unknown>);
                } catch {
                  // intentionally ignored: JSON.parse fails during mid-keystroke editing; state preserves last valid value
                }
              }}
            />
          </div>
        ) : (
          <SchemaConfigFields
            properties={properties}
            values={values}
            onChange={(key, val) => setValues((p) => ({ ...p, [key]: val }))}
            idPrefix="mkt-cfg"
          />
        )}

        {saveMutation.error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {saveMutation.error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saveMutation.saving}>
            {saveMutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Install Dialog ───────────────────────────────────────────────

function InstallDialog({
  plugin,
  open,
  onOpenChange,
  onInstalled,
}: {
  plugin: CatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const installMutation = useAdminMutation({
    method: "POST",
    path: "/api/v1/admin/plugins/marketplace/install",
    invalidates: onInstalled,
  });

  function handleOpenChange(next: boolean) {
    if (next) {
      setConfig({});
      installMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleInstall() {
    const body: Record<string, unknown> = { catalogId: plugin.id };
    if (Object.keys(config).length > 0) body.config = config;
    const result = await installMutation.mutate({ body });
    if (result.ok) handleOpenChange(false);
  }

  const properties = getSchemaProperties(plugin.configSchema);
  const hasConfig = Object.keys(properties).length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install {plugin.name}</DialogTitle>
          <DialogDescription>
            {hasConfig
              ? "Configure the plugin before installing."
              : `Install "${plugin.name}" into your workspace. It will be available immediately.`}
          </DialogDescription>
        </DialogHeader>

        {hasConfig && (
          <SchemaConfigFields
            properties={properties}
            values={config}
            onChange={(key, val) => setConfig((p) => ({ ...p, [key]: val }))}
            idPrefix="inst-cfg"
          />
        )}

        {installMutation.error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {installMutation.error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={installMutation.saving}>
            {installMutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Search + Filter Bar ──────────────────────────────────────────

function PluginFilterBar({
  search,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  typeFilter: string;
  onTypeFilterChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search plugins..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
      <Select value={typeFilter} onValueChange={onTypeFilterChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {PLUGIN_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {TYPE_LABELS[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Installed Tab ────────────────────────────────────────────────

function InstalledTab({
  deployMode,
  marketplacePlugins,
  refetchMarketplace,
}: {
  deployMode: DeployMode;
  marketplacePlugins: CatalogEntry[];
  refetchMarketplace: () => void;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [configPlugin, setConfigPlugin] = useState<PluginDescription | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<{ id: string; name: string } | null>(null);
  const [mktConfigTarget, setMktConfigTarget] = useState<{
    installationId: string;
    name: string;
    config: unknown;
    configSchema: unknown;
  } | null>(null);

  const checkMutation = useAdminMutation({ method: "POST" });
  const toggleMutation = useAdminMutation({ method: "POST" });
  const uninstallMutation = useAdminMutation({ method: "DELETE" });

  // Loaded plugins (config-file + runtime)
  const { data: pluginData, loading: pluginsLoading, error: pluginsError, refetch: refetchPlugins } =
    useAdminFetch("/api/v1/admin/plugins", { schema: PluginListResponseSchema });

  const loadedPlugins = pluginData?.plugins ?? [];
  const manageable = pluginData?.manageable ?? false;

  // Marketplace-installed plugins — type guard ensures installationId is string
  const marketplaceInstalled = marketplacePlugins.filter(
    (p): p is InstalledCatalogEntry => p.installed === true && typeof p.installationId === "string",
  );

  function refetchAll() {
    refetchPlugins();
    refetchMarketplace();
  }

  // Filter loaded plugins
  const filteredLoaded = loadedPlugins.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter !== "all" && !p.types.includes(typeFilter as PluginType)) return false;
    return true;
  });

  // Filter marketplace-installed
  const filteredMarketplace = marketplaceInstalled.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter !== "all" && p.type !== typeFilter) return false;
    return true;
  });

  const totalInstalled = filteredLoaded.length + filteredMarketplace.length;
  const isLoading = pluginsLoading;
  const hasFilters = search !== "" || typeFilter !== "all";

  async function handleHealthCheck(id: string) {
    setMutationError(null);
    const result = await checkMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/health`,
      itemId: id,
      onSuccess: () => refetchPlugins(),
    });
    if (!result.ok) setMutationError(`Health check failed for "${id}"`);
  }

  async function handleToggle(id: string, enable: boolean) {
    setMutationError(null);
    const action = enable ? "enable" : "disable";
    const result = await toggleMutation.mutate({
      path: `/api/v1/admin/plugins/${encodeURIComponent(id)}/${action}`,
      itemId: id,
      onSuccess: () => refetchPlugins(),
    });
    if (!result.ok) setMutationError(`Failed to ${action} plugin "${id}"`);
  }

  async function handleUninstall() {
    if (!uninstallTarget) return;
    setMutationError(null);
    const result = await uninstallMutation.mutate({
      path: `/api/v1/admin/plugins/marketplace/${encodeURIComponent(uninstallTarget.id)}`,
      method: "DELETE",
    });
    if (result.ok) {
      refetchAll();
    } else {
      setMutationError(`Failed to uninstall "${uninstallTarget.name}"`);
    }
    setUninstallTarget(null);
  }

  return (
    <div className="space-y-4">
      <PluginFilterBar
        search={search}
        onSearchChange={setSearch}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
      />

      {mutationError && (
        <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
      )}

      <AdminContentWrapper
        loading={isLoading}
        error={pluginsError}
        feature="Plugins"
        onRetry={refetchAll}
        loadingMessage="Loading plugins..."
        emptyIcon={Puzzle}
        emptyTitle="No plugins installed"
        emptyDescription={
          deployMode === "saas"
            ? "Browse the Available tab to install plugins from the marketplace."
            : "Plugins extend Atlas with additional datasources, tools, and integrations."
        }
        hasFilters={hasFilters}
        onClearFilters={() => { setSearch(""); setTypeFilter("all"); }}
        isEmpty={totalInstalled === 0}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Config-file / runtime plugins */}
          {filteredLoaded.map((plugin) => (
            <LoadedPluginCard
              key={`loaded-${plugin.id}`}
              plugin={plugin}
              deployMode={deployMode}
              manageable={manageable}
              checkMutating={checkMutation.isMutating(plugin.id)}
              toggleMutating={toggleMutation.isMutating(plugin.id)}
              onHealthCheck={() => handleHealthCheck(plugin.id)}
              onToggle={(enabled) => handleToggle(plugin.id, enabled)}
              onConfigure={() => setConfigPlugin(plugin)}
            />
          ))}

          {/* Marketplace-installed plugins */}
          {filteredMarketplace.map((plugin) => (
            <Card key={`mkt-${plugin.id}`} className="shadow-none">
              <CardHeader className="py-3 pb-1">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className="truncate">{plugin.name}</span>
                  {plugin.type && (
                    <Badge variant="outline" className="text-[10px]">
                      {plugin.type}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-[10px]">
                    marketplace
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                {plugin.description && (
                  <p className="mb-2 text-xs text-muted-foreground line-clamp-2">
                    {plugin.description}
                  </p>
                )}
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() =>
                      setMktConfigTarget({
                        installationId: plugin.installationId,
                        name: plugin.name,
                        config: {},
                        configSchema: plugin.configSchema,
                      })
                    }
                    title="Configure"
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-destructive hover:text-destructive"
                    onClick={() =>
                      setUninstallTarget({
                        id: plugin.installationId,
                        name: plugin.name,
                      })
                    }
                    title="Uninstall"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </AdminContentWrapper>

      {/* Config dialog — loaded plugins */}
      {configPlugin && (
        <ConfigDialog
          plugin={configPlugin}
          open={!!configPlugin}
          onOpenChange={(open) => !open && setConfigPlugin(null)}
          deployMode={deployMode}
        />
      )}

      {/* Config dialog — marketplace plugins */}
      {mktConfigTarget && (
        <MarketplaceConfigDialog
          plugin={mktConfigTarget}
          open={!!mktConfigTarget}
          onOpenChange={(open) => !open && setMktConfigTarget(null)}
          onSaved={refetchAll}
        />
      )}

      {/* Uninstall confirmation */}
      <AlertDialog open={!!uninstallTarget} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {uninstallTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the plugin from your workspace. You can reinstall it later from the
              Available tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uninstallMutation.saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Available Tab ────────────────────────────────────────────────

function AvailableTab({
  marketplacePlugins,
  loading,
  error,
  refetch,
}: {
  marketplacePlugins: CatalogEntry[];
  loading: boolean;
  error: ReturnType<typeof useAdminFetch>["error"];
  refetch: () => void;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [installTarget, setInstallTarget] = useState<CatalogEntry | null>(null);

  // Only show not-yet-installed
  const notInstalled = marketplacePlugins.filter((p) => !p.installed);

  const filtered = notInstalled.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter !== "all" && p.type !== typeFilter) return false;
    return true;
  });

  const hasFilters = search !== "" || typeFilter !== "all";

  return (
    <div className="space-y-4">
      <PluginFilterBar
        search={search}
        onSearchChange={setSearch}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
      />

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Plugin Marketplace"
        onRetry={refetch}
        loadingMessage="Loading available plugins..."
        emptyIcon={Store}
        emptyTitle="All plugins installed"
        emptyDescription="You've installed every plugin available for your plan. Check back later for new additions."
        hasFilters={hasFilters}
        onClearFilters={() => { setSearch(""); setTypeFilter("all"); }}
        isEmpty={filtered.length === 0}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((plugin) => (
            <Card key={plugin.id} className="shadow-none">
              <CardHeader className="py-3 pb-1">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className="truncate">{plugin.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {plugin.type}
                  </Badge>
                  {plugin.minPlan === "enterprise" && (
                    <Badge variant="secondary" className="text-[10px]">
                      Enterprise
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                {plugin.description && (
                  <p className="mb-3 text-xs text-muted-foreground line-clamp-2">
                    {plugin.description}
                  </p>
                )}
                <div className="flex items-center justify-end">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setInstallTarget(plugin)}
                  >
                    <Download className="mr-1 size-3" />
                    Install
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </AdminContentWrapper>

      {installTarget && (
        <InstallDialog
          plugin={installTarget}
          open={!!installTarget}
          onOpenChange={(open) => !open && setInstallTarget(null)}
          onInstalled={refetch}
        />
      )}
    </div>
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

  // Marketplace available plugins — fetched once, shared by both tabs (SaaS only)
  const { data: availableData, loading: availableLoading, error: availableError, refetch: refetchAvailable } =
    useAdminFetch(
      "/api/v1/admin/plugins/marketplace/available",
      { schema: AvailablePluginsResponseSchema },
    );

  const marketplacePlugins = availableData?.plugins ?? [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          {deployMode === "saas"
            ? "Browse and manage plugins for your workspace"
            : "Manage installed plugins"}
        </p>
      </div>

      <ErrorBoundary>
        {deployMode === "saas" ? (
          <Tabs defaultValue="installed">
            <TabsList className="mb-4">
              <TabsTrigger value="installed">Installed</TabsTrigger>
              <TabsTrigger value="available">Available</TabsTrigger>
            </TabsList>
            <TabsContent value="installed">
              <InstalledTab
                deployMode={deployMode}
                marketplacePlugins={marketplacePlugins}
                refetchMarketplace={refetchAvailable}
              />
            </TabsContent>
            <TabsContent value="available">
              <AvailableTab
                marketplacePlugins={marketplacePlugins}
                loading={availableLoading}
                error={availableError}
                refetch={refetchAvailable}
              />
            </TabsContent>
          </Tabs>
        ) : (
          <SelfHostedPlugins />
        )}
      </ErrorBoundary>
    </div>
  );
}
