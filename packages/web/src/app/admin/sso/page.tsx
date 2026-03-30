"use client";

import { useState } from "react";
import { z } from "zod";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { ShieldCheck, AlertTriangle, Loader2, Shield } from "lucide-react";

// ── Schemas ───────────────────────────────────────────────────────

const SSOProviderSummarySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean(),
  ssoEnforced: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const ProvidersResponseSchema = z.object({
  providers: z.array(SSOProviderSummarySchema),
  total: z.number(),
});

const EnforcementResponseSchema = z.object({
  enforced: z.boolean(),
  orgId: z.string(),
});

// ── Main Page ─────────────────────────────────────────────────────

export default function SSOPage() {
  const [confirmEnforce, setConfirmEnforce] = useState(false);

  const { data: providersData, loading: providersLoading, error: providersError, refetch: refetchProviders } =
    useAdminFetch("/api/v1/admin/sso/providers", {
      schema: ProvidersResponseSchema,
    });

  const { data: enforcementData, loading: enforcementLoading, error: enforcementError, refetch: refetchEnforcement } =
    useAdminFetch("/api/v1/admin/sso/enforcement", {
      schema: EnforcementResponseSchema,
    });

  const { mutate, saving, error: mutationError, clearError: clearMutationError } = useAdminMutation({
    path: "/api/v1/admin/sso/enforcement",
    method: "PUT",
    invalidates: [refetchProviders, refetchEnforcement],
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
    const result = await mutate({ body: { enforced: value } });
    if (result.ok) {
      setConfirmEnforce(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">SSO</h1>
        <p className="text-sm text-muted-foreground">
          Manage single sign-on providers and enforcement
        </p>
      </div>

      <ErrorBoundary>
        <div>
          {mutationError && (
            <ErrorBanner message={mutationError} onRetry={clearMutationError} />
          )}
          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="SSO"
            onRetry={() => { refetchProviders(); refetchEnforcement(); }}
            loadingMessage="Loading SSO configuration..."
            emptyIcon={ShieldCheck}
            emptyTitle="No SSO configured"
            isEmpty={false}
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
                      disabled={saving || (!enforced && !hasActiveProvider)}
                    />
                    <span className="text-sm text-muted-foreground">
                      {enforced ? "SSO enforcement is active" : "SSO enforcement is inactive"}
                    </span>
                    {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                  </div>

                  {!hasActiveProvider && !enforced && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        You need at least one active (enabled) SSO provider before you can enforce SSO.
                        Create a SAML or OIDC provider below.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Providers Card */}
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Shield className="size-4" />
                    SSO Providers
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {providers.length}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    Identity providers configured for this workspace. Manage providers via the API.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {providers.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Shield className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        No SSO providers configured.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Use the Admin API to create SAML or OIDC providers.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {providers.map((provider) => (
                        <div
                          key={provider.id}
                          className="flex items-center justify-between rounded-md border px-4 py-3"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{provider.domain}</span>
                              <Badge variant="secondary" className="text-[10px] uppercase">
                                {provider.type}
                              </Badge>
                              {provider.enabled ? (
                                <Badge variant="default" className="text-[10px]">Enabled</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">Disabled</Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate max-w-md">
                              {provider.issuer}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
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
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => doSetEnforcement(true)}
              disabled={saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Enable Enforcement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
