"use client";

/**
 * Admin → Settings → MCP
 *
 * Surfaces the MCP-prompts toggles in a dedicated page so admins find
 * "do I expose canonical eval prompts to my agents?" without scanning
 * the broader workspace settings list. Today the only knob is
 * `ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS` (#2076); future MCP-surface
 * settings (e.g. tool description overrides, hosted-MCP region pin)
 * will land here too.
 *
 * The page is read-only when the workspace has no internal DB
 * (settings persistence requires `DATABASE_URL`).
 */

import { useState } from "react";
import { z } from "zod";
import { Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";

const SettingSchema = z.object({
  key: z.string(),
  section: z.string(),
  label: z.string(),
  description: z.string(),
  type: z.enum(["string", "number", "boolean", "select"]),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  envVar: z.string(),
  scope: z.enum(["platform", "workspace"]),
  currentValue: z.string().optional(),
  source: z.enum(["env", "override", "workspace-override", "default"]),
});

const SettingsResponseSchema = z.object({
  settings: z.array(SettingSchema),
  manageable: z.boolean(),
});

type Setting = z.infer<typeof SettingSchema>;

const CANONICAL_KEY = "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS";

const TOGGLE_DESCRIPTIONS: Record<string, string> = {
  auto: "Expose canonical prompts only when this workspace looks like a demo workspace (active __demo__ connection or onboarding industry set).",
  always:
    "Always expose the 20 NovaMart canonical prompts, including in real-data workspaces. Useful when you want them as worked examples.",
  never:
    "Never expose canonical prompts on this workspace. The built-in templates and your own query patterns still appear.",
};

export default function McpSettingsPage() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/settings",
    { schema: SettingsResponseSchema },
  );

  const canonical = (data?.settings ?? []).find((s) => s.key === CANONICAL_KEY);
  const manageable = data?.manageable ?? false;

  return (
    <div className="p-6">
      <ErrorBoundary>
        <header className="mx-auto mb-8 max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">MCP Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Control what your MCP-connected agents can see in their prompt
            picker.
          </p>
        </header>

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="MCP Settings"
          onRetry={refetch}
          loadingMessage="Loading MCP settings..."
        >
          <div className="mx-auto max-w-2xl space-y-6">
            {canonical ? (
              <CanonicalToggle
                setting={canonical}
                manageable={manageable}
                onSaved={refetch}
              />
            ) : (
              <p className="rounded-xl border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                Canonical prompts setting unavailable. Make sure the API server
                is up to date.
              </p>
            )}
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}

function CanonicalToggle({
  setting,
  manageable,
  onSaved,
}: {
  setting: Setting;
  manageable: boolean;
  onSaved: () => void;
}) {
  const value = setting.currentValue ?? setting.default ?? "auto";
  const options = setting.options ?? ["auto", "always", "never"];

  const [pending, setPending] = useState<string | null>(null);
  const saveMutation = useAdminMutation({
    path: `/api/v1/admin/settings/${encodeURIComponent(setting.key)}`,
    method: "PUT",
    invalidates: () => {
      setPending(null);
      onSaved();
    },
  });

  async function handleChange(next: string) {
    if (next === value) return;
    setPending(next);
    const result = await saveMutation.mutate({ body: { value: next } });
    if (!result.ok) setPending(null);
  }

  const display = pending ?? value;

  return (
    <section className="rounded-2xl border bg-card/60 p-6 shadow-sm">
      <MutationErrorSurface
        error={saveMutation.error}
        feature="MCP Settings"
        onRetry={saveMutation.reset}
      />

      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 place-items-center rounded-xl border bg-background/60 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">
            {setting.label}
          </h2>
          <p className="mt-1 text-sm leading-snug text-muted-foreground">
            {setting.description}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select
          value={display}
          onValueChange={handleChange}
          disabled={!manageable || saveMutation.saving}
        >
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="text-xs text-muted-foreground">
          Changes propagate to MCP within ~5 seconds.
        </p>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {TOGGLE_DESCRIPTIONS[display] ?? null}
      </p>

      {!manageable && (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Settings are read-only on this deployment. Configure{" "}
          <code className="rounded bg-amber-500/10 px-1 font-mono">
            DATABASE_URL
          </code>{" "}
          to enable overrides.
        </p>
      )}
    </section>
  );
}
