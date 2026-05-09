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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDate, formatDateTime } from "@/lib/format";
import { Gauge, KeyRound, Loader2, RotateCcw, Trash2 } from "lucide-react";

// Wire-shape default for the per-client MCP rate limit. Mirrors
// `DEFAULT_REQUESTS_PER_MINUTE` in `packages/api/src/lib/rate-limit/oauth-client.ts`
// — a shared constant module would create a frontend↔api dependency
// the codebase intentionally avoids (CLAUDE.md: "Frontend is a pure
// HTTP client").
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const MIN_RATE_LIMIT_PER_MINUTE = 1;
const MAX_RATE_LIMIT_PER_MINUTE = 3600;

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

  // PATCH /admin/oauth-clients/:id/rate-limit (#2071)
  const rateLimitMutation = useAdminMutation<{
    success: boolean;
    clientId: string;
    rateLimitPerMinute: number | null;
  }>({
    method: "PATCH",
    invalidates: refetch,
  });

  const [revokeTarget, setRevokeTarget] = useState<OAuthClient | null>(null);
  const [rateLimitTarget, setRateLimitTarget] = useState<OAuthClient | null>(null);
  // Form state for the rate-limit dialog. Empty string maps to "use the
  // workspace default" (the API's null contract). Numeric input bounds
  // are enforced at submit time so invalid keystrokes don't show a
  // disabled/red state on every digit.
  const [rateLimitInput, setRateLimitInput] = useState<string>("");

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

  function requestRateLimitEdit(client: OAuthClient) {
    rateLimitMutation.reset();
    setRateLimitTarget(client);
    setRateLimitInput(
      client.rateLimitPerMinute != null ? String(client.rateLimitPerMinute) : "",
    );
  }

  function dismissRateLimitDialog() {
    if (rateLimitMutation.saving) return;
    rateLimitMutation.reset();
    setRateLimitTarget(null);
    setRateLimitInput("");
  }

  // Pure validation so the input + submit button can disable in lockstep.
  function parsedRateLimit(): number | null | "invalid" {
    const trimmed = rateLimitInput.trim();
    if (trimmed === "") return null; // empty → "use default"
    const parsed = Number.parseInt(trimmed, 10);
    if (
      !Number.isFinite(parsed)
      || parsed < MIN_RATE_LIMIT_PER_MINUTE
      || parsed > MAX_RATE_LIMIT_PER_MINUTE
      || String(parsed) !== trimmed
    ) {
      return "invalid";
    }
    return parsed;
  }

  async function handleRateLimitSubmit(reset: boolean) {
    if (!rateLimitTarget) return;
    let body: { requestsPerMinute: number | null };
    if (reset) {
      body = { requestsPerMinute: null };
    } else {
      const parsed = parsedRateLimit();
      if (parsed === "invalid") return; // submit button is disabled — defensive
      body = { requestsPerMinute: parsed };
    }
    const result = await rateLimitMutation.mutate({
      path: `/api/v1/admin/oauth-clients/${encodeURIComponent(rateLimitTarget.clientId)}/rate-limit`,
      body,
    });
    if (result.ok) dismissRateLimitDialog();
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
                  onEditRateLimit={requestRateLimitEdit}
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

      {/* Rate-limit override dialog (#2071). Distinct from the revoke
          flow — admins frequently raise a quota for a known-trusted
          agent without revoking, and the API contract is symmetric
          (null clears, integer sets). */}
      <Dialog
        open={!!rateLimitTarget}
        onOpenChange={(open) => {
          if (!open) dismissRateLimitDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set MCP rate limit</DialogTitle>
            <DialogDescription>
              Override the per-minute MCP request quota for{" "}
              <strong>
                {rateLimitTarget?.clientName ?? rateLimitTarget?.clientId ?? "this client"}
              </strong>
              . Leave blank to use the workspace default of {DEFAULT_RATE_LIMIT_PER_MINUTE}{" "}
              weighted requests per minute. Bound: {MIN_RATE_LIMIT_PER_MINUTE}–
              {MAX_RATE_LIMIT_PER_MINUTE}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 pt-2">
            <Label htmlFor="rate-limit-input" className="text-xs">
              Requests per minute
            </Label>
            <Input
              id="rate-limit-input"
              type="number"
              inputMode="numeric"
              min={MIN_RATE_LIMIT_PER_MINUTE}
              max={MAX_RATE_LIMIT_PER_MINUTE}
              step={1}
              value={rateLimitInput}
              placeholder={String(DEFAULT_RATE_LIMIT_PER_MINUTE)}
              onChange={(e) => setRateLimitInput(e.target.value)}
              disabled={rateLimitMutation.saving}
              aria-invalid={parsedRateLimit() === "invalid" ? true : undefined}
            />
            <p className="text-[11px] text-muted-foreground">
              executeSQL costs 5 weight; listEntities costs 1. A 60/min budget admits ~12 executeSQL or ~60 listEntities calls per minute.
            </p>
          </div>
          <MutationErrorSurface
            error={rateLimitMutation.error}
            feature="OAuth Clients"
            variant="inline"
          />
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRateLimitSubmit(true)}
              disabled={
                rateLimitMutation.saving || rateLimitTarget?.rateLimitPerMinute == null
              }
              aria-label="Reset to workspace default"
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              Reset to default
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={dismissRateLimitDialog}
                disabled={rateLimitMutation.saving}
              >
                Cancel
              </Button>
              <Button
                onClick={() => handleRateLimitSubmit(false)}
                disabled={
                  rateLimitMutation.saving || parsedRateLimit() === "invalid"
                }
              >
                {rateLimitMutation.saving && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OAuthClientShell({
  client,
  onRevoke,
  onEditRateLimit,
}: {
  client: OAuthClient;
  onRevoke: (client: OAuthClient) => void;
  onEditRateLimit: (client: OAuthClient) => void;
}) {
  const status: StatusKind = client.disabled
    ? "unavailable"
    : client.lastUsedAt
      ? "connected"
      : "ready";
  const displayName = client.clientName ?? client.clientId;
  const effectiveRpm = client.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const isOverridden = client.rateLimitPerMinute != null;

  return (
    <Shell
      icon={KeyRound}
      title={displayName}
      // Stable Playwright hook — use `getByTestId(\`oauth-client-row-${id}\`)`
      // rather than the brittle "section/div with hasText" locator pattern
      // (#2183 item 6).
      dataTestId={`oauth-client-row-${client.clientId}`}
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
        <div className="flex flex-col items-end gap-1.5 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            size="xs"
            onClick={() => onEditRateLimit(client)}
            aria-label={`Edit rate limit for ${displayName}`}
          >
            <Gauge className="mr-1.5 size-3" />
            Rate
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
        {/* MCP rate limit (#2071). Default value renders dimmed; an
            admin-set override renders bold with an `· override` suffix
            so the at-a-glance scan answers "which clients have a custom
            budget" without opening the edit dialog. */}
        <DetailRow
          label="MCP rate limit"
          value={
            <span
              className={cn(
                "font-mono tabular-nums",
                isOverridden ? "font-semibold" : "text-muted-foreground",
              )}
            >
              {effectiveRpm}/min{isOverridden ? " · override" : ""}
            </span>
          }
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
