"use client";

import { useState, type ComponentType } from "react";
import { z } from "zod";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { cn } from "@/lib/utils";
import {
  Bot,
  Brain,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  Info,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Settings,
  Timer,
} from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const SettingSourceSchema = z.enum(["env", "override", "workspace-override", "default"]);
type SettingSource = z.infer<typeof SettingSourceSchema>;

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
  source: SettingSourceSchema,
});
type SettingWithValue = z.infer<typeof SettingWithValueSchema>;

const SettingsResponseSchema = z.object({
  settings: z.array(SettingWithValueSchema),
  manageable: z.boolean(),
});

// ── Section metadata ──────────────────────────────────────────────

const SECTION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "Query Limits": Database,
  "Rate Limiting": Gauge,
  Sessions: Timer,
  Sandbox: Cpu,
  Agent: Bot,
  Intelligence: Brain,
  Demo: FlaskConical,
};

const SECTION_ORDER = [
  "Query Limits",
  "Rate Limiting",
  "Sessions",
  "Sandbox",
  "Agent",
  "Intelligence",
  "Demo",
];

function sectionIcon(section: string): ComponentType<{ className?: string }> {
  return SECTION_ICONS[section] ?? Settings;
}

// ── Source pill ───────────────────────────────────────────────────
// Only rendered when source !== "default" — default is the default state,
// and labeling it on every row was pure noise.

function SourcePill({ source }: { source: Exclude<SettingSource, "default"> }) {
  const tone =
    source === "workspace-override"
      ? "text-violet-600 dark:text-violet-400"
      : source === "override"
        ? "text-primary"
        : "text-emerald-600 dark:text-emerald-400";
  const dotTone =
    source === "workspace-override"
      ? "bg-violet-500"
      : source === "override"
        ? "bg-primary"
        : "bg-emerald-500";
  const label =
    source === "workspace-override" ? "Workspace" : source === "override" ? "Override" : "Env";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        tone,
      )}
    >
      <span className={cn("size-1.5 rounded-full", dotTone)} />
      {label}
    </span>
  );
}

// ── Setting control (reused for dialog) ───────────────────────────

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

// ── Section + row primitives ──────────────────────────────────────

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      {description && (
        <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
      )}
    </div>
  );
}

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
  const Icon = sectionIcon(setting.section);
  const isOverride =
    setting.source === "override" || setting.source === "workspace-override";
  const showRestart = !isSaas && setting.requiresRestart && isOverride;
  const valueText = setting.currentValue ?? "—";

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-xl border bg-card/40 px-3.5 py-3 transition-colors",
        "hover:border-border/80 hover:bg-card/70",
        isOverride && "border-primary/15",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40",
          isOverride ? "border-primary/20 text-primary" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {setting.label}
          </h3>
          {setting.secret && <Lock className="size-3 text-muted-foreground" />}
          {setting.source !== "default" && <SourcePill source={setting.source} />}
          {showRestart && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400">
              <RefreshCw className="size-2.5" />
              Restart
            </span>
          )}
        </div>
        <p className="text-xs leading-snug text-muted-foreground">{setting.description}</p>
        <div className="flex flex-wrap items-baseline gap-x-2 pt-0.5">
          {!isSaas && (
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {setting.envVar}
            </code>
          )}
          <span
            className={cn(
              "truncate font-mono text-[11px]",
              setting.currentValue ? "text-foreground/80" : "text-muted-foreground/70",
            )}
          >
            {valueText}
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
        {isOverride && manageable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={onReset}
            disabled={resetting}
            aria-label={`Reset ${setting.label} to default`}
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

  const {
    mutate: resetSetting,
    error: mutationError,
    clearError: clearMutationError,
    isMutating,
  } = useAdminMutation({
    method: "DELETE",
    invalidates: refetch,
  });

  const settings = data?.settings ?? [];
  const manageable = data?.manageable ?? false;

  // Only workspace-scoped settings — platform settings live at /admin/platform/settings
  const workspaceSections = new Map<string, SettingWithValue[]>();
  for (const s of settings) {
    if (s.scope !== "workspace") continue;
    const list = workspaceSections.get(s.section) ?? [];
    list.push(s);
    workspaceSections.set(s.section, list);
  }

  const orderedSections = SECTION_ORDER.filter((s) => workspaceSections.has(s)).concat(
    [...workspaceSections.keys()].filter((s) => !SECTION_ORDER.includes(s)),
  );

  const overrideCount = settings.filter(
    (s) =>
      s.scope === "workspace" &&
      (s.source === "override" || s.source === "workspace-override"),
  ).length;
  const totalCount = settings.filter((s) => s.scope === "workspace").length;

  async function handleReset(key: string) {
    await resetSetting({
      path: `/api/v1/admin/settings/${encodeURIComponent(key)}`,
      itemId: key,
    });
  }

  const subtitle = !manageable
    ? "Read-only — configure an internal database to enable overrides."
    : isSaas
      ? "Overrides save and take effect immediately."
      : "Overrides persist to the internal database. Some keys require a server restart.";

  return (
    <div className="p-6">
      <ErrorBoundary>
        <div className="mx-auto mb-8 flex max-w-3xl items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Workspace Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          {totalCount > 0 && (
            <div className="shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {String(overrideCount).padStart(2, "0")} / {String(totalCount).padStart(2, "0")}{" "}
              <span className="text-muted-foreground/60">overridden</span>
            </div>
          )}
        </div>

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
          <div className="mx-auto max-w-3xl space-y-8">
            {mutationError && (
              <ErrorBanner message={mutationError} onRetry={clearMutationError} />
            )}

            {!manageable && !isSaas && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Settings are read-only. To enable overrides, configure{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono text-xs">
                    DATABASE_URL
                  </code>{" "}
                  for the internal database.
                </p>
              </div>
            )}

            {orderedSections.map((section) => {
              const items = workspaceSections.get(section) ?? [];
              return (
                <section key={section}>
                  <SectionHeading title={section} />
                  <div className="space-y-2">
                    {items.map((setting) => (
                      <SettingRow
                        key={setting.key}
                        setting={setting}
                        manageable={manageable}
                        onEdit={() => setEditSetting(setting)}
                        onReset={() => handleReset(setting.key)}
                        resetting={isMutating(setting.key)}
                        deployMode={deployMode}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </AdminContentWrapper>
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
