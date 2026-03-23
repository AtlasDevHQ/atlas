/**
 * Enterprise workspace branding (white-labeling).
 *
 * CRUD for per-organization branding settings. Every mutation calls
 * `requireEnterprise("branding")` — unlicensed deployments get a clear error.
 * Read operations (getWorkspaceBranding) also gate on enterprise so the admin
 * UI can show the feature-disabled state.
 *
 * The public getter (getWorkspaceBrandingPublic) skips the enterprise check —
 * if branding was configured while enterprise was enabled, it should still
 * render correctly even if the license lapses.
 */

import { requireEnterprise } from "../index";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { WorkspaceBranding, SetWorkspaceBrandingInput } from "@useatlas/types";

export type { WorkspaceBranding, SetWorkspaceBrandingInput } from "@useatlas/types";

const log = createLogger("ee:branding");

// ── Typed errors ────────────────────────────────────────────────────

export type BrandingErrorCode = "validation" | "not_found";

export class BrandingError extends Error {
  constructor(message: string, public readonly code: BrandingErrorCode) {
    super(message);
    this.name = "BrandingError";
  }
}

// ── Internal row shape ──────────────────────────────────────────────

interface BrandingRow {
  id: string;
  org_id: string;
  logo_url: string | null;
  logo_text: string | null;
  primary_color: string | null;
  favicon_url: string | null;
  hide_atlas_branding: boolean;
  created_at: string;
  updated_at: string;
  // Required by internalQuery<T extends Record<string, unknown>> constraint
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToBranding(row: BrandingRow): WorkspaceBranding {
  return {
    id: row.id,
    orgId: row.org_id,
    logoUrl: row.logo_url,
    logoText: row.logo_text,
    primaryColor: row.primary_color,
    faviconUrl: row.favicon_url,
    hideAtlasBranding: row.hide_atlas_branding,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateBrandingInput(input: SetWorkspaceBrandingInput): void {
  if (input.primaryColor != null && input.primaryColor !== "") {
    if (!HEX_COLOR_RE.test(input.primaryColor)) {
      throw new BrandingError(
        `Invalid primary color "${input.primaryColor}". Must be a 6-digit hex color (e.g. #FF5500).`,
        "validation",
      );
    }
  }

  if (input.logoUrl != null && input.logoUrl !== "") {
    try {
      const parsed = new URL(input.logoUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new BrandingError(
          `Logo URL must use http:// or https:// (got "${parsed.protocol}").`,
          "validation",
        );
      }
    } catch (err) {
      if (err instanceof BrandingError) throw err;
      throw new BrandingError(
        `Invalid logo URL: "${input.logoUrl}". Must be a valid URL.`,
        "validation",
      );
    }
  }

  if (input.faviconUrl != null && input.faviconUrl !== "") {
    try {
      const parsed = new URL(input.faviconUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new BrandingError(
          `Favicon URL must use http:// or https:// (got "${parsed.protocol}").`,
          "validation",
        );
      }
    } catch (err) {
      if (err instanceof BrandingError) throw err;
      throw new BrandingError(
        `Invalid favicon URL: "${input.faviconUrl}". Must be a valid URL.`,
        "validation",
      );
    }
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Get the workspace branding for an organization (admin endpoint).
 * Returns null if no custom branding is set.
 */
export async function getWorkspaceBranding(orgId: string): Promise<WorkspaceBranding | null> {
  requireEnterprise("branding");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<BrandingRow>(
    `SELECT id, org_id, logo_url, logo_text, primary_color, favicon_url,
            hide_atlas_branding, created_at, updated_at
     FROM workspace_branding
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );

  if (rows.length === 0) return null;
  return rowToBranding(rows[0]);
}

/**
 * Get workspace branding without enterprise check (public endpoint).
 * Used by the frontend/widget to load branding without admin access.
 * Returns null if no custom branding is set or no internal DB.
 */
export async function getWorkspaceBrandingPublic(orgId: string): Promise<WorkspaceBranding | null> {
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<BrandingRow>(
    `SELECT id, org_id, logo_url, logo_text, primary_color, favicon_url,
            hide_atlas_branding, created_at, updated_at
     FROM workspace_branding
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );

  if (rows.length === 0) return null;
  return rowToBranding(rows[0]);
}

/**
 * Set (upsert) the workspace branding for an organization.
 * This is a full replacement — any field omitted from the input is reset
 * to null (or false for hideAtlasBranding). Callers must send all fields
 * to preserve existing values.
 */
export async function setWorkspaceBranding(
  orgId: string,
  input: SetWorkspaceBrandingInput,
): Promise<WorkspaceBranding> {
  requireEnterprise("branding");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for workspace branding.");
  }

  validateBrandingInput(input);

  const rows = await internalQuery<BrandingRow>(
    `INSERT INTO workspace_branding (org_id, logo_url, logo_text, primary_color, favicon_url, hide_atlas_branding)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET
       logo_url = EXCLUDED.logo_url,
       logo_text = EXCLUDED.logo_text,
       primary_color = EXCLUDED.primary_color,
       favicon_url = EXCLUDED.favicon_url,
       hide_atlas_branding = EXCLUDED.hide_atlas_branding,
       updated_at = now()
     RETURNING id, org_id, logo_url, logo_text, primary_color, favicon_url,
               hide_atlas_branding, created_at, updated_at`,
    [
      orgId,
      input.logoUrl ?? null,
      input.logoText ?? null,
      input.primaryColor ?? null,
      input.faviconUrl ?? null,
      input.hideAtlasBranding ?? false,
    ],
  );

  if (!rows[0]) throw new Error("Failed to save workspace branding — no row returned.");

  log.info({ orgId }, "Workspace branding saved");
  return rowToBranding(rows[0]);
}

/**
 * Delete workspace branding for an organization (reset to Atlas defaults).
 */
export async function deleteWorkspaceBranding(orgId: string): Promise<boolean> {
  requireEnterprise("branding");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for workspace branding.");
  }

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM workspace_branding WHERE org_id = $1 RETURNING id`,
    [orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId }, "Workspace branding deleted — reverted to Atlas defaults");
  }
  return deleted;
}
