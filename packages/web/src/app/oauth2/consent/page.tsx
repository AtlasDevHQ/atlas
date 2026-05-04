"use client";

/**
 * OAuth 2.1 consent screen (#2024).
 *
 * The authorization endpoint redirects here when a user (already
 * authenticated) is requesting access on behalf of a non-trusted
 * client. We display the requesting client + the scopes it asked for,
 * and on Approve / Deny we hand the decision back to Better Auth via
 * `authClient.oauth2.consent({ accept })`. Better Auth then completes
 * the authorize flow and redirects the user agent back to the client's
 * `redirect_uri`.
 *
 * The signed query that proves "this user actually came from /oauth2/
 * authorize" is round-tripped automatically by `oauthProviderClient()`
 * — we don't have to thread it manually.
 *
 * Not signed in? The plugin's `loginPage` config (set in server.ts)
 * handles the bounce at `/oauth2/authorize` *before* the user reaches
 * consent — Better Auth resumes the flow automatically post-login. If
 * a user nonetheless arrives here without a session (stale tab, manual
 * URL paste), we show a "session expired" error and instruct them to
 * restart the flow from their OAuth client; we do NOT auto-redirect to
 * login because the consent page can't reconstruct the signed query
 * after a round-trip.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { getApiUrl } from "@/lib/api-url";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  Database,
  Loader2,
  ShieldCheck,
} from "lucide-react";

// ── Scope copy ──────────────────────────────────────────────────────
//
// Map each Atlas-issued scope to a short user-readable description.
// The fallback shows the raw scope in muted text so unknown plugin
// scopes still render legibly without us having to maintain a closed
// allowlist. Atlas-specific MCP scopes get explicit copy because that's
// what users will actually grant.
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Verify your Atlas identity",
  profile: "See your name and profile picture",
  email: "See your email address",
  offline_access: "Stay signed in without prompting again",
  "mcp:read": "Read data from your Atlas workspace",
  "mcp:write": "Run actions in your Atlas workspace (reserved; not yet enabled)",
};

interface PublicClient {
  client_id: string;
  client_name?: string | null;
  client_uri?: string | null;
  logo_uri?: string | null;
  // Per RFC 7591; what the consent screen actually renders is `scope`
  // received from the URL — not the client's stored list.
}

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function ConsentPage() {
  const searchParams = useSearchParams();

  const clientId = searchParams.get("client_id");
  const requestedScope = searchParams.get("scope") ?? "";
  const scopes = useMemo(
    () =>
      requestedScope
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [requestedScope],
  );

  const [client, setClient] = useState<PublicClient | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the requesting client's display details via Better Auth's
  // signed-session-required public-client endpoint. A 401 here means
  // we're not authenticated — bounce to /login carrying the full URL so
  // the user comes back to consent on this exact request.
  useEffect(() => {
    if (!clientId) {
      setError("Missing client_id — open this page from an OAuth flow.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const url =
      `${getApiBase()}/api/auth/oauth2/public-client` +
      `?client_id=${encodeURIComponent(clientId)}`;
    fetch(url, {
      signal: controller.signal,
      credentials: "include",
    })
      .then(async (r) => {
        if (r.status === 401) {
          // Stale tab or manual paste: the plugin redirects unauth'd
          // users at /oauth2/authorize, not here. Show a recovery hint
          // instead of bouncing — we can't reconstruct the signed query
          // after a round-trip through /login.
          throw new Error(
            "Your authorization session expired. Restart the OAuth flow from your client.",
          );
        }
        if (!r.ok) throw new Error(`Public client lookup returned ${r.status}`);
        return (await r.json()) as PublicClient;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setClient(data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(
          err instanceof Error
            ? err.message
            : "Could not load application details.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clientId]);

  async function handleConsent(accept: boolean) {
    setSubmitting(accept ? "accept" : "deny");
    setError(null);
    try {
      // Network-level errors (DNS, offline, CORS preflight) and
      // server-side rejections both land in this catch — distinguish
      // so the user sees actionable copy. `TypeError: Failed to fetch`
      // is the de-facto cross-runtime signal for "couldn't reach the
      // origin"; everything else is a server-side condition we
      // surface verbatim.
      // Better Auth's oauth2.consent() automatically threads the signed
      // `oauth_query` back to the server via the `oauthProviderClient`
      // fetch hook. The server completes the authorization flow and
      // returns either a 302 redirect URL or a JSON envelope carrying it.
      //
      // The cast through `unknown` is required because `authClient` is
      // hand-typed as `OrgClient` in packages/web/src/lib/auth/client.ts
      // — the explicit type was added when organization plugin types
      // failed to infer through `createAuthClient`. The same erasure
      // hides the `oauth2.*` surface contributed by `oauthProviderClient`.
      // Adding it to OrgClient would couple auth-client.ts to every
      // page that touches OAuth; localizing the cast here keeps the
      // boundary tight.
      const res = (await (authClient as unknown as {
        oauth2: {
          consent: (
            opts: { accept: boolean; scope?: string },
          ) => Promise<{
            data?: { redirectURI?: string };
            error?: { message?: string };
          } | undefined>;
        };
      }).oauth2.consent({ accept })) ?? undefined;
      if (res?.error) {
        setError(res.error.message ?? "Consent failed.");
        return;
      }
      const redirectURI = res?.data?.redirectURI;
      if (!redirectURI) {
        setError(
          "Consent succeeded but no redirect was returned. Reopen the OAuth flow from your client.",
        );
        return;
      }
      window.location.href = redirectURI;
    } catch (err) {
      if (err instanceof TypeError) {
        setError(
          "Couldn't reach Atlas. Check your network connection and try again.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Consent failed.");
      }
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Authorize application
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          An application is asking to access your Atlas workspace. Review the
          permissions before granting access.
        </p>
      </div>

      <Card className="w-full">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            {client?.logo_uri ? (
              // eslint-disable-next-line @next/next/no-img-element -- third-party logos can come from any host; sized box keeps layout stable
              <img
                src={client.logo_uri}
                alt=""
                className="size-10 rounded-md object-cover"
              />
            ) : (
              <Database className="size-5 text-muted-foreground" aria-hidden />
            )}
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">
              {loading ? (
                <Skeleton className="h-5 w-40" />
              ) : (
                client?.client_name ?? clientId ?? "Unknown application"
              )}
            </CardTitle>
            {client?.client_uri && (
              <Link
                href={client.client_uri}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-xs text-muted-foreground hover:underline"
              >
                {client.client_uri}
              </Link>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium">Requested permissions</p>
            <ul className="mt-2 space-y-2">
              {scopes.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No specific permissions requested.
                </li>
              ) : (
                scopes.map((scope) => (
                  <li key={scope} className="flex items-start gap-2 text-sm">
                    <ShieldCheck
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden
                    />
                    <span>
                      {SCOPE_DESCRIPTIONS[scope] ?? (
                        <span className="text-muted-foreground">{scope}</span>
                      )}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={() => handleConsent(true)}
              disabled={loading || submitting !== null || !clientId}
              className="w-full"
            >
              {submitting === "accept" ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Authorizing
                </>
              ) : (
                "Approve"
              )}
            </Button>
            <Button
              onClick={() => handleConsent(false)}
              disabled={loading || submitting !== null || !clientId}
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
        Approving lets this application act on your behalf within the listed
        scopes only. You can revoke access at any time from your workspace
        settings.
      </p>
    </div>
  );
}
