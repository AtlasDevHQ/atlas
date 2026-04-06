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
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { Mail, Loader2, CheckCircle2, XCircle, RotateCcw, Eye, EyeOff } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

type EmailProvider = "resend" | "sendgrid" | "postmark" | "smtp" | "ses";

interface TestResult {
  success: boolean;
  message: string;
}

const EmailProviderConfigResponseSchema = z.object({
  config: z.object({
    provider: z.enum(["resend", "sendgrid", "postmark", "smtp", "ses"]),
    fromAddress: z.string(),
    apiKeyMasked: z.string().nullable(),
    source: z.enum(["override", "env", "default"]),
  }),
});

const PROVIDERS: { value: EmailProvider; label: string; description: string }[] = [
  { value: "resend", label: "Resend", description: "Modern email API for developers" },
  { value: "sendgrid", label: "SendGrid", description: "Twilio SendGrid email delivery" },
  { value: "postmark", label: "Postmark", description: "Transactional email service" },
  { value: "smtp", label: "SMTP", description: "Generic SMTP via webhook bridge (requires ATLAS_SMTP_URL)" },
  { value: "ses", label: "Amazon SES", description: "AWS Simple Email Service via webhook bridge (requires ATLAS_SMTP_URL)" },
];

/** Providers that need an API key configured directly. */
const NEEDS_API_KEY = new Set<EmailProvider>(["resend", "sendgrid", "postmark"]);

const formSchema = z.object({
  provider: z.enum(["resend", "sendgrid", "postmark", "smtp", "ses"]),
  apiKey: z.string(),
  fromAddress: z.string(),
  recipientEmail: z.string(),
});

// ── Main Page ─────────────────────────────────────────────────────

export default function EmailProviderPage() {
  const { blocked } = usePlatformAdminGuard();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { provider: "resend", apiKey: "", fromAddress: "", recipientEmail: "" },
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/email-provider",
    { schema: EmailProviderConfigResponseSchema },
  );

  const { mutate: saveMutate, saving, error: saveError, clearError: clearSaveError } =
    useAdminMutation({
      path: "/api/v1/admin/email-provider",
      method: "PUT",
      invalidates: refetch,
    });

  const { mutate: deleteMutate, saving: deleting, error: deleteError, clearError: clearDeleteError } =
    useAdminMutation({
      path: "/api/v1/admin/email-provider",
      method: "DELETE",
      invalidates: refetch,
    });

  const { mutate: testMutate, saving: testing, error: testError, clearError: clearTestError } =
    useAdminMutation<TestResult>({
      path: "/api/v1/admin/email-provider/test",
      method: "POST",
    });

  const mutationError = saveError ?? deleteError ?? testError;

  const existingConfig = data?.config ?? null;
  const hasOverride = existingConfig?.source === "override";
  const provider = form.watch("provider");

  // Sync form when server data loads or changes
  useEffect(() => {
    if (loading) return;
    if (existingConfig) {
      form.reset({
        provider: existingConfig.provider,
        apiKey: "",
        fromAddress: existingConfig.fromAddress,
        recipientEmail: "",
      });
    } else {
      form.reset({ provider: "resend", apiKey: "", fromAddress: "", recipientEmail: "" });
    }
    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }, [data, loading]);

  if (blocked) {
    return <LoadingState message="Checking access..." />;
  }

  async function handleSave(values: z.infer<typeof formSchema>) {
    if (NEEDS_API_KEY.has(values.provider) && !values.apiKey && !existingConfig?.apiKeyMasked) {
      form.setError("apiKey", { message: "API key is required for new configurations." });
      return;
    }

    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();

    const body: Record<string, string> = { provider: values.provider };
    if (values.apiKey) body.apiKey = values.apiKey;
    if (values.fromAddress.trim()) body.fromAddress = values.fromAddress.trim();

    const result = await saveMutate({ body });
    if (result.ok) {
      form.setValue("apiKey", "");
    }
  }

  async function handleDelete() {
    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();

    const result = await deleteMutate();
    if (result.ok) {
      form.reset({ provider: "resend", apiKey: "", fromAddress: "", recipientEmail: "" });
    }
  }

  async function handleTest() {
    const values = form.getValues();
    if (!values.recipientEmail.trim()) {
      form.setError("recipientEmail", { message: "Enter a recipient email to send a test." });
      return;
    }

    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();

    const body: Record<string, string> = {
      provider: values.provider,
      apiKey: values.apiKey || "use-existing",
      fromAddress: values.fromAddress.trim() || existingConfig?.fromAddress || "Atlas <noreply@useatlas.dev>",
      recipientEmail: values.recipientEmail.trim(),
    };

    const result = await testMutate({ body });
    if (result.ok && result.data) {
      setTestResult(result.data);
    }
  }

  function getKeyLabel(p: EmailProvider): string {
    if (p === "postmark") return "Server Token";
    return "API Key";
  }

  function getKeyPlaceholder(p: EmailProvider): string {
    switch (p) {
      case "resend": return "re_...";
      case "sendgrid": return "SG....";
      case "postmark": return "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
      default: return "";
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Email Provider</h1>
        <p className="text-sm text-muted-foreground">
          Configure the platform&apos;s default email provider for all outbound emails
        </p>
      </div>

      <ErrorBoundary>
        <div>
          {mutationError && (
            <ErrorBanner message={mutationError} onRetry={() => { clearSaveError(); clearDeleteError(); clearTestError(); }} />
          )}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="Email Provider"
            onRetry={refetch}
            loadingMessage="Loading email configuration..."
          >
            <div className="mx-auto max-w-2xl space-y-6">
              {/* Current status */}
              <Card className="shadow-none">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Mail className="size-4" />
                      Current Configuration
                    </CardTitle>
                    {hasOverride ? (
                      <Badge variant="default">Custom</Badge>
                    ) : existingConfig?.source === "env" ? (
                      <Badge variant="secondary">Environment</Badge>
                    ) : (
                      <Badge variant="secondary">Platform Default</Badge>
                    )}
                  </div>
                  <CardDescription>
                    {hasOverride
                      ? `Using ${PROVIDERS.find((p) => p.value === existingConfig?.provider)?.label ?? existingConfig?.provider} as the platform email provider.`
                      : existingConfig?.source === "env"
                        ? `Using ${PROVIDERS.find((p) => p.value === existingConfig?.provider)?.label ?? existingConfig?.provider} from environment variables.`
                        : "Using the platform default email provider (Resend). Configure a custom provider below."}
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
                        <span className="text-muted-foreground">From Address</span>
                        <p className="font-mono font-medium text-sm">{existingConfig.fromAddress}</p>
                      </div>
                      {existingConfig.apiKeyMasked && (
                        <div>
                          <span className="text-muted-foreground">{getKeyLabel(existingConfig.provider)}</span>
                          <p className="font-mono font-medium">{existingConfig.apiKeyMasked}</p>
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
                    {hasOverride ? "Update Configuration" : "Configure Email Provider"}
                  </CardTitle>
                  <CardDescription>
                    {hasOverride
                      ? `Update your platform email provider settings. Leave ${getKeyLabel(provider).toLowerCase()} empty to keep the existing key.`
                      : "Set up a custom email provider for the platform. This is used for all outbound emails (onboarding, scheduled tasks, invitations, agent actions)."}
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

                      {/* API Key (only for direct-API providers) */}
                      {NEEDS_API_KEY.has(provider) && (
                        <FormField
                          control={form.control}
                          name="apiKey"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {getKeyLabel(provider)}
                                {existingConfig?.apiKeyMasked && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    (leave empty to keep existing)
                                  </span>
                                )}
                              </FormLabel>
                              <div className="relative">
                                <FormControl>
                                  <Input
                                    type={showApiKey ? "text" : "password"}
                                    placeholder={existingConfig?.apiKeyMasked ?? getKeyPlaceholder(provider)}
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
                      )}

                      {/* SMTP/SES note */}
                      {(provider === "smtp" || provider === "ses") && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                          {provider === "smtp" ? "SMTP" : "Amazon SES"} requires the <code className="font-mono text-xs">ATLAS_SMTP_URL</code> environment variable to be set as an HTTP bridge for delivery.
                        </div>
                      )}

                      {/* From Address */}
                      <FormField
                        control={form.control}
                        name="fromAddress"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>From Address</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="Atlas <noreply@useatlas.dev>"
                                className="font-mono text-sm"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              The sender address for all platform emails. Must be verified with your email provider.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Test recipient */}
                      <FormField
                        control={form.control}
                        name="recipientEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Test Recipient</FormLabel>
                            <FormControl>
                              <Input
                                type="email"
                                placeholder="you@example.com"
                                className="text-sm"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Enter an email address to send a test email.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

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
                        <Button
                          type="submit"
                          disabled={saving || (NEEDS_API_KEY.has(provider) && !form.watch("apiKey") && !existingConfig?.apiKeyMasked)}
                        >
                          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          {hasOverride ? "Update" : "Save"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleTest}
                          disabled={testing || !form.watch("recipientEmail").trim()}
                        >
                          {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          Send Test Email
                        </Button>
                        {hasOverride && (
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
                            Reset to Default
                          </Button>
                        )}
                      </div>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </div>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>
    </div>
  );
}
