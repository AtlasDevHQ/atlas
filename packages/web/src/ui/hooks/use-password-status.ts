"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";

/**
 * Discriminated result so consumers can distinguish a "not admin" 403 from
 * an "MFA enrollment required" signal.
 *
 * `mfa-required` arrives via TWO paths:
 *   1. A 200 response with `{ mfaRequired: true, enrollmentUrl }` — the
 *      primary signal for #2486. The password-status route is the layout's
 *      pre-gate fetch and deliberately stays unblocked by `mfaRequired`
 *      middleware so the layout can read this field without being 403'd
 *      itself. MFA takes precedence over `passwordChangeRequired` — the
 *      user must complete enrollment before any other admin action.
 *   2. A 403 with `{ error: "mfa_enrollment_required", enrollmentUrl }` —
 *      defensive fallback if the carve-out is ever removed.
 */
export type PasswordStatusResult =
  | { kind: "allowed"; passwordChangeRequired: boolean }
  | { kind: "denied" }
  | { kind: "mfa-required"; enrollmentUrl: string };

interface MfaErrorBody {
  error?: string;
  enrollmentUrl?: string;
}

/**
 * Hand-typed raw shape of the `/me/password-status` 200 body. Every field
 * is optional here even though the server's OpenAPI schema declares them
 * required, because:
 *
 * 1. The web is a pure HTTP client (no `@atlas/api` import), so the type
 *    can't derive from the Zod schema and must be defensive against
 *    deploy-version skew (newer web vs. older API mid-deploy).
 * 2. Strict narrowing below (`mfaRequired === true`, `typeof` checks) lets
 *    us treat a missing field as a contract regression and throw rather
 *    than silently falling open. See `mfaRequired` handling at the bottom
 *    of the queryFn.
 */
interface PasswordStatusBody {
  passwordChangeRequired?: boolean;
  mfaRequired?: boolean;
  enrollmentUrl?: string;
}

const DEFAULT_ENROLLMENT_URL = "/admin/account-security";

/**
 * Checks admin access and password-change status via the password-status endpoint.
 *
 * Shared between AdminLayout (uses `kind` for access gating) and AtlasChat
 * (uses `passwordChangeRequired` for the change-password dialog). TanStack Query
 * deduplicates to a single request when both are mounted.
 *
 * Returns `isPending: true` until the check completes, `isError: true` on
 * transient failures (network, 500). 403 resolves to either `denied` or
 * `mfa-required` based on the body's typed error code.
 */
export function usePasswordStatus(enabled: boolean) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  return useQuery<PasswordStatusResult>({
    queryKey: ["admin", "me", "password-status"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, {
          credentials,
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("Password status check failed:", msg);
        throw new Error(msg || "Network error", { cause: err });
      }

      if (res.status === 403) {
        // Inspect the typed error code so missing-second-factor 403s don't
        // get classified the same as missing-role 403s. Body parse failures
        // fall through to `denied` — the safer default for an unknown 403.
        let body: MfaErrorBody = {};
        try {
          body = (await res.json()) as MfaErrorBody;
        } catch {
          // intentionally ignored: non-JSON 403 body falls through to
          // `denied`, the safer default for an unparseable forbidden response.
        }
        if (body.error === "mfa_enrollment_required") {
          return {
            kind: "mfa-required",
            enrollmentUrl: body.enrollmentUrl ?? DEFAULT_ENROLLMENT_URL,
          };
        }
        return { kind: "denied" };
      }

      // Other non-ok = transient failure. Throw so TanStack retries.
      if (!res.ok) {
        console.warn("Password status check failed:", res.status, res.statusText);
        throw new Error(`Password status check: HTTP ${res.status}`);
      }

      const data: PasswordStatusBody = await res.json();
      // #2486 — surface a missing `mfaRequired` field as an error rather
      // than silently treating it as `allowed`. Server-side `mfaRequired`
      // middleware still enforces the gate at the API boundary, so a
      // contract regression here doesn't open a hole — but the
      // layout-level gate this PR ships would disappear, which is a
      // user-facing security regression worth failing loud on.
      if (typeof data.mfaRequired !== "boolean") {
        console.warn(
          "password-status response missing required `mfaRequired` field — likely server/web version skew",
        );
        throw new Error(
          "Server returned an unexpected response from /me/password-status. This is likely a version mismatch — contact your administrator or try again later.",
        );
      }
      // MFA takes precedence over passwordChangeRequired — an unenrolled
      // admin must complete enrollment before any other admin action, so
      // surface the gate signal first and defer the password-change check
      // until the next fetch after enrollment.
      if (data.mfaRequired) {
        return {
          kind: "mfa-required",
          enrollmentUrl: data.enrollmentUrl ?? DEFAULT_ENROLLMENT_URL,
        };
      }
      return {
        kind: "allowed",
        passwordChangeRequired: !!data.passwordChangeRequired,
      };
    },
    enabled,
    retry: 1,
  });
}
