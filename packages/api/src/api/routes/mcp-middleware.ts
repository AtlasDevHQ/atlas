/**
 * Hono middleware for the hosted MCP endpoint (#2024).
 *
 * Sits in the route layer because middleware-level helpers depend on
 * `AuthEnv` from `./middleware.ts`, and CLAUDE.md keeps `lib/` strictly
 * above `api/routes/`. The pure validator
 * (`validateMcpBearer(req: Request) → AuthResult`) lives in
 * `lib/auth/mcp-bearer.ts`; this file is only the Hono adapter.
 *
 * Mount on the MCP route in PR B:
 * ```ts
 * import { mcpBearerAuth } from "@atlas/api/api/routes/mcp-middleware";
 * mcpRouter.use(mcpBearerAuth);
 * ```
 */

import { createMiddleware } from "hono/factory";
import { validateMcpBearer } from "@atlas/api/lib/auth/mcp-bearer";
import { createLogger } from "@atlas/api/lib/logger";
import type { AuthEnv } from "./middleware";

const log = createLogger("mcp-middleware");

/**
 * Bearer-auth middleware for MCP routes. Sets `requestId`,
 * `authResult`, and `atlasMode` (always `"published"` — MCP requests
 * never run in developer/preview mode) so the existing `runHandler`
 * Effect bridge can construct `AuthContext` from `c.get(...)`.
 *
 * Not wired into the global `authenticateRequest` dispatcher: MCP
 * tokens are valid only on MCP routes, never as a substitute for an
 * admin-console login.
 */
export const mcpBearerAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  // MCP requests always read published content. Developer-mode
  // surfaces (draft entities, unpublished prompts) belong to the
  // interactive admin console, not the agent path.
  c.set("atlasMode", "published");

  const result = await validateMcpBearer(c.req.raw);
  if (!result.authenticated) {
    log.warn(
      { requestId, status: result.status },
      "MCP bearer authentication failed",
    );
    return c.json(
      {
        error: result.status === 500 ? "auth_error" : "unauthorized",
        message: result.error,
        requestId,
      },
      result.status as 401 | 500,
    );
  }

  // The AuthEnv variable is typed as authenticated-only; the result
  // here matches that constraint thanks to the early-return above.
  c.set("authResult", result);
  await next();
});
