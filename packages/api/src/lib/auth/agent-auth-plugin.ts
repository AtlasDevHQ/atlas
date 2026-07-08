/**
 * The `agentAuth()` Better Auth plugin config — the Agent Auth Protocol spine
 * (#4409 Slice 1) now driven by the OpenAPI capability adapter (#4410 / #2058,
 * Slice 2).
 *
 * Registered UNCONDITIONALLY in `buildPlugins()` (server.ts), so the plugin's
 * routes and its `agent`/`agentHost`/`agentCapabilityGrant`/`approvalRequest`
 * schema are always present (auto-migrated by Better Auth's `ctx.runMigrations()`
 * at boot, like `twoFactor`/`passkey`/`oauthProvider`). Whether the surface is
 * *reachable* is decided per-request by the `ATLAS_AGENT_AUTH_ENABLED` gate
 * (`agent-auth-gate.ts`), NOT by conditional registration — that is what buys
 * live, no-redeploy toggling of a build-once auth singleton.
 *
 * ── Slice 2: OpenAPI adapter, not a hand-written capability ──────────────────
 *
 * Slice 1 advertised ONE hand-written capability. Slice 2 replaces it with the
 * `createFromOpenAPI` adapter (`agent-auth-openapi.ts`): every documented Atlas
 * API operation becomes a capability, derived from the spec with no
 * hand-maintained list and no drift. Capability-explosion is contained to the
 * read-only, non-admin surface by three cooperating controls (see
 * `agent-auth-openapi.ts`).
 *
 * ── How execution stays org-scoped ──────────────────────────────────────────
 *
 * The adapter's `onExecute` PROXIES each call through the in-process Atlas API
 * (`app.fetch`, no socket) rather than reimplementing the operation. The only
 * Atlas-specific work happens in `resolveHeaders`, which runs per execution:
 *
 *   1. Map the plugin's verified `agentSession` into the plugin-agnostic
 *      `AgentAuthIdentity` and resolve it to a membership-enforced, per-org
 *      `AtlasUser` (`resolveAgentAuthActor`). A missing / foreign workspace, or a
 *      lookup failure, is DENIED — this is what enforces cross-workspace
 *      isolation for every adapter-derived capability.
 *   2. Re-check the hot-reloadable gate for the RESOLVED workspace so a
 *      workspace that opted out has its data sealed even when the platform
 *      default is on (#4419, tier 2). Fail-closed.
 *   3. Mint a short-lived, workspace-scoped Better Auth API key for that user +
 *      org and forward it as `x-api-key`. That is a REAL per-org access token,
 *      not a plaintext secret: the proxied request re-enters the API's normal
 *      auth path (`resolveApiKeyAuth`), which binds the org from the key's
 *      metadata and enforces workspace isolation itself — no org-scope bypass.
 *
 * Reversibility: this module, `agent-auth-openapi.ts`, and `agent-auth-verifier.ts`
 * are the ONLY places that know about agent sessions / agent JWTs. Nothing
 * downstream — the dispatch gate, RBAC, permissions — learns the agent-auth
 * shape (pinned by `agent-auth-seam-quarantine.test.ts`).
 */

import {
  agentAuth,
  agentError,
  AGENT_AUTH_ERROR_CODES,
  type AgentAuthOptions,
  type AgentSession,
} from "@better-auth/agent-auth";
import { APIError, isAPIError } from "better-auth/api";

import { createLogger } from "@atlas/api/lib/logger";
import {
  resolveAgentAuthActor,
  type AgentAuthActorResult,
  type AgentAuthIdentity,
} from "@atlas/api/lib/auth/agent-auth-verifier";
import { isAgentAuthEnabled } from "@atlas/api/lib/auth/agent-auth-gate";
import {
  buildAgentAuthOpenApiOptions,
  type AgentAuthOpenApiOptions,
  type ProxyFetch,
} from "@atlas/api/lib/auth/agent-auth-openapi";
import {
  getAtlasOpenApiSpec,
  type AtlasOpenApiSpec,
} from "@atlas/api/lib/auth/atlas-openapi-source";
import { getInProcessApiFetch } from "@atlas/api/lib/auth/in-process-api";
import { buildApiKeyMetadata, type StoredApiKeyMetadata } from "@atlas/api/lib/auth/api-key-metadata";
import { API_KEY_HEADER } from "@atlas/api/lib/auth/managed";
import { getUserRole, clampToOrgRole } from "@atlas/api/lib/auth/permissions";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const log = createLogger("auth:agent-auth-plugin");

/**
 * Metadata key on the agent record carrying the workspace the agent proposes to
 * act in. Honored only if the agent's owning user is a live member of it (see
 * `resolveAgentAuthActor`) — never claim-trusted.
 */
export const AGENT_WORKSPACE_METADATA_KEY = "workspaceId";

/** TTL for a minted workspace API key. Short — the key is a per-execution credential, not a stored secret. */
const WORKSPACE_KEY_TTL_SECONDS = 15 * 60;
/** Re-mint when a cached key has less than this remaining, so a proxied call never races expiry. */
const WORKSPACE_KEY_REFRESH_BEFORE_MS = 2 * 60 * 1000;

/**
 * Read the agent-proposed workspace id off the agent session's metadata,
 * coerced to a non-empty string (metadata values are `string|number|boolean|null`).
 */
function workspaceIdFromSession(session: AgentSession): string | undefined {
  const raw = session.agent.metadata?.[AGENT_WORKSPACE_METADATA_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Map the plugin's verified `agentSession` into the plugin-agnostic identity the
 * verifier consumes. `userId` prefers the canonical owning account
 * (`session.userId`), falling back to the runtime `user.id` for autonomous
 * agents (out of scope for this slice, but the fallback keeps the mapping total).
 */
function toIdentity(session: AgentSession): AgentAuthIdentity {
  return {
    userId: session.userId ?? session.user.id,
    requestedWorkspaceId: workspaceIdFromSession(session),
    agentId: session.agentId,
    label: session.agent.name || session.user.name || undefined,
  };
}

/** The typed reasons `resolveAgentAuthActor` can deny for. */
type DenialReason = Extract<AgentAuthActorResult, { kind: "denied" }>["reason"];

/** Map a resolver denial to its spec-compliant error envelope. */
function denialError(reason: DenialReason): APIError {
  return agentError(
    "FORBIDDEN",
    AGENT_AUTH_ERROR_CODES.UNAUTHORIZED,
    reason === "not_a_member"
      ? "Agent is not authorized for the requested workspace."
      : "Agent identity could not be bound to a workspace.",
  );
}

/** The per-execution binding: resolve the agent to a membership-verified per-org user + workspace. */
async function resolveBoundActor(
  agentSession: AgentSession,
): Promise<{ user: AtlasUser; workspaceId: string }> {
  const identity = toIdentity(agentSession);
  const resolved = await resolveAgentAuthActor(identity);
  if (resolved.kind === "denied") {
    log.warn(
      { agentId: identity.agentId, reason: resolved.reason },
      "agent-auth capability execution denied",
    );
    throw denialError(resolved.reason);
  }

  // Workspace-override precedence (#4419, tier 2): with the workspace resolved,
  // honor a per-workspace opt-out even when the platform default is on. Fail-closed.
  if (!(await isAgentAuthEnabled(resolved.workspaceId))) {
    throw agentError(
      "NOT_FOUND",
      AGENT_AUTH_ERROR_CODES.UNAUTHORIZED,
      "Agent Auth is not enabled for this workspace.",
    );
  }
  return { user: resolved.user, workspaceId: resolved.workspaceId };
}

/**
 * Mint (or reuse a cached) short-lived, workspace-scoped Better Auth API key for
 * the resolved user + org — the "real per-org access token" the proxied call
 * carries. Server-side mint (no request headers, explicit `userId`) so the key
 * is OWNED by the agent's owning member and traceable in the audit, exactly like
 * an admin-minted workspace key (`admin-workspace-keys.ts` / ADR-0027 §6). The
 * key's LIVE member role is re-resolved at use time and capped at the stored
 * ceiling, so the agent never acts above its owner's reach.
 *
 * NB (documented scope): no RLS claims are threaded — an RLS-enabled workspace
 * fails CLOSED (rows blocked) rather than leaking, deferring RLS-claim
 * propagation to a later slice. Managed-mode assumption: the `x-api-key` path is
 * validated only in managed auth mode (the SaaS path this feature targets);
 * self-hosted `simple-key`/`none` deploys do not consume Better Auth keys.
 */
type MintWorkspaceToken = (input: { user: AtlasUser; workspaceId: string }) => Promise<string>;

/** The Better Auth `apiKey()` plugin's server-side `createApiKey`, narrowed to what we call. */
export type CreateWorkspaceApiKey = (opts: {
  body: {
    userId: string;
    // Typed as the exact metadata we build (not a bare `Record`) so the call
    // site assigns without an `unknown` hop and a shape change is a type error.
    metadata: StoredApiKeyMetadata;
    name: string;
    expiresIn: number;
  };
}) => Promise<{ id?: string; key?: string } | undefined>;

/**
 * Pure minting core (no cache, no auth-instance resolution) — exported so the
 * per-org token contract is unit-tested directly: server-side `userId` binding,
 * workspace-scoped metadata, the org-role ceiling, and fail-closed error
 * envelopes. `createApiKey` is `undefined` on a deployment whose apiKey plugin
 * didn't register it.
 *
 * Both failure branches are 500-class. `agentError` builds an `APIError`, so it
 * bypasses the `onExecute` wrapper's ref injection (the wrapper re-throws
 * `APIError`s unchanged); each branch therefore logs with its OWN correlatable
 * `ref` and stamps that `ref` into the agent-facing message, matching the
 * wrapper's opaque-error path (CLAUDE.md: request IDs on all 500s).
 */
export async function mintWorkspaceApiKeyVia(
  createApiKey: CreateWorkspaceApiKey | undefined,
  { user, workspaceId }: { user: AtlasUser; workspaceId: string },
): Promise<string> {
  if (!createApiKey) {
    const ref = crypto.randomUUID();
    log.error(
      { workspaceId, ref },
      "apiKey plugin createApiKey unavailable — cannot mint per-org agent token",
    );
    throw agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `Per-org token minting is not available on this deployment (ref ${ref}).`,
    );
  }

  const role = clampToOrgRole(getUserRole(user));
  const metadata = buildApiKeyMetadata({ orgId: workspaceId, role });
  const created = await createApiKey({
    body: {
      userId: user.id,
      name: `agent-auth:${workspaceId}`,
      metadata,
      expiresIn: WORKSPACE_KEY_TTL_SECONDS,
    },
  });
  if (!created?.key) {
    const ref = crypto.randomUUID();
    log.error(
      { workspaceId, ref },
      "createApiKey returned no key material — cannot mint per-org agent token",
    );
    throw agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `Could not mint the per-org agent token (ref ${ref}). Retry shortly.`,
    );
  }
  return created.key;
}

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

const mintWorkspaceApiKey: MintWorkspaceToken = async ({ user, workspaceId }) => {
  const cacheKey = `${user.id}:${workspaceId}`;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - now > WORKSPACE_KEY_REFRESH_BEFORE_MS) return cached.token;

  // Dynamic import: a static import of `auth/server` would pull its eager
  // `db/internal` graph into every consumer + break partial-mock tests. Mirrors
  // the dynamic-import pattern in `admin-workspace-keys.ts`.
  const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
  const createApiKey = (getAuthInstance().api as { createApiKey?: unknown })
    .createApiKey as CreateWorkspaceApiKey | undefined;
  const token = await mintWorkspaceApiKeyVia(createApiKey, { user, workspaceId });
  tokenCache.set(cacheKey, { token, expiresAtMs: now + WORKSPACE_KEY_TTL_SECONDS * 1000 });
  return token;
};

/**
 * The proxy transport for `onExecute`: route the derived operation through the
 * in-process Atlas API via `app.fetch` (no network socket), so the real
 * middleware stack — auth, org scoping, RLS, rate limits, the handler — runs
 * exactly as for any client. The transport is obtained from the
 * `in-process-api` registry (seeded by `api/index.ts`) rather than importing the
 * `api/` layer here, keeping `lib/` above the route layer (CLAUDE.md). `null`
 * only in a non-API process, where the surface is spec-less + gated so this
 * never runs; fail closed with a ref if it somehow does.
 */
const inProcessFetch: ProxyFetch = async (input, init) => {
  const fn = getInProcessApiFetch();
  if (!fn) {
    const ref = crypto.randomUUID();
    log.error({ ref }, "in-process API transport unavailable — cannot proxy agent-auth capability");
    throw agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `The in-process API transport is unavailable (ref ${ref}).`,
    );
  }
  return fn(input, init);
};

/**
 * Base URL the proxy prefixes each operation path with. `app.fetch` routes on
 * the pathname, so only a valid absolute URL is required; a server-side fetch
 * sends no `Origin`, so CORS never trips.
 */
function resolveInternalApiBase(): string {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/$/, "") : "http://127.0.0.1:3001";
}

/** Injected seams — real in production, stubbed in tests. */
export interface AgentAuthPluginDeps {
  /** The Atlas OpenAPI document capabilities are derived from. */
  readonly spec: AtlasOpenApiSpec | null;
  /** Proxy transport for `onExecute`. */
  readonly fetch: ProxyFetch;
  /** Per-org token minter. */
  readonly mintToken: MintWorkspaceToken;
  /** Base URL the proxy prefixes operation paths with. */
  readonly baseUrl: string;
}

function resolveDeps(overrides?: Partial<AgentAuthPluginDeps>): AgentAuthPluginDeps {
  return {
    spec: overrides?.spec !== undefined ? overrides.spec : getAtlasOpenApiSpec(),
    fetch: overrides?.fetch ?? inProcessFetch,
    mintToken: overrides?.mintToken ?? mintWorkspaceApiKey,
    baseUrl: overrides?.baseUrl ?? resolveInternalApiBase(),
  };
}

/**
 * Recover the HTTP status the adapter embedded in its plain-`Error` message
 * (`Upstream API error <status>: <body>`). Returns `null` for any message that
 * doesn't match — a transport error, or an adapter message-format change on a
 * version bump (which safely falls through to the opaque-500 path).
 */
function parseUpstreamStatus(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^Upstream API error (\d{3}):/.exec(message);
  return match ? Number(match[1]) : null;
}

/** Transient 4xx statuses the agent should retry after a backoff, not treat as a permanent client error. */
const RETRIABLE_UPSTREAM_STATUS: ReadonlySet<number> = new Set([408, 429]);

/** Map a proxied 4xx to the agent-auth error status label that yields the same code. */
function upstreamClientErrorLabel(
  status: number,
): "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    default:
      return "BAD_REQUEST";
  }
}

/**
 * Build the adapter options (or the inert empty-capability set when no spec is
 * available — a non-API process, or a spec-generation failure; the surface is
 * default-off and gated, so zero capabilities is safe). The inert branch needs
 * no `resolveCapabilities`/`blockedCapabilities` beyond the empties: with zero
 * base capabilities there is nothing to hide or block.
 */
function buildOptions(deps: AgentAuthPluginDeps): AgentAuthOpenApiOptions {
  if (!deps.spec) {
    return { capabilities: [], defaultHostCapabilities: [], blockedCapabilities: [] };
  }

  const resolveHeaders: NonNullable<
    Parameters<typeof buildAgentAuthOpenApiOptions>[1]["resolveHeaders"]
  > = async ({ agentSession }) => {
    const { user, workspaceId } = await resolveBoundActor(agentSession);
    const token = await deps.mintToken({ user, workspaceId });
    return { [API_KEY_HEADER]: token };
  };

  const opts = buildAgentAuthOpenApiOptions(deps.spec, {
    baseUrl: deps.baseUrl,
    resolveHeaders,
    fetch: deps.fetch,
  });

  // Wrap the adapter's proxy `onExecute` so an UNEXPECTED failure (upstream
  // brownout, a thrown transport error) does NOT (a) go silent on Atlas's side,
  // nor (b) echo a raw upstream error body back to the agent — the least-trusted
  // actor. Intentional denials (`resolveHeaders` throwing an `APIError`) and the
  // plugin's own typed errors are re-thrown unchanged so their status/envelope
  // survive; only opaque errors are collapsed to a non-leaking ref. (CLAUDE.md:
  // no silent swallow, no secrets in responses, requestId on 500s.)
  const proxyExecute = opts.onExecute;
  if (!proxyExecute) return opts;

  const onExecute: NonNullable<AgentAuthOptions["onExecute"]> = async (ctx) => {
    const requestId = crypto.randomUUID();
    try {
      return await proxyExecute(ctx);
    } catch (err) {
      // Re-throw intentional denials + the plugin's own typed errors unchanged
      // so their status/envelope survive. `isAPIError` is a STRUCTURAL check —
      // `agentError` builds its `APIError` from a `@better-auth/core/error` copy
      // that may be a distinct class identity from this module's import, so a raw
      // `instanceof` would miss it and collapse a 403/404 denial into a 500.
      if (isAPIError(err)) throw err;

      // The adapter throws a PLAIN Error (`Upstream API error <status>: <body>`)
      // for every non-2xx proxied response, embedding the raw upstream body.
      const upstreamStatus = parseUpstreamStatus(err);

      // A RETRIABLE 4xx is transient — the proxy re-enters the full Atlas
      // middleware stack via `app.fetch`, so `checkRateLimit` can return 429 and
      // a slow handler 408. Tell the agent to back off and retry, NOT that the
      // call is permanently bad. (Preserve the throttle/timeout status label.)
      if (upstreamStatus !== null && RETRIABLE_UPSTREAM_STATUS.has(upstreamStatus)) {
        log.warn(
          { status: upstreamStatus, requestId, capability: ctx.capability },
          "agent-auth openapi proxy: upstream throttled/timed out (retriable)",
        );
        throw agentError(
          upstreamStatus === 429 ? "TOO_MANY_REQUESTS" : "REQUEST_TIMEOUT",
          // Machine-readable code must let an SDK branch throttle-vs-fault: 429
          // gets the purpose-built `rate_limited`, not the `internal_error` the
          // genuine-server-fault path uses. (408 has no dedicated code.)
          upstreamStatus === 429
            ? AGENT_AUTH_ERROR_CODES.RATE_LIMITED
            : AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
          `The Atlas API is throttling or timed out (HTTP ${upstreamStatus}). Retry after a short backoff (ref ${requestId}).`,
        );
      }

      // A DETERMINISTIC 4xx is the agent's own bad request (invalid args / not
      // permitted): surface a client-class envelope WITHOUT the raw body (no
      // leak) and WITHOUT misleading retry guidance. A 5xx or an unparseable/
      // transport error falls through to the opaque 500.
      if (upstreamStatus !== null && upstreamStatus >= 400 && upstreamStatus < 500) {
        log.warn(
          { status: upstreamStatus, requestId, capability: ctx.capability },
          "agent-auth openapi proxy: upstream rejected the request (client error)",
        );
        throw agentError(
          upstreamClientErrorLabel(upstreamStatus),
          AGENT_AUTH_ERROR_CODES.INVALID_REQUEST,
          `The Atlas API rejected this capability call (HTTP ${upstreamStatus}). Check the arguments — it will not succeed on retry unchanged (ref ${requestId}).`,
        );
      }

      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId, capability: ctx.capability },
        "agent-auth openapi proxy execution failed",
      );
      throw agentError(
        "INTERNAL_SERVER_ERROR",
        AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
        `Failed to execute capability (ref ${requestId}). Retry; if it persists, contact your operator.`,
      );
    }
  };

  return { ...opts, onExecute };
}

/**
 * Build the `agentAuth()` plugin. Kept as a factory (not a module-level
 * singleton) so `buildPlugins()` composes it like every other plugin and tests
 * can construct it in isolation with injected seams.
 */
export function buildAgentAuthPlugin(
  overrides?: Partial<AgentAuthPluginDeps>,
): ReturnType<typeof agentAuth> {
  const options = buildOptions(resolveDeps(overrides));
  return agentAuth({
    ...options,
    // AFTER the spread: `createFromOpenAPI` derives `providerName`/
    // `providerDescription` from the spec's `info` ("Atlas API" / the API
    // blurb), but the discovery document should carry Atlas's own branding and
    // the load-bearing "experimental" signal — so these literals must win.
    providerName: "Atlas",
    providerDescription:
      "Atlas — deploy-anywhere text-to-SQL data analyst agent (Agent Auth Protocol, experimental).",
  });
}
