"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Cpu, Loader2, CheckCircle2, XCircle, RotateCcw, Eye, EyeOff } from "lucide-react";
import type { ModelConfigProvider, WorkspaceModelConfig, TestModelConfigResponse } from "@/ui/lib/types";

// ── Types ─────────────────────────────────────────────────────────

interface ModelConfigResponse {
  config: WorkspaceModelConfig | null;
}

type TestResult = TestModelConfigResponse;

const PROVIDERS: { value: ModelConfigProvider; label: string; description: string }[] = [
  { value: "anthropic", label: "Anthropic", description: "Claude models via api.anthropic.com" },
  { value: "openai", label: "OpenAI", description: "GPT models via api.openai.com" },
  { value: "azure-openai", label: "Azure OpenAI", description: "Azure-hosted OpenAI models" },
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Any OpenAI-compatible endpoint" },
];

const NEEDS_BASE_URL: Set<ModelConfigProvider> = new Set(["azure-openai", "custom"]);

const modelConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom"]),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
});

// ── Main Page ─────────────────────────────────────────────────────

export default function ModelConfigPage() {
  const form = useForm<z.infer<typeof modelConfigSchema>>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: { provider: "anthropic", model: "", apiKey: "", baseUrl: "" },
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<ModelConfigResponse>(
    "/api/v1/admin/model-config",
    {
      transform: (json) => json as ModelConfigResponse,
    },
  );

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
    useAdminMutation<TestResult>({
      path: "/api/v1/admin/model-config/test",
      method: "POST",
    });

  const mutationError = saveError ?? deleteError ?? testError;

  const existingConfig = data?.config ?? null;
  const provider = form.watch("provider");

  // Sync form when server data loads or changes (after save/refetch)
  useEffect(() => {
    if (loading) return; // wait for fetch to complete
    if (existingConfig) {
      form.reset({
        provider: existingConfig.provider,
        model: existingConfig.model,
        apiKey: "", // Never pre-fill API key
        baseUrl: existingConfig.baseUrl ?? "",
      });
    } else {
      form.reset({ provider: "anthropic", model: "", apiKey: "", baseUrl: "" });
    }
    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }, [data, loading]); // reset when server data changes or loading completes

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">AI Provider</h1>
          <p className="text-sm text-muted-foreground">Configure your workspace LLM provider</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="AI Provider" />
      </div>
    );
  }

  async function handleSave(values: z.infer<typeof modelConfigSchema>) {
    if (!values.apiKey && !existingConfig) {
      form.setError("apiKey", { message: "API key is required for new configurations." });
      return;
    }

    setTestResult(null);

    clearSaveError();
    clearDeleteError();
    clearTestError();

    const body: Record<string, string> = {
      provider: values.provider,
      model: values.model.trim(),
      apiKey: values.apiKey,
    };
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }

    const result = await saveMutate({ body });
    if (result !== undefined) {
      form.setValue("apiKey", ""); // Clear API key after save
    }
  }

  async function handleDelete() {
    setTestResult(null);

    clearSaveError();
    clearDeleteError();
    clearTestError();

    const result = await deleteMutate();
    if (result !== undefined) {
      form.reset({ provider: "anthropic", model: "", apiKey: "", baseUrl: "" });
    }
  }

  async function handleTest() {
    const values = form.getValues();
    setTestResult(null);

    clearSaveError();
    clearDeleteError();
    clearTestError();

    const body: Record<string, string> = {
      provider: values.provider,
      model: values.model.trim(),
      apiKey: values.apiKey || "placeholder-for-test",
    };
    if (NEEDS_BASE_URL.has(values.provider) && values.baseUrl) {
      body.baseUrl = values.baseUrl.trim();
    }

    const result = await testMutate({ body });
    if (result !== undefined) {
      setTestResult(result);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">AI Provider</h1>
        <p className="text-sm text-muted-foreground">
          Configure your workspace&apos;s LLM provider and API key
        </p>
      </div>

      <ErrorBoundary>
        <div className="flex-1 overflow-auto p-6">
          {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
          {mutationError && (
            <ErrorBanner message={mutationError} onRetry={() => { clearSaveError(); clearDeleteError(); clearTestError(); }} />
          )}

          {loading ? (
            <LoadingState message="Loading model configuration..." />
          ) : (
            <div className="mx-auto max-w-2xl space-y-6">
              {/* Current status */}
              <Card className="shadow-none">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Cpu className="size-4" />
                      Current Configuration
                    </CardTitle>
                    {existingConfig ? (
                      <Badge variant="default">Custom</Badge>
                    ) : (
                      <Badge variant="secondary">Platform Default</Badge>
                    )}
                  </div>
                  <CardDescription>
                    {existingConfig
                      ? `Using ${PROVIDERS.find((p) => p.value === existingConfig.provider)?.label ?? existingConfig.provider} with model ${existingConfig.model}`
                      : "Using the platform default provider and model. Configure a custom provider below."}
                  </CardDescription>
                </CardHeader>
                {existingConfig && (
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Provider</span>
                        <p className="font-medium">
                          {PROVIDERS.find((p) => p.value === existingConfig.provider)?.label ?? existingConfig.provider}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Model</span>
                        <p className="font-mono font-medium">{existingConfig.model}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">API Key</span>
                        <p className="font-mono font-medium">{existingConfig.apiKeyMasked}</p>
                      </div>
                      {existingConfig.baseUrl && (
                        <div>
                          <span className="text-muted-foreground">Base URL</span>
                          <p className="truncate font-mono font-medium">{existingConfig.baseUrl}</p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                )}
              </Card>

              {/* Configuration form */}
              <Card className="shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    {existingConfig ? "Update Configuration" : "Configure Custom Provider"}
                  </CardTitle>
                  <CardDescription>
                    {existingConfig
                      ? "Update your workspace's LLM provider settings. Leave API key empty to keep the existing key."
                      : "Set up a custom LLM provider for your workspace. This overrides the platform default for all users in this workspace."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
                      {/* Provider */}
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
                                      <div className="text-xs text-muted-foreground">{p.description}</div>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Model */}
                      <FormField
                        control={form.control}
                        name="model"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Model</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={
                                  provider === "anthropic" ? "claude-opus-4-6" :
                                  provider === "openai" ? "gpt-4o" :
                                  "model-name"
                                }
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* API Key */}
                      <FormField
                        control={form.control}
                        name="apiKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              API Key
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
                                  className="pr-10 font-mono"
                                  {...field}
                                />
                              </FormControl>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                                onClick={() => setShowApiKey(!showApiKey)}
                              >
                                {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Base URL (for Azure/Custom) */}
                      {NEEDS_BASE_URL.has(provider) && (
                        <FormField
                          control={form.control}
                          name="baseUrl"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Base URL</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder={
                                    provider === "azure-openai"
                                      ? "https://your-resource.openai.azure.com/openai/deployments/your-model/"
                                      : "https://api.example.com/v1"
                                  }
                                  className="font-mono text-sm"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription>
                                {provider === "azure-openai"
                                  ? "The Azure OpenAI deployment endpoint URL."
                                  : "The base URL for your OpenAI-compatible API endpoint."}
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {/* Test result */}
                      {testResult && (
                        <div
                          className={`flex items-start gap-2 rounded-md border px-4 py-3 text-sm ${
                            testResult.success
                              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                              : "border-destructive/30 bg-destructive/5 text-destructive"
                          }`}
                        >
                          {testResult.success ? (
                            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                          ) : (
                            <XCircle className="mt-0.5 size-4 shrink-0" />
                          )}
                          <span>{testResult.message}</span>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2">
                        <Button type="submit" disabled={saving || !form.watch("model").trim() || (!form.watch("apiKey") && !existingConfig)}>
                          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          {existingConfig ? "Update" : "Save"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleTest}
                          disabled={testing || !form.watch("model").trim() || !form.watch("apiKey")}
                        >
                          {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          Test Connection
                        </Button>
                        {existingConfig && (
                          <Button
                            type="button"
                            variant="ghost"
                            className="text-muted-foreground"
                            onClick={handleDelete}
                            disabled={deleting}
                          >
                            {deleting ? (
                              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="mr-1.5 size-3.5" />
                            )}
                            Reset to Platform Default
                          </Button>
                        )}
                      </div>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ErrorBoundary>
    </div>
  );
}
