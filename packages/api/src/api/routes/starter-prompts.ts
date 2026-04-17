/**
 * Routes backing the adaptive empty-chat starter surface.
 *
 * Favorites are per-user and mode-agnostic: a pin always renders for its
 * owner regardless of admin moderation on popular suggestions. The list
 * endpoint composes tiers in the resolver; the /favorites/* endpoints
 * are the CRUD surface for the personal-productivity tier.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type {
  StarterPromptsResponse,
  CreateFavoriteResponse,
  UpdateFavoriteResponse,
  FavoriteStarterPrompt,
} from "@useatlas/types/starter-prompt";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";
import { resolveStarterPrompts } from "@atlas/api/lib/starter-prompts/resolver";
import {
  createFavorite,
  deleteFavorite,
  updateFavoritePosition,
  FavoriteCapError,
  DuplicateFavoriteError,
  InvalidFavoriteTextError,
  FAVORITE_TEXT_MAX_LENGTH,
  type FavoritePromptRow,
} from "@atlas/api/lib/starter-prompts/favorite-store";
import { AuthErrorSchema, ErrorSchema, parsePagination } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STARTER_PROMPT_PROVENANCE = [
  "favorite",
  "popular",
  "library",
  "cold-start",
] as const;

const StarterPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  provenance: z.enum(STARTER_PROMPT_PROVENANCE),
});

const StarterPromptsResponseSchema = z.object({
  prompts: z.array(StarterPromptSchema),
  total: z.number().int().nonnegative(),
});

const FavoriteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  position: z.number(),
  createdAt: z.string().datetime(),
});

const CreateFavoriteBodySchema = z.object({
  text: z.string().min(1, "Pin text must not be empty").max(FAVORITE_TEXT_MAX_LENGTH),
});

const CreateFavoriteResponseSchema = z.object({
  favorite: FavoriteSchema,
});

const PatchFavoriteBodySchema = z.object({
  position: z.number().finite(),
});

const FavoriteIdParamSchema = z.object({
  id: z.string().min(1).max(128).openapi({
    param: { name: "id", in: "path" },
    example: "fav-abc123",
  }),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listStarterPromptsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Starter Prompts"],
  summary: "Get adaptive starter prompts",
  description:
    "Returns the ordered list of starter prompts for the current context, composing " +
    "favorites, approved popular suggestions, and the demo-industry library. An empty " +
    "list signals the cold-start state — the client renders a single-CTA empty state.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of prompts to return (1–50, default 6).",
        example: "6",
      }),
    }),
  },
  responses: {
    200: {
      description: "Resolved starter prompts",
      content: { "application/json": { schema: StarterPromptsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const createFavoriteRoute = createRoute({
  method: "post",
  path: "/favorites",
  tags: ["Starter Prompts"],
  summary: "Pin a starter prompt for the current user",
  description:
    "Pins a message text as a personal starter prompt. Pins render ahead of the " +
    "popular and library tiers in the empty state. Cap is per-user and per-workspace " +
    "(default 10, configurable via ATLAS_STARTER_PROMPT_MAX_FAVORITES).",
  request: {
    body: {
      content: { "application/json": { schema: CreateFavoriteBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Pinned favorite",
      content: { "application/json": { schema: CreateFavoriteResponseSchema } },
    },
    400: {
      description: "Invalid input or cap exceeded",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "Prompt already pinned",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteFavoriteRoute = createRoute({
  method: "delete",
  path: "/favorites/{id}",
  tags: ["Starter Prompts"],
  summary: "Unpin a starter prompt",
  request: { params: FavoriteIdParamSchema },
  responses: {
    204: { description: "Unpinned" },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Favorite belongs to a different user",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Favorite not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const patchFavoriteRoute = createRoute({
  method: "patch",
  path: "/favorites/{id}",
  tags: ["Starter Prompts"],
  summary: "Reorder a pinned starter prompt",
  description:
    "Update the position of a pin. Position is a float so inserts-between are O(1). " +
    "Higher position values sort first (most-recently-pinned on top).",
  request: {
    params: FavoriteIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchFavoriteBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated favorite",
      content: {
        "application/json": {
          schema: z.object({ favorite: FavoriteSchema }),
        },
      },
    },
    400: {
      description: "Invalid position value",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Favorite belongs to a different user",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Favorite not found",
      content: { "application/json": { schema: ErrorSchema } },
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

const log = createLogger("starter-prompts-route");

const starterPrompts = new OpenAPIHono<AuthEnv>();

starterPrompts.use("/*", standardAuth);
starterPrompts.use("/*", requestContext);

function serializeFavorite(row: FavoritePromptRow): FavoriteStarterPrompt {
  return {
    id: row.id,
    text: row.text,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

function getMaxFavorites(): number {
  return getConfig()?.starterPrompts?.maxFavorites ?? 10;
}

starterPrompts.openapi(listStarterPromptsRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { requestId, atlasMode } = yield* RequestContext;
    const { user, orgId } = yield* AuthContext;

    const { limit } = parsePagination(c, { limit: 6, maxLimit: 50 });
    const coldWindowDays = getConfig()?.starterPrompts?.coldWindowDays ?? 90;

    const prompts = yield* Effect.tryPromise({
      try: () =>
        resolveStarterPrompts({
          orgId: orgId ?? null,
          userId: user?.id ?? null,
          mode: atlasMode,
          limit,
          coldWindowDays,
          requestId,
        }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    return { prompts, total: prompts.length } satisfies StarterPromptsResponse;
  });

  const body = await runEffect(c, program, { label: "resolve starter prompts" });
  return c.json(body, 200);
});

type CreateOutcome =
  | { kind: "created"; favorite: FavoritePromptRow }
  | { kind: "cap_exceeded"; message: string }
  | { kind: "duplicate"; message: string }
  | { kind: "invalid_text"; message: string }
  | { kind: "missing_org" };

starterPrompts.openapi(createFavoriteRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user, orgId } = yield* AuthContext;

    if (!user?.id || !orgId) {
      return { outcome: { kind: "missing_org" as const }, requestId };
    }

    const { text } = c.req.valid("json");

    // Typed failures (cap, duplicate, invalid_text) are expected control
    // flow for this route, not defects. Catch at the Promise boundary so
    // they land in the success channel as discriminated outcomes.
    const outcome = yield* Effect.tryPromise<CreateOutcome, Error>({
      try: async (): Promise<CreateOutcome> => {
        try {
          const favorite = await createFavorite(
            { userId: user.id, orgId, text },
            getMaxFavorites(),
          );
          return { kind: "created", favorite };
        } catch (err) {
          if (err instanceof FavoriteCapError) {
            return { kind: "cap_exceeded", message: err.message };
          }
          if (err instanceof DuplicateFavoriteError) {
            return { kind: "duplicate", message: err.message };
          }
          if (err instanceof InvalidFavoriteTextError) {
            return { kind: "invalid_text", message: err.message };
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          log.error(
            { err: err.message, userId: user.id, orgId, requestId },
            "createFavorite failed",
          ),
        ),
      ),
    );

    return { outcome, requestId };
  });

  const { outcome, requestId } = await runEffect(c, program, {
    label: "pin starter prompt",
  });

  if (outcome.kind === "missing_org") {
    return c.json(
      {
        error: "missing_workspace",
        message:
          "Pinning starter prompts requires an active workspace. Switch to a workspace and try again.",
        requestId,
      },
      400,
    );
  }
  if (outcome.kind === "cap_exceeded") {
    return c.json(
      { error: "favorite_cap_exceeded", message: outcome.message, requestId },
      400,
    );
  }
  if (outcome.kind === "invalid_text") {
    return c.json(
      { error: "invalid_favorite_text", message: outcome.message, requestId },
      400,
    );
  }
  if (outcome.kind === "duplicate") {
    return c.json(
      { error: "duplicate_favorite", message: outcome.message, requestId },
      409,
    );
  }
  return c.json(
    { favorite: serializeFavorite(outcome.favorite) } satisfies CreateFavoriteResponse,
    200,
  );
});

starterPrompts.openapi(deleteFavoriteRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user, orgId } = yield* AuthContext;

    if (!user?.id || !orgId) {
      return {
        kind: "not_found" as const,
        requestId,
      };
    }

    const { id } = c.req.valid("param");

    const result = yield* Effect.tryPromise({
      try: () => deleteFavorite({ id, userId: user.id, orgId }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          log.error(
            { err: err.message, favoriteId: id, userId: user.id, orgId, requestId },
            "deleteFavorite failed",
          ),
        ),
      ),
    );
    return { kind: result.status, requestId };
  });

  const outcome = await runEffect(c, program, { label: "unpin starter prompt" });

  if (outcome.kind === "ok") {
    return c.body(null, 204);
  }
  if (outcome.kind === "forbidden") {
    return c.json(
      {
        error: "forbidden",
        message: "You can only unpin your own starter prompts.",
        requestId: outcome.requestId,
      },
      403,
    );
  }
  return c.json(
    {
      error: "not_found",
      message: "Favorite not found.",
      requestId: outcome.requestId,
    },
    404,
  );
});

starterPrompts.openapi(patchFavoriteRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user, orgId } = yield* AuthContext;

    if (!user?.id || !orgId) {
      return { kind: "not_found" as const, requestId };
    }

    const { id } = c.req.valid("param");
    const { position } = c.req.valid("json");

    const result = yield* Effect.tryPromise({
      try: () =>
        updateFavoritePosition({ id, userId: user.id, orgId, position }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          log.error(
            { err: err.message, favoriteId: id, userId: user.id, orgId, requestId },
            "updateFavoritePosition failed",
          ),
        ),
      ),
    );

    if (result.status === "ok") {
      return {
        kind: "ok" as const,
        body: { favorite: serializeFavorite(result.favorite) } satisfies UpdateFavoriteResponse,
        requestId,
      };
    }
    return { kind: result.status, requestId };
  });

  const outcome = await runEffect(c, program, { label: "reorder starter prompt" });
  if (outcome.kind === "ok") {
    return c.json(outcome.body, 200);
  }
  if (outcome.kind === "forbidden") {
    return c.json(
      {
        error: "forbidden",
        message: "You can only reorder your own starter prompts.",
        requestId: outcome.requestId,
      },
      403,
    );
  }
  return c.json(
    {
      error: "not_found",
      message: "Favorite not found.",
      requestId: outcome.requestId,
    },
    404,
  );
});

export { starterPrompts };
