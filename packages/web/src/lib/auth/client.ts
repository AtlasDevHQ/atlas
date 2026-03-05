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
import { adminClient } from "better-auth/client/plugins";
import { API_URL } from "@/lib/api-url";

function getBaseURL(): string {
  if (API_URL) return API_URL + "/api/auth";
  if (typeof window !== "undefined") return window.location.origin + "/api/auth";
  return "http://localhost:3000/api/auth";
}

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [apiKeyClient(), adminClient()],
  // Cross-origin deployments (app.useatlas.dev → api.useatlas.dev) require
  // credentials: "include" so the browser stores and sends session cookies.
  fetchOptions: API_URL ? { credentials: "include" as RequestCredentials } : {},
});
