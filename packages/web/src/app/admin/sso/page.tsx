"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { ShieldCheck, AlertTriangle, Loader2, Shield, Plus } from "lucide-react";
import {
  ProvidersResponseSchema,
  EnforcementResponseSchema,
  type SSOProviderSummary,
} from "@/ui/components/admin/sso/sso-types";
import { ProviderCard } from "@/ui/components/admin/sso/provider-card";
import { CreateProviderDialog } from "@/ui/components/admin/sso/create-provider-dialog";
import { EditProviderDialog } from "@/ui/components/admin/sso/edit-provider-dialog";
import { DeleteProviderDialog } from "@/ui/components/admin/sso/delete-provider-dialog";

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
  const hasActiveProvider = providers.some((p) => p.enabled);

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
    const enabledCount = providers.filter((p) => p.enabled).length;
    return enabledCount === 1;
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SSO</h1>
          <p className="text-sm text-muted-foreground">
            Manage single sign-on providers and enforcement
          </p>
        </div>
        {providers.length > 0 && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Provider
          </Button>
        )}
      </div>

      <ErrorBoundary>
        <div>
          {enforcementMutationError && (
            <ErrorBanner message={enforcementMutationError} onRetry={clearEnforcementError} />
          )}
          {toggleError && (
            <ErrorBanner message={toggleError} onRetry={clearToggleError} />
          )}
          {verifyError && (
            <ErrorBanner message={verifyError} onRetry={clearVerifyError} />
          )}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="SSO"
            onRetry={() => { refetchProviders(); refetchEnforcement(); }}
            loadingMessage="Loading SSO configuration..."
            emptyIcon={ShieldCheck}
            emptyTitle="No SSO providers configured"
            emptyDescription="Add your first SAML or OIDC provider to enable single sign-on for your workspace."
            emptyAction={{ label: "Add SSO Provider", onClick: () => setCreateOpen(true) }}
            isEmpty={providers.length === 0}
          >
            <div className="space-y-6">
              {/* Enforcement Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="size-4" />
                    SSO Enforcement
                    {enforced ? (
                      <Badge variant="default" className="text-[10px]">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Inactive</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    When enabled, all members must sign in via the configured identity provider.
                    Password login will be disabled for this workspace.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={enforced}
                      onCheckedChange={handleToggleEnforcement}
                      disabled={enforcementSaving || (!enforced && !hasActiveProvider)}
                    />
                    <span className="text-sm text-muted-foreground">
                      {enforced
                        ? `SSO enforcement is active — ${providers.filter((p) => p.enabled).length} provider${providers.filter((p) => p.enabled).length !== 1 ? "s" : ""} active`
                        : "SSO enforcement is inactive"}
                    </span>
                    {enforcementSaving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                  </div>

                  {!hasActiveProvider && !enforced && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        You need at least one active (enabled) SSO provider before you can enforce SSO.
                        Add and verify a provider below.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Providers Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Shield className="size-4" />
                      SSO Providers
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        {providers.length}
                      </Badge>
                    </CardTitle>
                  </div>
                  <CardDescription>
                    Identity providers configured for this workspace.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {providers.map((provider) => (
                      <ProviderCard
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
                  </div>
                </CardContent>
              </Card>
            </div>
          </AdminContentWrapper>
        </div>
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
            <ErrorBanner message={enforcementMutationError} onRetry={clearEnforcementError} />
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
