"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { z } from "zod";
import {
  buildProviderConfig,
  hasAnyProviderFieldFilled,
  INITIAL_FIELD_VALUES,
  EMAIL_PROVIDERS,
  type EmailProvider,
  type ProviderFieldValues,
} from "./build-provider-config";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useConfigForm } from "@/ui/hooks/use-config-form";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
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

const PROVIDER_LABEL: Record<EmailProvider, string> = {
  resend: "Resend",
  sendgrid: "SendGrid",
  postmark: "Postmark",
  smtp: "SMTP",
  ses: "Amazon SES",
};

const PROVIDER_DESCRIPTION: Record<EmailProvider, string> = {
  resend: "Modern email API for developers",
  sendgrid: "Twilio SendGrid email delivery",
  postmark: "Transactional email service",
  smtp: "Generic SMTP (via ATLAS_SMTP_URL bridge)",
  ses: "AWS Simple Email Service (via ATLAS_SMTP_URL bridge)",
};

const BaselineSchema = z.object({
  provider: z.literal("resend"),
  fromAddress: z.string(),
});

const OverrideSchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS),
  fromAddress: z.string(),
  secretLabel: z.string(),
  secretMasked: z.string().nullable(),
  hints: z.record(z.string(), z.string()),
  installedAt: z.string(),
});

const EmailProviderConfigResponseSchema = z.object({
  config: z.object({
    baseline: BaselineSchema,
    override: OverrideSchema.nullable(),
  }),
});

type EmailProviderConfigResponse = z.infer<typeof EmailProviderConfigResponseSchema>;

/**
 * Editable field set for `useConfigForm` — the single statement of what this
 * page edits (#4204). `creds` re-baselines to `INITIAL_FIELD_VALUES` on every
 * refetch because secrets are write-only: the server never echoes them back,
 * so "dirty" means "the admin typed something new since the last load".
 */
type EmailFormValues = {
  provider: EmailProvider;
  fromAddress: string;
  creds: ProviderFieldValues;
};

interface TestResult {
  success: boolean;
  message: string;
}

// ── Design primitives ──────────────────────────────────────────────

type StatusKind = "connected" | "disconnected" | "locked";

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

// ── Provider field groups ─────────────────────────────────────────

interface ProviderFieldsProps {
  provider: EmailProvider;
  values: ProviderFieldValues;
  onChange: (next: ProviderFieldValues) => void;
  showSecrets: boolean;
  onToggleSecrets: () => void;
}

function SecretInput({
  id,
  placeholder,
  value,
  onChange,
  show,
  onToggleShow,
}: {
  id: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        placeholder={placeholder}
        className="pr-10 font-mono text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
        onClick={onToggleShow}
      >
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
    </div>
  );
}

function ProviderFields({ provider, values, onChange, showSecrets, onToggleSecrets }: ProviderFieldsProps) {
  const set = <K extends keyof ProviderFieldValues>(k: K, v: ProviderFieldValues[K]) =>
    onChange({ ...values, [k]: v });

  if (provider === "resend") {
    return (
      <div className="space-y-1">
        <Label htmlFor="resendApiKey">API key</Label>
        <SecretInput
          id="resendApiKey"
          placeholder="re_..."
          value={values.resendApiKey}
          onChange={(v) => set("resendApiKey", v)}
          show={showSecrets}
          onToggleShow={onToggleSecrets}
        />
      </div>
    );
  }

  if (provider === "sendgrid") {
    return (
      <div className="space-y-1">
        <Label htmlFor="sendgridApiKey">API key</Label>
        <SecretInput
          id="sendgridApiKey"
          placeholder="SG...."
          value={values.sendgridApiKey}
          onChange={(v) => set("sendgridApiKey", v)}
          show={showSecrets}
          onToggleShow={onToggleSecrets}
        />
      </div>
    );
  }

  if (provider === "postmark") {
    return (
      <div className="space-y-1">
        <Label htmlFor="postmarkServerToken">Server token</Label>
        <SecretInput
          id="postmarkServerToken"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={values.postmarkServerToken}
          onChange={(v) => set("postmarkServerToken", v)}
          show={showSecrets}
          onToggleShow={onToggleSecrets}
        />
      </div>
    );
  }

  if (provider === "smtp") {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="space-y-1">
            <Label htmlFor="smtpHost">Host</Label>
            <Input
              id="smtpHost"
              placeholder="smtp.example.com"
              className="font-mono text-sm"
              value={values.smtpHost}
              onChange={(e) => set("smtpHost", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="smtpPort">Port</Label>
            <Input
              id="smtpPort"
              type="number"
              className="w-24 font-mono text-sm"
              value={values.smtpPort}
              onChange={(e) => set("smtpPort", e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="smtpUsername">Username</Label>
          <Input
            id="smtpUsername"
            className="font-mono text-sm"
            value={values.smtpUsername}
            onChange={(e) => set("smtpUsername", e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="smtpPassword">Password</Label>
          <SecretInput
            id="smtpPassword"
            placeholder="••••••••"
            value={values.smtpPassword}
            onChange={(v) => set("smtpPassword", v)}
            show={showSecrets}
            onToggleShow={onToggleSecrets}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="smtpTls" checked={values.smtpTls} onCheckedChange={(v) => set("smtpTls", v)} />
          <Label htmlFor="smtpTls" className="text-xs">Use TLS</Label>
        </div>
      </div>
    );
  }

  // SES
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="sesRegion">Region</Label>
        <Input
          id="sesRegion"
          placeholder="us-east-1"
          className="font-mono text-sm"
          value={values.sesRegion}
          onChange={(e) => set("sesRegion", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sesAccessKeyId">Access key ID</Label>
        <Input
          id="sesAccessKeyId"
          placeholder="AKIA..."
          className="font-mono text-sm"
          value={values.sesAccessKeyId}
          onChange={(e) => set("sesAccessKeyId", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sesSecretAccessKey">Secret access key</Label>
        <SecretInput
          id="sesSecretAccessKey"
          placeholder="••••••••"
          value={values.sesSecretAccessKey}
          onChange={(v) => set("sesSecretAccessKey", v)}
          show={showSecrets}
          onToggleShow={onToggleSecrets}
        />
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────

export default function EmailProviderPage() {
  const [expanded, setExpanded] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Load → edit → dirty-gated save → re-baseline ride `useConfigForm`
  // (#4204). The dirty compare derives from `toForm`, so Save/Replace stays
  // disabled on an unchanged form — the always-fires save this page used to
  // hand-roll is structurally gone. The post-save invalidation refetch
  // re-baselines the form (credentials back to empty, from-address to the
  // saved override), replacing the old `lastSyncedKey` sync effect.
  const form = useConfigForm<EmailProviderConfigResponse, EmailFormValues>({
    path: "/api/v1/admin/email-provider",
    schema: EmailProviderConfigResponseSchema,
    saveMethod: "PUT",
    toForm: (d) => ({
      provider: d.config.override?.provider ?? "resend",
      fromAddress: d.config.override?.fromAddress ?? "",
      creds: INITIAL_FIELD_VALUES,
    }),
    toPayload: (v) => {
      // `handleSave` validates before calling `save()`, so `ok` holds here.
      // The empty-config arm exists only to keep `toPayload` total; if a
      // future caller skips that validation the server rejects the payload
      // with a 400 rather than storing a half-built config.
      const configResult = buildProviderConfig(v.provider, v.creds);
      return {
        provider: v.provider,
        fromAddress: v.fromAddress.trim(),
        config: configResult.ok ? configResult.config : {},
      };
    },
  });

  // Remove/test stay hand-wired mutations: DELETE and POST /test are actions,
  // not part of the config-form save loop. No explicit `invalidates` —
  // useAdminMutation's onSuccess already invalidates every admin-fetch query,
  // which refetches the GET above and drives the re-baseline.
  const { mutate: deleteMutate, saving: deleting, error: deleteError, clearError: clearDeleteError } =
    useAdminMutation({
      path: "/api/v1/admin/email-provider",
      method: "DELETE",
    });
  const { mutate: testMutate, saving: testing, error: testError, clearError: clearTestError } =
    useAdminMutation<TestResult>({
      path: "/api/v1/admin/email-provider/test",
      method: "POST",
    });

  const structuredError = combineMutationErrors([form.error, deleteError, testError]);
  const baseline = form.data?.config.baseline;
  const override = form.data?.config.override ?? null;
  const hasOverride = override !== null;
  const showEditor = hasOverride || expanded;
  const values = form.values;
  const fields = form.fields;

  function clearAllErrors() {
    setFormError(null);
    form.clearError();
    clearDeleteError();
    clearTestError();
  }

  async function handleSave() {
    setTestResult(null);
    clearAllErrors();
    if (!values) return;

    const configResult = buildProviderConfig(values.provider, values.creds);
    if (!configResult.ok) {
      setFormError(configResult.error);
      return;
    }
    if (!values.fromAddress.trim()) {
      setFormError("From address is required.");
      return;
    }

    const result = await form.save();
    if (result.ok) {
      // Transient test-flow state isn't part of the form baseline, so the
      // refetch re-baseline doesn't touch it — clear it here like the old
      // sync effect did.
      setRecipientEmail("");
    }
  }

  async function handleRemove() {
    setTestResult(null);
    clearAllErrors();
    const result = await deleteMutate();
    if (result.ok) {
      // The invalidation refetch re-baselines the form to the baseline-only
      // state; only the transient UI state needs clearing by hand.
      setExpanded(false);
      setRecipientEmail("");
    }
  }

  async function handleTest() {
    setTestResult(null);
    clearAllErrors();
    if (!values) return;

    if (!recipientEmail.trim()) {
      setFormError("Enter a recipient email to send a test.");
      return;
    }

    // Distinguish "user is testing fresh creds" from "user is testing the saved
    // override" by checking whether any provider-specific field was touched.
    // If anything is typed we MUST test exactly that — otherwise we'd silently
    // fall through to the saved/platform config and mislead the admin.
    const hasTypedCreds = hasAnyProviderFieldFilled(values.provider, values.creds);
    const configResult = buildProviderConfig(values.provider, values.creds);

    const body: Record<string, unknown> = { recipientEmail: recipientEmail.trim() };

    if (hasTypedCreds) {
      if (!configResult.ok) {
        setFormError(configResult.error);
        return;
      }
      body.provider = values.provider;
      body.fromAddress =
        values.fromAddress.trim() || override?.fromAddress || baseline?.fromAddress;
      body.config = configResult.config;
    } else if (!hasOverride) {
      setFormError("Enter credentials to test, or save an override first.");
      return;
    }
    // Else: no fresh creds and an override exists — fall through to test the saved override.

    const result = await testMutate({ body });
    if (result.ok && result.data) setTestResult(result.data);
  }

  function handleCollapse() {
    setExpanded(false);
    setTestResult(null);
    setRecipientEmail("");
    form.reset();
    clearAllErrors();
  }

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Email Provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Atlas sends your workspace emails via Resend by default. Bring your own provider —
          Resend, SendGrid, Postmark, SMTP, or Amazon SES — to deliver from your own domain.
        </p>
      </div>

      <ErrorBoundary>
        {(structuredError || formError) && (
          <div className="mx-auto mb-4 max-w-3xl">
            <MutationErrorSurface
              error={structuredError}
              feature="Email Provider"
              onRetry={clearAllErrors}
            />
            {!structuredError && formError && (
              <ErrorBanner message={formError} onRetry={clearAllErrors} actionLabel="Dismiss" />
            )}
          </div>
        )}

        <AdminContentWrapper
          loading={form.loading}
          error={form.loadError}
          feature="Email Provider"
          onRetry={form.refetch}
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
                description="Your provider credentials and sender address. Applies to this workspace only."
              />

              {!showEditor && (
                <CompactRow
                  icon={Mail}
                  title="Use your own email provider"
                  description="Deliver from your own verified sender on Resend, SendGrid, Postmark, SMTP, or SES."
                  status="disconnected"
                  action={
                    <Button type="button" variant="outline" size="sm" onClick={() => setExpanded(true)}>
                      + Add credentials
                    </Button>
                  }
                />
              )}

              {showEditor && values && fields && (
                <OverrideShell
                  status={hasOverride ? "connected" : "disconnected"}
                  title={
                    hasOverride
                      ? `Workspace ${PROVIDER_LABEL[override!.provider]} override`
                      : "Add your provider credentials"
                  }
                  description={
                    hasOverride
                      ? "Emails from this workspace are delivered with your credentials."
                      : "Pick a provider, paste the credentials, and set a verified sender."
                  }
                  onCollapse={!hasOverride ? handleCollapse : undefined}
                  actions={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleTest}
                        disabled={testing || !recipientEmail.trim()}
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
                        onClick={handleSave}
                        disabled={form.saving || !form.dirty}
                      >
                        {form.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                        {hasOverride ? "Replace" : "Save"}
                      </Button>
                    </>
                  }
                >
                  {hasOverride && override && (
                    <DetailList>
                      <DetailRow label="Provider" value={PROVIDER_LABEL[override.provider]} />
                      <DetailRow label="From address" value={override.fromAddress} mono />
                      {override.secretMasked && (
                        <DetailRow label={override.secretLabel} value={override.secretMasked} mono />
                      )}
                      {Object.entries(override.hints).map(([k, v]) => (
                        <DetailRow key={k} label={k} value={v} mono={k !== "TLS"} />
                      ))}
                      <DetailRow label="Added" value={formatDateTime(override.installedAt)} />
                    </DetailList>
                  )}

                  <div className="space-y-4">
                    <div className="space-y-1">
                      <Label htmlFor="providerSelect">Provider</Label>
                      <Select
                        value={values.provider}
                        onValueChange={(v) => fields.provider.set(v as EmailProvider)}
                      >
                        <SelectTrigger id="providerSelect">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {EMAIL_PROVIDERS.map((p) => (
                            <SelectItem key={p} value={p}>
                              <div>
                                <div className="font-medium">{PROVIDER_LABEL[p]}</div>
                                <div className="text-xs text-muted-foreground">{PROVIDER_DESCRIPTION[p]}</div>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {hasOverride && (
                        <p className="text-xs text-muted-foreground">
                          Saving replaces your existing override. Credentials aren&apos;t reused across providers.
                        </p>
                      )}
                    </div>

                    <ProviderFields
                      provider={values.provider}
                      values={values.creds}
                      onChange={fields.creds.set}
                      showSecrets={showSecrets}
                      onToggleSecrets={() => setShowSecrets((v) => !v)}
                    />

                    <div className="space-y-1">
                      <Label htmlFor="fromAddress">From address</Label>
                      <Input
                        id="fromAddress"
                        placeholder={override?.fromAddress ?? "Acme <noreply@acme.com>"}
                        className="font-mono text-sm"
                        value={values.fromAddress}
                        onChange={(e) => fields.fromAddress.set(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Must be a sender verified with the chosen provider.
                      </p>
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="recipientEmail">Test recipient</Label>
                      <Input
                        id="recipientEmail"
                        type="email"
                        placeholder="you@example.com"
                        className="text-sm"
                        value={recipientEmail}
                        onChange={(e) => setRecipientEmail(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Where to send a deliverability check.
                      </p>
                    </div>

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
                  </div>
                </OverrideShell>
              )}
            </section>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}
