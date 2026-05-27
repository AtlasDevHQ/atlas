/**
 * Route prefixes accessible to unauthenticated visitors. Consumed by:
 * - `packages/web/src/proxy.ts` (Next.js 16 server-side proxy)
 * - `packages/web/src/ui/components/auth-guard.tsx` (client-side guard)
 *
 * Adding a new public deep-link (invitation accept, public report, etc.)
 * is a one-line change here — both layers pick it up automatically.
 *
 * Matched via `startsWith`. Each consumer prepends/appends its own
 * framework-specific extras (`/api`, `/_next` for proxy; auth pages for
 * AuthGuard) — those don't belong in the shared list because they mean
 * different things in each context.
 */
export const PUBLIC_ROUTE_PREFIXES = [
  "/demo",
  "/shared",
  "/report",
  "/accept-invitation",
] as const;
