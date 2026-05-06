/**
 * Connect-wizard adapter over the shared `brandUseatlasHost` helper in
 * `@useatlas/types/saas-hosts`. Returns the brand surface for inputs
 * recognised as a canonical SaaS regional `api*.useatlas.dev` host;
 * `null` for everything else (self-hosted operators on arbitrary
 * hostnames, brand inputs that are already canonical, dev fallback to
 * `window.location.origin`).
 *
 * Lives at this file path because Next.js inlines
 * `process.env.NEXT_PUBLIC_*` at bundle time — Playwright cannot
 * drive the SaaS code path through `getApiUrl()`, so the unit test
 * for the rendered snippet has to call this helper directly. Without
 * an importable seam a future regex drift would silently render the
 * wrong URL into every SaaS user's pasted config.
 */

import { brandUseatlasHost } from "@useatlas/types";

export function brandedMcpBase(base: string): string | null {
  return brandUseatlasHost(base);
}
