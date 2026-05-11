"use client";

import { useEffect, useRef, useState } from "react";
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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
} from "@/ui/components/admin/compact";
import {
  Cpu,
  KeyRound,
  Loader2,
  CheckCircle2,
  XCircle,
  Lock,
  Eye,
  EyeOff,
  ArrowUpRight,
} from "lucide-react";
import {
  WorkspaceModelConfigSchema,
  BillingStatusSchema,
  GatewayCatalogResponseSchema,
} from "@/ui/lib/admin-schemas";
import type { ModelConfigProvider, TestModelConfigResponse } from "@/ui/lib/types";
import { GatewayModelPicker } from "@/ui/components/admin/gateway-model-picker";

// ── Schemas / constants ───────────────────────────────────────────

const ModelConfigResponseSchema = z.object({
  config: WorkspaceModelConfigSchema.nullable(),
});

const PROVIDERS: { value: ModelConfigProvider; label: string; description: string }[] = [
  { value: "anthropic", label: "Anthropic", description: "Claude models via api.anthropic.com" },
  { value: "openai", label: "OpenAI", description: "GPT models via api.openai.com" },
  { value: "azure-openai", label: "Azure OpenAI", description: "Azure-hosted OpenAI models" },
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Any OpenAI-compatible endpoint" },
  { value: "gateway", label: "Vercel AI Gateway", description: "Any gateway model — platform credits or BYOT key" },
  { value: "bedrock", label: "AWS Bedrock", description: "Bedrock-hosted Anthropic / Amazon / others via IAM creds" },
];

const PROVIDER_LABEL: Record<ModelConfigProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "azure-openai": "Azure OpenAI",
  custom: "Custom",
  gateway: "Vercel AI Gateway",
  bedrock: "AWS Bedrock",
};

const NEEDS_BASE_URL: Set<ModelConfigProvider> = new Set(["azure-openai", "custom"]);

// Mirrors `BEDROCK_REGIONS` from `@useatlas/types`. Kept in lockstep at the
// type-bump boundary; the type re-export below catches drift at compile time.
const BEDROCK_REGION_OPTIONS = [
  { value: "us-east-1", label: "us-east-1 (N. Virginia)" },
  { value: "us-east-2", label: "us-east-2 (Ohio)" },
  { value: "us-west-2", label: "us-west-2 (Oregon)" },
  { value: "eu-central-1", label: "eu-central-1 (Frankfurt)" },
  { value: "eu-west-1", label: "eu-west-1 (Ireland)" },
  { value: "eu-west-3", label: "eu-west-3 (Paris)" },
  { value: "ap-northeast-1", label: "ap-northeast-1 (Tokyo)" },
  { value: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
  { value: "ap-southeast-2", label: "ap-southeast-2 (Sydney)" },
  { value: "ap-south-1", label: "ap-south-1 (Mumbai)" },
  { value: "ca-central-1", label: "ca-central-1 (Central)" },
  { value: "sa-east-1", label: "sa-east-1 (São Paulo)" },
] as const;

// Partial by design — unknown model IDs fall back to the raw string so that
// a new platform model ships without a UI change. Keep in sync with billing's
// `MODEL_OPTIONS` only for the models you want humanized here.
const PLATFORM_MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "anthropic/claude-haiku-4.5": "Haiku 4.5",
  "anthropic/claude-sonnet-4.6": "Sonnet 4.6",
  "anthropic/claude-opus-4.6": "Opus 4.6",
  "anthropic/claude-opus-4.7": "Opus 4.7",
};

function platformModelLabel(value: string): string {
  return PLATFORM_MODEL_LABELS[value] ?? value;
}

const modelConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom", "gateway", "bedrock"]),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
  // Bedrock-specific. Stored as separate inputs and JSON-bundled into the
  // apiKey wire field at submit time so the API stays uniform.
  bedrockRegion: z.string(),
  bedrockAccessKeyId: z.string(),
  bedrockSecretAccessKey: z.string(),
  bedrockSessionToken: z.string(),
});

// ── Main page ─────────────────────────────────────────────────────

export default function ModelConfigPage() {
  const { blocked } = usePlatformAdminGuard();
  const [expanded, setExpanded] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<TestModelConfigResponse | null>(null);

  const form = useForm<z.infer<typeof modelConfigSchema>>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: {
      provider: "anthropic",
      model: "",
      apiKey: "",
      baseUrl: "",
      bedrockRegion: "us-east-1",
      bedrockAccessKeyId: "",
      bedrockSecretAccessKey: "",
      bedrockSessionToken: "",
    },
  });

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/model-config",
    { schema: ModelConfigResponseSchema },
  );

  // Gateway catalog (anonymous, server-cached) — fetched eagerly so the
  // picker is responsive on first toggle. The endpoint is server-cached so
  // the cost is one cold hit per pod.
  const {
    data: catalog,
    loading: catalogLoading,
    refetch: refetchCatalog,
  } = useAdminFetch(
    "/api/v1/admin/model-config/catalog",
    { schema: GatewayCatalogResponseSchema },
  );

  // BYOT direct-provider catalogs — only fetched when the workspace has
  // a saved configuration on the matching provider with a healthy key.
  // Without these preconditions the endpoint would return 400
  // `missing_byot_key` on every page load, surfacing as a noisy error
  // banner. Gating with `enabled` keeps the request firmly
  // tied to the picker's render gate.
  const existingConfigForGate = data?.config ?? null;
  const anthropicCatalogEnabled =
    existingConfigForGate?.provider === "anthropic" &&
    existingConfigForGate.apiKeyStatus === "masked";
  const openaiCatalogEnabled =
    existingConfigForGate?.provider === "openai" &&
    existingConfigForGate.apiKeyStatus === "masked";
  const bedrockCatalogEnabled =
    existingConfigForGate?.provider === "bedrock" &&
    existingConfigForGate.apiKeyStatus === "masked" &&
    !!existingConfigForGate.bedrockRegion;
  const {
    data: anthropicCatalog,
    loading: anthropicCatalogLoading,
    refetch: refetchAnthropicCatalog,
  } = useAdminFetch(
    "/api/v1/admin/model-config/catalog?provider=anthropic",
    {
      schema: GatewayCatalogResponseSchema,
      enabled: anthropicCatalogEnabled,
    },
  );
  const {
    data: openaiCatalog,
    loading: openaiCatalogLoading,
    refetch: refetchOpenaiCatalog,
  } = useAdminFetch(
    "/api/v1/admin/model-config/catalog?provider=openai",
    {
      schema: GatewayCatalogResponseSchema,
      enabled: openaiCatalogEnabled,
    },
  );
  const {
    data: bedrockCatalog,
    loading: bedrockCatalogLoading,
    refetch: refetchBedrockCatalog,
  } = useAdminFetch(
    "/api/v1/admin/model-config/catalog?provider=bedrock",
    {
      schema: GatewayCatalogResponseSchema,
      enabled: bedrockCatalogEnabled,
    },
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

  const mutationError = combineMutationErrors([saveError, deleteError, testError]);
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
        bedrockRegion: existingConfig.bedrockRegion ?? "us-east-1",
        // IAM creds are never sent back to the wire — admin re-enters
        // them on rotation. The picker remains usable from the saved
        // bundle on the server side via the catalog endpoint.
        bedrockAccessKeyId: "",
        bedrockSecretAccessKey: "",
        bedrockSessionToken: "",
      });
    } else {
      form.reset({
      provider: "anthropic",
      model: "",
      apiKey: "",
      baseUrl: "",
      bedrockRegion: "us-east-1",
      bedrockAccessKeyId: "",
      bedrockSecretAccessKey: "",
      bedrockSessionToken: "",
    });
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
    // Bedrock credentials live in three separate inputs; the wire shape
    // packs them into the apiKey JSON bundle.
    const bedrockApiKey =
      values.provider === "bedrock" &&
      (values.bedrockAccessKeyId.trim() || values.bedrockSecretAccessKey.trim())
        ? JSON.stringify({
            accessKeyId: values.bedrockAccessKeyId.trim(),
            secretAccessKey: values.bedrockSecretAccessKey.trim(),
            ...(values.bedrockSessionToken.trim()
              ? { sessionToken: values.bedrockSessionToken.trim() }
              : {}),
          })
        : null;
    const effectiveApiKey =
      values.provider === "bedrock" ? bedrockApiKey ?? "" : values.apiKey;
    // Gateway tolerates an empty apiKey (platform credits); every other
    // provider needs one on initial creation.
    if (!effectiveApiKey && !existingConfig && values.provider !== "gateway") {
      form.setError(
        values.provider === "bedrock" ? "bedrockAccessKeyId" : "apiKey",
        {
          message:
            values.provider === "bedrock"
              ? "Access key + secret are required for new configurations."
              : "API key is required for new configurations.",
        },
      );
      return;
    }
    if (values.provider === "bedrock" && bedrockApiKey) {
      if (!values.bedrockAccessKeyId.trim() || !values.bedrockSecretAccessKey.trim()) {
        form.setError("bedrockSecretAccessKey", {
          message: "Both access key and secret are required.",
        });
        return;
      }
    }
    setTestResult(null);
    clearAllErrors();
    const body: Record<string, string> = {
      provider: values.provider,
      model: values.model.trim(),
    };
    if (effectiveApiKey) body.apiKey = effectiveApiKey;
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }
    if (values.provider === "bedrock") {
      body.bedrockRegion = values.bedrockRegion;
    }
    const result = await saveMutate({ body });
    if (result.ok) {
      form.setValue("apiKey", "");
      form.setValue("bedrockAccessKeyId", "");
      form.setValue("bedrockSecretAccessKey", "");
      form.setValue("bedrockSessionToken", "");
    }
  }

  async function handleDelete() {
    setTestResult(null);
    clearAllErrors();
    const result = await deleteMutate();
    if (result.ok) {
      form.reset({
      provider: "anthropic",
      model: "",
      apiKey: "",
      baseUrl: "",
      bedrockRegion: "us-east-1",
      bedrockAccessKeyId: "",
      bedrockSecretAccessKey: "",
      bedrockSessionToken: "",
    });
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
    };
    if (values.provider === "bedrock") {
      // For bedrock, the test endpoint needs the JSON-bundled cred shape;
      // an empty placeholder isn't enough because the AWS SDK call has no
      // dry-run mode.
      if (!values.bedrockAccessKeyId.trim() || !values.bedrockSecretAccessKey.trim()) {
        form.setError("bedrockSecretAccessKey", {
          message: "Enter both access key + secret before testing.",
        });
        return;
      }
      body.apiKey = JSON.stringify({
        accessKeyId: values.bedrockAccessKeyId.trim(),
        secretAccessKey: values.bedrockSecretAccessKey.trim(),
        ...(values.bedrockSessionToken.trim()
          ? { sessionToken: values.bedrockSessionToken.trim() }
          : {}),
      });
      body.bedrockRegion = values.bedrockRegion;
    } else if (values.apiKey) {
      // Gateway can test on platform credits with no key — omit apiKey
      // entirely so the EE validator doesn't reject an empty-string
      // sentinel.
      body.apiKey = values.apiKey;
    } else if (values.provider !== "gateway") {
      body.apiKey = "placeholder-for-test";
    }
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }
    const result = await testMutate({ body });
    if (result.ok && result.data) setTestResult(result.data);
  }

  function handleCollapse() {
    setExpanded(false);
    setTestResult(null);
    form.reset({
      provider: "anthropic",
      model: "",
      apiKey: "",
      baseUrl: "",
      bedrockRegion: "us-east-1",
      bedrockAccessKeyId: "",
      bedrockSecretAccessKey: "",
      bedrockSessionToken: "",
    });
    clearAllErrors();
  }

  const currentProvider = form.watch("provider");
  const isGateway = currentProvider === "gateway";
  // BYOT picker requires the saved config to match the current form
  // provider — we use the workspace's stored BYOT key for the discovery
  // call. Switching the form to a provider without saving falls back to
  // the free-text input.
  const showAnthropicPicker =
    currentProvider === "anthropic" &&
    existingConfig?.provider === "anthropic" &&
    existingConfig?.apiKeyStatus === "masked";
  const showOpenaiPicker =
    currentProvider === "openai" &&
    existingConfig?.provider === "openai" &&
    existingConfig?.apiKeyStatus === "masked";
  const showBedrockPicker =
    currentProvider === "bedrock" &&
    existingConfig?.provider === "bedrock" &&
    existingConfig?.apiKeyStatus === "masked" &&
    !!existingConfig?.bedrockRegion;
  const isBedrock = currentProvider === "bedrock";
  // Bedrock save requires either an existing config (key preservation) OR a
  // freshly-entered access key + secret. Test requires the new bundle every
  // time — the workspace-stored creds aren't echoed back.
  const watchedAccessKey = form.watch("bedrockAccessKeyId");
  const watchedSecret = form.watch("bedrockSecretAccessKey");
  const hasBedrockBundleEntered = !!watchedAccessKey?.trim() && !!watchedSecret?.trim();
  const saveDisabled =
    saving ||
    !form.watch("model").trim() ||
    (isBedrock
      ? !existingConfig && !hasBedrockBundleEntered
      : !form.watch("apiKey") && !existingConfig && !isGateway);
  const testDisabled =
    testing ||
    !form.watch("model").trim() ||
    (isBedrock
      ? !hasBedrockBundleEntered
      : !form.watch("apiKey") && !isGateway);

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">AI Provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas routes every chat through the platform default model. Bring your own provider —
          Anthropic, OpenAI, Azure OpenAI, an OpenAI-compatible endpoint, or the Vercel AI Gateway
          catalog — to run requests against your own credentials or pick any gateway model on
          platform credits.
        </p>
      </div>

      <ErrorBoundary>
        {mutationError && (
          <div className="mx-auto mb-4 max-w-3xl">
            <MutationErrorSurface
              error={mutationError}
              feature="AI Provider"
              onRetry={clearAllErrors}
            />
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
                status="disconnected"
                action={
                  billingMissing ? (
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      <Lock className="size-3" />
                      Locked
                    </span>
                  ) : (
                    <Link
                      href="/admin/billing"
                      className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
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

              {existingConfig?.modelStatus === "deprecated" && (
                <div
                  className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
                  role="alert"
                >
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-0.5">
                    <div className="font-medium">
                      Model <span className="font-mono">{existingConfig.model}</span> is no longer in {PROVIDER_LABEL[existingConfig.provider]}'s catalog.
                    </div>
                    <div className="text-xs">
                      {existingConfig.modelSuggestedReplacement
                        ? `Pick a new model — Atlas suggests `
                        : "Pick a new model — no close replacement was found automatically."}
                      {existingConfig.modelSuggestedReplacement && (
                        <span className="font-mono">{existingConfig.modelSuggestedReplacement}</span>
                      )}
                      . Chat will keep working against the deprecated ID until the provider rejects it.
                    </div>
                  </div>
                </div>
              )}

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
                    <Button type="button" size="sm" variant="outline" onClick={() => refetchBilling()}>
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
                <Shell
                  icon={KeyRound}
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
                      <DetailRow
                        label="API key"
                        value={
                          existingConfig.apiKeyStatus === "masked"
                            ? existingConfig.apiKeyMasked ?? "—"
                            : existingConfig.apiKeyStatus === "platform_credits"
                              ? "— (platform credits)"
                              : "— (decryption failed)"
                        }
                        mono
                      />
                      {existingConfig.apiKeyStatus === "decrypt_failed" && (
                        <DetailRow
                          label=""
                          value="The stored key cannot be decrypted (likely a key-rotation drift). Re-enter it below to restore this workspace; until then, chat is blocked."
                        />
                      )}
                      {existingConfig.modelStatus === "deprecated" && (
                        <DetailRow
                          label="Model status"
                          value={
                            existingConfig.modelSuggestedReplacement
                              ? `Deprecated upstream. Suggested replacement: ${existingConfig.modelSuggestedReplacement}.`
                              : "Deprecated upstream. Pick a new model from the catalog."
                          }
                        />
                      )}
                      {existingConfig.baseUrl && (
                        <DetailRow label="Base URL" value={existingConfig.baseUrl} mono />
                      )}
                      {existingConfig.bedrockRegion && (
                        <DetailRow label="AWS region" value={existingConfig.bedrockRegion} mono />
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
                              {isGateway ? (
                                <GatewayModelPicker
                                  models={catalog?.models ?? []}
                                  value={field.value}
                                  onChange={field.onChange}
                                  loading={catalogLoading}
                                  fallback={catalog?.fallback}
                                  onRetry={refetchCatalog}
                                />
                              ) : showAnthropicPicker ? (
                                <GatewayModelPicker
                                  models={anthropicCatalog?.models ?? []}
                                  value={field.value}
                                  onChange={field.onChange}
                                  loading={anthropicCatalogLoading}
                                  onRetry={refetchAnthropicCatalog}
                                />
                              ) : showOpenaiPicker ? (
                                <GatewayModelPicker
                                  models={openaiCatalog?.models ?? []}
                                  value={field.value}
                                  onChange={field.onChange}
                                  loading={openaiCatalogLoading}
                                  onRetry={refetchOpenaiCatalog}
                                />
                              ) : showBedrockPicker ? (
                                <GatewayModelPicker
                                  models={bedrockCatalog?.models ?? []}
                                  value={field.value}
                                  onChange={field.onChange}
                                  loading={bedrockCatalogLoading}
                                  onRetry={refetchBedrockCatalog}
                                />
                              ) : (
                                <Input
                                  placeholder={
                                    currentProvider === "anthropic"
                                      ? "claude-opus-4-7"
                                      : currentProvider === "openai"
                                        ? "gpt-4o"
                                        : "model-name"
                                  }
                                  className="font-mono text-sm"
                                  {...field}
                                />
                              )}
                            </FormControl>
                            {showAnthropicPicker && anthropicCatalog && (
                              <CatalogFreshness
                                fetchedAt={anthropicCatalog.fetchedAt}
                                onRefresh={refetchAnthropicCatalog}
                                refreshing={anthropicCatalogLoading}
                              />
                            )}
                            {showOpenaiPicker && openaiCatalog && (
                              <CatalogFreshness
                                fetchedAt={openaiCatalog.fetchedAt}
                                onRefresh={refetchOpenaiCatalog}
                                refreshing={openaiCatalogLoading}
                              />
                            )}
                            {showBedrockPicker && bedrockCatalog && (
                              <CatalogFreshness
                                fetchedAt={bedrockCatalog.fetchedAt}
                                onRefresh={refetchBedrockCatalog}
                                refreshing={bedrockCatalogLoading}
                              />
                            )}
                            {currentProvider === "anthropic" && !showAnthropicPicker && (
                              <FormDescription>
                                Save your Anthropic API key first to pick from the live model catalog.
                              </FormDescription>
                            )}
                            {currentProvider === "openai" && !showOpenaiPicker && (
                              <FormDescription>
                                Save your OpenAI API key first to pick from the live model catalog.
                              </FormDescription>
                            )}
                            {currentProvider === "bedrock" && !showBedrockPicker && (
                              <FormDescription>
                                Save your AWS credentials + region first to pick from the live Bedrock model catalog.
                              </FormDescription>
                            )}
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {currentProvider !== "bedrock" && (
                        <FormField
                          control={form.control}
                          name="apiKey"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                API key
                                {isGateway ? (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    (optional — leave empty for platform credits)
                                  </span>
                                ) : (
                                  existingConfig && (
                                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                                      (leave empty to keep existing)
                                    </span>
                                  )
                                )}
                              </FormLabel>
                              <div className="relative">
                                <FormControl>
                                  <Input
                                    type={showApiKey ? "text" : "password"}
                                    placeholder={
                                      isGateway
                                        ? "vck_... (optional)"
                                        : existingConfig?.apiKeyMasked ?? "sk-..."
                                    }
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
                      )}

                      {currentProvider === "bedrock" && (
                        <>
                          <FormField
                            control={form.control}
                            name="bedrockRegion"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>AWS region</FormLabel>
                                <Select value={field.value} onValueChange={field.onChange}>
                                  <FormControl>
                                    <SelectTrigger>
                                      <SelectValue placeholder="Pick a region" />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {BEDROCK_REGION_OPTIONS.map((r) => (
                                      <SelectItem key={r.value} value={r.value}>
                                        {r.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormDescription>
                                  Bedrock surfaces a different catalog per region — pick the one your account has model access in.
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="bedrockAccessKeyId"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  Access key ID
                                  {existingConfig?.provider === "bedrock" && existingConfig.apiKeyMasked && (
                                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                                      (leave empty to keep existing — currently {existingConfig.apiKeyMasked})
                                    </span>
                                  )}
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    placeholder="AKIA…"
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
                            name="bedrockSecretAccessKey"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Secret access key</FormLabel>
                                <FormControl>
                                  <Input
                                    type={showApiKey ? "text" : "password"}
                                    placeholder={
                                      existingConfig?.provider === "bedrock"
                                        ? "(leave empty to keep existing)"
                                        : "AWS secret"
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
                            name="bedrockSessionToken"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  Session token
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    (optional — federated / STS only)
                                  </span>
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    type={showApiKey ? "text" : "password"}
                                    className="font-mono text-sm"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormDescription>
                            Atlas calls Bedrock with the workspace's IAM credentials. Minimum policy: <code>bedrock:InvokeModel</code> + <code>bedrock:ListFoundationModels</code> on every model you intend to use.
                          </FormDescription>
                        </>
                      )}

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
                </Shell>
              )}
            </section>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}

// Picker freshness footer — "last refreshed N hours ago" + a manual
// refresh action. The discovery cache TTLs at 6h server-side; this is
// how admins force a fresh fetch after a key rotation or when a new
// upstream model lands.
function CatalogFreshness({
  fetchedAt,
  onRefresh,
  refreshing,
}: {
  fetchedAt: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const relative = relativeTime(fetchedAt);
  return (
    <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
      <span>Last refreshed {relative}</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline disabled:opacity-50"
      >
        {refreshing && <Loader2 className="size-3 animate-spin" />}
        Refresh now
      </button>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
