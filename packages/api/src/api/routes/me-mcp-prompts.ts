/**
 * Workspace-facing MCP prompts preview endpoint (#2179).
 *
 * Mounted at `GET /api/v1/me/mcp-prompts`. Returns the same workspace
 * prompt list the MCP server's `prompts/list` handler would return for
 * the calling user's active workspace, plus a structured `canonicalGate`
 * envelope so the Settings → AI Agents preview block can explain a
 * closed gate (admin disabled canonical eval prompts, or auto-detection
 * found no demo signal) with a link to the admin toggle page.
 *
 * Why a separate HTTP endpoint instead of round-tripping through MCP:
 * the workspace user doesn't have an OAuth-issued bearer for the MCP
 * surface yet — that's exactly the loop they're trying to close by
 * connecting an agent. Calling `prompts/list` from the page would be
 * an opaque pre-OAuth roundtrip; this endpoint reuses session auth and
 * delegates to the same `listMcpPrompts` source-merging + gate-evaluation
 * pipeline so the visible-prompt sets stay in lockstep without a
 * cross-package call.
 *
 * Workspace isolation: the route reads `user.activeOrganizationId`
 * directly — no body / query parameter for `workspaceId`. By
 * construction, a caller can only preview prompts for their own active
 * workspace; the route's contract has no field that could redirect this.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { McpPromptsResponseSchema } from "@useatlas/schemas/mcp-prompts";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

// Late-bound import — `@atlas/mcp/prompts/listing` pulls semantic /
// settings / internal-DB modules. The lazy `await import()` keeps the
// route module's top-level load fast and matches the runtime shape of
// the `@atlas/mcp/hosted` mount in `index.ts`. The
// `/* turbopackIgnore: true */` directive prevents Next.js / Turbopack
// from tracing the module into the standalone Vercel template bundle
// (`examples/nextjs-standalone`) — that deploy does not ship the heavy
// `@atlas/mcp` graph and Turbopack tracing alone would defeat the
// late-bind goal. The Hono runtime resolves the import natively at
// runtime via the workspace dep.
async function loadListingModule() {
  return await import(/* turbopackIgnore: true */ "@atlas/mcp/prompts/listing");
}

// Wire schemas live in `@useatlas/schemas/mcp-prompts` so the route, the
// listing pipeline (`@atlas/mcp/prompts/listing`), and the web client
// (`packages/web/src/ui/lib/me-schemas.ts`) derive from one Zod source.
// `McpPromptsResponseSchema` is imported above.

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const listMcpPromptsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Me — MCP Prompts"],
  summary: "Preview the prompts your connected agent will see",
  description:
    "Returns the prompts an MCP-connected agent would see via `prompts/list` " +
    "for the caller's active workspace, grouped by source (built-in / " +
    "canonical / semantic / library). Powers the Settings → AI Agents " +
    "preview block. Includes a `canonicalGate` envelope explaining why " +
    "canonical eval prompts may be hidden so the UI can render a banner " +
    "linking to Admin → Settings → MCP.",
  responses: {
    200: {
      description: "Prompt list + canonical gate envelope",
      content: { "application/json": { schema: McpPromptsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
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

const meMcpPrompts = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

meMcpPrompts.use(standardAuth);
meMcpPrompts.use(requestContext);

meMcpPrompts.openapi(listMcpPromptsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      yield* RequestContext;
      const { user } = yield* AuthContext;
      // Active workspace drives canonical gating; an unbound user (no
      // active org) still gets built-ins and a closed canonical gate
      // because the demo signals have no workspace to resolve against.
      const workspaceId = user?.activeOrganizationId;

      const { listMcpPrompts } = yield* Effect.promise(() =>
        loadListingModule(),
      );
      const result = yield* Effect.promise(() =>
        listMcpPrompts({ workspaceId }),
      );

      // Spread to drop the listing module's `readonly` shape — Hono's
      // `c.json` types want mutable arrays. The copy is one shallow
      // allocation; entries are already plain objects.
      return c.json(
        {
          prompts: result.prompts.map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments.map((a) => ({ ...a })),
            source: p.source,
          })),
          canonicalGate: { ...result.canonicalGate },
        },
        200,
      );
    }),
    { label: "list mcp prompts" },
  );
});

export { meMcpPrompts };
