/**
 * Workspace + platform security adoption telemetry.
 *
 * MFA + passkey + trust-device counters surfaced by the workspace
 * `/api/v1/admin/security/metrics` and platform
 * `/api/v1/platform/admin/security/metrics` endpoints. Wire shape lives
 * here so the API and web schemas stay in lockstep — the corresponding
 * Zod definition in `@useatlas/schemas` uses `satisfies z.ZodType<...>`
 * to fail at compile time on drift.
 *
 * Bucket invariant (validated by `.refine()` on the Zod side):
 *
 *   noFactors + twoFactorOnly + passkeyOnly + bothFactors === adminCount
 *   mfaEnrolled === twoFactorOnly + passkeyOnly + bothFactors
 *   activeTrustDeviceUsers <= activeTrustDevices
 */

export interface SecurityBuckets {
  /** Total admin/owner-role members in scope. */
  adminCount: number;
  /** `twoFactorOnly + passkeyOnly + bothFactors`. Convenience derivation. */
  mfaEnrolled: number;
  /** TOTP enrolled, no passkey. */
  twoFactorOnly: number;
  /** Passkey enrolled, no TOTP. */
  passkeyOnly: number;
  /** Both TOTP and at least one passkey. */
  bothFactors: number;
  /** Neither TOTP nor a passkey. */
  noFactors: number;
  /** Active trust-device cookies (verification rows where `expiresAt > NOW()`). */
  activeTrustDevices: number;
  /** Distinct admin/owner users with at least one active trust grant. */
  activeTrustDeviceUsers: number;
}

export interface WorkspaceSecurityMetrics extends SecurityBuckets {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string | null;
}

export interface PlatformSecurityMetrics {
  /** Cross-workspace aggregate buckets. */
  aggregate: SecurityBuckets;
  /** One row per active workspace. Suspended/deleted workspaces excluded. */
  workspaces: WorkspaceSecurityMetrics[];
}
