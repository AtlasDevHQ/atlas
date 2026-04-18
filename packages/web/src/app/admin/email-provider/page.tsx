"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  Mail,
  Loader2,
  CheckCircle2,
  XCircle,
  Lock,
  Eye,
  EyeOff,
  X,
} from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const BaselineSchema = z.object({
  provider: z.literal("resend"),
  fromAddress: z.string(),
});

const OverrideSchema = z.object({
  fromAddress: z.string(),
  apiKeyMasked: z.string(),
  installedAt: z.string(),
});

const EmailProviderConfigResponseSchema = z.object({
  config: z.object({
    baseline: BaselineSchema,
    override: OverrideSchema.nullable(),
  }),
});

interface TestResult {
  success: boolean;
  message: string;
}

const formSchema = z.object({
  apiKey: z.string(),
  fromAddress: z.string(),
  recipientEmail: z.string(),
});

// ── Design primitives ──────────────────────────────────────────────

type StatusKind = "connected" | "disconnected" | "locked";

function StatusDot({ kind }: { kind: StatusKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,_var(--primary)_15%,_transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "locked" && "bg-muted-foreground/30",
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

/** Thin single-line row, used for the locked baseline and the collapsed override prompt. */
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

/** Full card used when the override is configured or the user is mid-setup. */
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
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}
      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" ? "border-primary/30 text-primary" : "text-muted-foreground",
          )}
        >
          <Mail className="size-4" />
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
      {children != null && <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>}
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

// ── Page ─────────────────────────────────────────────────────────

export default function EmailProviderPage() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { apiKey: "", fromAddress: "", recipientEmail: "" },
  });
  const [expanded, setExpanded] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const { data, loading, error, refetch } = useAdminFetch("/api/v1/admin/email-provider", {
    schema: EmailProviderConfigResponseSchema,
  });

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
  const baseline = data?.config.baseline;
  const override = data?.config.override ?? null;
  const hasOverride = override !== null;
  const showEditor = hasOverride || expanded;

  // Hydrate the form from the saved override when it loads.
  useEffect(() => {
    if (loading) return;
    form.reset({
      apiKey: "",
      fromAddress: override?.fromAddress ?? "",
      recipientEmail: "",
    });
    setTestResult(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }, [data, loading]);

  function clearMutationErrors() {
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }

  async function handleSave(values: z.infer<typeof formSchema>) {
    if (!hasOverride && !values.apiKey) {
      form.setError("apiKey", { message: "A Resend API key is required." });
      return;
    }

    setTestResult(null);
    clearMutationErrors();

    const body: Record<string, string> = {};
    if (values.apiKey) body.apiKey = values.apiKey;
    if (values.fromAddress.trim()) body.fromAddress = values.fromAddress.trim();

    const result = await saveMutate({ body });
    if (result.ok) {
      form.setValue("apiKey", "");
    }
  }

  async function handleRemove() {
    setTestResult(null);
    clearMutationErrors();
    const result = await deleteMutate();
    if (result.ok) {
      form.reset({ apiKey: "", fromAddress: "", recipientEmail: "" });
      setExpanded(false);
    }
  }

  async function handleTest() {
    const values = form.getValues();
    if (!values.recipientEmail.trim()) {
      form.setError("recipientEmail", { message: "Enter a recipient email to send a test." });
      return;
    }
    setTestResult(null);
    clearMutationErrors();

    const body: Record<string, string> = { recipientEmail: values.recipientEmail.trim() };
    if (values.apiKey) body.apiKey = values.apiKey;
    if (values.fromAddress.trim()) body.fromAddress = values.fromAddress.trim();

    const result = await testMutate({ body });
    if (result.ok && result.data) setTestResult(result.data);
  }

  function handleCollapse() {
    setExpanded(false);
    setTestResult(null);
    form.reset({ apiKey: "", fromAddress: "", recipientEmail: "" });
    clearMutationErrors();
  }

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Email Provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas sends your workspace emails via Resend. Add your own API key and sender address
          to deliver from your own domain.
        </p>
      </div>

      <ErrorBoundary>
        {mutationError && (
          <div className="mx-auto mb-4 max-w-3xl">
            <ErrorBanner message={mutationError} onRetry={clearMutationErrors} />
          </div>
        )}

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Email Provider"
          onRetry={refetch}
          loadingMessage="Loading email configuration..."
        >
          <div className="mx-auto max-w-3xl space-y-8">
            {/* Baseline — read-only */}
            <section>
              <SectionHeading
                title="Platform baseline"
                description="Shared Atlas default. Used when your workspace has no override."
              />
              {baseline && (
                <CompactRow
                  icon={Mail}
                  title="Resend"
                  description={baseline.fromAddress}
                  status="locked"
                  trailingLabel={
                    <span className="flex items-center gap-1">
                      <Lock className="size-3" />
                      Locked
                    </span>
                  }
                />
              )}
            </section>

            {/* BYO override */}
            <section>
              <SectionHeading
                title="Workspace override"
                description="Your Resend API key and sender address. Applies to this workspace only."
              />

              {!showEditor && (
                <CompactRow
                  icon={Mail}
                  title="Use your own Resend account"
                  description="Deliver from your own verified domain."
                  status="disconnected"
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setExpanded(true)}
                    >
                      + Add credentials
                    </Button>
                  }
                />
              )}

              {showEditor && (
                <OverrideShell
                  status={hasOverride ? "connected" : "disconnected"}
                  title={hasOverride ? "Workspace Resend override" : "Add your Resend credentials"}
                  description={
                    hasOverride
                      ? "Emails from this workspace are delivered with your key."
                      : "Paste a Resend API key and the verified sender address you want to use."
                  }
                  onCollapse={!hasOverride ? handleCollapse : undefined}
                  actions={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTest}
                        disabled={testing || !form.watch("recipientEmail").trim()}
                      >
                        {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                        Send test
                      </Button>
                      {hasOverride && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={handleRemove}
                          disabled={deleting}
                        >
                          {deleting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                          Remove override
                        </Button>
                      )}
                      <Button
                        type="button"
                        onClick={form.handleSubmit(handleSave)}
                        disabled={saving || (!hasOverride && !form.watch("apiKey"))}
                      >
                        {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                        {hasOverride ? "Update" : "Save"}
                      </Button>
                    </>
                  }
                >
                  {hasOverride && override && (
                    <DetailList>
                      <DetailRow label="Provider" value="Resend" />
                      <DetailRow label="From address" value={override.fromAddress} mono />
                      <DetailRow label="API key" value={override.apiKeyMasked} mono />
                      <DetailRow label="Added" value={formatDateTime(override.installedAt)} />
                    </DetailList>
                  )}

                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="apiKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              API key
                              {hasOverride && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  (leave empty to keep existing)
                                </span>
                              )}
                            </FormLabel>
                            <div className="relative">
                              <FormControl>
                                <Input
                                  type={showApiKey ? "text" : "password"}
                                  placeholder={override?.apiKeyMasked ?? "re_..."}
                                  className="pr-10 font-mono"
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
                                {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="fromAddress"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              From address
                              {hasOverride && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  (optional — leave empty to keep existing)
                                </span>
                              )}
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder={baseline?.fromAddress ?? "Acme <noreply@acme.com>"}
                                className="font-mono text-sm"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Must be a sender verified with Resend.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="recipientEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Test recipient</FormLabel>
                            <FormControl>
                              <Input
                                type="email"
                                placeholder="you@example.com"
                                className="text-sm"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription>
                              Where to send a deliverability check.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

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
