/**
 * Wire-format Zod schemas for security adoption telemetry.
 *
 * Single source of truth for the workspace + platform security metrics
 * endpoints — used by API route OpenAPI validation and by web
 * `useAdminFetch` schema parsing. Hand-replicated copies on either side
 * are exactly the drift trap PR #1648 closed for the platform-stats
 * surface; see the docblock in `./platform.ts` for that backstory.
 *
 * `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field rename in
 * `@useatlas/types` breaks this file at compile time. The `.refine()`
 * call validates the bucket-sum invariant — a SQL drift in the route
 * (e.g. swapping `AND NOT` to `OR NOT` in a `FILTER` clause) fails
 * loudly in the schema parse instead of silently miscoloring the
 * traffic-light tiles in the UI.
 */
import { z } from "zod";
import type {
  SecurityBuckets,
  WorkspaceSecurityMetrics,
  PlatformSecurityMetrics,
} from "@useatlas/types";

/**
 * Bucket-sum invariants, validated at parse time.
 *
 *   - The four mutually-exclusive buckets sum to `adminCount`.
 *   - `mfaEnrolled` equals the three "has any factor" buckets.
 *   - `activeTrustDeviceUsers` cannot exceed `activeTrustDevices`
 *     (one user may hold many cookies, never the inverse).
 */
function bucketsValid(b: SecurityBuckets): boolean {
  if (b.noFactors + b.twoFactorOnly + b.passkeyOnly + b.bothFactors !== b.adminCount) {
    return false;
  }
  if (b.twoFactorOnly + b.passkeyOnly + b.bothFactors !== b.mfaEnrolled) {
    return false;
  }
  if (b.activeTrustDeviceUsers > b.activeTrustDevices) {
    return false;
  }
  return true;
}

const BUCKET_INVARIANT_MESSAGE =
  "Security bucket invariant violated: counts are inconsistent. This indicates a server-side query drift, not a client error.";

const SecurityBucketsObject = z.object({
  adminCount: z.number().int().min(0),
  mfaEnrolled: z.number().int().min(0),
  twoFactorOnly: z.number().int().min(0),
  passkeyOnly: z.number().int().min(0),
  bothFactors: z.number().int().min(0),
  noFactors: z.number().int().min(0),
  activeTrustDevices: z.number().int().min(0),
  activeTrustDeviceUsers: z.number().int().min(0),
});

export const SecurityBucketsSchema = SecurityBucketsObject.refine(
  bucketsValid,
  { message: BUCKET_INVARIANT_MESSAGE },
) satisfies z.ZodType<SecurityBuckets>;

export const WorkspaceSecurityMetricsSchema = SecurityBucketsObject.extend({
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceSlug: z.string().nullable(),
}).refine(bucketsValid, {
  message: BUCKET_INVARIANT_MESSAGE,
}) satisfies z.ZodType<WorkspaceSecurityMetrics>;

export const PlatformSecurityMetricsSchema = z.object({
  aggregate: SecurityBucketsSchema,
  workspaces: z.array(WorkspaceSecurityMetricsSchema),
}) satisfies z.ZodType<PlatformSecurityMetrics>;
