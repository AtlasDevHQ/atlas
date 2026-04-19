"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  type StatusKind,
} from "@/ui/components/admin/compact";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  AlertTriangle,
  Loader2,
  Shield,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Copy,
  Check,
  KeyRound,
} from "lucide-react";
import {
  ProvidersResponseSchema,
  EnforcementResponseSchema,
  type SSOProviderSummary,
} from "@/ui/components/admin/sso/sso-types";
import { CreateProviderDialog } from "@/ui/components/admin/sso/create-provider-dialog";
import { EditProviderDialog } from "@/ui/components/admin/sso/edit-provider-dialog";
import { DeleteProviderDialog } from "@/ui/components/admin/sso/delete-provider-dialog";

// ── Page-local helpers ────────────────────────────────────────────

function VerificationBadge({ status }: { status: "pending" | "verified" | "failed" }) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="default" className="gap-1 bg-emerald-600 text-[10px] text-emerald-50 hover:bg-emerald-600">
          <ShieldCheck className="size-3" />
          Verified
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="gap-1 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="gap-1 border-red-500/50 text-[10px] text-red-600 dark:text-red-400">
          <ShieldAlert className="size-3" />
          Failed
        </Badge>
      );
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.debug("Clipboard write failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      className="h-6 gap-1 text-muted-foreground"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function SSOPage() {
  const [confirmEnforce, setConfirmEnforce] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<SSOProviderSummary | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<SSOProviderSummary | null>(null);

  const { data: providersData, loading: providersLoading, error: providersError, refetch: refetchProviders } =
    useAdminFetch("/api/v1/admin/sso/providers", {
      schema: ProvidersResponseSchema,
    });

  const { data: enforcementData, loading: enforcementLoading, error: enforcementError, refetch: refetchEnforcement } =
    useAdminFetch("/api/v1/admin/sso/enforcement", {
      schema: EnforcementResponseSchema,
    });

  const { mutate: mutateEnforcement, saving: enforcementSaving, error: enforcementMutationError, clearError: clearEnforcementError } = useAdminMutation({
    path: "/api/v1/admin/sso/enforcement",
    method: "PUT",
    invalidates: [refetchProviders, refetchEnforcement],
  });

  const { mutate: mutateProvider, isMutating, error: toggleError, clearError: clearToggleError } = useAdminMutation({
    method: "PATCH",
  });

  const { mutate: verifyDomainMutation, isMutating: isVerifying, error: verifyError, clearError: clearVerifyError } = useAdminMutation({
    method: "POST",
  });

  const loading = providersLoading || enforcementLoading;
  const error = providersError ?? enforcementError;
  const providers = providersData?.providers ?? [];
  const enforced = enforcementData?.enforced ?? false;
  const enabledProviders = providers.filter((p) => p.enabled);
  const hasActiveProvider = enabledProviders.length > 0;

  async function handleToggleEnforcement(enable: boolean) {
    if (enable) {
      setConfirmEnforce(true);
      return;
    }
    await doSetEnforcement(false);
  }

  async function doSetEnforcement(value: boolean) {
    const result = await mutateEnforcement({ body: { enforced: value } });
    if (result.ok) {
      setConfirmEnforce(false);
    }
  }

  async function handleToggleEnabled(provider: SSOProviderSummary, enabled: boolean) {
    await mutateProvider({
      path: `/api/v1/admin/sso/providers/${provider.id}`,
      body: { enabled },
      itemId: `toggle-${provider.id}`,
    });
  }

  async function handleVerifyDomain(provider: SSOProviderSummary) {
    await verifyDomainMutation({
      path: `/api/v1/admin/sso/providers/${provider.id}/verify`,
      itemId: `verify-${provider.id}`,
    });
  }

  // Check if deleting this provider would be the last enabled one
  function isLastEnabledWithEnforcement(provider: SSOProviderSummary): boolean {
    if (!enforced || !provider.enabled) return false;
    return enabledProviders.length === 1;
  }

  const enforcementDescription = enforced
    ? `Active — ${enabledProviders.length} provider${enabledProviders.length !== 1 ? "s" : ""} in rotation`
    : hasActiveProvider
    ? "All members use password login until turned on"
    : "Add an enabled provider before you can enforce";

  const providerCount = providers.length;
  const enabledCount = enabledProviders.length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">SSO</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(enabledCount > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(enabledCount).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(providerCount).padStart(2, "0")} active
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Single sign-on providers and workspace-wide enforcement.
        </p>
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="SSO"
          onRetry={() => { refetchProviders(); refetchEnforcement(); }}
          loadingMessage="Loading SSO configuration..."
          isEmpty={false}
        >
          {enforcementMutationError && (
            <div className="mb-4">
              <ErrorBanner message={friendlyError(enforcementMutationError)} onRetry={clearEnforcementError} />
            </div>
          )}
          {toggleError && (
            <div className="mb-4">
              <ErrorBanner message={friendlyError(toggleError)} onRetry={clearToggleError} />
            </div>
          )}
          {verifyError && (
            <div className="mb-4">
              <ErrorBanner message={friendlyError(verifyError)} onRetry={clearVerifyError} />
            </div>
          )}

          <div className="space-y-10">
            {/* Enforcement */}
            <section>
              <SectionHeading
                title="Enforcement"
                description="Force every member to sign in through SSO"
              />
              {enforced ? (
                <Shell
                  icon={ShieldCheck}
                  title="SSO enforcement"
                  description={enforcementDescription}
                  status="connected"
                  actions={
                    <div className="flex items-center gap-2">
                      {enforcementSaving && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" />
                      )}
                      <span className="text-xs text-muted-foreground">
                        Password login disabled
                      </span>
                      <Switch
                        checked={enforced}
                        onCheckedChange={handleToggleEnforcement}
                        disabled={enforcementSaving}
                        aria-label="Disable SSO enforcement"
                      />
                    </div>
                  }
                />
              ) : (
                <div className="space-y-2">
                  <CompactRow
                    icon={ShieldCheck}
                    title="SSO enforcement"
                    description={enforcementDescription}
                    status={hasActiveProvider ? "disconnected" : "unavailable"}
                    action={
                      <div className="flex items-center gap-2">
                        {enforcementSaving && (
                          <Loader2 className="size-3 animate-spin text-muted-foreground" />
                        )}
                        <Switch
                          checked={enforced}
                          onCheckedChange={handleToggleEnforcement}
                          disabled={enforcementSaving || !hasActiveProvider}
                          aria-label="Enable SSO enforcement"
                        />
                      </div>
                    }
                  />
                  {!hasActiveProvider && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        You need at least one active (enabled) SSO provider before you can enforce SSO.
                        Add and verify a provider below.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Providers */}
            <section>
              <SectionHeading
                title="Providers"
                description="SAML and OIDC identity providers configured for this workspace"
              />
              <div className="space-y-2">
                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    onEdit={setEditProvider}
                    onDelete={setDeleteProvider}
                    onToggleEnabled={handleToggleEnabled}
                    onVerifyDomain={handleVerifyDomain}
                    isToggling={isMutating(`toggle-${provider.id}`)}
                    isVerifying={isVerifying(`verify-${provider.id}`)}
                  />
                ))}

                <CompactRow
                  icon={Plus}
                  title={providers.length === 0 ? "Add your first provider" : "Add another provider"}
                  description={
                    providers.length === 0
                      ? "Connect Okta, Azure AD, Google Workspace, or any SAML/OIDC IdP"
                      : "Hook up another SAML or OIDC identity provider"
                  }
                  status="disconnected"
                  action={
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="mr-1.5 size-3.5" />
                      Add provider
                    </Button>
                  }
                />
              </div>
            </section>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>

      {/* Enforcement Confirmation Dialog */}
      <AlertDialog open={confirmEnforce} onOpenChange={setConfirmEnforce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable SSO Enforcement?</AlertDialogTitle>
            <AlertDialogDescription>
              All members will be required to sign in via SSO. Password login will be disabled
              for this workspace. Organization owners can disable enforcement via API key
              authentication as a break-glass escape.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {enforcementMutationError && (
            <ErrorBanner message={friendlyError(enforcementMutationError)} onRetry={clearEnforcementError} />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enforcementSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => doSetEnforcement(true)}
              disabled={enforcementSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {enforcementSaving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Enable Enforcement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {createOpen && (
        <CreateProviderDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}
      {editProvider && (
        <EditProviderDialog
          open={true}
          onOpenChange={(open) => { if (!open) setEditProvider(null); }}
          provider={editProvider}
        />
      )}
      {deleteProvider && (
        <DeleteProviderDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDeleteProvider(null); }}
          provider={deleteProvider}
          isLastEnabledWithEnforcement={isLastEnabledWithEnforcement(deleteProvider)}
        />
      )}
    </div>
  );
}

// ── Provider row ────────────────────────────────────────────────

function ProviderRow({
  provider,
  onEdit,
  onDelete,
  onToggleEnabled,
  onVerifyDomain,
  isToggling,
  isVerifying,
}: {
  provider: SSOProviderSummary;
  onEdit: (provider: SSOProviderSummary) => void;
  onDelete: (provider: SSOProviderSummary) => void;
  onToggleEnabled: (provider: SSOProviderSummary, enabled: boolean) => void;
  onVerifyDomain: (provider: SSOProviderSummary) => void;
  isToggling: boolean;
  isVerifying: boolean;
}) {
  const domainVerified = provider.domainVerificationStatus === "verified";
  const status: StatusKind = provider.enabled ? "connected" : "disconnected";
  const Icon = provider.type === "saml" ? Shield : KeyRound;

  // SP Metadata — Entity ID and ACS URL are derived from the app's base URL.
  // Resolve origin in an effect so the first paint doesn't flash a
  // relative-path placeholder and the CopyButtons never copy a broken URL.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const hasOrigin = origin.length > 0;
  const spEntityId = `${origin}/api/auth/sso/${provider.type}/entity-id/${provider.id}`;
  const spAcsUrl = `${origin}/api/auth/sso/${provider.type}/callback/${provider.id}`;

  return (
    <Shell
      icon={Icon}
      title={provider.domain}
      description={provider.issuer}
      status={status}
      titleBadge={
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px] uppercase">
          {provider.type}
        </Badge>
      }
      actions={
        <>
          {!domainVerified && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onVerifyDomain(provider)}
              disabled={isVerifying}
            >
              {isVerifying ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Verify
            </Button>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Switch
                    checked={provider.enabled}
                    onCheckedChange={(checked) => onToggleEnabled(provider, checked)}
                    disabled={isToggling || (!domainVerified && !provider.enabled)}
                    aria-label={provider.enabled ? "Disable provider" : "Enable provider"}
                  />
                </div>
              </TooltipTrigger>
              {!domainVerified && !provider.enabled && (
                <TooltipContent>
                  <p>Verify domain ownership before enabling this provider</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onEdit(provider)}
            aria-label="Edit provider"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onDelete(provider)}
            className="text-destructive hover:text-destructive"
            aria-label="Delete provider"
          >
            <Trash2 className="size-3" />
          </Button>
        </>
      }
    >
      <DetailList>
        <DetailRow
          label="Verification"
          value={<VerificationBadge status={provider.domainVerificationStatus} />}
        />
        <DetailRow label="Domain" value={provider.domain} mono truncate />
        <DetailRow label="Issuer" value={provider.issuer} mono truncate />
        {provider.domainVerifiedAt && (
          <DetailRow
            label="Verified"
            value={formatDateTime(provider.domainVerifiedAt)}
          />
        )}
        <DetailRow label="Added" value={formatDateTime(provider.createdAt)} />
      </DetailList>

      {!domainVerified && provider.verificationToken && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2">
          <code className="flex-1 truncate text-[11px] font-mono text-muted-foreground">
            TXT _atlas-verify.{provider.domain} = {provider.verificationToken}
          </code>
          <CopyButton value={provider.verificationToken} label="verification token" />
        </div>
      )}

      {provider.type === "saml" && hasOrigin && (
        <DetailList>
          <DetailRow label="SP Entity ID" value={spEntityId} mono truncate />
          <DetailRow label="SP ACS URL" value={spAcsUrl} mono truncate />
          <div className="flex items-center justify-end gap-2 pt-1">
            <CopyButton value={spEntityId} label="Entity ID" />
            <CopyButton value={spAcsUrl} label="ACS URL" />
          </div>
        </DetailList>
      )}
    </Shell>
  );
}
