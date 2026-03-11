"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { Settings, Pencil, RotateCcw, Loader2, Info, Lock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface SettingDefinition {
  key: string;
  section: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  default?: string;
  secret?: boolean;
  envVar: string;
  currentValue: string | undefined;
  source: "env" | "override" | "default";
}

interface SettingsResponse {
  settings: SettingDefinition[];
  manageable: boolean;
}

// ── Source badge ───────────────────────────────────────────────────

function SourceBadge({ source }: { source: "env" | "override" | "default" }) {
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

function EditDialog({
  setting,
  open,
  onOpenChange,
  onSaved,
  apiUrl,
  credentials,
}: {
  setting: SettingDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  apiUrl: string;
  credentials: RequestCredentials;
}) {
  const [value, setValue] = useState(setting.currentValue ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpen(next: boolean) {
    if (next) {
      setValue(setting.currentValue ?? setting.default ?? "");
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/settings/${encodeURIComponent(setting.key)}`,
        {
          method: "PUT",
          credentials,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {setting.label}</DialogTitle>
          <DialogDescription>{setting.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {setting.type === "boolean" ? (
            <div className="flex items-center gap-3">
              <Switch
                checked={value === "true"}
                onCheckedChange={(checked) => setValue(checked ? "true" : "false")}
              />
              <span className="text-sm text-muted-foreground">
                {value === "true" ? "Enabled" : "Disabled"}
              </span>
            </div>
          ) : setting.type === "select" && setting.options ? (
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger>
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {setting.options.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              type={setting.type === "number" ? "number" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={setting.default ?? ""}
            />
          )}

          {setting.default && (
            <p className="text-xs text-muted-foreground">
              Default: <code className="rounded bg-muted px-1">{setting.default}</code>
            </p>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  setting: SettingDefinition;
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
        {setting.source === "override" && manageable && (
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

// ── Main Page ─────────────────────────────────────────────────────

export default function SettingsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const [editSetting, setEditSetting] = useState<SettingDefinition | null>(null);
  const [resettingKey, setResettingKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<SettingsResponse>(
    "/api/v1/admin/settings",
    {
      transform: (json) => json as SettingsResponse,
    },
  );

  const settings = data?.settings ?? [];
  const manageable = data?.manageable ?? false;

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Manage application configuration</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Settings" />
      </div>
    );
  }

  // Group settings by section
  const sections = new Map<string, SettingDefinition[]>();
  for (const s of settings) {
    const list = sections.get(s.section) ?? [];
    list.push(s);
    sections.set(s.section, list);
  }

  async function handleReset(key: string) {
    setResettingKey(key);
    setMutationError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/settings/${encodeURIComponent(key)}`,
        { method: "DELETE", credentials },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to reset setting");
    } finally {
      setResettingKey(null);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage application configuration
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
        {mutationError && (
          <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
        )}

        {!manageable && !loading && !error && (
          <div className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Settings are read-only. To enable overrides, configure{" "}
              <code className="rounded bg-amber-500/10 px-1 font-mono text-xs">DATABASE_URL</code>{" "}
              for the internal database.
            </p>
          </div>
        )}

        {loading ? (
          <LoadingState message="Loading settings..." />
        ) : settings.length > 0 ? (
          <div className="space-y-6">
            {Array.from(sections.entries()).map(([section, items]) => (
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
                        resetting={resettingKey === setting.key}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !error ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Settings className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No settings available</p>
          </div>
        ) : null}
      </div>

      {editSetting && (
        <EditDialog
          setting={editSetting}
          open={!!editSetting}
          onOpenChange={(open) => !open && setEditSetting(null)}
          onSaved={refetch}
          apiUrl={apiUrl}
          credentials={credentials}
        />
      )}
    </div>
  );
}
