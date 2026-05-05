"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";

/**
 * Discriminated result so consumers can distinguish a "not admin" 403 from
 * an "MFA enrollment required" 403. The `mfa-required` branch is defensive
 * — the password-status endpoint is not currently behind `mfaRequired`,
 * but classifying the typed body keeps AdminLayout correct if that changes.
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
            enrollmentUrl: body.enrollmentUrl ?? "/admin/settings/security",
          };
        }
        return { kind: "denied" };
      }

      // Other non-ok = transient failure. Throw so TanStack retries.
      if (!res.ok) {
        console.warn("Password status check failed:", res.status, res.statusText);
        throw new Error(`Password status check: HTTP ${res.status}`);
      }

      const data: { passwordChangeRequired?: boolean } = await res.json();
      return {
        kind: "allowed",
        passwordChangeRequired: !!data.passwordChangeRequired,
      };
    },
    enabled,
    retry: 1,
  });
}
