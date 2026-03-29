/**
 * Better Auth React client.
 *
 * Imported from page.tsx. The useSession() hook runs in all auth modes
 * but session data is only meaningful when authMode === "managed".
 * Bearer tokens are handled server-side by the bearer plugin;
 * browser sessions use cookies automatically.
 *
 * Base URL resolution priority:
 *   1. NEXT_PUBLIC_ATLAS_API_URL — cross-origin API (set when frontend and API are separate)
 *   2. window.location.origin    — same-origin fallback (browser)
 *   3. http://localhost:3000      — SSR / prerender fallback
 *
 * A full URL is required for SSR compatibility — relative "/api/auth" fails
 * during Next.js static prerendering because there's no host to resolve against.
 */

import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { stripeClient } from "@better-auth/stripe/client";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { API_URL } from "@/lib/api-url";
import { ac, owner, admin, member } from "./org-permissions";
import { adminAccessControl, adminRole, platformAdminRole } from "./admin-permissions";

function getBaseURL(): string {
  if (API_URL) return API_URL + "/api/auth";
  if (typeof window !== "undefined") return window.location.origin + "/api/auth";
  return "http://localhost:3000/api/auth";
}

const _authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [
    // @ts-expect-error — TS6 strictness breaks apiKeyClient plugin type; runtime types are correct
    apiKeyClient(),
    adminClient({
      ac: adminAccessControl,
      roles: {
        admin: adminRole,
        platform_admin: platformAdminRole,
      },
    }),
    organizationClient({
      ac,
      roles: { owner, admin, member },
    }),
    stripeClient({ subscription: true }),
  ],
  // Cross-origin deployments (app.useatlas.dev → api.useatlas.dev) require
  // credentials: "include" so the browser stores and sends session cookies.
  fetchOptions: API_URL ? { credentials: "include" as RequestCredentials } : {},
});

// TS6 fails to infer organizationClient plugin types through createAuthClient.
// Re-export with the organization namespace explicitly typed.
type OrgResult<T> = { data: T | null; error: { message: string } | null };
type OrgClient = typeof _authClient & {
  organization: {
    create: (opts: { name: string; slug: string; logo?: string }) => Promise<OrgResult<{ id: string }>>;
    list: () => Promise<OrgResult<{ id: string; name: string; slug: string; logo?: string | null }[]>>;
    setActive: (opts: { organizationId: string }) => Promise<OrgResult<Record<string, unknown>>>;
  };
};
export const authClient: OrgClient = _authClient as OrgClient;
