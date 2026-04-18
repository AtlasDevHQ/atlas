"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/ui/form";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import {
  Cpu,
  KeyRound,
  Loader2,
  CheckCircle2,
  XCircle,
  Lock,
  Eye,
  EyeOff,
  X,
  ArrowUpRight,
} from "lucide-react";
import { WorkspaceModelConfigSchema, BillingStatusSchema } from "@/ui/lib/admin-schemas";
import type { ModelConfigProvider, TestModelConfigResponse } from "@/ui/lib/types";

// ── Schemas / constants ───────────────────────────────────────────

const ModelConfigResponseSchema = z.object({
  config: WorkspaceModelConfigSchema.nullable(),
});

const PROVIDERS: { value: ModelConfigProvider; label: string; description: string }[] = [
  { value: "anthropic", label: "Anthropic", description: "Claude models via api.anthropic.com" },
  { value: "openai", label: "OpenAI", description: "GPT models via api.openai.com" },
  { value: "azure-openai", label: "Azure OpenAI", description: "Azure-hosted OpenAI models" },
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Any OpenAI-compatible endpoint" },
];

const PROVIDER_LABEL: Record<ModelConfigProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "azure-openai": "Azure OpenAI",
  custom: "Custom",
};

const NEEDS_BASE_URL: Set<ModelConfigProvider> = new Set(["azure-openai", "custom"]);

// Partial by design — unknown model IDs fall back to the raw string so that
// a new platform model ships without a UI change. Keep in sync with billing's
// `MODEL_OPTIONS` only for the models you want humanized here.
const PLATFORM_MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
};

function platformModelLabel(value: string): string {
  return PLATFORM_MODEL_LABELS[value] ?? value;
}

const modelConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom"]),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
});

// ── Design primitives (local — promote to shared admin/ when a 4th page lifts) ─

type StatusKind = "connected" | "disconnected" | "locked" | "unavailable";

function StatusDot({ kind }: { kind: StatusKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "locked" && "bg-muted-foreground/30",
        kind === "unavailable" &&
          "bg-muted-foreground/20 outline-1 outline-dashed outline-muted-foreground/30",
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
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
  trailingLabel,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  trailingLabel?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors hover:bg-card/70 hover:border-border/80">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">{title}</h3>
          <StatusDot kind={status} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {trailingLabel && (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {trailingLabel}
        </span>
      )}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function OverrideShell({
  status,
  title,
  description,
  onCollapse,
  children,
  actions,
}: {
  status: StatusKind;
  title: string;
  description: string;
  onCollapse?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 transition-colors",
        status === "connected" && "border-primary/20",
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
            status === "connected" ? "border-primary/30 text-primary" : "text-muted-foreground",
          )}
        >
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">{title}</h3>
            {status === "connected" ? (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                Live
              </span>
            ) : onCollapse ? (
              <button
                type="button"
                aria-label="Cancel"
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
      {children != null && <div className="flex-1 space-y-4 px-4 pb-3 text-sm">{children}</div>}
      {actions && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
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

// ── Main page ─────────────────────────────────────────────────────

export default function ModelConfigPage() {
  const { blocked } = usePlatformAdminGuard();
  const [expanded, setExpanded] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<TestModelConfigResponse | null>(null);

  const form = useForm<z.infer<typeof modelConfigSchema>>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: { provider: "anthropic", model: "", apiKey: "", baseUrl: "" },
  });

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/model-config",
    { schema: ModelConfigResponseSchema },
  );

  // Billing drives the BYOT gate + the platform-default label. 404 means
  // self-hosted (billing routes not mounted) — fall through to the generic
  // baseline and treat BYOT as permitted. Any other error (500, network)
  // keeps the gate up: we'd rather make the user retry than flash the
  // credential form open on a transient failure.
  const {
    data: billing,
    loading: billingLoading,
    error: billingError,
    refetch: refetchBilling,
  } = useAdminFetch("/api/v1/billing", { schema: BillingStatusSchema });

  const { mutate: saveMutate, saving, error: saveError, clearError: clearSaveError } =
    useAdminMutation({
      path: "/api/v1/admin/model-config",
      method: "PUT",
      invalidates: refetch,
    });
  const { mutate: deleteMutate, saving: deleting, error: deleteError, clearError: clearDeleteError } =
    useAdminMutation({
      path: "/api/v1/admin/model-config",
      method: "DELETE",
      invalidates: refetch,
    });
  const { mutate: testMutate, saving: testing, error: testError, clearError: clearTestError } =
    useAdminMutation<TestModelConfigResponse>({
      path: "/api/v1/admin/model-config/test",
      method: "POST",
    });

  const mutationError = saveError ?? deleteError ?? testError;
  const existingConfig = data?.config ?? null;
  const hasOverride = existingConfig !== null;
  const showEditor = hasOverride || expanded;

  const billingMissing = billingError?.status === 404;
  const byotRequired = !billingMissing && !!billing && !billing.plan.byot;
  // `byotResolved` prevents the credential form from flashing open before we
  // actually know BYOT eligibility. Don't simplify to `!billingLoading` — that
  // would show the form on a transient failure, which is exactly the regress
  // we're preventing.
  const byotResolved = billingMissing || !!billing;
  const canOverride = byotResolved && !byotRequired;
  const billingFailed = !!billingError && !billingMissing;
  const platformModel = billing?.currentModel ?? billing?.plan.defaultModel ?? null;

  // Sync form state from server only when the override's identity actually
  // changes — not on every background refetch. An unconditional reset would
  // clobber in-flight edits and dismiss mutation errors the user hasn't seen.
  //
  // Deps intentionally exclude `form` and the `clear*Error` callbacks: the
  // `useForm` instance is stable across renders, and `useAdminMutation`
  // returns `clearError` as a stable `useCallback([])`. Including them would
  // force the effect to re-run on every render and defeat the identity gate.
  const lastSyncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const key = existingConfig
      ? `${existingConfig.provider}|${existingConfig.model}|${existingConfig.updatedAt}`
      : "none";
    if (lastSyncedKey.current === key) return;
    lastSyncedKey.current = key;
    if (existingConfig) {
      form.reset({
        provider: existingConfig.provider,
        model: existingConfig.model,
        apiKey: "",
        baseUrl: existingConfig.baseUrl ?? "",
      });
    } else {
      form.reset({ provider: "anthropic", model: "", apiKey: "", baseUrl: "" });
    }
    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }, [data, loading]);

  if (blocked) {
    return <LoadingState message="Checking access..." />;
  }

  function clearAllErrors() {
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }

  async function handleSave(values: z.infer<typeof modelConfigSchema>) {
    // Guard independently of the Save button's `disabled` state — a user can
    // press Enter inside an input to submit the <form> directly, which
    // bypasses the button.
    if (!values.model.trim()) {
      form.setError("model", { message: "Model is required." });
      return;
    }
    if (!values.apiKey && !existingConfig) {
      form.setError("apiKey", { message: "API key is required for new configurations." });
      return;
    }
    setTestResult(null);
    clearAllErrors();
    const body: Record<string, string> = {
      provider: values.provider,
      model: values.model.trim(),
      apiKey: values.apiKey,
    };
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }
    const result = await saveMutate({ body });
    if (result.ok) form.setValue("apiKey", "");
  }

  async function handleDelete() {
    setTestResult(null);
    clearAllErrors();
    const result = await deleteMutate();
    if (result.ok) {
      form.reset({ provider: "anthropic", model: "", apiKey: "", baseUrl: "" });
      setExpanded(false);
    }
  }

  async function handleTest() {
    const values = form.getValues();
    setTestResult(null);
    clearAllErrors();
    const body: Record<string, string> = {
      provider: values.provider,
      model: values.model.trim(),
      apiKey: values.apiKey || "placeholder-for-test",
    };
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }
    const result = await testMutate({ body });
    if (result.ok && result.data) setTestResult(result.data);
  }

  function handleCollapse() {
    setExpanded(false);
    setTestResult(null);
    form.reset({ provider: "anthropic", model: "", apiKey: "", baseUrl: "" });
    clearAllErrors();
  }

  const currentProvider = form.watch("provider");
  const saveDisabled =
    saving || !form.watch("model").trim() || (!form.watch("apiKey") && !existingConfig);
  const testDisabled =
    testing || !form.watch("model").trim() || !form.watch("apiKey");

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">AI Provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas routes every chat through the platform default model. Bring your own provider —
          Anthropic, OpenAI, Azure OpenAI, or any OpenAI-compatible endpoint — to run requests
          against your own API key.
        </p>
      </div>

      <ErrorBoundary>
        {mutationError && (
          <div className="mx-auto mb-4 max-w-3xl">
            <ErrorBanner message={mutationError} onRetry={clearAllErrors} actionLabel="Dismiss" />
          </div>
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="AI Provider"
          onRetry={refetch}
          loadingMessage="Loading model configuration..."
        >
          <div className="mx-auto max-w-3xl space-y-8">
            {/* Platform baseline — always locked */}
            <section>
              <SectionHeading
                title="Platform baseline"
                description="Shared Atlas default. Used when this workspace has no override."
              />
              <CompactRow
                icon={Cpu}
                title={platformModel ? platformModelLabel(platformModel) : "Platform default"}
                description={
                  billingMissing
                    ? "Managed via ATLAS_PROVIDER and ATLAS_MODEL settings."
                    : platformModel
                      ? `Every chat routes through ${platformModel} unless this workspace overrides it.`
                      : "Every chat routes through the platform default unless this workspace overrides it."
                }
                status="locked"
                trailingLabel={
                  billingMissing ? (
                    <span className="flex items-center gap-1">
                      <Lock className="size-3" />
                      Locked
                    </span>
                  ) : (
                    <Link
                      href="/admin/billing"
                      className="flex items-center gap-1 hover:text-foreground"
                    >
                      <Lock className="size-3" />
                      Managed on billing
                    </Link>
                  )
                }
              />
            </section>

            {/* Workspace override — gated by BYOT */}
            <section>
              <SectionHeading
                title="Workspace override"
                description="Your provider credentials. Applies to this workspace only."
              />

              {/* Still resolving billing — don't flash the credential form
                  before we know whether BYOT is on. */}
              {billingLoading && !byotResolved && (
                <div
                  aria-busy
                  className="flex items-center gap-3 rounded-xl border border-dashed bg-card/20 px-3.5 py-2.5"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Checking BYOT eligibility…
                  </span>
                </div>
              )}

              {/* Transient billing failure — surface the error with a retry
                  instead of silently rendering nothing. */}
              {billingFailed && (
                <CompactRow
                  icon={XCircle}
                  title="Can't check BYOT eligibility"
                  description={
                    billingError?.message ??
                    "Billing is temporarily unreachable. Retry, or try again shortly."
                  }
                  status="unavailable"
                  action={
                    <Button type="button" size="sm" variant="outline" onClick={refetchBilling}>
                      Retry
                    </Button>
                  }
                />
              )}

              {/* BYOT disabled — gate before any form appears */}
              {byotRequired && (
                <CompactRow
                  icon={KeyRound}
                  title="Bring your own provider"
                  description="Enable BYOT on billing to route this workspace through your own API key."
                  status="unavailable"
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/admin/billing">
                        Enable on billing
                        <ArrowUpRight className="ml-1 size-3.5" />
                      </Link>
                    </Button>
                  }
                />
              )}

              {/* BYOT permitted, no override, not yet expanded */}
              {canOverride && !showEditor && (
                <CompactRow
                  icon={KeyRound}
                  title="Bring your own provider"
                  description="Paste credentials to run this workspace against your own provider and model."
                  status="disconnected"
                  action={
                    <Button type="button" variant="outline" size="sm" onClick={() => setExpanded(true)}>
                      + Add credentials
                    </Button>
                  }
                />
              )}

              {/* BYOT permitted + editor visible (either has override or user expanded) */}
              {canOverride && showEditor && (
                <OverrideShell
                  status={hasOverride ? "connected" : "disconnected"}
                  title={
                    hasOverride && existingConfig
                      ? `Workspace ${PROVIDER_LABEL[existingConfig.provider]} override`
                      : "Add your provider credentials"
                  }
                  description={
                    hasOverride
                      ? "Every chat in this workspace routes through your credentials."
                      : "Pick a provider, paste the API key, and save. Credentials are encrypted at rest."
                  }
                  onCollapse={!hasOverride ? handleCollapse : undefined}
                  actions={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTest}
                        disabled={testDisabled}
                      >
                        {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                        Test connection
                      </Button>
                      {hasOverride && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={handleDelete}
                          disabled={deleting}
                        >
                          {deleting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          Remove override
                        </Button>
                      )}
                      {/* Submit via `form` attribute so Enter-in-input and
                          button-click both route through the same <form>'s
                          onSubmit. Stops the two paths from silently
                          diverging on a future refactor. */}
                      <Button
                        type="submit"
                        form="model-config-override-form"
                        disabled={saveDisabled}
                      >
                        {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                        {hasOverride ? "Replace" : "Save"}
                      </Button>
                    </>
                  }
                >
                  {hasOverride && existingConfig && (
                    <DetailList>
                      <DetailRow
                        label="Provider"
                        value={PROVIDER_LABEL[existingConfig.provider]}
                      />
                      <DetailRow label="Model" value={existingConfig.model} mono />
                      <DetailRow label="API key" value={existingConfig.apiKeyMasked} mono />
                      {existingConfig.baseUrl && (
                        <DetailRow label="Base URL" value={existingConfig.baseUrl} mono />
                      )}
                      <DetailRow label="Updated" value={formatDateTime(existingConfig.updatedAt)} />
                    </DetailList>
                  )}

                  <Form {...form}>
                    <form
                      id="model-config-override-form"
                      onSubmit={form.handleSubmit(handleSave)}
                      className="space-y-4"
                    >
                      <FormField
                        control={form.control}
                        name="provider"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Provider</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {PROVIDERS.map((p) => (
                                  <SelectItem key={p.value} value={p.value}>
                                    <div>
                                      <div className="font-medium">{p.label}</div>
                                      <div className="text-xs text-muted-foreground">
                                        {p.description}
                                      </div>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="model"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Model</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={
                                  currentProvider === "anthropic"
                                    ? "claude-opus-4-6"
                                    : currentProvider === "openai"
                                      ? "gpt-4o"
                                      : "model-name"
                                }
                                className="font-mono text-sm"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="apiKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              API key
                              {existingConfig && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  (leave empty to keep existing)
                                </span>
                              )}
                            </FormLabel>
                            <div className="relative">
                              <FormControl>
                                <Input
                                  type={showApiKey ? "text" : "password"}
                                  placeholder={existingConfig ? existingConfig.apiKeyMasked : "sk-..."}
                                  className="pr-10 font-mono text-sm"
                                  {...field}
                                />
                              </FormControl>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                                onClick={() => setShowApiKey((v) => !v)}
                              >
                                {showApiKey ? (
                                  <EyeOff className="size-3.5" />
                                ) : (
                                  <Eye className="size-3.5" />
                                )}
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {NEEDS_BASE_URL.has(currentProvider) && (
                        <FormField
                          control={form.control}
                          name="baseUrl"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Base URL</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder={
                                    currentProvider === "azure-openai"
                                      ? "https://your-resource.openai.azure.com/openai/deployments/your-model/"
                                      : "https://api.example.com/v1"
                                  }
                                  className="font-mono text-sm"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                {currentProvider === "azure-openai"
                                  ? "The Azure OpenAI deployment endpoint URL."
                                  : "The base URL for your OpenAI-compatible API endpoint."}
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {testResult && (
                        <div
                          className={cn(
                            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                            testResult.success
                              ? "border-primary/30 bg-primary/5 text-primary"
                              : "border-destructive/30 bg-destructive/5 text-destructive",
                          )}
                        >
                          {testResult.success ? (
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                          ) : (
                            <XCircle className="mt-0.5 size-4 shrink-0" />
                          )}
                          <span>{testResult.message}</span>
                        </div>
                      )}
                    </form>
                  </Form>
                </OverrideShell>
              )}
            </section>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}
