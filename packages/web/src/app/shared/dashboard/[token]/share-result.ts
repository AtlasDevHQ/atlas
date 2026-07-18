// Universal (server + client) response mapping for the shared-dashboard fetch.
// Extracted from `fetch.ts` (#4718) so the client-side org-share resolution
// (`org-share-client.ts`) shares the EXACT status→reason mapping and schema
// validation the SSR fetch uses — the two paths cannot drift. The
// resource-agnostic core (status mapping, #4690 auth-reason split, totality)
// was lifted to `../../share-result.ts` when the conversation surface adopted
// the pattern (#4719); this module keeps only the dashboard-specific pieces:
// the schema validation and the surface's default log label. Must stay
// importable from client components: no server-only imports (`next/headers`,
// `node:crypto`) may ever land here.

import { sharedDashboardViewSchema } from "@useatlas/schemas";
import {
  mapSharedResponse,
  type ShareBodyValidation,
  type ShareFetchResult,
} from "../../share-result";
import type { SharedDashboard } from "./types";

// The resource-agnostic reason vocabulary + auth-wall helpers, re-exported so
// this surface's consumers keep one import site.
export {
  isAuthWallReason,
  resolveAuthReason,
  type AuthWallReason,
  type FailReason,
} from "../../share-result";

export type FetchResult = ShareFetchResult<SharedDashboard>;

/** Validate a 200 body against the shared-view SSOT schema (`@useatlas/schemas`)
 *  rather than trust-casting the raw JSON — the `.strict()` schema also rejects
 *  any stray field the API projection might leak. On failure, `detail` carries
 *  issue paths + codes only — never the response values, which are the
 *  dashboard's data — so a projection drift is diagnosable from the log line. */
function validateSharedDashboard(raw: unknown): ShareBodyValidation<SharedDashboard> {
  const parsed = sharedDashboardViewSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(", "),
    };
  }
  // No cast: `parsed.data` (SharedDashboardViewWire) is structurally the
  // SharedDashboard SSOT type, so any future schema/type drift fails the build
  // here rather than being papered over.
  return { ok: true, data: parsed.data };
}

/**
 * Map a public-dashboard API response to a {@link FetchResult}. Shared verbatim
 * by the SSR fetch (`fetch.ts`) and the client-side org-share resolution
 * (`org-share-client.ts`). TOTAL over its inputs (see `mapSharedResponse`) —
 * `OrgShareResolver`'s two-state model relies on it never rejecting.
 *
 * `tokenHash` is the caller's pre-computed share-token fingerprint — log lines
 * carry it, NEVER the cleartext token (#4317).
 */
export async function mapSharedDashboardResponse(
  res: Response,
  tokenHash: string,
  logLabel = "[shared-dashboard]",
): Promise<FetchResult> {
  return mapSharedResponse(res, tokenHash, logLabel, validateSharedDashboard);
}
