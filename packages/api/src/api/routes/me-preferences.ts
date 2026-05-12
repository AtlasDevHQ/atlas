/**
 * Per-user preferences — mounted at `/api/v1/me/preferences`.
 *
 * Read + write the calling user's UI-shaped preferences. Auth: any signed-in
 * user; no admin gate on GET. PATCH only accepts `default_landing = 'admin'`
 * from a workspace admin / owner / platform admin — non-admins land on a 403
 * since the admin console would 403 them anyway after the redirect.
 *
 * Availability: requires managed auth + an internal DB. In non-managed modes
 * the column doesn't exist (the migration is in MANAGED_AUTH_MIGRATIONS) and
 * the route returns 404 so the UI can omit the Interface section.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ADMIN_ROLES,
  DEFAULT_LANDINGS,
  isDefaultLanding,
  type AdminRole,
} from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-preferences");

// Roles that may persist `defaultLanding = 'admin'`. This is the
// authoritative gate; the UI mirrors the same set at `interface-section.tsx`.
const ADMIN_ROLES_SET: ReadonlySet<AdminRole> = new Set(ADMIN_ROLES);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DefaultLandingSchema = z.enum(DEFAULT_LANDINGS);

const PreferencesResponseSchema = z.object({
  defaultLanding: DefaultLandingSchema,
});

const UpdatePreferencesRequestSchema = z.object({
  defaultLanding: DefaultLandingSchema,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const getPreferencesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Me — Preferences"],
  summary: "Read your UI preferences",
  description:
    "Returns the calling user's UI preferences. `defaultLanding` decides " +
    "which surface (`chat` or `admin`) the root route resolves to after " +
    "sign-in.",
  responses: {
    200: {
      description: "User preferences",
      content: { "application/json": { schema: PreferencesResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth + internal DB", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updatePreferencesRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["Me — Preferences"],
  summary: "Update your UI preferences",
  description:
    "Persists `defaultLanding` on the calling user's row. Setting `admin` " +
    "requires the caller to be an admin / owner / platform-admin.",
  request: {
    body: {
      content: { "application/json": { schema: UpdatePreferencesRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Preferences updated",
      content: { "application/json": { schema: PreferencesResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "`admin` landing requires an admin role", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth + internal DB", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const mePreferences = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

mePreferences.use(standardAuth);
mePreferences.use(requestContext);

function unavailableResponse(requestId: string) {
  return {
    error: "not_available" as const,
    message:
      "User preferences require managed auth with an internal database.",
    requestId,
  };
}

// Coerce DB string to the legal enum; unknown values map to `chat` so a
// future schema-extension row doesn't 500 today's clients.
function coerceLanding(raw: string | null | undefined) {
  return isDefaultLanding(raw) ? raw : "chat";
}

mePreferences.openapi(getPreferencesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB() || !user) {
      return c.json(unavailableResponse(requestId), 404);
    }

    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<{ default_landing: string | null }>(
          `SELECT default_landing FROM "user" WHERE id = $1`,
          [user.id],
        ),
      catch: (err) =>
        err instanceof Error ? err : new Error(String(err)),
    });

    const defaultLanding = coerceLanding(rows[0]?.default_landing ?? null);
    return c.json({ defaultLanding }, 200);
  }), { label: "get my preferences" });
});

mePreferences.openapi(updatePreferencesRoute, async (c) => {
  const body = c.req.valid("json");

  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB() || !user) {
      return c.json(unavailableResponse(requestId), 404);
    }

    // Server-side role gate — the UI hides the `admin` option for non-admins,
    // but a direct API call would otherwise persist a value that mis-routes
    // the user the moment role is promoted and pollutes audit logs in the
    // meantime.
    if (
      body.defaultLanding === "admin" &&
      !ADMIN_ROLES_SET.has(user.role as AdminRole)
    ) {
      return c.json(
        {
          error: "forbidden",
          message: "Only admins can land on the admin console.",
          requestId,
        },
        403,
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        internalQuery(
          `UPDATE "user" SET default_landing = $1 WHERE id = $2`,
          [body.defaultLanding, user.id],
        ),
      catch: (err) =>
        err instanceof Error ? err : new Error(String(err)),
    });

    log.info(
      { userId: user.id, defaultLanding: body.defaultLanding, requestId },
      "User preferences updated",
    );

    return c.json({ defaultLanding: body.defaultLanding }, 200);
  }), { label: "update my preferences" });
});

export { mePreferences };
