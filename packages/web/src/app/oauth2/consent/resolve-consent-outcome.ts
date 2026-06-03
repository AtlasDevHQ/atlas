/**
 * Maps Better Auth's `oauth2.consent` response to the consent screen's next
 * action.
 *
 * Atlas runs the `@better-auth/oauth-provider` plugin (`oauthProviderClient`
 * on the client), whose `/oauth2/consent` endpoint returns `{ redirect, url }`
 * on success — the post-consent redirect target is `url`. The deprecated
 * `oidc-provider` plugin's `redirectURI` field does NOT exist on this client,
 * so reading it yields `undefined` and the redirect silently fails. Extracting
 * the mapping here pins that contract under test (see #3122).
 */

/** Shape that `authClient.oauth2.consent()` resolves to (BA `{ redirect, url }`). */
export interface ConsentResponse {
  data?: { redirect?: boolean; url?: string } | null;
  error?: { message?: string | null } | null;
}

/**
 * Discriminated by `kind` so the caller statically reaches `url` only on the
 * `redirect` branch and `message` only on the `error` branch.
 */
export type ConsentOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string };

export function resolveConsentOutcome(
  res: ConsentResponse | undefined,
): ConsentOutcome {
  // Error envelope wins over a (possibly partial) data payload.
  if (res?.error) {
    return { kind: "error", message: res.error.message ?? "Consent failed." };
  }
  // Read `.url` — the real redirect target on `@better-auth/oauth-provider`.
  const url = res?.data?.url;
  if (!url) {
    return {
      kind: "error",
      message:
        "Consent succeeded but no redirect was returned. Reopen the OAuth flow from your client.",
    };
  }
  return { kind: "redirect", url };
}
