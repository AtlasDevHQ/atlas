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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Upload,
  FlaskConical,
  Copy,
  Check,
} from "lucide-react";
import {
  samlFormSchema,
  oidcFormSchema,
  DomainCheckResponseSchema,
  type CreateProviderForm,
  type SSOProviderDetail,
  type SSOTestResult,
} from "./sso-types";

interface CreateProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DialogStep = "form" | "dns-record";

export function CreateProviderDialog({
  open,
  onOpenChange,
}: CreateProviderDialogProps) {
  const [providerType, setProviderType] = useState<"saml" | "oidc">("saml");
  const [step, setStep] = useState<DialogStep>("form");
  const [createdProvider, setCreatedProvider] = useState<SSOProviderDetail | null>(null);
  const [domainCheckQuery, setDomainCheckQuery] = useState("");
  const [testResult, setTestResult] = useState<SSOTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const currentSchema = providerType === "saml" ? samlFormSchema : oidcFormSchema;
  const form = useForm<CreateProviderForm>({
    resolver: zodResolver(currentSchema),
    defaultValues: providerType === "saml"
      ? { type: "saml", domain: "", issuer: "", idpEntityId: "", idpSsoUrl: "", idpCertificate: "" }
      : { type: "oidc", domain: "", issuer: "", clientId: "", clientSecret: "", discoveryUrl: "" },
  });

  // Domain availability check
  const { data: domainCheck, loading: domainChecking, error: domainCheckError } = useAdminFetch(
    `/api/v1/admin/sso/domain-check?domain=${encodeURIComponent(domainCheckQuery)}`,
    {
      schema: DomainCheckResponseSchema,
      deps: [domainCheckQuery],
    },
  );

  const { mutate: createProvider, saving, error: createError, clearError, reset: resetMutation } = useAdminMutation<{ provider: SSOProviderDetail }>({
    path: "/api/v1/admin/sso/providers",
    method: "POST",
  });

  const { mutate: testProvider } = useAdminMutation<SSOTestResult>();

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep("form");
      setCreatedProvider(null);
      setTestResult(null);
      setTestError(null);
      setTesting(false);
      setDomainCheckQuery("");
      setCopied(false);
      resetMutation();
      form.reset(
        providerType === "saml"
          ? { type: "saml", domain: "", issuer: "", idpEntityId: "", idpSsoUrl: "", idpCertificate: "" }
          : { type: "oidc", domain: "", issuer: "", clientId: "", clientSecret: "", discoveryUrl: "" },
      );
    }
  }, [open]);

  // Debounced domain check
  function handleDomainChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.length >= 3 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
      debounceRef.current = setTimeout(() => setDomainCheckQuery(value), 300);
    } else {
      setDomainCheckQuery("");
    }
  }

  // Switch provider type — reset form with correct defaults
  function handleTypeChange(type: "saml" | "oidc") {
    setProviderType(type);
    setTestResult(null);
    const domain = form.getValues("domain");
    const issuer = form.getValues("issuer");
    form.reset(
      type === "saml"
        ? { type: "saml", domain, issuer, idpEntityId: "", idpSsoUrl: "", idpCertificate: "" }
        : { type: "oidc", domain, issuer, clientId: "", clientSecret: "", discoveryUrl: "" },
    );
  }

  // File upload for SAML certificate
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
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  async function handleSubmit(values: CreateProviderForm) {
    clearError();
    const body = values.type === "saml"
      ? {
          type: "saml" as const,
          issuer: values.issuer,
          domain: values.domain,
          config: {
            idpEntityId: values.idpEntityId,
            idpSsoUrl: values.idpSsoUrl,
            idpCertificate: values.idpCertificate,
          },
        }
      : {
          type: "oidc" as const,
          issuer: values.issuer,
          domain: values.domain,
          config: {
            clientId: values.clientId,
            clientSecret: values.clientSecret,
            discoveryUrl: values.discoveryUrl,
          },
        };

    const result = await createProvider({ body: body as Record<string, unknown> });
    if (result.ok && result.data) {
      setCreatedProvider(result.data.provider);
      setStep("dns-record");
    }
  }

  async function handleTestConnection() {
    if (!createdProvider) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    const result = await testProvider({
      path: `/api/v1/admin/sso/providers/${createdProvider.id}/test`,
      method: "POST",
    });
    if (result.ok && result.data) {
      setTestResult(result.data);
    } else if (!result.ok) {
      setTestError(result.error);
    }
    setTesting(false);
  }

  async function handleCopyToken() {
    if (!createdProvider?.verificationToken) return;
    try {
      await navigator.clipboard.writeText(createdProvider.verificationToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.debug("Clipboard write failed:", err instanceof Error ? err.message : String(err));
    }
  }

  const domainValue = form.watch("domain");
  const showDomainStatus = domainCheckQuery === domainValue && domainValue.length >= 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {step === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add SSO Provider</DialogTitle>
              <DialogDescription>
                Configure a SAML or OIDC identity provider for single sign-on.
              </DialogDescription>
            </DialogHeader>

            {createError && <ErrorBanner message={createError} onRetry={clearError} />}

            <Tabs value={providerType} onValueChange={(v) => handleTypeChange(v as "saml" | "oidc")}>
              <TabsList className="w-full">
                <TabsTrigger value="saml" className="flex-1">SAML</TabsTrigger>
                <TabsTrigger value="oidc" className="flex-1">OIDC</TabsTrigger>
              </TabsList>
            </Tabs>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                {/* Domain */}
                <FormField
                  control={form.control}
                  name="domain"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Domain</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            placeholder="acme.com"
                            {...field}
                            onChange={(e) => {
                              field.onChange(e);
                              handleDomainChange(e.target.value);
                            }}
                          />
                          {showDomainStatus && (
                            <div className="absolute right-2 top-1/2 -translate-y-1/2">
                              {domainChecking ? (
                                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                              ) : domainCheckError ? (
                                <XCircle className="size-4 text-red-500" />
                              ) : domainCheck?.available ? (
                                <CheckCircle2 className="size-4 text-emerald-500" />
                              ) : (
                                <XCircle className="size-4 text-red-500" />
                              )}
                            </div>
                          )}
                        </div>
                      </FormControl>
                      {showDomainStatus && !domainChecking && domainCheckError && (
                        <p className="text-xs text-red-500">Could not check domain availability</p>
                      )}
                      {showDomainStatus && !domainChecking && !domainCheckError && domainCheck && !domainCheck.available && (
                        <p className="text-xs text-red-500">{domainCheck.reason ?? "Domain unavailable"}</p>
                      )}
                      <FormDescription>
                        Email domain for auto-provisioning (e.g. acme.com)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Issuer */}
                <FormField
                  control={form.control}
                  name="issuer"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Issuer URL</FormLabel>
                      <FormControl>
                        <Input placeholder="https://idp.example.com" {...field} />
                      </FormControl>
                      <FormDescription>
                        Identity provider issuer identifier
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* SAML-specific fields */}
                {providerType === "saml" && (
                  <>
                    <FormField
                      control={form.control}
                      name={"idpEntityId" as never}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>IdP Entity ID</FormLabel>
                          <FormControl>
                            <Input placeholder="https://idp.example.com/entity" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={"idpSsoUrl" as never}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>IdP SSO URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://idp.example.com/sso" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={"idpCertificate" as never}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>X.509 Certificate</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
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

                {/* OIDC-specific fields */}
                {providerType === "oidc" && (
                  <>
                    <FormField
                      control={form.control}
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
                      control={form.control}
                      name={"clientSecret" as never}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Client Secret</FormLabel>
                          <FormControl>
                            <Input type="password" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={"discoveryUrl" as never}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Discovery URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://idp.example.com/.well-known/openid-configuration" {...field} />
                          </FormControl>
                          <FormDescription>
                            OpenID Connect Discovery endpoint
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

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
                    Create Provider
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Verify Domain Ownership</DialogTitle>
              <DialogDescription>
                Add the following DNS TXT record to verify ownership of{" "}
                <strong>{createdProvider?.domain}</strong>.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* DNS record display */}
              <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
                <div className="space-y-1">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Record Type</p>
                  <p className="text-sm font-mono">TXT</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Host</p>
                  <p className="text-sm font-mono">_atlas-verify.{createdProvider?.domain}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Value</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all text-sm font-mono">
                      {createdProvider?.verificationToken}
                    </code>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={handleCopyToken}
                    >
                      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                DNS changes may take up to 48 hours to propagate. You can verify domain ownership
                from the provider list once the record is live.
              </p>

              {/* Test connection */}
              <div className="space-y-2">
                <Button
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
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
