/**
 * Admin workspace branding routes.
 *
 * Mounted under /api/v1/admin/branding. All routes require admin role AND
 * enterprise license (enforced within the branding service layer).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  getWorkspaceBranding,
  setWorkspaceBranding,
  deleteWorkspaceBranding,
  BrandingError,
} from "@atlas/ee/branding/white-label";
import { WorkspaceBrandingSchema as BrandingSchema } from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const brandingDomainError = domainError(BrandingError, { validation: 400, not_found: 404 });

function clientIP(c: Context): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

// Strip `user:pass@` userinfo from an admin-supplied URL before it lands in
// `admin_action_log.metadata`. An admin who pastes
// `https://u:tok@cdn/logo.png` into the logo URL field shouldn't accidentally
// write their credentials into the audit trail compliance reviewers read.
// `null` passes through unchanged (null means "clear the field").
function scrubUrl(url: string | null | undefined): string | null | undefined {
  if (url === null || url === undefined) return url;
  return url.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s@/]*@/gi, "$1://***@");
}

// `BrandingSchema` is re-exported under its prior local alias from
// `@useatlas/schemas` so the existing route definitions below don't need
// to change — single source of truth for the workspace-branding wire shape.

const SetBrandingBodySchema = z.object({
  logoUrl: z.string().nullable().optional().openapi({
    description: "URL to custom logo image. Set to null to clear.",
    example: "https://example.com/logo.png",
  }),
  logoText: z.string().nullable().optional().openapi({
    description: "Text to show next to/instead of logo (e.g. company name). Set to null to clear.",
    example: "Acme Corp",
  }),
  primaryColor: z.string().nullable().optional().openapi({
    description: "Hex color to replace Atlas brand color. Must be 6-digit hex (e.g. #FF5500). Set to null to clear.",
    example: "#FF5500",
  }),
  faviconUrl: z.string().nullable().optional().openapi({
    description: "URL to custom favicon. Set to null to clear.",
    example: "https://example.com/favicon.ico",
  }),
  hideAtlasBranding: z.boolean().optional().openapi({
    description: "When true, remove 'Atlas' / 'Powered by Atlas' text from the UI.",
    example: true,
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getBrandingRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Branding"],
  summary: "Get workspace branding",
  description:
    "Returns the workspace's custom branding configuration, or null if using Atlas defaults.",
  responses: {
    200: {
      description: "Workspace branding (null if using Atlas defaults)",
      content: {
        "application/json": {
          schema: z.object({ branding: BrandingSchema.nullable() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const setBrandingRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Branding"],
  summary: "Update workspace branding",
  description:
    "Sets custom branding for the workspace. Overwrites all fields. Enterprise license required.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: SetBrandingBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Branding saved",
      content: {
        "application/json": {
          schema: z.object({ branding: BrandingSchema }),
        },
      },
    },
    400: {
      description: "Invalid branding configuration or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteBrandingRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Branding"],
  summary: "Reset workspace branding",
  description:
    "Removes custom branding for the workspace. Reverts to Atlas defaults.",
  responses: {
    200: {
      description: "Branding reset to Atlas defaults",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "No custom branding found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminBranding = createAdminRouter();

adminBranding.use(requireOrgContext());

// GET / — get workspace branding
adminBranding.openapi(getBrandingRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const branding = yield* getWorkspaceBranding(orgId!);
    return c.json({ branding }, 200);
  }), { label: "get workspace branding", domainErrors: [brandingDomainError] });
});

// PUT / — set workspace branding
adminBranding.openapi(setBrandingRoute, async (c) => {
  const ipAddress = clientIP(c);
  const body = c.req.valid("json");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const branding = yield* setWorkspaceBranding(orgId!, {
      logoUrl: body.logoUrl,
      logoText: body.logoText,
      primaryColor: body.primaryColor,
      faviconUrl: body.faviconUrl,
      hideAtlasBranding: body.hideAtlasBranding,
    });
    // Metadata mirrors the request body so compliance review can distinguish a
    // cosmetic tweak (primaryColor) from a white-label takeover
    // (hideAtlasBranding: true). Only fields the admin actually set show up —
    // a future refactor that spreads `branding` itself would echo
    // post-state defaults and obscure the admin's intent.
    logAdminAction({
      actionType: ADMIN_ACTIONS.branding.update,
      targetType: "branding",
      targetId: orgId!,
      ipAddress,
      metadata: {
        ...(body.logoUrl !== undefined && { logoUrl: scrubUrl(body.logoUrl) }),
        ...(body.logoText !== undefined && { logoText: body.logoText }),
        ...(body.primaryColor !== undefined && { primaryColor: body.primaryColor }),
        ...(body.faviconUrl !== undefined && { faviconUrl: scrubUrl(body.faviconUrl) }),
        ...(body.hideAtlasBranding !== undefined && { hideAtlasBranding: body.hideAtlasBranding }),
      },
    });
    return c.json({ branding }, 200);
  }), { label: "save workspace branding", domainErrors: [brandingDomainError] });
});

// DELETE / — reset workspace branding
adminBranding.openapi(deleteBrandingRoute, async (c) => {
  const ipAddress = clientIP(c);

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const deleted = yield* deleteWorkspaceBranding(orgId!);
    if (!deleted) {
      // No-op deletes don't audit — nothing was reset, so emitting a row
      // would pollute forensic queries that count actual branding changes.
      return c.json({ error: "not_found", message: "No custom branding found." }, 404);
    }
    logAdminAction({
      actionType: ADMIN_ACTIONS.branding.delete,
      targetType: "branding",
      targetId: orgId!,
      ipAddress,
    });
    return c.json({ message: "Branding reset to Atlas defaults." }, 200);
  }), { label: "reset workspace branding", domainErrors: [brandingDomainError] });
});

export { adminBranding };
