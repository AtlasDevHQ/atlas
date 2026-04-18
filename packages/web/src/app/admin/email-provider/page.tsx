"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { z } from "zod";
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

const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

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

interface ProviderFieldValues {
  resendApiKey: string;
  sendgridApiKey: string;
  postmarkServerToken: string;
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpTls: boolean;
  sesRegion: string;
  sesAccessKeyId: string;
  sesSecretAccessKey: string;
}

const INITIAL_FIELD_VALUES: ProviderFieldValues = {
  resendApiKey: "",
  sendgridApiKey: "",
  postmarkServerToken: "",
  smtpHost: "",
  smtpPort: "587",
  smtpUsername: "",
  smtpPassword: "",
  smtpTls: true,
  sesRegion: "us-east-1",
  sesAccessKeyId: "",
  sesSecretAccessKey: "",
};

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

/**
 * Assemble the provider-specific `config` payload from the form values.
 * Returns null when required fields are empty so the caller can flag it.
 */
function buildProviderConfig(
  provider: EmailProvider,
  values: ProviderFieldValues,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  switch (provider) {
    case "resend":
      if (!values.resendApiKey.trim()) return { ok: false, error: "API key is required." };
      return { ok: true, config: { apiKey: values.resendApiKey.trim() } };
    case "sendgrid":
      if (!values.sendgridApiKey.trim()) return { ok: false, error: "API key is required." };
      return { ok: true, config: { apiKey: values.sendgridApiKey.trim() } };
    case "postmark":
      if (!values.postmarkServerToken.trim()) return { ok: false, error: "Server token is required." };
      return { ok: true, config: { serverToken: values.postmarkServerToken.trim() } };
    case "smtp": {
      const port = Number(values.smtpPort);
      if (!values.smtpHost.trim()) return { ok: false, error: "Host is required." };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Port must be 1–65535." };
      if (!values.smtpUsername.trim()) return { ok: false, error: "Username is required." };
      if (!values.smtpPassword.trim()) return { ok: false, error: "Password is required." };
      return {
        ok: true,
        config: {
          host: values.smtpHost.trim(),
          port,
          username: values.smtpUsername.trim(),
          password: values.smtpPassword.trim(),
          tls: values.smtpTls,
        },
      };
    }
    case "ses":
      if (!values.sesRegion.trim()) return { ok: false, error: "Region is required." };
      if (!values.sesAccessKeyId.trim()) return { ok: false, error: "Access key ID is required." };
      if (!values.sesSecretAccessKey.trim()) return { ok: false, error: "Secret access key is required." };
      return {
        ok: true,
        config: {
          region: values.sesRegion.trim(),
          accessKeyId: values.sesAccessKeyId.trim(),
          secretAccessKey: values.sesSecretAccessKey.trim(),
        },
      };
  }
}

// ── Page ─────────────────────────────────────────────────────────

export default function EmailProviderPage() {
  const [expanded, setExpanded] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [provider, setProvider] = useState<EmailProvider>("resend");
  const [fromAddress, setFromAddress] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [fields, setFields] = useState<ProviderFieldValues>(INITIAL_FIELD_VALUES);
  const [formError, setFormError] = useState<string | null>(null);
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

  const mutationError = saveError ?? deleteError ?? testError ?? formError;
  const baseline = data?.config.baseline;
  const override = data?.config.override ?? null;
  const hasOverride = override !== null;
  const showEditor = hasOverride || expanded;

  useEffect(() => {
    if (loading) return;
    setProvider(override?.provider ?? "resend");
    setFromAddress(override?.fromAddress ?? "");
    setFields(INITIAL_FIELD_VALUES);
    setRecipientEmail("");
    setTestResult(null);
    setFormError(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }, [data, loading]);

  function clearAllErrors() {
    setFormError(null);
    clearSaveError();
    clearDeleteError();
    clearTestError();
  }

  async function handleSave() {
    setTestResult(null);
    clearAllErrors();

    const configResult = buildProviderConfig(provider, fields);
    if (!configResult.ok) {
      setFormError(configResult.error);
      return;
    }
    if (!fromAddress.trim()) {
      setFormError("From address is required.");
      return;
    }

    const result = await saveMutate({
      body: {
        provider,
        fromAddress: fromAddress.trim(),
        config: configResult.config,
      },
    });
    if (result.ok) {
      setFields(INITIAL_FIELD_VALUES);
    }
  }

  async function handleRemove() {
    setTestResult(null);
    clearAllErrors();
    const result = await deleteMutate();
    if (result.ok) {
      setExpanded(false);
      setProvider("resend");
      setFromAddress("");
      setFields(INITIAL_FIELD_VALUES);
    }
  }

  async function handleTest() {
    setTestResult(null);
    clearAllErrors();

    if (!recipientEmail.trim()) {
      setFormError("Enter a recipient email to send a test.");
      return;
    }

    const configResult = buildProviderConfig(provider, fields);
    const body: Record<string, unknown> = { recipientEmail: recipientEmail.trim() };
    if (configResult.ok) {
      body.provider = provider;
      body.fromAddress = fromAddress.trim() || override?.fromAddress || baseline?.fromAddress;
      body.config = configResult.config;
    }
    // else: no fresh creds → fall through to the saved override/baseline test path

    const result = await testMutate({ body });
    if (result.ok && result.data) setTestResult(result.data);
  }

  function handleCollapse() {
    setExpanded(false);
    setTestResult(null);
    setProvider("resend");
    setFromAddress("");
    setRecipientEmail("");
    setFields(INITIAL_FIELD_VALUES);
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
        {mutationError && (
          <div className="mx-auto mb-4 max-w-3xl">
            <ErrorBanner message={mutationError} onRetry={clearAllErrors} />
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

              {showEditor && (
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
                      <Button type="button" onClick={handleSave} disabled={saving}>
                        {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
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
                      <Select value={provider} onValueChange={(v) => setProvider(v as EmailProvider)}>
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
                      provider={provider}
                      values={fields}
                      onChange={setFields}
                      showSecrets={showSecrets}
                      onToggleSecrets={() => setShowSecrets((v) => !v)}
                    />

                    <div className="space-y-1">
                      <Label htmlFor="fromAddress">From address</Label>
                      <Input
                        id="fromAddress"
                        placeholder={override?.fromAddress ?? "Acme <noreply@acme.com>"}
                        className="font-mono text-sm"
                        value={fromAddress}
                        onChange={(e) => setFromAddress(e.target.value)}
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
