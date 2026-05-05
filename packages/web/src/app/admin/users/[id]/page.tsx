"use client";

/**
 * Per-user danger-zone surface (#2093).
 *
 * Reachable from the /admin/users list via the "Manage user" dropdown
 * action. Today this page hosts the "Revoke all authentication" lever
 * and a read-only summary of the user's live auth artifacts; it
 * deliberately does NOT duplicate the role / ban surface that lives
 * in the list-page dropdowns. Future per-user controls (transfer
 * ownership, force password reset, etc.) belong here when they land.
 *
 * The danger-zone surface is its own page rather than a list-row
 * dropdown for two reasons:
 *
 *   1. Force-revoke is the load-bearing off-boarding action — making
 *      the operator navigate to a dedicated page builds in a "are you
 *      sure you're on the right user" pause that a list-row click
 *      doesn't.
 *   2. The artifact-count summary is a precondition for an informed
 *      confirmation. Surfacing "5 sessions · 2 trusted browsers · 1
 *      passkey" inline lets the operator see what they're about to
 *      destroy before the dialog opens.
 */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ShieldAlert, KeyRound, Smartphone, MonitorSmartphone, Database, UserX } from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ReasonDialog } from "@/ui/components/admin/queue";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { z } from "zod";

// Mirrors the API response schema in admin-revoke.ts. Kept in sync via the
// generated OpenAPI types in CI; the local declaration here is for the
// useAdminFetch consumer and is the source of truth for what the page
// actually reads.
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

  const { data: preview, loading, error, refetch } = useAdminFetch<Preview>(
    `/api/v1/admin/users/${userId}/revoke-auth/preview`,
    { schema: PreviewSchema },
  );

  const revokeAuth = useAdminMutation({
    path: `/api/v1/admin/users/${userId}/revoke-auth`,
    method: "POST",
    invalidates: refetch,
  });

  // Derive the "anything to revoke" boolean from the live counts so the
  // button shows a disabled state when there are no artifacts to clear —
  // a zero-count revoke still emits an audit row, but the UX should
  // reflect that the lever is a no-op before the operator pulls it.
  const totalArtifacts = preview
    ? preview.sessions + preview.trustedDevices + preview.passkeys +
      preview.oauthAccessTokens + preview.oauthRefreshTokens
    : 0;

  async function handleRevoke(reason: string) {
    const result = await revokeAuth.mutate({
      body: reason ? { reason } : {},
      onSuccess: () => {
        setConfirmOpen(false);
      },
    });
    // Keep the dialog open on failure so the operator can see the error
    // alongside the artifact-count context they were about to destroy.
    // useAdminMutation surfaces FetchError through `revokeAuth.error`,
    // which ReasonDialog renders via mutationError + feature routing.
    if (!result.ok) {
      return;
    }
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
            {/* Identity card */}
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

            {/* Authentication artefacts summary */}
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

            {/* Danger zone */}
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <ShieldAlert className="size-5" />
                  Danger zone
                </CardTitle>
                <CardDescription>
                  Force-revoke every authentication artifact for this user. The user can re-enroll
                  if they&apos;re re-hired; the contractor / compromised-account scenario is the
                  load-bearing case.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
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
