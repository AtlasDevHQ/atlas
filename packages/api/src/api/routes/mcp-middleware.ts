/**
 * Hono middleware for the hosted MCP endpoint (#2024).
 *
 * Sits in the route layer because middleware-level helpers depend on
 * `AuthEnv` from `./middleware.ts`, and CLAUDE.md keeps `lib/` strictly
 * above `api/routes/`. The pure validator
 * (`validateMcpBearer(req: Request) → AuthResult`) lives in
 * `lib/auth/mcp-bearer.ts`; this file is only the Hono adapter.
 *
 * Mount on the MCP route when the hosted endpoint lands:
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

  // Defensive wrapper: an unexpected throw from `validateMcpBearer`
  // (e.g. from header construction or a defect in the validator
  // itself) escapes to Hono's default error handler and produces a
  // 500 with no `requestId`. The codebase invariant is "every 500
  // carries `requestId`" — we honour it here by translating any
  // unexpected throw into a 500 response that does.
  let result;
  try {
    result = await validateMcpBearer(c.req.raw);
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        requestId,
      },
      "MCP bearer middleware threw unexpectedly — failing closed with 500",
    );
    return c.json(
      {
        error: "auth_error",
        message: "MCP authentication system error",
        requestId,
      },
      500,
    );
  }

  if (!result.authenticated) {
    // Use error severity for systemic-failure 500s (the validator
    // already log.errored at the throw site, this site mirrors it
    // so per-source level filters don't drop the signal). 401s are
    // expected client-shape failures and stay at warn.
    const logFn = result.status >= 500 ? log.error.bind(log) : log.warn.bind(log);
    logFn(
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
