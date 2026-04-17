/**
 * GET /api/v1/starter-prompts — adaptive empty-chat starter surface (#1474, PRD #1473).
 *
 * Returns the resolved, ordered list of starter prompts for the current
 * user/org/mode context, each tagged with `provenance` so the UI can badge
 * or group. For this slice only `library` (demo-industry curated prompts)
 * and the cold-start empty case are emitted; favorites and approved-popular
 * tiers come in later slices (#1475–#1477).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import { getConfig } from "@atlas/api/lib/config";
import { resolveStarterPrompts } from "@atlas/api/lib/starter-prompts/resolver";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StarterPromptSchema = z.object({
  id: z.string(),
  text: z.string(),
  provenance: z.enum(["favorite", "popular", "library", "cold-start"]),
});

const StarterPromptsResponseSchema = z.object({
  prompts: z.array(StarterPromptSchema),
  total: z.number().int().nonnegative(),
});

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
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

const starterPrompts = new OpenAPIHono<AuthEnv>();

starterPrompts.use("/", standardAuth);
starterPrompts.use("/", requestContext);

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
          mode: atlasMode satisfies AtlasMode,
          limit,
          coldWindowDays,
          requestId,
        }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    return { prompts, total: prompts.length };
  });

  const body = await runEffect(c, program, { label: "resolve starter prompts" });
  return c.json(body, 200);
});

export { starterPrompts };
