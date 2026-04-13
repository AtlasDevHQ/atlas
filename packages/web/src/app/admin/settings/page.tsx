"use client";

import { useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { Settings, Pencil, RotateCcw, Loader2, Info, Lock, RefreshCw } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const SettingWithValueSchema = z.object({
  key: z.string(),
  section: z.string(),
  label: z.string(),
  description: z.string(),
  type: z.enum(["string", "number", "boolean", "select"]),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  secret: z.boolean().optional(),
  envVar: z.string(),
  requiresRestart: z.boolean().optional(),
  scope: z.enum(["platform", "workspace"]),
  currentValue: z.string().optional(),
  source: z.enum(["env", "override", "workspace-override", "default"]),
});
type SettingWithValue = z.infer<typeof SettingWithValueSchema>;

const SettingsResponseSchema = z.object({
  settings: z.array(SettingWithValueSchema),
  manageable: z.boolean(),
});

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
  deployMode,
}: {
  setting: SettingWithValue;
  manageable: boolean;
  onEdit: () => void;
  onReset: () => void;
  resetting: boolean;
  deployMode: "saas" | "self-hosted";
}) {
  const isSaas = deployMode === "saas";
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
          {!isSaas && setting.requiresRestart ? (
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
          {!isSaas && (
            <>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{setting.envVar}</code>
              <span className="text-xs text-muted-foreground">=</span>
            </>
          )}
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

// ── Main Page ─────────────────────────────────────────────────────

export default function SettingsPage() {
  const [editSetting, setEditSetting] = useState<SettingWithValue | null>(null);
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/settings",
    { schema: SettingsResponseSchema },
  );

  const { mutate: resetSetting, error: mutationError, clearError: clearMutationError, isMutating } =
    useAdminMutation({
      method: "DELETE",
      invalidates: refetch,
    });

  const settings = data?.settings ?? [];
  const manageable = data?.manageable ?? false;

  // Only show workspace-scoped settings — platform settings live at /admin/platform/settings
  const workspaceSections = new Map<string, SettingWithValue[]>();
  for (const s of settings) {
    if (s.scope !== "workspace") continue;
    const list = workspaceSections.get(s.section) ?? [];
    list.push(s);
    workspaceSections.set(s.section, list);
  }

  async function handleReset(key: string) {
    await resetSetting({
      path: `/api/v1/admin/settings/${encodeURIComponent(key)}`,
      itemId: key,
    });
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Workspace Settings</h1>
        <p className="text-sm text-muted-foreground">
          Settings that apply to this workspace
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
          isEmpty={workspaceSections.size === 0}
        >
          {!manageable && !isSaas && (
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
            <div className="mb-6 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <p className="text-sm text-primary dark:text-primary/80">
                {isSaas
                  ? "Setting overrides are saved and take effect immediately."
                  : <>
                      Setting overrides are saved to the database. Settings marked{" "}
                      <span className="font-medium">Live</span> take effect immediately.
                      Settings marked{" "}
                      <span className="font-medium">Requires restart</span> need a server
                      restart.
                    </>
                }
              </p>
            </div>
          )}

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
                        deployMode={deployMode}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
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
