/**
 * Admin workspace branding routes.
 *
 * Mounted under /api/v1/admin/branding. All routes require admin role AND
 * enterprise license (enforced within the branding service layer).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getWorkspaceBranding,
  setWorkspaceBranding,
  deleteWorkspaceBranding,
  BrandingError,
} from "@atlas/ee/branding/white-label";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("admin-branding");

const BRANDING_ERROR_STATUS = { validation: 400, not_found: 404 } as const;

/**
 * Throw HTTPException for known branding errors. Enterprise license
 * errors → 403; BrandingError → 400/404. Unknown errors fall through.
 */
function throwIfBrandingError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Enterprise features")) {
    throw new HTTPException(403, {
      res: Response.json({ error: "enterprise_required", message }, { status: 403 }),
    });
  }
  if (err instanceof BrandingError) {
    const status = BRANDING_ERROR_STATUS[err.code];
    throw new HTTPException(status, {
      res: Response.json({ error: err.code, message: err.message }, { status }),
    });
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BrandingSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  logoUrl: z.string().nullable(),
  logoText: z.string().nullable(),
  primaryColor: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  hideAtlasBranding: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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

const adminBranding = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

adminBranding.use(adminAuth);
adminBranding.use(requestContext);

adminBranding.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Our thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// GET / — get workspace branding
adminBranding.openapi(getBrandingRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const branding = await getWorkspaceBranding(orgId);
    return c.json({ branding }, 200);
  } catch (err) {
    throwIfBrandingError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get workspace branding");
    return c.json({ error: "internal_error", message: "Failed to get workspace branding.", requestId }, 500);
  }
});

// PUT / — set workspace branding
adminBranding.openapi(setBrandingRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const body = c.req.valid("json");

  try {
    const branding = await setWorkspaceBranding(orgId, {
      logoUrl: body.logoUrl,
      logoText: body.logoText,
      primaryColor: body.primaryColor,
      faviconUrl: body.faviconUrl,
      hideAtlasBranding: body.hideAtlasBranding,
    });
    return c.json({ branding }, 200);
  } catch (err) {
    throwIfBrandingError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to save workspace branding");
    return c.json({ error: "internal_error", message: "Failed to save workspace branding.", requestId }, 500);
  }
});

// DELETE / — reset workspace branding
adminBranding.openapi(deleteBrandingRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const deleted = await deleteWorkspaceBranding(orgId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "No custom branding found." }, 404);
    }
    return c.json({ message: "Branding reset to Atlas defaults." }, 200);
  } catch (err) {
    throwIfBrandingError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to reset workspace branding");
    return c.json({ error: "internal_error", message: "Failed to reset workspace branding.", requestId }, 500);
  }
});

export { adminBranding };
