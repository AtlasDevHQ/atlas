/**
 * The anonymous demo door — `/mcp/demo` (#5604).
 *
 * The hosted `/mcp/{workspace_id}` router admits an OAuth bearer; the
 * onboarding router (`/mcp/onboarding`, ADR-0018) admits nobody and exposes one
 * provisioning tool. This is the third mount, and it is neither:
 *
 *   - It DOES bind an actor. Every request carries a signed anonymous demo
 *     token (minted by `POST /api/v1/demo/anonymous`), which resolves to a
 *     `member`-role `AtlasUser` whose `activeOrganizationId` is the demo
 *     workspace — resolved by SLUG from the settings registry, never from the
 *     path or a header. That actor runs the FULL dispatch gate (billing →
 *     action policy → `mcp:write` → RBAC → approval) exactly as a hosted actor
 *     would; nothing here bypasses `runMcpDispatchGate`.
 *   - It exposes LESS than the email demo, never more: `searchAtlas`,
 *     `executeSQL`, and the optional `shareEmail` hand-off. No `explore`, no
 *     semantic tools, no prompts, no resources, no plugin tools.
 *   - It fails closed on every workspace-scope ambiguity, with a request id:
 *     no resolvable demo workspace → 503; a token or session row pinned to a
 *     different workspace than the current resolution → 403; an MCP session id
 *     driven by a bearer that did not create it → 403.
 *   - It is rate-limited per client IP and per minted identity, both budgets
 *     read from the settings registry, at every tool call — on top of the
 *     per-client MCP limiter the shared dispatch already runs.
 *
 * Like the onboarding router, the routes are registered unconditionally and
 * the `ATLAS_DEMO_ENABLED` gate is evaluated per request (#3886: this module
 * is built while `api/index.ts` evaluates, before config resolves).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Hono } from "hono";
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "@atlas/api/lib/config";
import { withRequestContext, createLogger } from "@atlas/api/lib/logger";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { isDemoEnabled } from "@atlas/api/lib/demo";
import { DEMO_CONNECTION_ID } from "@atlas/api/lib/semantic/entities";
import {
  ANONYMOUS_DEMO_SCOPES,
  anonymousDemoActor,
  anonymousDemoClientId,
  captureAnonymousDemoEmail as defaultCaptureEmail,
  checkAnonymousDemoLimits as defaultCheckLimits,
  loadAnonymousDemoSession as defaultLoadSession,
  recordAnonymousDemoAnswer as defaultRecordAnswer,
  resolveDemoWorkspaceId as defaultResolveWorkspace,
  verifyAnonymousDemoToken as defaultVerifyToken,
  type AnonymousDemoLimitResult,
  type AnonymousDemoSession,
  type AnonymousDemoTokenClaims,
  type CaptureAnonymousDemoEmailResult,
  type DemoWorkspaceResolution,
} from "@atlas/api/lib/demo-anonymous";
import { createMcpDispatch } from "./mcp-dispatch.js";
import {
  registerExecuteSqlTool,
  registerSearchAtlasTool,
  type McpToolDispatch,
} from "./tools.js";
import { envelope, toEnvelopeResult } from "./error-envelope.js";
import { McpSessionStore, resolveMaxSessions } from "./session-store.js";
import pkg from "../package.json" with { type: "json" };

const log = createLogger("mcp-demo");

const VERSION: string = pkg.version;

// ── Injectable seams (tests stub these; production uses the lib defaults) ──

export interface DemoMcpDeps {
  readonly demoEnabled?: () => boolean;
  readonly verifyToken?: (token: string) => AnonymousDemoTokenClaims | null;
  readonly resolveWorkspace?: () => Promise<DemoWorkspaceResolution>;
  readonly loadSession?: (sessionId: string) => Promise<AnonymousDemoSession | null>;
  readonly checkLimits?: (input: {
    ip: string | null;
    sessionId: string | null;
  }) => Promise<AnonymousDemoLimitResult>;
  readonly recordAnswer?: (sessionId: string, requestId?: string) => Promise<void>;
  readonly captureEmail?: (input: {
    sessionId: string;
    email: string;
    ip: string | null;
    userAgent: string | null;
    requestId: string;
  }) => Promise<CaptureAnonymousDemoEmailResult>;
}

function resolveDeps(deps: DemoMcpDeps): Required<DemoMcpDeps> {
  return {
    demoEnabled: deps.demoEnabled ?? isDemoEnabled,
    verifyToken: deps.verifyToken ?? defaultVerifyToken,
    resolveWorkspace: deps.resolveWorkspace ?? defaultResolveWorkspace,
    loadSession: deps.loadSession ?? defaultLoadSession,
    checkLimits: deps.checkLimits ?? defaultCheckLimits,
    recordAnswer: deps.recordAnswer ?? defaultRecordAnswer,
    captureEmail: deps.captureEmail ?? defaultCaptureEmail,
  };
}

/** The one `rate_limited` envelope every anonymous refusal speaks. */
function rateLimitedResult(limit: Extract<AnonymousDemoLimitResult, { allowed: false }>): CallToolResult {
  const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
  return toEnvelopeResult(
    envelope(
      "rate_limited",
      `The demo is rate-limited. Please wait ${retryAfter} seconds and try again.`,
      {
        retry_after: retryAfter,
        hint:
          limit.bucket === "ip"
            ? "Anonymous demo traffic is limited per client IP. Wait the indicated time before retrying."
            : "Each anonymous demo session has its own per-minute budget. Wait the indicated time before retrying.",
      },
    ),
  );
}

// ── Per-HTTP-request context for the tool-level gate ───────────────────
//
// The shared dispatch opens its own `withRequestContext` frame per tool call,
// which REPLACES the api-layer ALS — so the client IP stamped at the router
// cannot be read from there inside the tool body. A separate ALS (the same
// trick `live-actor-store.ts` uses for the live role) carries the IP across
// the whole dispatch chain untouched.

interface DemoRequestFrame {
  readonly ip: string | null;
  readonly requestId: string;
}

const demoRequestStore = new AsyncLocalStorage<DemoRequestFrame>();

/** @internal — exported for the unit tests that drive `createDemoMcpServer` without the router. */
export function withDemoRequestFrame<T>(frame: DemoRequestFrame, fn: () => T): T {
  return demoRequestStore.run(frame, fn);
}

// ── The per-session server ─────────────────────────────────────────────

export interface DemoMcpServerContext {
  readonly session: AnonymousDemoSession;
  readonly workspaceId: string;
}

/**
 * Build the MCP server for ONE anonymous session. The actor is minted from
 * the session id + demo workspace; every tool routes through the shared
 * dispatch (so the ADR-0016 gate order runs unchanged) wrapped with the
 * anonymous gate — per-IP / per-identity limits BEFORE the body, the
 * answer counter AFTER a non-error result.
 */
export function createDemoMcpServer(
  ctx: DemoMcpServerContext,
  deps: DemoMcpDeps = {},
): McpServer {
  const d = resolveDeps(deps);
  const sessionId = ctx.session.id;
  const actor = anonymousDemoActor(sessionId, ctx.workspaceId);

  const server = new McpServer(
    { name: "atlas-demo", version: VERSION },
    { capabilities: { tools: {} } },
  );

  const base = createMcpDispatch({
    actor,
    transport: "sse",
    workspaceId: ctx.workspaceId,
    deployMode: getConfig()?.deployMode ?? "self-hosted",
    // Non-empty on purpose: an absent clientId is "stdio, exempt" for both the
    // write-scope gate and the per-client limiter (see demo-anonymous.ts).
    clientId: anonymousDemoClientId(sessionId),
    scopes: ANONYMOUS_DEMO_SCOPES,
  });

  /**
   * The anonymous budgets, checked BEFORE the shared dispatch opens — so a
   * limited client is refused before the per-client limiter, the billing
   * lookup and the action-policy read spend anything on it. Both budgets
   * are settings-registry entries (`demo-anonymous.ts`).
   */
  async function anonymousGate(toolName: string): Promise<CallToolResult | null> {
    const frame = demoRequestStore.getStore();
    const limit = await d.checkLimits({ ip: frame?.ip ?? null, sessionId });
    if (limit.allowed) return null;
    log.warn(
      { requestId: frame?.requestId, toolName, sessionId, bucket: limit.bucket },
      "Anonymous demo tool call rate-limited",
    );
    return rateLimitedResult(limit);
  }

  const dispatch: McpToolDispatch = async (toolName, reqs, body, spanAttributes) => {
    const blocked = await anonymousGate(toolName);
    if (blocked) return blocked;
    return base.dispatch(
      toolName,
      reqs,
      async (requestId) => {
        const result = await body(requestId);
        // A delivered answer is what moves the email-capture gate and the
        // launch-cycle count. Error envelopes are not answers. (A non-error
        // `approval_required` body would count — unreachable on this door,
        // which carries `mcp:read` against a workspace with no approval
        // rules, and an answer the visitor never saw is the only cost.)
        if (!result.isError) await d.recordAnswer(sessionId, requestId);
        return result;
      },
      spanAttributes,
    );
  };

  // The whole surface: two reads, plus the optional hand-off. Registration
  // order is what `tools/list` shows a client first.
  registerSearchAtlasTool(server, dispatch);
  // A visitor's client sends only `sql`; the demo install is the target.
  registerExecuteSqlTool(server, dispatch, { defaultConnectionId: DEMO_CONNECTION_ID });
  registerShareEmailTool(server, { sessionId, deps: d });

  return server;
}

/**
 * `shareEmail` — the explicit, optional act that replaces the email gate.
 * Refused before the first answer (the lib enforces it; this just translates
 * the refusal into the MCP envelope vocabulary). Not routed through the data
 * dispatch: it reaches no datasource and no fact, so the billing / policy /
 * RBAC gates have nothing to say about it — but it IS charged against both
 * anonymous budgets like every other call on this door.
 */
function registerShareEmailTool(
  server: McpServer,
  opts: { sessionId: string; deps: Required<DemoMcpDeps> },
): void {
  server.registerTool(
    "shareEmail",
    {
      title: "Share your email (optional)",
      description:
        "OPTIONAL. After you have received at least one answer from the demo, share an email address " +
        "to hear from Atlas. Never required to keep querying, and refused before the first answer. " +
        "Only call this when the user explicitly asks to share their email.",
      inputSchema: {
        email: z.string().describe("The email address the user chose to share."),
      },
      annotations: {
        // Records a lead — a write, but a closed one (Atlas's own CRM, no
        // external reach the user did not ask for).
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async ({ email }): Promise<CallToolResult> => {
      const frame = demoRequestStore.getStore();
      const requestId = frame?.requestId ?? crypto.randomUUID();
      const ip = frame?.ip ?? null;
      try {
        const limit = await opts.deps.checkLimits({ ip, sessionId: opts.sessionId });
        if (!limit.allowed) return rateLimitedResult(limit);
        const result = await opts.deps.captureEmail({
          sessionId: opts.sessionId,
          email,
          ip,
          userAgent: null,
          requestId,
        });
        if (!result.ok) {
          switch (result.reason) {
            case "answer_required":
              return toEnvelopeResult(
                envelope(
                  "validation_failed",
                  "Ask the demo a question first — an email can be shared after the first answer, never before.",
                  { hint: "Call searchAtlas or executeSQL, then offer shareEmail again if the user wants updates." },
                ),
              );
            case "invalid_email":
              return toEnvelopeResult(envelope("validation_failed", "That does not look like an email address."));
            case "session_not_found":
              return toEnvelopeResult(
                envelope("forbidden", "This demo session no longer exists.", {
                  hint: "Re-run `bunx @useatlas/mcp init --demo` to mint a fresh session.",
                }),
              );
            default: {
              const _exhaustive: never = result.reason;
              return _exhaustive;
            }
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: result.returning
                ? "Thanks — we already had that email on file; it is now linked to this demo session."
                : "Thanks — your email is recorded. You can keep querying the demo.",
            },
          ],
        };
      } catch (err) {
        log.error(
          { requestId, sessionId: opts.sessionId, err: err instanceof Error ? err.message : String(err) },
          "shareEmail failed",
        );
        return toEnvelopeResult(
          envelope("internal_error", "Could not record the email. Please try again.", {
            request_id: requestId,
          }),
        );
      }
    },
  );
}

// ── Router ─────────────────────────────────────────────────────────────

const HANDLED_METHODS = ["POST", "GET", "DELETE"];

/**
 * Relative to the `/mcp/demo` mount: the canonical Streamable HTTP path and
 * the same `/sse` alias the sibling mounts keep for clients pinned to it.
 */
const DEMO_PATHS = ["/", "/sse"];

const MINT_HINT =
  "Mint one with `bunx @useatlas/mcp init --demo`, or POST /api/v1/demo/anonymous.";

type Refusal = {
  readonly status: 401 | 403 | 404 | 503;
  readonly body: { error: string; message: string; hint?: string; requestId: string };
};

/**
 * Hono router for the anonymous demo door. Must be mounted BEFORE the hosted
 * `/mcp/:workspaceId` router so the literal `demo` segment is matched here.
 */
export function createDemoMcpRouter(deps: DemoMcpDeps = {}): Hono {
  const d = resolveDeps(deps);
  const router = new Hono();

  // A dedicated session store — never shared with the identity-bearing hosted
  // store or the onboarding one.
  const sessions = new McpSessionStore(() => resolveMaxSessions());
  // MCP session id → anonymous session id. A bearer may only drive the MCP
  // sessions it created; a guessed or leaked `mcp-session-id` presented with a
  // different anonymous token is refused rather than served by the server the
  // first token bound.
  const owners = new Map<string, string>();

  function pruneOwners(): void {
    for (const id of owners.keys()) {
      if (!sessions.get(id)) owners.delete(id);
    }
  }

  async function admit(req: Request, requestId: string): Promise<
    | { readonly kind: "ok"; readonly session: AnonymousDemoSession; readonly workspaceId: string }
    | ({ readonly kind: "refused" } & Refusal)
  > {
    const auth = req.headers.get("authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) {
      return {
        kind: "refused",
        status: 401,
        body: {
          error: "missing_bearer",
          message: "The anonymous demo endpoint needs a demo token in the Authorization header.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }
    const token = auth.slice("bearer ".length).trim();
    const claims = token ? d.verifyToken(token) : null;
    if (!claims) {
      return {
        kind: "refused",
        status: 401,
        body: {
          error: "invalid_bearer",
          message: "The demo token did not verify — it may have expired.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }

    // Fail closed: the demo workspace is resolved NOW, from the registry, and
    // must agree with what the token was minted for.
    const workspace = await d.resolveWorkspace();
    if (!workspace.ok) {
      log.error({ requestId, reason: workspace.reason }, "Anonymous demo refused — demo workspace unresolved");
      return {
        kind: "refused",
        status: 503,
        body: {
          error: "demo_workspace_unavailable",
          message: "The demo workspace is not available right now. Quote the request id if this persists.",
          requestId,
        },
      };
    }
    if (claims.workspaceId !== workspace.id) {
      log.warn(
        { requestId, tokenWorkspaceId: claims.workspaceId, resolvedWorkspaceId: workspace.id },
        "Anonymous demo refused — token pinned to a different workspace than the current demo resolution",
      );
      return {
        kind: "refused",
        status: 403,
        body: {
          error: "workspace_mismatch",
          message: "This demo token was minted for a different demo workspace.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }

    let session: AnonymousDemoSession | null;
    try {
      session = await d.loadSession(claims.sessionId);
    } catch (err) {
      log.error(
        { requestId, sessionId: claims.sessionId, err: err instanceof Error ? err.message : String(err) },
        "Anonymous demo session lookup failed — refusing (fail-closed)",
      );
      return {
        kind: "refused",
        status: 503,
        body: {
          error: "auth_unavailable",
          message: "Could not verify the demo session. Retry shortly.",
          requestId,
        },
      };
    }
    if (!session) {
      return {
        kind: "refused",
        status: 401,
        body: {
          error: "unknown_session",
          message: "This demo session does not exist.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }
    if (session.expiresAt.getTime() < Date.now()) {
      return {
        kind: "refused",
        status: 401,
        body: {
          error: "session_expired",
          message: "This demo session has expired.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }
    if (session.workspaceId !== workspace.id) {
      log.warn(
        { requestId, sessionWorkspaceId: session.workspaceId, resolvedWorkspaceId: workspace.id },
        "Anonymous demo refused — session row pinned to a different workspace than the current demo resolution",
      );
      return {
        kind: "refused",
        status: 403,
        body: {
          error: "workspace_mismatch",
          message: "This demo session belongs to a different demo workspace.",
          hint: MINT_HINT,
          requestId,
        },
      };
    }
    return { kind: "ok", session, workspaceId: workspace.id };
  }

  router.on(HANDLED_METHODS, DEMO_PATHS, async (c) => {
    const requestId = crypto.randomUUID();
    if (!d.demoEnabled()) {
      return c.json(
        {
          error: "not_found",
          message: "The anonymous demo endpoint is not enabled on this deployment.",
          requestId,
        },
        404,
      );
    }

    const admission = await admit(c.req.raw, requestId);
    if (admission.kind === "refused") {
      return c.json(admission.body, admission.status);
    }
    const { session, workspaceId } = admission;
    const actor = anonymousDemoActor(session.id, workspaceId);
    const ip = getClientIP(c.req.raw);
    const mcpSessionId = c.req.raw.headers.get("mcp-session-id");

    try {
      // `connectionId` pins the execution target to the platform demo
      // install the demo workspace was set up with (`/use-demo`). The
      // registry's `"default"` is never visible on SaaS, and the imported
      // demo entities sit in the whitelist's unpinned bucket, so a target
      // that is both the request's connection and the tool's makes
      // `resolveExecutionTarget` read it as the all-sources self target and
      // the whitelist union admits the demo tables.
      return await withRequestContext(
        {
          requestId,
          user: actor,
          atlasMode: "published",
          agentOrigin: "mcp",
          clientIp: ip,
          connectionId: DEMO_CONNECTION_ID,
        },
        () =>
          withDemoRequestFrame({ ip, requestId }, async () => {
            if (mcpSessionId) {
              const entry = sessions.get(mcpSessionId);
              if (!entry) {
                return c.json(
                  {
                    error: "unknown_session",
                    message: "Session not found. Reconnect with a fresh initialize request.",
                    requestId,
                  },
                  404,
                );
              }
              if (owners.get(mcpSessionId) !== session.id) {
                log.warn(
                  { requestId, mcpSessionId, sessionId: session.id },
                  "Anonymous demo refused — MCP session driven by a bearer that did not create it",
                );
                return c.json(
                  {
                    error: "session_not_owned",
                    message: "This MCP session belongs to a different demo token.",
                    requestId,
                  },
                  403,
                );
              }
              return sessions.dispatchExisting(c.req.raw, entry);
            }
            // A NEW MCP session is charged to both budgets like a tool call:
            // otherwise one token could open sessions until the per-region
            // cap 503s the door for everyone, with nothing counting it.
            const limit = await d.checkLimits({ ip, sessionId: session.id });
            if (!limit.allowed) {
              const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
              log.warn(
                { requestId, sessionId: session.id, bucket: limit.bucket, retryAfterSeconds },
                "Anonymous demo session creation rate-limited",
              );
              return c.json(
                {
                  error: "rate_limited",
                  message: "Too many demo requests. Please wait before opening another session.",
                  retryAfterSeconds,
                  requestId,
                },
                { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
              );
            }
            return sessions.dispatchNew(c.req.raw, {
              createServer: async () => createDemoMcpServer({ session, workspaceId }, d),
              onRegistered: (id) => {
                pruneOwners();
                owners.set(id, session.id);
                log.info(
                  { mcpSessionId: id, sessionId: session.id, workspaceId },
                  "Anonymous demo MCP session created",
                );
              },
              tooManyMessage: "Too many demo sessions right now. Please try again shortly.",
            });
          }),
      );
    } catch (err) {
      log.error(
        { requestId, sessionId: session.id, err: err instanceof Error ? err.message : String(err) },
        "Anonymous demo MCP dispatch failed",
      );
      return c.json(
        { error: "internal_error", message: "Demo request handling failed.", requestId },
        500,
      );
    }
  });

  return router;
}
