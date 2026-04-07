"use client";

import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  Loader2,
  Upload,
  FlaskConical,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  editSamlFormSchema,
  editOidcFormSchema,
  SSOProviderDetailSchema,
  type EditProviderForm,
  type SSOProviderDetail,
  type SSOProviderSummary,
  type SSOTestResult,
} from "./sso-types";

interface EditProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: SSOProviderSummary | null;
}

export function EditProviderDialog({
  open,
  onOpenChange,
  provider,
}: EditProviderDialogProps) {
  // Render nothing when no provider selected — caller controls `open` state
  if (!provider) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    );
  }

  return <EditProviderDialogInner open={open} onOpenChange={onOpenChange} provider={provider} />;
}

/** Inner component — `provider` is guaranteed non-null. */
function EditProviderDialogInner({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: SSOProviderSummary;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const [testResult, setTestResult] = useState<SSOTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch full provider detail (includes config)
  const { data: detail, loading: detailLoading, error: detailError } = useAdminFetch(
    `/api/v1/admin/sso/providers/${provider.id}`,
    {
      schema: SSOProviderDetailSchema,
      deps: [provider.id],
    },
  );

  const currentSchema = provider.type === "oidc" ? editOidcFormSchema : editSamlFormSchema;
  const form = useForm<EditProviderForm>({
    resolver: zodResolver(currentSchema),
    defaultValues: { type: provider.type, domain: "", issuer: "" } as EditProviderForm,
  });
  // react-hook-form Control<Union> doesn't narrow for FormField — extract as FieldValues
  const formControl = form.control as unknown as import("react-hook-form").Control;

  const { mutate: updateProvider, saving, error: updateError, clearError, reset: resetMutation } = useAdminMutation<{ provider: SSOProviderDetail }>({
    method: "PATCH",
  });

  const { mutate: testProviderConn } = useAdminMutation<SSOTestResult>();

  // Populate form when detail loads
  useEffect(() => {
    if (!detail) return;
    const config = detail.config as Record<string, string>;

    if (provider.type === "saml") {
      form.reset({
        type: "saml",
        domain: detail.domain,
        issuer: detail.issuer,
        idpEntityId: config.idpEntityId ?? "",
        idpSsoUrl: config.idpSsoUrl ?? "",
        idpCertificate: config.idpCertificate ?? "",
      });
    } else {
      form.reset({
        type: "oidc",
        domain: detail.domain,
        issuer: detail.issuer,
        clientId: config.clientId ?? "",
        clientSecret: "", // blank = keep existing
        discoveryUrl: config.discoveryUrl ?? "",
      });
    }
  }, [detail, provider.id]);

  // Reset state on dialog open/close
  useEffect(() => {
    if (open) {
      setShowSecret(false);
      setTestResult(null);
      setTestError(null);
      setTesting(false);
      resetMutation();
    }
  }, [open]);

  const domainValue = form.watch("domain");
  const domainChanged = detail && domainValue !== detail.domain;

  function handleCertUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") {
        form.setValue("idpCertificate" as never, text as never, { shouldValidate: true });
      }
    };
    reader.onerror = () => {
      console.debug("File read failed:", reader.error instanceof Error ? reader.error.message : String(reader.error));
      form.setError("idpCertificate" as never, {
        type: "manual",
        message: "Failed to read file. Try pasting the certificate text directly.",
      } as never);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleSubmit(values: EditProviderForm) {
    clearError();

    const config = values.type === "saml"
      ? {
          idpEntityId: values.idpEntityId,
          idpSsoUrl: values.idpSsoUrl,
          idpCertificate: values.idpCertificate,
        }
      : {
          clientId: values.clientId,
          // Only send clientSecret if the user typed a new one
          ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
          discoveryUrl: values.discoveryUrl,
        };

    const body: Record<string, unknown> = {
      issuer: values.issuer,
      domain: values.domain,
      config,
    };

    const result = await updateProvider({
      path: `/api/v1/admin/sso/providers/${provider.id}`,
      body,
    });

    if (result.ok) {
      onOpenChange(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    const result = await testProviderConn({
      path: `/api/v1/admin/sso/providers/${provider.id}/test`,
      method: "POST",
    });
    if (result.ok && result.data) {
      setTestResult(result.data);
    } else if (!result.ok) {
      setTestError(result.error);
    }
    setTesting(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit SSO Provider</DialogTitle>
          <DialogDescription>
            Update the configuration for your{" "}
            <Badge variant="secondary" className="text-[10px] uppercase font-mono">
              {provider.type}
            </Badge>{" "}
            provider on <strong>{provider.domain}</strong>.
          </DialogDescription>
        </DialogHeader>

        {updateError && <ErrorBanner message={updateError} onRetry={clearError} />}

        {detailLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {detailError && (
          <ErrorBanner message={detailError.message ?? "Failed to load provider details"} />
        )}

        {!detailLoading && !detailError && detail && (
          <>
        {domainChanged && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Changing the domain will reset verification. You&apos;ll need to add a new DNS TXT record.
            </p>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* Type (read-only) */}
            <FormItem>
              <FormLabel>Type</FormLabel>
              <Input value={provider.type.toUpperCase()} disabled />
              <FormDescription>
                Provider type cannot be changed. Delete and recreate to switch.
              </FormDescription>
            </FormItem>

            {/* Domain */}
            <FormField
              control={formControl}
              name="domain"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Domain</FormLabel>
                  <FormControl>
                    <Input placeholder="acme.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Issuer */}
            <FormField
              control={formControl}
              name="issuer"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Issuer URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://idp.example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* SAML fields */}
            {provider.type === "saml" && (
              <>
                <FormField
                  control={formControl}
                  name={"idpEntityId" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>IdP Entity ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={formControl}
                  name={"idpSsoUrl" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>IdP SSO URL</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={formControl}
                  name={"idpCertificate" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>X.509 Certificate</FormLabel>
                      <FormControl>
                        <Textarea
                          className="min-h-[100px] font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="size-3" />
                          Upload .pem / .crt
                        </Button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pem,.crt"
                          className="hidden"
                          onChange={handleCertUpload}
                        />
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* OIDC fields */}
            {provider.type === "oidc" && (
              <>
                <FormField
                  control={formControl}
                  name={"clientId" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={formControl}
                  name={"clientSecret" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Client Secret</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showSecret ? "text" : "password"}
                            placeholder="Leave blank to keep existing secret"
                            {...field}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="absolute right-1 top-1/2 -translate-y-1/2"
                            onClick={() => setShowSecret(!showSecret)}
                            aria-label={showSecret ? "Hide secret" : "Show secret"}
                          >
                            {showSecret ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          </Button>
                        </div>
                      </FormControl>
                      <FormDescription>
                        Leave blank to keep the existing secret
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={formControl}
                  name={"discoveryUrl" as never}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discovery URL</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* Test connection */}
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testing}
                className="w-full"
              >
                {testing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <FlaskConical className="size-3" />
                )}
                Test Connection
              </Button>

              {testError && (
                <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  <p className="font-medium">Test failed</p>
                  <p className="mt-1">{testError}</p>
                </div>
              )}

              {testResult && (
                <div className={`rounded-md border px-3 py-2 text-xs ${
                  testResult.success
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                    : "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                }`}>
                  <p className="font-medium">
                    {testResult.success ? "Connection successful" : "Connection failed"}
                  </p>
                  {testResult.errors?.map((err, i) => (
                    <p key={i} className="mt-1">{err}</p>
                  ))}
                  {testResult.warnings?.map((warn, i) => (
                    <p key={i} className="mt-1 text-amber-600 dark:text-amber-400">{warn}</p>
                  ))}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-3 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
