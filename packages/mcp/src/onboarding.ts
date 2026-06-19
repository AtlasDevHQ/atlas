/**
 * Anonymous onboarding caller — the single, audited pre-actor carve-out from
 * the MCP dispatch gate (ADR-0018, PRD #3646, #3649).
 *
 * `start_trial` is the *one* tool a brand-new prospect can invoke before any
 * user, Workspace, or bearer exists. It is **not** an MCP actor (governed /
 * trusted / hosted) and is structurally incapable of reaching
 * `runMcpDispatchGate`: it is registered on a SEPARATE, unauthenticated MCP
 * server (`createOnboardingMcpServer`) mounted on a distinct pre-auth endpoint
 * (`createOnboardingMcpRouter` → `/mcp/onboarding/sse`). That server exposes
 * NOTHING else — no `explore`, no `executeSQL`, no datasource tools — so the
 * anonymous caller can do exactly one thing: provision a trial Workspace.
 *
 * The call *produces* a real user + Workspace via `provisionTrialWorkspace`
 * (the shared lib seam) and returns `{ workspaceId, connectUrl, state }`. A
 * normal *hosted* actor then takes over via the DCR/PKCE connect against
 * `connectUrl` — at which point every read/write/setup tool runs the full
 * dispatch gate (action policy → `mcp:write` → RBAC → approval). This tool
 * NEVER binds an actor and NEVER calls the gate; eroding that boundary would
 * reintroduce an unauthenticated mutation inside the actor model.
 *
 * SaaS-only: the router and tool exist only when `deployMode === 'saas'`.
 * Off-SaaS there is no billing surface to onboard onto, so the endpoint is
 * absent and the underlying provisioner refuses.
 */

import { Hono } from "hono";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "@atlas/api/lib/config";
import {
  withRequestContext,
  getRequestContext,
  createLogger,
} from "@atlas/api/lib/logger";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import {
  verifyTurnstile as defaultVerifyTurnstile,
  type VerifyTurnstileResult,
} from "@atlas/api/lib/turnstile";
import {
  checkTrialAttemptRateLimit as defaultCheckRateLimit,
  type TrialAttemptRateLimitResult,
} from "@atlas/api/lib/trial-abuse";
import {
  provisionTrialWorkspace as defaultProvision,
  TrialProvisioningError,
  type ProvisionTrialInput,
  type ProvisionTrialResult,
} from "@atlas/ee/onboarding/provision-trial";
import { elicitMaskedForm } from "./elicitation.js";
import { toEnvelopeResult, envelope } from "./error-envelope.js";
import {
  McpSessionStore,
  resolveMaxSessions,
} from "./session-store.js";
import pkg from "../package.json" with { type: "json" };

const log = createLogger("mcp-onboarding");

const VERSION: string = pkg.version;

/** Injected for tests; defaults to the real lib provisioner. */
export type ProvisionTrialFn = (
  input: ProvisionTrialInput,
) => Promise<ProvisionTrialResult>;

/** Injected for tests; defaults to the real Cloudflare Turnstile verifier. */
export type VerifyTurnstileFn = (opts: {
  token: string;
  remoteIp?: string | null;
  requestId?: string;
}) => Promise<VerifyTurnstileResult>;

/** Injected for tests; defaults to the real per-IP/email attempt limiter. */
export type TrialAttemptLimiter = (input: {
  ip: string | null;
  email: string;
}) => TrialAttemptRateLimitResult;

export interface RegisterStartTrialOptions {
  /** Override the provisioner (tests inject a stub). */
  readonly provision?: ProvisionTrialFn;
  /** Override Turnstile verification (tests inject a pass/fail stub). */
  readonly verifyTurnstile?: VerifyTurnstileFn;
  /** Override the creation-attempt rate limiter (tests force a trip). */
  readonly checkRateLimit?: TrialAttemptLimiter;
}

/** Structured output shape of a successful `start_trial` call. */
const startTrialOutputShape = {
  workspaceId: z.string(),
  connectUrl: z.string(),
  state: z.enum(["grace", "locked"]),
} as const;

const startTrialInputShape = {
  email: z
    .string()
    .optional()
    .describe("Business email for the new account. Elicited if omitted."),
  orgName: z
    .string()
    .optional()
    .describe("Name for the new workspace. Elicited if omitted."),
  turnstileToken: z
    .string()
    .max(4096)
    .optional()
    .describe(
      "Cloudflare Turnstile token proving the signup is human-initiated. " +
        "REQUIRED — obtain it from the Turnstile challenge presented during the " +
        "onboarding handshake. Missing or invalid tokens are rejected.",
    ),
} as const;

/** Map a typed provisioning failure onto the MCP tool-error envelope. */
function provisioningErrorResult(
  err: TrialProvisioningError,
  requestId: string,
): CallToolResult {
  switch (err.code) {
    case "invalid_input":
      return toEnvelopeResult(envelope("validation_failed", err.message));
    case "signup_failed":
      return toEnvelopeResult(
        envelope("validation_failed", err.message, {
          hint: "If you already have an Atlas account, sign in on the web instead of starting a new trial.",
        }),
      );
    case "not_saas":
      // Defensive — the tool isn't registered off-SaaS, but never leak a stack.
      return toEnvelopeResult(envelope("forbidden", err.message));
    case "org_failed":
    case "trial_not_assigned":
      return toEnvelopeResult(
        envelope("internal_error", err.message, { request_id: requestId }),
      );
  }
}

/**
 * Collect `email` + `orgName`, preferring the tool arguments and falling back
 * to MCP elicitation when either is missing. Returns `null` if the client
 * declines/cancels the elicitation.
 */
async function resolveSignupInput(
  server: McpServer,
  args: { email?: string; orgName?: string },
  requestId: string,
): Promise<{ email: string; orgName: string } | null> {
  let email = args.email?.trim();
  let orgName = args.orgName?.trim();
  if (email && orgName) return { email, orgName };

  const outcome = await elicitMaskedForm(server, {
    // No actor exists yet — bind the elicitation requestState to a synthetic,
    // per-call principal so the single-use / TTL guarantees still hold.
    principal: `onboarding:${requestId}`,
    message: "Start your Atlas trial — enter your business email and a name for your workspace.",
    fields: [
      {
        name: "email",
        title: "Business email",
        description: "Your work email address.",
        required: !email,
      },
      {
        name: "orgName",
        title: "Workspace name",
        description: "A name for your new Atlas workspace.",
        required: !orgName,
      },
    ],
  });
  if (outcome.action !== "accept") return null;
  email = (outcome.values.email ?? email)?.trim();
  orgName = (outcome.values.orgName ?? orgName)?.trim();
  if (!email || !orgName) return null;
  return { email, orgName };
}

/**
 * Register the `start_trial` tool on `server`. The tool runs OUTSIDE
 * `runMcpDispatchGate` (no actor, no Workspace yet) — it is the anonymous
 * onboarding caller's only capability.
 */
export function registerStartTrialTool(
  server: McpServer,
  opts: RegisterStartTrialOptions = {},
): void {
  const provision = opts.provision ?? defaultProvision;
  const verifyTurnstileFn = opts.verifyTurnstile ?? defaultVerifyTurnstile;
  const checkRateLimit = opts.checkRateLimit ?? defaultCheckRateLimit;

  server.registerTool(
    "start_trial",
    {
      title: "Start an Atlas trial",
      description:
        "Provision a brand-new Atlas trial workspace and return a connect URL. " +
        "Collects a business email and workspace name (via elicitation if not supplied), " +
        "creates the account + workspace on the trial tier in an unclaimed grace period, " +
        "and returns the URL your agent uses to connect (OAuth). Claim the account on the " +
        "web to start the full 14-day trial.",
      inputSchema: startTrialInputShape,
      outputSchema: startTrialOutputShape,
      annotations: {
        // Provisions a new workspace — a creating, world-opening write.
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      const requestId = crypto.randomUUID();
      // Best-effort per-request client IP, stamped by the onboarding router
      // (createOnboardingMcpRouter) into the AsyncLocalStorage request context.
      // `null` when no trusted proxy is configured or off the HTTP path
      // (in-memory transport tests) — the per-IP limiter degrades to a shared
      // bucket, never throws.
      const clientIp = getRequestContext()?.clientIp ?? null;
      try {
        const input = await resolveSignupInput(server, args, requestId);
        if (!input) {
          return toEnvelopeResult(
            envelope(
              "validation_failed",
              "A business email and workspace name are required to start a trial.",
            ),
          );
        }

        // ── Abuse controls (ADR-0018 § Abuse posture, #3654) ───────────────
        // Order: rate-limit FIRST (cheap, throttles even malformed/tokenless
        // spam before it can burn a Turnstile round-trip or a DB write), then
        // Turnstile. The limiter bounds creation ATTEMPTS per-IP/per-email —
        // NOT trials per IP (shared NATs must keep signing up).
        const rate = checkRateLimit({ ip: clientIp, email: input.email });
        if (!rate.allowed) {
          const retryAfter = Math.ceil((rate.retryAfterMs ?? 60_000) / 1000);
          log.warn(
            { requestId, bucket: rate.bucket, retryAfter, event: "start_trial.rate_limited" },
            "start_trial creation attempt rate-limited",
          );
          return toEnvelopeResult(
            envelope(
              "rate_limited",
              `Too many trial signup attempts. Please wait ${retryAfter} seconds and try again.`,
              {
                retry_after: retryAfter,
                hint: "Self-serve trial signups are rate-limited per IP and per email. Wait the indicated time before retrying.",
              },
            ),
          );
        }

        // Turnstile token presence — a client that never ran the widget gets a
        // validation rejection (not a Turnstile failure: that requires a
        // server round-trip we skip when the token is clearly absent).
        const token = args.turnstileToken?.trim();
        if (!token) {
          log.warn(
            { requestId, event: "start_trial.turnstile_missing" },
            "start_trial called without a Turnstile token",
          );
          return toEnvelopeResult(
            envelope(
              "validation_failed",
              "A Cloudflare Turnstile token is required to start a trial.",
              {
                hint: "Complete the bot-protection challenge and pass its token as `turnstileToken`.",
              },
            ),
          );
        }

        // Turnstile siteverify — fails closed (missing secret, network error,
        // and explicit rejection all return ok:false). Never leak the secret,
        // the token, or Cloudflare error codes to the caller; log them only.
        const verify = await verifyTurnstileFn({ token, remoteIp: clientIp, requestId });
        if (!verify.ok) {
          log.warn(
            {
              requestId,
              errorCodes: verify.errorCodes,
              reason: verify.reason,
              event: "start_trial.turnstile_failed",
            },
            "start_trial Turnstile verification failed",
          );
          return toEnvelopeResult(
            envelope(
              "forbidden",
              "Bot-protection check failed. Refresh the challenge and try again.",
            ),
          );
        }

        const result = await provision(input);
        const text =
          result.state === "grace"
            ? `Trial workspace created in grace period. Connect your agent at: ${result.connectUrl} — then claim your account on the web to start your full 14-day trial.`
            : `Workspace created, but this account has already used its trial, so it's locked. Connect at ${result.connectUrl} and subscribe on the web to continue.`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            workspaceId: result.workspaceId,
            connectUrl: result.connectUrl,
            state: result.state,
          },
        };
      } catch (err) {
        if (err instanceof TrialProvisioningError) {
          log.warn(
            { requestId, code: err.code },
            "start_trial provisioning refused",
          );
          return provisioningErrorResult(err, requestId);
        }
        log.error(
          { requestId, err: err instanceof Error ? err.message : String(err) },
          "start_trial provisioning failed unexpectedly",
        );
        return toEnvelopeResult(
          envelope(
            "internal_error",
            "Trial provisioning failed unexpectedly. Please retry.",
            { request_id: requestId },
          ),
        );
      }
    },
  );
}

/**
 * Build the unauthenticated onboarding MCP server. It exposes ONLY
 * `start_trial` — no native tools, no datasource tools, no actor. Returns
 * `null` off-SaaS so the caller can decline to mount the endpoint.
 */
export function createOnboardingMcpServer(
  opts: RegisterStartTrialOptions = {},
): McpServer | null {
  if (getConfig()?.deployMode !== "saas") return null;
  const server = new McpServer(
    { name: "atlas-onboarding", version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerStartTrialTool(server, opts);
  return server;
}

const HANDLED_METHODS = ["POST", "GET", "DELETE"];

/**
 * Hono router for the pre-auth onboarding MCP endpoint. Mounted at
 * `/mcp/onboarding` (so the full path is `/mcp/onboarding/sse`), it carries no
 * bearer verification, no workspace admission, and no residency check — there
 * is no identity yet. SaaS-only: off-SaaS the router has no routes and every
 * request 404s.
 *
 * Must be mounted BEFORE the hosted `/mcp/:workspaceId/sse` router so the
 * literal `onboarding` segment is matched here rather than treated as a
 * workspace id.
 */
export function createOnboardingMcpRouter(): Hono {
  const router = new Hono();
  if (getConfig()?.deployMode !== "saas") return router;

  // A dedicated session store for the onboarding endpoint — never shared with
  // the identity-bearing hosted store.
  const sessions = new McpSessionStore(() => resolveMaxSessions());

  router.on(HANDLED_METHODS, "/sse", async (c) => {
    const requestId = crypto.randomUUID();
    const sessionId = c.req.raw.headers.get("mcp-session-id");
    // Resolve the client IP once at the HTTP seam and stamp it into the request
    // context so the per-session `start_trial` handler can rate-limit attempts
    // per-IP without re-threading the raw Request (#3654). `null` when no
    // trusted proxy is configured (ATLAS_TRUST_PROXY unset).
    const clientIp = getClientIP(c.req.raw);
    try {
      return await withRequestContext(
        { requestId, atlasMode: "published", agentOrigin: "mcp", clientIp },
        async () => {
          if (sessionId) {
            const entry = sessions.get(sessionId);
            if (!entry) {
              return c.json(
                {
                  error: "unknown_session",
                  message:
                    "Session not found. Reconnect with a fresh initialize request.",
                  requestId,
                },
                404,
              );
            }
            return sessions.dispatchExisting(c.req.raw, entry);
          }
          return sessions.dispatchNew(c.req.raw, {
            createServer: async () => {
              const server = createOnboardingMcpServer();
              if (!server) {
                // Unreachable — the router only mounts routes on SaaS — but
                // fail loud rather than serve a half-built server.
                throw new Error("onboarding server unavailable");
              }
              return server;
            },
            tooManyMessage:
              "Too many onboarding sessions right now. Please try again shortly.",
          });
        },
      );
    } catch (err) {
      log.error(
        { requestId, err: err instanceof Error ? err.message : String(err) },
        "Onboarding MCP dispatch failed",
      );
      return c.json(
        {
          error: "internal_error",
          message: "Onboarding request handling failed.",
          requestId,
        },
        500,
      );
    }
  });

  return router;
}
