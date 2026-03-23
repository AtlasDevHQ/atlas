"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
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

// ── Main Page ─────────────────────────────────────────────────────

export default function ModelConfigPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [provider, setProvider] = useState<ModelConfigProvider>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useAdminFetch<ModelConfigResponse>(
    "/api/v1/admin/model-config",
    {
      transform: (json) => json as ModelConfigResponse,
    },
  );

  const existingConfig = data?.config ?? null;

  // Reset form to existing config values
  function syncFormToConfig(config: WorkspaceModelConfig | null) {
    if (config) {
      setProvider(config.provider);
      setModel(config.model);
      setBaseUrl(config.baseUrl ?? "");
      setApiKey(""); // Never pre-fill API key
    } else {
      setProvider("anthropic");
      setModel("");
      setApiKey("");
      setBaseUrl("");
    }
    setTestResult(null);
    setMutationError(null);
  }

  // Sync form when data loads
  const [prevConfig, setPrevConfig] = useState<WorkspaceModelConfig | null | undefined>(undefined);
  if (data !== null && existingConfig !== prevConfig) {
    setPrevConfig(existingConfig);
    syncFormToConfig(existingConfig);
  }

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

  async function handleSave() {
    if (!apiKey && !existingConfig) {
      setMutationError("API key is required.");
      return;
    }

    setSaving(true);
    setMutationError(null);
    setTestResult(null);

    try {
      const body: Record<string, string> = {
        provider,
        model: model.trim(),
        apiKey,
      };
      if (NEEDS_BASE_URL.has(provider) && baseUrl) {
        body.baseUrl = baseUrl.trim();
      }

      const res = await fetch(`${apiUrl}/api/v1/admin/model-config`, {
        method: "PUT",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }

      setApiKey(""); // Clear API key after save
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setMutationError(null);
    setTestResult(null);

    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/model-config`, {
        method: "DELETE",
        credentials,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }

      syncFormToConfig(null);
      await refetch();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to reset configuration");
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setMutationError(null);

    try {
      const body: Record<string, string> = {
        provider,
        model: model.trim(),
        apiKey: apiKey || "placeholder-for-test",
      };
      if (NEEDS_BASE_URL.has(provider) && baseUrl) {
        body.baseUrl = baseUrl.trim();
      }

      const res = await fetch(`${apiUrl}/api/v1/admin/model-config/test`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }

      const result = (await res.json()) as TestResult;
      setTestResult(result);
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setTesting(false);
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
            <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />
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
                <CardContent className="space-y-4">
                  {/* Provider */}
                  <div className="space-y-2">
                    <Label htmlFor="provider">Provider</Label>
                    <Select value={provider} onValueChange={(v) => setProvider(v as ModelConfigProvider)}>
                      <SelectTrigger id="provider">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
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
                  </div>

                  {/* Model */}
                  <div className="space-y-2">
                    <Label htmlFor="model">Model</Label>
                    <Input
                      id="model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={
                        provider === "anthropic" ? "claude-opus-4-6" :
                        provider === "openai" ? "gpt-4o" :
                        "model-name"
                      }
                      className="font-mono"
                    />
                  </div>

                  {/* API Key */}
                  <div className="space-y-2">
                    <Label htmlFor="apiKey">
                      API Key
                      {existingConfig && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (leave empty to keep existing)
                        </span>
                      )}
                    </Label>
                    <div className="relative">
                      <Input
                        id="apiKey"
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={existingConfig ? existingConfig.apiKeyMasked : "sk-..."}
                        className="pr-10 font-mono"
                      />
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
                  </div>

                  {/* Base URL (for Azure/Custom) */}
                  {NEEDS_BASE_URL.has(provider) && (
                    <div className="space-y-2">
                      <Label htmlFor="baseUrl">Base URL</Label>
                      <Input
                        id="baseUrl"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={
                          provider === "azure-openai"
                            ? "https://your-resource.openai.azure.com/openai/deployments/your-model/"
                            : "https://api.example.com/v1"
                        }
                        className="font-mono text-sm"
                      />
                      <p className="text-xs text-muted-foreground">
                        {provider === "azure-openai"
                          ? "The Azure OpenAI deployment endpoint URL."
                          : "The base URL for your OpenAI-compatible API endpoint."}
                      </p>
                    </div>
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
                    <Button onClick={handleSave} disabled={saving || !model.trim() || (!apiKey && !existingConfig)}>
                      {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                      {existingConfig ? "Update" : "Save"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleTest}
                      disabled={testing || !model.trim() || !apiKey}
                    >
                      {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                      Test Connection
                    </Button>
                    {existingConfig && (
                      <Button
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
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ErrorBoundary>
    </div>
  );
}
