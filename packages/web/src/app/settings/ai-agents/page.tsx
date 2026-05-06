"use client";

/**
 * Settings → AI Agents (#2065).
 *
 * Workspace-native completion of the hosted-MCP install story. 1.4.0
 * shipped two extremes — power users got the CLI
 * (`bunx @useatlas/mcp init --hosted --write`) and DCR-spec-compliant
 * clients bootstrapped themselves; admins got a revocation-only inspection
 * surface at `/admin/oauth-clients`. Workspace users in the middle had
 * nothing. This page is theirs:
 *
 *   - Lists OAuth clients THIS user personally registered (not workspace-wide)
 *   - Per-row Revoke that calls the new self-revoke endpoint
 *   - On SaaS, surfaces a "Connect new agent" CTA that opens a 3-step wizard
 *
 * Self-hosted operators see the table but no Connect CTA — their auth model
 * differs and the admin surface (or the CLI) remains the install path. The
 * deploy-mode gate is read from the same `/api/v1/me/oauth-clients` response
 * so non-admin users don't need a second admin-gated roundtrip.
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import {
  MeOAuthClientsResponseSchema,
  type OAuthClient,
} from "@/ui/lib/me-schemas";
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
import { Bot, Loader2, Plus, Trash2 } from "lucide-react";

// Wizard is heavier than the list view (carries client-config templates +
// clipboard glue) and only opens on user action. Dynamic import keeps the
// list path off the SSR bundle so the empty-state hits TTFB clean.
const ConnectWizard = dynamic(
  () => import("./connect-wizard").then((m) => m.ConnectWizard),
  { ssr: false },
);

export default function AIAgentsPage() {
  const {
    data: listData,
    loading,
    error,
    refetch,
  } = useAdminFetch("/api/v1/me/oauth-clients", {
    schema: MeOAuthClientsResponseSchema,
  });
  const clients: OAuthClient[] = listData?.clients ?? [];
  // The fallback is the same safe default the API uses when getConfig() is
  // null — non-SaaS surfaces don't render the connect CTA.
  const deployMode = listData?.deployMode ?? "self-hosted";
  const isSaas = deployMode === "saas";

  const revokeMutation = useAdminMutation<{
    success: boolean;
    tokensRevoked: number;
  }>({
    method: "POST",
    invalidates: refetch,
  });

  const [revokeTarget, setRevokeTarget] = useState<OAuthClient | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function handleRevoke() {
    if (!revokeTarget) return;
    const result = await revokeMutation.mutate({
      path: `/api/v1/me/oauth-clients/${encodeURIComponent(revokeTarget.clientId)}/revoke`,
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
    revokeMutation.reset();
    setRevokeTarget(null);
  }

  const totalCount = clients.length;
  const showStat = !loading && !error && listData != null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Settings
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">AI Agents</h1>
          {showStat && totalCount > 0 && (
            <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
              <span className={cn("text-primary")}>{String(totalCount).padStart(2, "0")}</span>
              <span className="opacity-50">{" connected"}</span>
            </p>
          )}
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Connect Claude Desktop, Cursor, ChatGPT, or any MCP-compatible agent to query your workspace data on your behalf. Revoking a client invalidates every outstanding token; the agent will need to re-authorize before it can continue.
        </p>
        {showStat && isSaas && (
          <div className="mt-4">
            <Button
              variant="default"
              size="sm"
              onClick={() => setWizardOpen(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Connect new agent
            </Button>
          </div>
        )}
      </header>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="AI Agents"
          onRetry={refetch}
          loadingMessage="Loading connected agents..."
          emptyIcon={Bot}
          emptyTitle="No agents connected yet"
          emptyDescription="Connect Claude Desktop, Cursor, or any MCP client in 30 seconds."
          emptyAction={
            isSaas
              ? { label: "Connect new agent", onClick: () => setWizardOpen(true) }
              : undefined
          }
          isEmpty={clients.length === 0}
        >
          <section>
            <SectionHeading
              title="Connected agents"
              description="Each agent is shown with its registration date, redirect URIs, and outstanding token count"
            />
            <div className="space-y-2">
              {clients.map((client) => (
                <AIAgentShell
                  key={client.clientId}
                  client={client}
                  onRevoke={requestRevoke}
                />
              ))}
            </div>
          </section>
        </AdminContentWrapper>
      </ErrorBoundary>

      {!isSaas && showStat && clients.length === 0 && (
        <p className="mt-6 text-xs text-muted-foreground">
          Self-hosted Atlas: install agents via the{" "}
          <a
            href="https://docs.useatlas.dev/guides/mcp-hosted"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            CLI installer
          </a>{" "}
          or have an admin manage clients in{" "}
          <Link href="/admin/oauth-clients" className="underline underline-offset-2">
            Admin → OAuth Clients
          </Link>
          .
        </p>
      )}

      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) dismissRevokeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke agent</DialogTitle>
            <DialogDescription>
              This will revoke{" "}
              <strong>{revokeTarget?.clientName ?? revokeTarget?.clientId ?? "this agent"}</strong>
              {" "}and invalidate every outstanding access and refresh token. The agent will need to re-authorize before it can query your workspace again.
            </DialogDescription>
          </DialogHeader>
          <MutationErrorSurface
            error={revokeMutation.error}
            feature="AI Agents"
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
              Revoke agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {wizardOpen && (
        <ConnectWizard
          open={wizardOpen}
          onClose={() => {
            setWizardOpen(false);
            // Refetch on close — a successful connect lands a new row in the
            // table, but the client-side state can't observe it without a
            // refetch (the OAuth dance happens in the agent process, not here).
            refetch();
          }}
        />
      )}
    </div>
  );
}

function AIAgentShell({
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
      icon={Bot}
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
