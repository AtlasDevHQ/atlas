/**
 * Public workspace branding route.
 *
 * Mounted at /api/v1/branding. Returns branding for the current workspace
 * without requiring admin access. Used by the frontend and widget to load
 * branding. Attempts to resolve org from session; returns null branding if
 * no session or no org context.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { getWorkspaceBrandingPublic } from "@atlas/ee/branding/white-label";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { withRequestId, type AuthEnv } from "./middleware";
import { ErrorSchema } from "./shared-schemas";

const log = createLogger("public-branding");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PublicBrandingSchema = z.object({
  logoUrl: z.string().nullable(),
  logoText: z.string().nullable(),
  primaryColor: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  hideAtlasBranding: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const getBrandingRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Branding"],
  summary: "Get workspace branding (public)",
  description:
    "Returns the workspace's custom branding for the current session. " +
    "No admin role required. Returns null branding if no custom branding is set.",
  responses: {
    200: {
      description: "Workspace branding (null if using Atlas defaults)",
      content: {
        "application/json": {
          schema: z.object({ branding: PublicBrandingSchema.nullable() }),
        },
      },
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

const publicBranding = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

publicBranding.use(withRequestId);

publicBranding.openapi(getBrandingRoute, async (c) => runHandler(c, "get public branding", async () => {
  const req = c.req.raw;

  // Try to resolve the org from the session. This is best-effort — if auth
  // fails or there's no session, we return null branding.
  let orgId: string | undefined;
  try {
    const authResult = await authenticateRequest(req);
    if (authResult.authenticated) {
      orgId = authResult.user?.activeOrganizationId ?? undefined;
    }
  } catch (err) {
    // intentionally ignored: auth failure is expected for unauthenticated visitors
    log.debug({ err: err instanceof Error ? err.message : String(err) }, "Public branding: auth resolution failed, returning null branding");
  }

  if (!orgId) {
    return c.json({ branding: null }, 200);
  }

  const branding = await getWorkspaceBrandingPublic(orgId);
  if (!branding) {
    return c.json({ branding: null }, 200);
  }

  // Return only public-safe fields (no internal IDs or timestamps)
  return c.json({
    branding: {
      logoUrl: branding.logoUrl,
      logoText: branding.logoText,
      primaryColor: branding.primaryColor,
      faviconUrl: branding.faviconUrl,
      hideAtlasBranding: branding.hideAtlasBranding,
    },
  }, 200);
}));

export { publicBranding };
