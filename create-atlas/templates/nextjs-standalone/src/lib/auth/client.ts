/**
 * Better Auth React client — simplified for embedded API (same-origin).
 *
 * No cross-origin URL needed since the Hono API is served via the
 * Next.js catch-all route at /api/*.
 */

import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";

function getBaseURL(): string {
  if (typeof window !== "undefined") return window.location.origin + "/api/auth";
  // On Vercel, use auto-injected URL variables
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}/api/auth`;
  // Local dev fallback
  return "http://localhost:3000/api/auth";
}

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [apiKeyClient()],
});
