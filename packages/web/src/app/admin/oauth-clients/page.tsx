"use client";

import { useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  ListOAuthClientsResponseSchema,
  type OAuthClient,
} from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  type StatusKind,
} from "@/ui/components/admin/compact";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate, formatDateTime } from "@/lib/format";
import { KeyRound, Loader2, Trash2 } from "lucide-react";

export default function OAuthClientsPage() {
  const {
    data: listData,
    loading,
    error,
    refetch,
  } = useAdminFetch("/api/v1/admin/oauth-clients", {
    schema: ListOAuthClientsResponseSchema,
  });
  const clients: OAuthClient[] = listData?.clients ?? [];

  const revokeMutation = useAdminMutation<{
    success: boolean;
    tokensRevoked: number;
  }>({
    method: "POST",
    invalidates: refetch,
  });

  const [revokeTarget, setRevokeTarget] = useState<OAuthClient | null>(null);

  async function handleRevoke() {
    if (!revokeTarget) return;
    const result = await revokeMutation.mutate({
      path: `/api/v1/admin/oauth-clients/${encodeURIComponent(revokeTarget.clientId)}/revoke`,
    });
    if (result.ok) {
      setRevokeTarget(null);
    }
  }

  function requestRevoke(client: OAuthClient) {
    revokeMutation.reset();
    setRevokeTarget(client);
  }

  function dismissRevokeDialog() {
    if (revokeMutation.saving) return;
    // Clear the mutation error state alongside the dialog so a stale failure
    // doesn't bleed into other surfaces (e.g. on next open) after dismissal.
    revokeMutation.reset();
    setRevokeTarget(null);
  }

  const activeCount = clients.filter((c) => !c.disabled).length;
  const totalCount = clients.length;
  const showStat = !loading && !error && listData != null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">OAuth clients</h1>
          {showStat && (
            <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
              <span className={cn(activeCount > 0 ? "text-primary" : "text-muted-foreground")}>
                {String(activeCount).padStart(2, "0")}
              </span>
              <span className="opacity-50">{" / "}</span>
              {String(totalCount).padStart(2, "0")} active
            </p>
          )}
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Inspect and revoke OAuth 2.1 clients registered against this workspace, including MCP agents (Claude Desktop, ChatGPT, Cursor) that registered via Dynamic Client Registration.
        </p>
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="OAuth Clients"
          onRetry={refetch}
          loadingMessage="Loading OAuth clients..."
          emptyIcon={KeyRound}
          emptyTitle="No OAuth clients registered"
          emptyDescription="Clients appear here when an MCP agent or other OAuth-compliant tool authorizes against this workspace."
          isEmpty={clients.length === 0}
        >
          {/*
            Revoke errors render inside the open dialog (the dialog stays open
            on failure so the user can see the message and retry). A
            page-level surface here would render the same error twice — see
            silent-failure-hunter I2 from PR #2062 review.
          */}

          <section>
            <SectionHeading
              title="Registered clients"
              description="Each client is shown with its registration date, redirect URIs, and outstanding token count"
            />
            <div className="space-y-2">
              {clients.map((client) => (
                <OAuthClientShell
                  key={client.clientId}
                  client={client}
                  onRevoke={requestRevoke}
                />
              ))}
            </div>
          </section>
        </AdminContentWrapper>
      </ErrorBoundary>

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) dismissRevokeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke OAuth client</DialogTitle>
            <DialogDescription>
              This will permanently revoke{" "}
              <strong>{revokeTarget?.clientName ?? revokeTarget?.clientId ?? "this client"}</strong>
              {" "}and invalidate every outstanding access and refresh token. The client will need to re-register before it can authorize again. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <MutationErrorSurface
            error={revokeMutation.error}
            feature="OAuth Clients"
            variant="inline"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={dismissRevokeDialog}
              disabled={revokeMutation.saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={revokeMutation.saving}
            >
              {revokeMutation.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Revoke client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OAuthClientShell({
  client,
  onRevoke,
}: {
  client: OAuthClient;
  onRevoke: (client: OAuthClient) => void;
}) {
  const status: StatusKind = client.disabled
    ? "unavailable"
    : client.lastUsedAt
      ? "connected"
      : "ready";
  const displayName = client.clientName ?? client.clientId;

  return (
    <Shell
      icon={KeyRound}
      title={displayName}
      description={
        client.disabled
          ? "Disabled — revoke to remove from the list"
          : client.lastUsedAt
            ? `Last used ${formatDateTime(client.lastUsedAt)}`
            : "Registered but never used"
      }
      status={status}
      titleBadge={
        client.disabled ? (
          <Badge variant="outline" className="shrink-0 border-destructive/30 text-[10px] text-destructive">
            Disabled
          </Badge>
        ) : client.type === "public" ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            Public
          </Badge>
        ) : undefined
      }
      actions={
        <Button
          variant="outline"
          size="xs"
          onClick={() => onRevoke(client)}
          className="text-destructive hover:text-destructive"
          aria-label={`Revoke ${displayName}`}
        >
          <Trash2 className="mr-1.5 size-3" />
          Revoke
        </Button>
      }
    >
      <DetailList>
        <DetailRow label="Client ID" value={client.clientId} mono truncate />
        <DetailRow label="Registered" value={formatDate(client.createdAt)} />
        <DetailRow
          label="Last used"
          value={client.lastUsedAt ? formatDateTime(client.lastUsedAt) : "Never"}
        />
        <DetailRow
          label="Active tokens"
          value={String(client.tokenCount)}
          mono
        />
        {client.redirectUris.length > 0 && (
          <DetailRow
            label={client.redirectUris.length === 1 ? "Redirect URI" : "Redirect URIs"}
            value={client.redirectUris.join(", ")}
            mono
            truncate
          />
        )}
      </DetailList>
    </Shell>
  );
}
