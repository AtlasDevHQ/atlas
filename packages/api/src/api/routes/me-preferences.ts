/**
 * Per-user preferences (#2022).
 *
 * Mounted at `/api/v1/me/preferences`. Read + write the calling user's
 * UI-shaped preferences. Today this is just `default_landing` — which surface
 * (`chat` or `admin`) the root route resolves to after sign-in — but the
 * shape is forward-compatible: future preferences (theme override,
 * keyboard-shortcut profile, density) live on the same row and ride the
 * same GET/PATCH pair so the page doesn't fan out into one endpoint per knob.
 *
 * Auth: any signed-in user; no admin gate. The preference is per-user, not
 * per-workspace, so it survives org-switch.
 *
 * Availability: requires managed auth + an internal DB. In non-managed modes
 * (`local` / `none`) the column doesn't exist (the migration is in
 * MANAGED_AUTH_MIGRATIONS) and the UI omits the Interface section.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-preferences");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DefaultLandingSchema = z.enum(["chat", "admin"]);

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
    "Returns the calling user's UI preferences. Today this is just " +
    "`defaultLanding` — the surface (`chat` or `admin`) the root route " +
    "resolves to after sign-in. Defaults to `chat` for any user that " +
    "hasn't flipped the toggle.",
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
    "Persists `defaultLanding` on the calling user's row. The next time the " +
    "user lands on `/`, the chat surface honours the choice — admins who " +
    "set `admin` get a redirect into the admin console, everyone else " +
    "lands on chat.",
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

// `default_landing` is on the Better Auth `user` table — only readable when
// the deployment runs managed auth with an internal DB. Outside that, the
// column doesn't exist (migration is in MANAGED_AUTH_MIGRATIONS) and the
// route returns 404 so the UI can omit the Interface section cleanly.
function unavailableResponse(requestId: string) {
  return {
    error: "not_available" as const,
    message:
      "User preferences require managed auth with an internal database.",
    requestId,
  };
}

type DefaultLanding = z.infer<typeof DefaultLandingSchema>;

function coerceLanding(raw: string | null | undefined): DefaultLanding {
  // The CHECK constraint pins the value set, but a row from a future schema
  // (a value we don't recognize yet) shouldn't break the page — fall back to
  // chat, which matches the column default and the new-user experience.
  return raw === "admin" ? "admin" : "chat";
}

mePreferences.openapi(getPreferencesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB() || !user) {
      return c.json(unavailableResponse(requestId), 404);
    }

    const rows = yield* Effect.promise(() =>
      internalQuery<{ default_landing: string | null }>(
        `SELECT default_landing FROM "user" WHERE id = $1`,
        [user.id],
      ),
    );

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

    yield* Effect.promise(() =>
      internalQuery(
        `UPDATE "user" SET default_landing = $1 WHERE id = $2`,
        [body.defaultLanding, user.id],
      ),
    );

    log.info(
      { userId: user.id, defaultLanding: body.defaultLanding, requestId },
      "User preferences updated",
    );

    return c.json({ defaultLanding: body.defaultLanding }, 200);
  }), { label: "update my preferences" });
});

export { mePreferences };
