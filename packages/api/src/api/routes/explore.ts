/**
 * Read-only semantic-layer exploration endpoint (#4049 / ADR-0025 §3 missing
 * endpoint #3, governed by ADR-0027's shared gate-parity contract).
 *
 * POST /api/v1/explore accepts a read-only bash command (ls/cat/grep/find/…)
 * and runs it against the workspace's semantic layer through the SAME shared
 * `lib/tools/explore` facade the agent loop and the MCP `explore` tool use.
 * The facade selects a sandboxed backend (plugin > Vercel sandbox > nsjail >
 * sidecar > just-bash) and enforces read-only, path-traversal-protected access
 * scoped to `semantic/` — there is no command re-validation here because the
 * backend (OverlayFs / nsjail bind-mount / deny-all microVM) is the boundary.
 *
 * ADR-0027's shared gate-parity contract governs this sibling endpoint:
 *   - NO billing gate. `explore` is metadata-only and touches no datasource,
 *     so it mirrors the MCP `explore` tool omitting `checksBilling` (gate 0).
 *   - Member floor — inherited from `standardAuth` (any authenticated member).
 *   - Workspace isolation derives from the credential, never the request body.
 *     `exploreTool.execute` reads `getRequestContext().user.activeOrganizationId`
 *     (bound by the `requestContext` middleware) to resolve the org-scoped,
 *     mode-specific semantic root; the body carries only `{ command }`.
 *   - Audited `origin=cli`: the handler binds `agentOrigin` (derived from the
 *     credential's `origin` claim, NOT hardcoded) + a distinct `actor.kind`
 *     into the request context so any approval/audit path downstream traces to
 *     the real owning member. Explore writes no `audit_log` row itself (it runs
 *     no SQL); the origin rides on the structured log and approval context,
 *     mirroring how the MCP path binds `agentOrigin: "mcp"`.
 *
 * Command-level failures (a `grep` that matches nothing, a missing file) are
 * normal for an exploration tool: the facade returns an `Error:` / `Error
 * (exit N):`-prefixed string as its output, which this route surfaces as a 200
 * body — never an HTTP 5xx. Only an unexpected throw from the facade (the
 * defensive safety net) yields a 500 with a `requestId`.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { isRequestOrigin } from "@atlas/api/lib/approvals/types";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("explore-route");

/**
 * Upper bound on a single command string. Generous for any realistic
 * `grep`/`find`/`awk` over the semantic layer while capping the payload a
 * hostile client can force through the sandbox. Tunable if a real need
 * surfaces; mirrors the modest free-text bounds the MCP semantic tools use.
 */
const MAX_COMMAND_LEN = 4000;

export const ExploreRequestSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1, "command must not be empty")
    .max(MAX_COMMAND_LEN, `command must be at most ${MAX_COMMAND_LEN} characters`),
});

const ExploreResponseSchema = z.object({
  /**
   * The command's combined output. On a non-zero exit (e.g. a `grep` that
   * matched nothing) this is the facade's `Error (exit N):` string — a normal
   * exploration result, not an HTTP error.
   */
  output: z.string(),
});

const exploreRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Explore"],
  summary: "Explore the semantic layer",
  description:
    "Runs a read-only bash command (ls/cat/grep/find/…) against the workspace's semantic layer inside a sandbox with read-only, path-traversal-protected access scoped to `semantic/`. Returns the command output. Writes, shell escapes, and traversal outside the semantic directory are rejected by the sandbox backend.",
  request: {
    body: {
      content: { "application/json": { schema: ExploreRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Command output (including non-zero-exit results)",
      content: { "application/json": { schema: ExploreResponseSchema } },
    },
    400: {
      description: "Bad request (malformed JSON body)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const explore = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

explore.use(standardAuth);
explore.use(requestContext);

// Normalize JSON parse errors from @hono/zod-openapi into the standard API
// error format. Mirrors validate-sql.ts / query.ts.
explore.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

explore.openapi(
  exploreRoute,
  async (c) => {
    const { command } = c.req.valid("json");
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");
    const user = authResult?.user;
    // The outer `requestContext` middleware bound these (it ran first); we
    // re-thread them through the inner bind below because `withRequestContext`
    // is `AsyncLocalStorage.run` — it REPLACES the context, it does not merge.
    // Dropping `atlasMode` would silently downgrade a developer-mode caller to
    // the published overlay inside `exploreTool.execute` (it reads
    // `reqCtx.atlasMode ?? "published"` to resolve the org-scoped semantic root).
    const atlasMode = c.get("atlasMode");
    const trustDeviceIdentifier = c.get("trustDeviceIdentifier");

    // Audit origin derives from the credential's claim, never hardcoded — a
    // device-flow `atlas` bearer carries `origin: "cli"` (#4043 / ADR-0026);
    // a web session leaves it undefined so it is not mislabeled. Validated
    // against the canonical vocabulary so an unexpected value can't land in the
    // approval/audit context. (Same shape as `resolveOriginClaim` in
    // audit/admin.ts — reproduced inline as that helper is module-private.)
    const claimsOrigin = user?.claims?.origin;
    const agentOrigin =
      typeof claimsOrigin === "string" && isRequestOrigin(claimsOrigin)
        ? claimsOrigin
        : undefined;

    // Re-establish the request context as a SUPERSET of the middleware's bind
    // (`user` + `atlasMode` + `trustDeviceIdentifier`) PLUS the audit origin +
    // a distinct actor kind, so any downstream approval/audit path traces to
    // the real owning member (ADR-0027 sub-decision 6) AND `exploreTool.execute`
    // still resolves the correct org-scoped, mode-specific semantic root.
    // `actor.kind` is `human` for the device-flow human; unattended workspace
    // keys (a distinct kind) are #4046's responsibility.
    return withRequestContext(
      {
        requestId,
        user,
        atlasMode,
        trustDeviceIdentifier,
        actor: { kind: "human" },
        ...(agentOrigin ? { agentOrigin } : {}),
      },
      async () => {
        try {
          // Reuse the shared explore facade — identical to the MCP `explore`
          // tool (packages/mcp/src/tools.ts). It returns a prose string:
          // success → output; failure → an `Error:` / `Error (exit N):` string.
          // The backend enforces read-only, path-traversal-protected scoping,
          // so no command re-validation is needed or attempted here.
          //
          // Imported dynamically (not at module top) so loading this route never
          // eagerly pulls the explore facade's sandbox machinery into the module
          // graph — sibling route tests partially-mock `lib/tools/explore`
          // (omitting `explore`), and a top-level import would make `app.fetch`
          // construction fail those suites with "Export named 'explore' not
          // found". Mirrors query.ts dynamic-importing its db/connection helper.
          const { explore: exploreTool } = await import("@atlas/api/lib/tools/explore");
          const output = await exploreTool.execute!(
            { command },
            { toolCallId: `rest-explore-${requestId}`, messages: [] },
          );
          const text = typeof output === "string" ? output : JSON.stringify(output);
          // Command-level failures (non-zero exit, missing file) are normal
          // exploration results — return them as a 200 body, not an HTTP error.
          return c.json({ output: text }, 200);
        } catch (err) {
          // Defensive safety net: `exploreTool.execute` catches its own
          // backend-init / exec failures and returns them as `Error:` strings,
          // so a genuine throw here is unexpected. Surface a 500 with a
          // requestId for log correlation (never a silent fallback).
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), requestId },
            "Explore command failed unexpectedly",
          );
          return c.json(
            {
              error: "internal_error",
              message: `An unexpected error occurred (ref: ${requestId.slice(0, 8)}). If this persists, check the server logs.`,
              requestId,
            },
            500,
          );
        }
      },
    );
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);
