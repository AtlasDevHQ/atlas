"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Fingerprint, ShieldAlert, KeyRound, Smartphone, MonitorSmartphone, Database, UserX } from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ReasonDialog } from "@/ui/components/admin/queue";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { z } from "zod";

// Hand-mirrored from the API's PreviewResponseSchema in
// admin-revoke.ts. Update both when the response shape changes.
const PreviewSchema = z.object({
  targetUserId: z.string(),
  targetUserEmail: z.string().nullable(),
  sessions: z.number().int().nonnegative(),
  trustedDevices: z.number().int().nonnegative(),
  passkeys: z.number().int().nonnegative(),
  oauthAccessTokens: z.number().int().nonnegative(),
  oauthRefreshTokens: z.number().int().nonnegative(),
});

type Preview = z.infer<typeof PreviewSchema>;

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const userId = params.id;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mfaResetOpen, setMfaResetOpen] = useState(false);

  const { data: preview, loading, error, refetch } = useAdminFetch<Preview>(
    `/api/v1/admin/users/${userId}/revoke-auth/preview`,
    { schema: PreviewSchema },
  );

  const revokeAuth = useAdminMutation({
    path: `/api/v1/admin/users/${userId}/revoke-auth`,
    method: "POST",
    invalidates: refetch,
  });

  // Sibling primitive (#2092 — Wave 2B). Narrower scope than revoke-auth:
  // clears passkeys + TOTP only, leaves sessions and OAuth grants alone.
  // The same `refetch` invalidates the preview counts so the passkey
  // count tile updates after a successful reset.
  const resetMfa = useAdminMutation({
    path: `/api/v1/admin/users/${userId}/reset-mfa`,
    method: "POST",
    invalidates: refetch,
  });

  const totalArtifacts = preview
    ? preview.sessions + preview.trustedDevices + preview.passkeys +
      preview.oauthAccessTokens + preview.oauthRefreshTokens
    : 0;

  // No error branch — `onSuccess` only fires on 2xx, so a failure leaves
  // the dialog open with `revokeAuth.error` rendered through
  // ReasonDialog's `mutationError`.
  async function handleRevoke(reason: string) {
    await revokeAuth.mutate({
      body: reason ? { reason } : {},
      onSuccess: () => setConfirmOpen(false),
    });
  }

  async function handleMfaReset(reason: string) {
    await resetMfa.mutate({
      body: reason ? { reason } : {},
      onSuccess: () => setMfaResetOpen(false),
    });
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/admin/users")}
          aria-label="Back to users"
        >
          <ArrowLeft className="mr-1.5 size-4" />
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User actions</h1>
          <p className="text-sm text-muted-foreground">
            Off-boarding and credential controls for a single user.
          </p>
        </div>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="User Auth Revoke"
        onRetry={refetch}
        loadingMessage="Loading user…"
        isEmpty={!preview}
        emptyIcon={UserX}
        emptyTitle="User not found"
        emptyDescription="This user is not in your workspace, or the id is invalid."
      >
        {preview && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{preview.targetUserEmail ?? "(no email on record)"}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {preview.targetUserId}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Role and membership are managed from the{" "}
                  <button
                    type="button"
                    onClick={() => router.push("/admin/users")}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    users list
                  </button>
                  . This page is for actions that don&apos;t fit a row-level dropdown.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Authentication artifacts</CardTitle>
                <CardDescription>
                  Live credentials this user can sign in with. Revoking below clears every
                  artifact in a single transaction.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <ArtifactStat
                    icon={<MonitorSmartphone className="size-4" />}
                    label="Sessions"
                    value={preview.sessions}
                    description="Active web sign-ins"
                  />
                  <ArtifactStat
                    icon={<Smartphone className="size-4" />}
                    label="Trusted browsers"
                    value={preview.trustedDevices}
                    description="2FA-skip cookies"
                  />
                  <ArtifactStat
                    icon={<KeyRound className="size-4" />}
                    label="Passkeys"
                    value={preview.passkeys}
                    description="Enrolled WebAuthn keys"
                  />
                  <ArtifactStat
                    icon={<Database className="size-4" />}
                    label="OAuth access tokens"
                    value={preview.oauthAccessTokens}
                    description="Issued under MCP / OAuth clients"
                  />
                  <ArtifactStat
                    icon={<Database className="size-4" />}
                    label="OAuth refresh tokens"
                    value={preview.oauthRefreshTokens}
                    description="Long-lived MCP / OAuth grants"
                  />
                </dl>
              </CardContent>
            </Card>

            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <ShieldAlert className="size-5" />
                  Danger zone
                </CardTitle>
                <CardDescription>
                  Recovery and off-boarding controls. Reset MFA recovers a locked-out user;
                  full revoke handles the contractor / compromised-account case. Both write
                  audit rows.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/*
                  MFA reset (#2092 — Wave 2B). Narrower scope than full revoke:
                  clears passkeys + TOTP + bundled backup codes only. Sessions
                  and OAuth grants stay live so a recovery reset doesn't
                  double as an unintended sign-out.
                */}
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
                  <h3 className="text-sm font-semibold">Reset MFA enrollment</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Atomically clears every passkey, TOTP secret, and bundled backup-code
                    batch for this user inside a single transaction. Sessions and OAuth
                    grants are left in place. The user is forced to re-enroll a second
                    factor on the next admin-router request. Use this when a user has
                    lost their only authenticator and is locked out.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {/*
                      Stays clickable even at zero-passkey preview — the
                      preview endpoint doesn't expose TOTP enrollment, and
                      a zero-MFA reset still emits a forensic audit row
                      (same "audit on zero" pattern as revoke-auth).
                    */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                      onClick={() => setMfaResetOpen(true)}
                    >
                      <Fingerprint className="mr-1.5 size-3.5" />
                      Reset MFA enrollment
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {preview.passkeys === 0
                        ? "No passkeys on file. Any TOTP secret will still be cleared."
                        : `${preview.passkeys} passkey${preview.passkeys === 1 ? "" : "s"} and any TOTP secret will be cleared.`}
                    </span>
                  </div>
                </div>

                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
                  <h3 className="text-sm font-semibold">Revoke all authentication</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Atomically deletes every active session, trusted-browser cookie, enrolled
                    passkey, and OAuth access/refresh token for this user inside a single
                    transaction. Audited with per-class counts plus the reason you provide below.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmOpen(true)}
                      disabled={totalArtifacts === 0}
                    >
                      Revoke all authentication
                    </Button>
                    {totalArtifacts === 0 ? (
                      <Badge variant="outline" className="text-xs">
                        No live artifacts to revoke
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {totalArtifacts} artifact{totalArtifacts === 1 ? "" : "s"} will be deleted.
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </AdminContentWrapper>

      <ReasonDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!revokeAuth.saving) {
            setConfirmOpen(open);
            if (!open) revokeAuth.clearError();
          }
        }}
        title="Revoke all authentication"
        description="Recorded in the audit log alongside your account, with per-class counts."
        confirmLabel="Revoke all authentication"
        placeholder="e.g., Contractor terminated 2026-05-05, badge revoked"
        feature="User Auth Revoke"
        context={
          preview ? (
            <div className="space-y-1.5">
              <div className="font-medium text-foreground">
                {preview.targetUserEmail ?? preview.targetUserId}
              </div>
              <div className="text-muted-foreground">
                {preview.sessions} session{preview.sessions === 1 ? "" : "s"} ·{" "}
                {preview.trustedDevices} trusted browser{preview.trustedDevices === 1 ? "" : "s"} ·{" "}
                {preview.passkeys} passkey{preview.passkeys === 1 ? "" : "s"} ·{" "}
                {preview.oauthAccessTokens + preview.oauthRefreshTokens} OAuth token
                {preview.oauthAccessTokens + preview.oauthRefreshTokens === 1 ? "" : "s"}
              </div>
            </div>
          ) : null
        }
        onConfirm={handleRevoke}
        loading={revokeAuth.saving}
        mutationError={revokeAuth.error}
      />

      <ReasonDialog
        open={mfaResetOpen}
        onOpenChange={(open) => {
          if (!resetMfa.saving) {
            setMfaResetOpen(open);
            if (!open) resetMfa.clearError();
          }
        }}
        title="Reset MFA enrollment"
        description="Recorded in the audit log with per-artifact counts (passkeys, TOTP secrets, backup-code batches). Sessions and OAuth grants stay live."
        confirmLabel="Reset MFA"
        placeholder="e.g., User reports stolen laptop, cross-checked with HR ticket TKT-1234"
        feature="User MFA Reset"
        context={
          preview ? (
            <div className="space-y-1.5">
              <div className="font-medium text-foreground">
                {preview.targetUserEmail ?? preview.targetUserId}
              </div>
              <div className="text-muted-foreground">
                {preview.passkeys} passkey{preview.passkeys === 1 ? "" : "s"} on file. Any TOTP
                secret + bundled backup codes will also be cleared.
              </div>
            </div>
          ) : null
        }
        onConfirm={handleMfaReset}
        loading={resetMfa.saving}
        mutationError={resetMfa.error}
      />
    </div>
  );
}

function ArtifactStat({
  icon,
  label,
  value,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  description: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground/70">{description}</div>
    </div>
  );
}
