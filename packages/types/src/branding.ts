/**
 * Workspace branding (white-labeling) types shared across API, frontend, and SDK.
 *
 * Enterprise customers can configure custom logo, colors, favicon, and hide
 * Atlas branding per workspace.
 */

// ── Branding record ─────────────────────────────────────────────────

export interface WorkspaceBranding {
  id: string;
  orgId: string;
  logoUrl: string | null;
  logoText: string | null;
  /** 6-digit hex color (e.g. #FF5500), or null for Atlas default. */
  primaryColor: string | null;
  faviconUrl: string | null;
  hideAtlasBranding: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public-safe subset of WorkspaceBranding (no internal IDs or timestamps).
 * Returned by the public GET /api/v1/branding endpoint.
 */
export type WorkspaceBrandingPublic = Pick<
  WorkspaceBranding,
  "logoUrl" | "logoText" | "primaryColor" | "faviconUrl" | "hideAtlasBranding"
>;

// ── Request shape ───────────────────────────────────────────────────

/**
 * Input for setting workspace branding. This is a full replacement —
 * any field not included is reset to null (or false for hideAtlasBranding).
 * Callers must send all fields to preserve existing values.
 */
export interface SetWorkspaceBrandingInput {
  logoUrl?: string | null;
  logoText?: string | null;
  /** 6-digit hex color (e.g. #FF5500). Set to null to clear. */
  primaryColor?: string | null;
  faviconUrl?: string | null;
  hideAtlasBranding?: boolean;
}
