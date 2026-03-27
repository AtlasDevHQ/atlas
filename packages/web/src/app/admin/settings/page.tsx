"use client";

import { useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormDialog,
  FormField,
  FormItem,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { Separator } from "@/components/ui/separator";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Settings, Pencil, RotateCcw, Loader2, Info, Lock, RefreshCw, Palette, Shield } from "lucide-react";
import { DEFAULT_BRAND_COLOR, OKLCH_RE, applyBrandColor } from "@/ui/hooks/use-dark-mode";

// ── Types ─────────────────────────────────────────────────────────

interface SettingWithValue {
  key: string;
  section: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  default?: string;
  secret?: boolean;
  envVar: string;
  requiresRestart?: boolean;
  scope: "platform" | "workspace";
  currentValue: string | undefined;
  source: "env" | "override" | "workspace-override" | "default";
}

interface SettingsResponse {
  settings: SettingWithValue[];
  manageable: boolean;
}

// ── Source badge ───────────────────────────────────────────────────

function SourceBadge({ source }: { source: "env" | "override" | "workspace-override" | "default" }) {
  if (source === "workspace-override") {
    return (
      <Badge variant="default" className="bg-violet-600 text-[10px]">
        workspace override
      </Badge>
    );
  }
  if (source === "override") {
    return (
      <Badge variant="default" className="text-[10px]">
        override
      </Badge>
    );
  }
  if (source === "env") {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px]">
        env
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      default
    </Badge>
  );
}

// ── Edit Dialog ───────────────────────────────────────────────────

const editSettingSchema = z.object({
  value: z.string(),
});

function SettingControl({
  setting,
  field,
}: {
  setting: SettingWithValue;
  field: { value: string; onChange: (value: string) => void };
}) {
  if (setting.type === "boolean") {
    return (
      <div className="flex items-center gap-3">
        <FormControl>
          <Switch
            checked={field.value === "true"}
            onCheckedChange={(checked) => field.onChange(checked ? "true" : "false")}
          />
        </FormControl>
        <span className="text-sm text-muted-foreground">
          {field.value === "true" ? "Enabled" : "Disabled"}
        </span>
      </div>
    );
  }

  if (setting.type === "select" && setting.options) {
    return (
      <Select value={field.value} onValueChange={field.onChange}>
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          {setting.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <FormControl>
      <Input
        type={setting.type === "number" ? "number" : "text"}
        placeholder={setting.default ?? ""}
        value={field.value}
        onChange={(e) => field.onChange(e.target.value)}
      />
    </FormControl>
  );
}

function EditDialog({
  setting,
  open,
  onOpenChange,
  onSaved,
}: {
  setting: SettingWithValue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const saveMutation = useAdminMutation({
    path: `/api/v1/admin/settings/${encodeURIComponent(setting.key)}`,
    method: "PUT",
    invalidates: onSaved,
  });

  function handleOpenChange(next: boolean) {
    if (next) saveMutation.reset();
    onOpenChange(next);
  }

  async function handleSubmit(values: z.infer<typeof editSettingSchema>) {
    await saveMutation.mutate({
      body: { value: values.value },
      onSuccess: () => onOpenChange(false),
    });
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Edit ${setting.label}`}
      description={setting.description}
      schema={editSettingSchema}
      defaultValues={{ value: setting.currentValue ?? setting.default ?? "" }}
      onSubmit={handleSubmit}
      saving={saveMutation.saving}
      serverError={saveMutation.error}
      className="max-w-md"
    >
      {(form) => (
        <>
          <FormField
            control={form.control}
            name="value"
            render={({ field }) => (
              <FormItem>
                <SettingControl setting={setting} field={field} />
                <FormMessage />
              </FormItem>
            )}
          />
          {setting.default && (
            <p className="text-xs text-muted-foreground">
              Default: <code className="rounded bg-muted px-1">{setting.default}</code>
            </p>
          )}
        </>
      )}
    </FormDialog>
  );
}

// ── Setting Row ───────────────────────────────────────────────────

function SettingRow({
  setting,
  manageable,
  onEdit,
  onReset,
  resetting,
}: {
  setting: SettingWithValue;
  manageable: boolean;
  onEdit: () => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const displayValue = setting.currentValue ?? (
    <span className="text-muted-foreground italic">not set</span>
  );

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{setting.label}</span>
          <SourceBadge source={setting.source} />
          {setting.secret && <Lock className="size-3 text-muted-foreground" />}
          {setting.requiresRestart ? (
            <Badge variant="outline" className="gap-1 text-[10px] text-amber-600 border-amber-500/30 dark:text-amber-400">
              <RefreshCw className="size-2.5" />
              Requires restart
            </Badge>
          ) : !setting.secret ? (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
              Live
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{setting.description}</p>
        <div className="flex items-center gap-1.5">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{setting.envVar}</code>
          <span className="text-xs text-muted-foreground">=</span>
          <span className="truncate text-xs font-mono">
            {typeof displayValue === "string" ? displayValue : displayValue}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!setting.secret && manageable && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onEdit}>
            <Pencil className="mr-1 size-3" />
            Edit
          </Button>
        )}
        {(setting.source === "override" || setting.source === "workspace-override") && manageable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={onReset}
            disabled={resetting}
          >
            {resetting ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <RotateCcw className="mr-1 size-3" />
            )}
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Brand Color Card ──────────────────────────────────────────────

function BrandColorCard({
  setting,
  manageable,
  onSaved,
}: {
  setting: SettingWithValue | undefined;
  manageable: boolean;
  onSaved: () => void;
}) {
  const currentValue = setting?.currentValue ?? DEFAULT_BRAND_COLOR;
  const [value, setValue] = useState(currentValue);
  const isValidOklch = OKLCH_RE.test(value.trim());

  const { mutate, saving, error } = useAdminMutation({
    path: `/api/v1/admin/settings/${encodeURIComponent("ATLAS_BRAND_COLOR")}`,
    invalidates: onSaved,
  });

  // Sync local state when API data changes
  const settingValue = setting?.currentValue;
  const [prevSettingValue, setPrevSettingValue] = useState(settingValue);
  if (settingValue !== prevSettingValue) {
    setPrevSettingValue(settingValue);
    setValue(settingValue ?? DEFAULT_BRAND_COLOR);
  }

  async function handleSave() {
    const result = await mutate({
      method: "PUT",
      body: { value },
    });
    if (result.ok) {
      applyBrandColor(value);
    }
  }

  async function handleReset() {
    const result = await mutate({ method: "DELETE" });
    if (result.ok) {
      setValue(DEFAULT_BRAND_COLOR);
      applyBrandColor(DEFAULT_BRAND_COLOR);
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="size-4" />
          Brand Color
        </CardTitle>
        <CardDescription>
          Primary brand color used for theme tokens (primary, ring, sidebar). Changes apply immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div
            className="size-10 rounded-md border"
            style={{ backgroundColor: value }}
          />
          <div className="flex-1">
            <Input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                applyBrandColor(e.target.value);
              }}
              placeholder={DEFAULT_BRAND_COLOR}
              disabled={!manageable}
              className="font-mono text-sm"
            />
          </div>
        </div>

        {value && !isValidOklch && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Value does not appear to be in oklch format. Expected: <code className="rounded bg-muted px-1">oklch(L C H)</code>
          </p>
        )}

        {(setting?.source === "override" || setting?.source === "workspace-override") && (
          <p className="text-xs text-muted-foreground">
            Default: <code className="rounded bg-muted px-1">{DEFAULT_BRAND_COLOR}</code>
          </p>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {manageable && (
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || value === currentValue || !isValidOklch}
            >
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Save
            </Button>
            {(setting?.source === "override" || setting?.source === "workspace-override") && (
              <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
                <RotateCcw className="mr-1 size-3" />
                Reset to default
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function SettingsPage() {
  const [editSetting, setEditSetting] = useState<SettingWithValue | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<SettingsResponse>(
    "/api/v1/admin/settings",
    {
      transform: (json) => json as SettingsResponse,
    },
  );

  const { mutate: resetSetting, error: mutationError, clearError: clearMutationError, isMutating } =
    useAdminMutation({
      method: "DELETE",
      invalidates: refetch,
    });

  const settings = data?.settings ?? [];
  const manageable = data?.manageable ?? false;

  // Pull out brand color for dedicated card; group rest by scope then section
  const brandColorSetting = settings.find((s) => s.key === "ATLAS_BRAND_COLOR");

  const workspaceSections = new Map<string, SettingWithValue[]>();
  const platformSections = new Map<string, SettingWithValue[]>();
  for (const s of settings) {
    if (s.key === "ATLAS_BRAND_COLOR") continue;
    const target = s.scope === "workspace" ? workspaceSections : platformSections;
    const list = target.get(s.section) ?? [];
    list.push(s);
    target.set(s.section, list);
  }
  const hasPlatformSettings = platformSections.size > 0 || !!brandColorSetting;

  async function handleReset(key: string) {
    await resetSetting({
      path: `/api/v1/admin/settings/${encodeURIComponent(key)}`,
      itemId: key,
    });
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage application configuration
        </p>
      </div>

      <ErrorBoundary>
      <div>
        {mutationError && (
          <ErrorBanner message={mutationError} onRetry={clearMutationError} />
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Settings"
          onRetry={refetch}
          loadingMessage="Loading settings..."
          emptyIcon={Settings}
          emptyTitle="No settings available"
          isEmpty={settings.length === 0}
        >
          {!manageable && (
            <div className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Settings are read-only. To enable overrides, configure{" "}
                <code className="rounded bg-amber-500/10 px-1 font-mono text-xs">DATABASE_URL</code>{" "}
                for the internal database.
              </p>
            </div>
          )}

          {manageable && (
            <div className="mb-6 flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
              <p className="text-sm text-blue-700 dark:text-blue-300">
                Setting overrides are saved to the database. Settings marked{" "}
                <span className="font-medium">Live</span> take effect immediately.
                Settings marked{" "}
                <span className="font-medium">Requires restart</span> need a server
                restart.
              </p>
            </div>
          )}

          <div className="space-y-8">
            {/* Workspace Settings */}
            {workspaceSections.size > 0 && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Workspace Settings</h2>
                  <p className="text-sm text-muted-foreground">
                    Settings that apply to this workspace. Workspace admins can manage these.
                  </p>
                </div>
                <div className="space-y-4">
                  {Array.from(workspaceSections.entries()).map(([section, items]) => (
                    <Card key={section} className="shadow-none">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">{section}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {items.map((setting, i) => (
                          <div key={setting.key}>
                            {i > 0 && <Separator />}
                            <SettingRow
                              setting={setting}
                              manageable={manageable}
                              onEdit={() => setEditSetting(setting)}
                              onReset={() => handleReset(setting.key)}
                              resetting={isMutating(setting.key)}
                            />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Platform Settings — only visible to platform admins */}
            {hasPlatformSettings && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Shield className="size-4 text-muted-foreground" />
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight">Platform Settings</h2>
                    <p className="text-sm text-muted-foreground">
                      Global settings managed by platform administrators. Changes affect all workspaces.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <BrandColorCard
                    setting={brandColorSetting}
                    manageable={manageable}
                    onSaved={refetch}
                  />
                  {Array.from(platformSections.entries()).map(([section, items]) => (
                    <Card key={section} className="shadow-none">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">{section}</CardTitle>
                        {section === "Secrets" && (
                          <CardDescription>
                            Sensitive values are masked and read-only. Manage these via environment variables.
                          </CardDescription>
                        )}
                      </CardHeader>
                      <CardContent>
                        {items.map((setting, i) => (
                          <div key={setting.key}>
                            {i > 0 && <Separator />}
                            <SettingRow
                              setting={setting}
                              manageable={manageable}
                              onEdit={() => setEditSetting(setting)}
                              onReset={() => handleReset(setting.key)}
                              resetting={isMutating(setting.key)}
                            />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        </AdminContentWrapper>
      </div>
      </ErrorBoundary>

      {editSetting && (
        <EditDialog
          setting={editSetting}
          open={!!editSetting}
          onOpenChange={(open) => !open && setEditSetting(null)}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
