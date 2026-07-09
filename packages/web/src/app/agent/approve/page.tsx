"use client";

/**
 * Agent Auth device-authorization approval screen (#4411 / #2058, Slice 3).
 *
 * When an AI agent requests a capability whose approval strength requires a
 * present user, the `@better-auth/agent-auth` device-code flow returns a
 * `verification_uri_complete` pointing here:
 * `/agent/approve?agent_id=<id>&code=<user_code>` (Atlas wires that URL via
 * `deviceAuthorizationPage` → `resolveAgentApprovalPage`). A signed-in human
 * lands on this page, reviews the pending capability request (what the agent is,
 * which capabilities, and why), and approves or denies. Approve activates the
 * pending grant; deny leaves it unusable.
 *
 * This reuses the OAuth-consent / CLI-device UI primitives (Card, Button,
 * Skeleton, lucide icons, the centered radial-gradient layout) rather than
 * hand-rolling a second consent surface.
 *
 * Gating: every agent-auth endpoint is 404 when `ATLAS_AGENT_AUTH_ENABLED` is
 * off (the #4409 request-time, fail-closed gate). So when the feature is off,
 * the pending-request fetch and the approve/deny POST both return 404, and this
 * page renders the "not available" state — the page has no reachable surface,
 * exactly like the rest of agent-auth.
 *
 * Not signed in? We render a sign-in prompt linking to /login with a redirect
 * back to this exact URL (agent_id + code ride in the query), so the user
 * returns here to finish approving — the plugin's `/agent/approve-capability`
 * requires a session. (There is no auto-redirect; the user clicks through.)
 */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { getApiUrl } from "@/lib/api-url";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  resolvePendingApproval,
  type PendingApprovalRequest,
} from "./resolve-pending-approval";
import {
  isAgentAuthGateOff,
  resolveApprovalOutcome,
} from "./resolve-approval-outcome";

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

/** The page's data-load phase. */
type LoadState =
  | "loading"
  | "ready"
  | "not-found"
  | "unavailable"
  | "missing-params"
  | "error";

function AgentApproval() {
  const searchParams = useSearchParams();
  const session = authClient.useSession();

  const agentId = searchParams.get("agent_id") ?? "";
  const code = searchParams.get("code") ?? "";

  const [load, setLoad] = useState<LoadState>("loading");
  const [request, setRequest] = useState<PendingApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const userId = session.data?.user?.id;

  // Fetch the pending request once a signed-in user is present. `GET
  // /agent/ciba/pending` returns the user's pending approvals across BOTH
  // methods; `resolvePendingApproval` selects the device request for this
  // `agent_id`. A 404 bearing the gate envelope means the whole agent-auth
  // surface is off; any other 404 is a per-request error (see
  // resolve-approval-outcome.ts for the discrimination).
  useEffect(() => {
    // No authenticated user yet (session still loading, or signed out) — the
    // render shows the skeleton or the sign-in prompt, so don't fetch.
    if (!userId) return;
    if (!agentId || !code) {
      setLoad("missing-params");
      return;
    }
    const controller = new AbortController();
    setLoad("loading");
    setError(null);
    fetch(`${getApiBase()}/api/auth/agent/ciba/pending`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (controller.signal.aborted) return;
        if (r.status === 404) {
          // 404 is ambiguous on this surface (see resolve-approval-outcome.ts):
          // only the gate's whole-surface envelope means agent auth is off. Any
          // other 404 is a per-request error and must not be misdiagnosed as
          // "feature disabled".
          let body: unknown = null;
          try {
            body = await r.json();
          } catch {
            // intentionally ignored: a non-JSON 404 body (gateway HTML) carries
            // no discriminator; it falls to the per-request error branch below.
            body = null;
          }
          if (isAgentAuthGateOff(r.status, body)) {
            setLoad("unavailable");
            return;
          }
          setError(
            "Could not load the pending request (HTTP 404). Reopen the link from your agent.",
          );
          setLoad("error");
          return;
        }
        if (r.status === 401) {
          setError(
            "Your session expired. Sign in again to approve this request.",
          );
          setLoad("error");
          return;
        }
        if (!r.ok) {
          setError(
            `Could not load the pending request (HTTP ${r.status}). Refresh to try again.`,
          );
          setLoad("error");
          return;
        }
        let payload: unknown;
        try {
          payload = await r.json();
        } catch (parseErr) {
          // A non-JSON 200 body (proxy HTML, truncated stream) can't be a
          // pending list — surface an actionable message instead of letting the
          // raw SyntaxError escape, and log the cause so an operator can tell a
          // proxy interstitial from a genuinely malformed plugin body.
          console.debug(
            "agent-approve pending parse failed",
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
          setError("Could not load the pending request. Refresh to try again.");
          setLoad("error");
          return;
        }
        const lookup = resolvePendingApproval(payload, agentId);
        if (lookup.kind === "ready") {
          setRequest(lookup.request);
          setLoad("ready");
        } else {
          setLoad("not-found");
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        // Raw error messages (extension/CSP/browser internals) are cryptic UI
        // text — show fixed actionable copy, keep the cause in the console.
        console.debug(
          "agent-approve pending fetch failed",
          err instanceof Error ? err.message : String(err),
        );
        setError(
          err instanceof TypeError
            ? "Couldn't reach Atlas. Check your connection and try again."
            : "Could not load the pending request. Refresh to try again.",
        );
        setLoad("error");
      });
    return () => controller.abort();
  }, [userId, agentId, code]);

  async function decide(action: "approve" | "deny") {
    if (!agentId || !code) return;
    setSubmitting(action);
    setError(null);
    try {
      const res = await fetch(
        `${getApiBase()}/api/auth/agent/approve-capability`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, user_code: code, action }),
        },
      );
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // intentionally ignored: a non-JSON body (empty 204, gateway HTML) is
        // expected on some error paths; resolveApprovalOutcome degrades to an
        // actionable default from the HTTP status alone.
        body = null;
      }
      const result = resolveApprovalOutcome({ status: res.status, body });
      if (result.kind === "resolved") {
        setOutcome(result.decision);
      } else if (result.kind === "unavailable") {
        setLoad("unavailable");
      } else {
        setError(result.message);
      }
    } catch (err) {
      // Same discipline as the pending fetch: fixed copy in the UI, raw cause
      // in the console for diagnosis.
      console.debug(
        "agent-approve decision failed",
        err instanceof Error ? err.message : String(err),
      );
      setError(
        err instanceof TypeError
          ? "Couldn't reach Atlas. Check your connection and try again."
          : "Could not record your decision. Refresh the page and try again.",
      );
    } finally {
      setSubmitting(null);
    }
  }

  // ── Loading session ──────────────────────────────────────────────
  if (session.isPending) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  // ── Not signed in → sign-in prompt linking to /login (returns here) ──
  if (!session.data) {
    const returnTo = `/agent/approve?agent_id=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sign in to continue</CardTitle>
          <CardDescription>
            Sign in to Atlas to review the capability an agent is requesting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href={`/login?redirect=${encodeURIComponent(returnTo)}`}>
              Sign in
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Decision recorded ────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" aria-hidden />
            Capability approved
          </CardTitle>
          <CardDescription>
            The agent can now use this capability in your workspace. You can
            close this page and return to your agent.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (outcome === "denied") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" aria-hidden />
            Request denied
          </CardTitle>
          <CardDescription>
            The agent was not granted this capability. You can close this page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── Surface gated off (agent auth disabled) ──────────────────────
  if (load === "unavailable") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent approvals are not available</CardTitle>
          <CardDescription>
            {/* Reachable only via the PLATFORM-tier gate 404 (#4419) — a
                workspace admin cannot enable it; only the Atlas operator can. */}
            Agent authorization is not enabled on this Atlas deployment. Ask
            your Atlas operator to enable it, then reopen the link from your
            agent.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── Missing / stale link ─────────────────────────────────────────
  if (load === "missing-params") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Open this from your agent</CardTitle>
          <CardDescription>
            This approval link is missing its agent and code. Reopen the link
            your agent provided to review the request.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── No matching pending request (expired / already handled) ──────
  if (load === "not-found") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No pending request</CardTitle>
          <CardDescription>
            This request has expired or was already handled. Ask your agent to
            request the capability again to get a fresh approval link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── Failed to load the pending request ───────────────────────────
  if (load === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Couldn&apos;t load the request</CardTitle>
          <CardDescription
            className="flex items-start gap-2 text-destructive"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error ?? "Couldn't load the request. Refresh to try again."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ── Loading the pending request ──────────────────────────────────
  if (load === "loading" || !request) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  // ── Approval form ────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Bot className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Authorize an agent
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          An AI agent is requesting a capability in your workspace. Review it
          before granting access.
        </p>
      </div>

      <Card className="w-full">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <Bot className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">
              {request.agentName ?? "Unknown agent"}
            </CardTitle>
            <CardDescription className="truncate">
              Requesting access as{" "}
              <span className="font-medium text-foreground">
                {session.data.user?.email}
              </span>
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {request.bindingMessage ? (
            <p className="rounded-md border bg-muted/40 p-3 text-sm">
              {request.bindingMessage}
            </p>
          ) : null}

          <div>
            <p className="text-sm font-medium">Requested capabilities</p>
            <ul className="mt-2 space-y-2">
              {request.capabilities.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No specific capabilities requested.
                </li>
              ) : (
                request.capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="flex items-start gap-2 text-sm"
                  >
                    <ShieldCheck
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden
                    />
                    <span>
                      <span className="font-mono">{capability}</span>
                      {request.capabilityReasons[capability] ? (
                        <span className="text-muted-foreground">
                          {" "}
                          — {request.capabilityReasons[capability]}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>

          {request.expiresIn > 0 ? (
            <p className="text-xs text-muted-foreground">
              This request expires in about {Math.ceil(request.expiresIn / 60)}{" "}
              minute{Math.ceil(request.expiresIn / 60) === 1 ? "" : "s"} — approve
              or deny before then.
            </p>
          ) : null}

          {error ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={() => decide("approve")}
              disabled={submitting !== null}
              className="w-full"
            >
              {submitting === "approve" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Approving
                </>
              ) : (
                "Approve"
              )}
            </Button>
            <Button
              onClick={() => decide("deny")}
              disabled={submitting !== null}
              variant="outline"
              className="w-full"
            >
              {submitting === "deny" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Denying
                </>
              ) : (
                "Deny"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="mt-4 max-w-sm text-center text-xs text-muted-foreground">
        Approving lets this agent use the listed capabilities in your workspace
        only. You can revoke access at any time from your workspace settings.
      </p>
    </div>
  );
}

export default function AgentApprovePage() {
  // useSearchParams requires a Suspense boundary for static prerender.
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      }
    >
      <AgentApproval />
    </Suspense>
  );
}
