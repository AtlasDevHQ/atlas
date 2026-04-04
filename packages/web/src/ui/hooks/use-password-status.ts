"use client";

import { useQuery } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";

interface PasswordStatusResult {
  /** Whether the user has admin access (password-status endpoint returned 200). */
  allowed: boolean;
  /** Whether the user needs to change their default password. */
  passwordChangeRequired: boolean;
}

/**
 * Checks admin access and password-change status via the password-status endpoint.
 *
 * Shared between AdminLayout (uses `allowed` for access gating) and AtlasChat
 * (uses `passwordChangeRequired` for the change-password dialog). TanStack Query
 * deduplicates to a single request when both are mounted.
 *
 * Returns `isPending: true` until the check completes, `isError: true` on
 * transient failures (network, 500). Only 403 is treated as a definitive "denied".
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

      // 403 = definitive denial (not admin). Don't throw — this is a valid result.
      if (res.status === 403) {
        return { allowed: false, passwordChangeRequired: false };
      }

      // Other non-ok = transient failure. Throw so TanStack retries.
      if (!res.ok) {
        console.warn("Password status check failed:", res.status, res.statusText);
        throw new Error(`Password status check: HTTP ${res.status}`);
      }

      const data: { passwordChangeRequired?: boolean } = await res.json();
      return {
        allowed: true,
        passwordChangeRequired: !!data.passwordChangeRequired,
      };
    },
    enabled,
    retry: 1,
  });
}
