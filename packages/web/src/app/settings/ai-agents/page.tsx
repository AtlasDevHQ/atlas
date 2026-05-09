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

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useVisibilityGatedPoll } from "@/ui/hooks/use-visibility-gated-poll";
import {
  MeOAuthClientsResponseSchema,
  MeMcpUsageResponseSchema,
  type McpUsageEntry,
  type OAuthClient,
} from "@/ui/lib/me-schemas";
import { UsageChip } from "@/ui/components/settings/usage-chip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { AlertTriangle, Bot, Globe, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

// Wizard is heavier than the list view (carries client-config templates +
// clipboard glue) and only opens on user action. Dynamic import keeps the
// list path off the SSR bundle so the empty-state hits TTFB clean.
const ConnectWizard = dynamic(
  () => import("./connect-wizard").then((m) => m.ConnectWizard),
  { ssr: false },
);

// Prompts preview block (#2179) — fetches `/api/v1/me/mcp-prompts` and
// renders the source-grouped prompt set. Dynamic-imported alongside the
// wizard to keep the page's first paint focused on the connected-agents
// list; the preview slots in once the JS chunk arrives.
const PromptsPreview = dynamic(
  () => import("./prompts-preview").then((m) => m.PromptsPreview),
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

  // Live MCP rate-limit usage (#2216). Separate fetch so the poll
  // cadence below doesn't refetch the heavier clients query (which
  // already has its own SWR semantics in TanStack). The schema parse
  // surfaces wire drift as a banner via useAdminFetch's
  // `code: "schema_mismatch"` path rather than a broken chip.
  const { data: usageData, refetch: refetchUsage } = useAdminFetch(
    "/api/v1/me/mcp-usage",
    { schema: MeMcpUsageResponseSchema },
  );

  // Stable refetch ref for the visibility-gated poll. `useCallback`
  // here is a correctness aid (TanStack Query's `refetch` is already
  // stable per query instance, but the hook's effect depends on its
  // identity), not a perf optimization — see CLAUDE.md "React Compiler
  // handles memoization" carve-out for stability cases.
  const refetchUsageStable = useCallback(() => {
    void refetchUsage();
  }, [refetchUsage]);
  // Poll every 10s while foregrounded; refetch immediately on
  // visibility return; do nothing while hidden. Acceptance criterion
  // from #2216 — verifiable via the e2e DevTools Network observation.
  useVisibilityGatedPoll(refetchUsageStable, 10_000);

  // Build a client-id → usage map up front so the row renderer doesn't
  // walk the array per agent. Empty map (no usage data yet) is the
  // first-paint state — the chip renders a neutral 0/60 placeholder
  // until the first fetch lands.
  const usageById: Map<string, McpUsageEntry> = new Map(
    (usageData?.clients ?? []).map((u) => [u.clientId, u]),
  );

  const revokeMutation = useAdminMutation<{
    success: boolean;
    tokensRevoked: number;
  }>({
    method: "POST",
    invalidates: refetch,
  });

  // #2073 — workspace-scope toggle + per-workspace grant revoke. Both
  // hit the same `/api/v1/me/oauth-clients/:id/...` family and share
  // the refetch invalidation hook so the agents list rerenders with
  // the new scope/grant state without a manual refresh.
  const scopeMutation = useAdminMutation<{
    success: boolean;
    workspaceScope: "single" | "multi";
    grantedWorkspaceIds: string[];
  }>({
    method: "POST",
    invalidates: refetch,
  });
  const grantMutation = useAdminMutation<{
    success: boolean;
    removed: number;
  }>({
    method: "DELETE",
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

  async function toggleWorkspaceScope(client: OAuthClient) {
    const targetMode = client.workspaceScope === "multi" ? "single" : "multi";
    await scopeMutation.mutate({
      path: `/api/v1/me/oauth-clients/${encodeURIComponent(client.clientId)}/workspace-scope`,
      body: { mode: targetMode },
    });
  }

  async function revokeWorkspaceGrant(client: OAuthClient, workspaceId: string) {
    await grantMutation.mutate({
      path: `/api/v1/me/oauth-clients/${encodeURIComponent(client.clientId)}/workspaces/${encodeURIComponent(workspaceId)}`,
    });
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
                <div
                  key={client.clientId}
                  // Revoked rows dim slightly so the audit trail is visible
                  // but the row reads as "no longer active". Active and
                  // reconnect_required render at full opacity.
                  className={cn(
                    client.tokenState === "revoked" && "opacity-60",
                  )}
                >
                  <AIAgentShell
                    client={client}
                    usage={usageById.get(client.clientId)}
                    onRevoke={requestRevoke}
                    onToggleScope={toggleWorkspaceScope}
                    onRevokeWorkspaceGrant={revokeWorkspaceGrant}
                    scopeMutating={scopeMutation.saving}
                    grantMutating={grantMutation.saving}
                  />
                </div>
              ))}
            </div>
          </section>
        </AdminContentWrapper>
      </ErrorBoundary>

      <ErrorBoundary>
        <PromptsPreview />
      </ErrorBoundary>

      {!isSaas && showStat && clients.length === 0 && (
        <p className="mt-6 text-xs text-muted-foreground">
          Self-hosted Atlas: install agents via the{" "}
          <a
            href="https://docs.useatlas.dev/guides/mcp"
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

/**
 * Map the wire-level `tokenState` to the page's three-state UI surface.
 * The function is a pure switch so the badge / status / description /
 * row dim treatment all derive from one decision and stay in lockstep.
 *
 * The legacy `disabled` flag remains the source of truth for `revoked`
 * — admin-revoke flips it before the cascading DELETE finishes — and
 * `tokenState` collapses three signals (disabled, live access, live
 * refresh) into one render-time enum so the renderer doesn't have to
 * re-derive the precedence.
 */
function presentTokenState(tokenState: OAuthClient["tokenState"]): {
  status: StatusKind;
  badge: { label: string; tone: "muted" | "warn" | "danger" } | null;
  description: string | null;
} {
  switch (tokenState) {
    case "active":
      return {
        status: "connected",
        // No badge for the healthy state — the row stays uncluttered;
        // the connected status dot already conveys "Active".
        badge: null,
        description: null,
      };
    case "reconnect_required":
      return {
        status: "ready",
        badge: { label: "Reconnect required", tone: "warn" },
        description: "Last token expired and refresh failed — re-run the connect wizard to restore this agent.",
      };
    case "revoked":
      return {
        status: "unavailable",
        badge: { label: "Revoked", tone: "danger" },
        description: "Revoked — remove from the list to clean up.",
      };
    default: {
      // Defense in depth: if the API ever ships a fourth state before
      // this page is updated, the Zod schema in `me-schemas.ts` will
      // normally reject the response at the parse boundary. But during
      // a multi-PR rollout the schema can land first; without this
      // branch, an unknown enum value crashes the entire page render
      // with `TypeError: Cannot read properties of undefined`. Fall
      // back to a neutral status badge + soft warning so the rest of
      // the table stays usable. `satisfies never` keeps compile-time
      // exhaustiveness.
      const _exhaustive: never = tokenState;
      console.error(`Unknown tokenState received from API: ${String(_exhaustive)}`);
      return {
        status: "ready",
        badge: { label: "Unknown state", tone: "warn" },
        description: "Status temporarily unavailable — please refresh.",
      };
    }
  }
}

function AIAgentShell({
  client,
  usage,
  onRevoke,
  onToggleScope,
  onRevokeWorkspaceGrant,
  scopeMutating,
  grantMutating,
}: {
  client: OAuthClient;
  /**
   * Live MCP rate-limit usage for this client (#2216). Optional —
   * absent on first paint and on the brief race when a brand-new
   * client lands in the list before the next usage poll. The chip
   * tolerates `undefined` by rendering a neutral 0/<ceiling>
   * placeholder so the visual scaffolding is stable.
   */
  usage: McpUsageEntry | undefined;
  onRevoke: (client: OAuthClient) => void;
  onToggleScope: (client: OAuthClient) => void;
  onRevokeWorkspaceGrant: (client: OAuthClient, workspaceId: string) => void;
  scopeMutating: boolean;
  grantMutating: boolean;
}) {
  const presentation = presentTokenState(client.tokenState);
  const displayName = client.clientName ?? client.clientId;
  const description =
    presentation.description ??
    (client.lastUsedAt
      ? `Last used ${formatDateTime(client.lastUsedAt)}`
      : "Registered but never used");

  // #2073 — multi-scope badge precedes the token-state badge so the
  // cross-workspace surface is visible at a glance even when a state
  // badge (Reconnect / Revoked) is also present.
  const stateBadge = presentation.badge ? (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 text-[10px]",
        presentation.badge.tone === "danger" && "border-destructive/30 text-destructive",
        presentation.badge.tone === "warn" && "border-amber-500/40 text-amber-700 dark:text-amber-400",
      )}
    >
      {presentation.badge.tone === "warn" && (
        <AlertTriangle className="mr-1 size-3" aria-hidden="true" />
      )}
      {presentation.badge.label}
    </Badge>
  ) : client.type === "public" ? (
    <Badge variant="outline" className="shrink-0 text-[10px]">
      Public
    </Badge>
  ) : undefined;

  const scopeBadge = client.workspaceScope === "multi" ? (
    <Badge
      variant="outline"
      className="shrink-0 text-[10px] border-primary/30 text-primary"
      title="This agent can be pointed at any of your workspaces via the X-Atlas-Workspace header."
    >
      <Globe className="mr-1 size-3" aria-hidden="true" />
      All workspaces
    </Badge>
  ) : undefined;

  // Live usage chip — informational, not enforcement. Renders on every
  // row (revoked clients included so a saturated bucket on a revoked
  // client is still visible during the brief audit window before the
  // user removes the row). The chip's `aria-label` carries the percent
  // context so screen readers get the same warning sighted users do
  // from the tone. The "?" tooltip explains the per-tool weighting and
  // points to the canonical source so a user querying their bucket
  // doesn't have to reverse-engineer the math. The default ceiling
  // (60) matches the limiter's `DEFAULT_REQUESTS_PER_MINUTE` so the
  // first-paint placeholder agrees with what the API will return.
  const usageBadge = (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center">
            <UsageChip
              used={usage?.currentMinuteWeightedRequests ?? 0}
              ceiling={usage?.ceiling ?? 60}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
          <p>
            Weighted MCP request usage this minute. <code>executeSQL</code>{" "}
            and <code>explore</code> count 5×; <code>runMetric</code> 3×;
            others 1×.
          </p>
          <p className="mt-1.5">
            <a
              href="https://docs.useatlas.dev/guides/mcp#per-tool-weights"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Read the per-tool weights
            </a>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  // Compose the title-row badges: scope first (cross-workspace flag),
  // then state (Reconnect / Revoked / public type), then usage. Wrapping
  // in a single `<span>` keeps the Shell's titleBadge slot's flex math
  // happy when more than one is present.
  const composedBadges = (
    <span className="flex items-center gap-1.5">
      {scopeBadge}
      {stateBadge}
      {usageBadge}
    </span>
  );
  const titleBadge = composedBadges;

  return (
    <Shell
      icon={Bot}
      title={displayName}
      description={description}
      status={presentation.status}
      titleBadge={titleBadge}
      actions={
        <div className="flex items-center gap-2">
          {client.tokenState === "reconnect_required" && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onRevoke(client)}
              aria-label={`Reconnect ${displayName}`}
              // The reconnect path is "revoke + re-run the wizard" today
              // (no per-token refresh UI in 1.4.1). The CTA shares the
              // revoke handler so the table state converges immediately
              // — Out of scope: a one-click "refresh now" that doesn't
              // tear down the client.
            >
              <RefreshCw className="mr-1.5 size-3" />
              Reconnect
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => onToggleScope(client)}
            disabled={scopeMutating}
            aria-label={
              client.workspaceScope === "multi"
                ? `Restrict ${displayName} to its origin workspace`
                : `Allow ${displayName} to access all your workspaces`
            }
          >
            {scopeMutating && <Loader2 className="mr-1.5 size-3 animate-spin" />}
            {!scopeMutating && <Globe className="mr-1.5 size-3" />}
            {client.workspaceScope === "multi" ? "Restrict" : "Multi-workspace"}
          </Button>
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
        </div>
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

      {client.workspaceScope === "multi" && client.grantedWorkspaceIds.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-3">
          <p className="mb-2 text-[11px] font-medium text-muted-foreground">
            Granted workspaces ({client.grantedWorkspaceIds.length})
          </p>
          <ul className="space-y-1.5">
            {client.grantedWorkspaceIds.map((workspaceId) => (
              <li
                key={workspaceId}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <code className="truncate font-mono text-muted-foreground">
                  {workspaceId}
                </code>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRevokeWorkspaceGrant(client, workspaceId)}
                  disabled={grantMutating}
                  className="text-destructive hover:text-destructive"
                  aria-label={`Revoke ${displayName} access to workspace ${workspaceId}`}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Shell>
  );
}
