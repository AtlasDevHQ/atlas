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
 * Reversibility: the verifier (`agent-auth-verifier.ts`) header carries the
 * authoritative enumeration of which files may know which agent-auth shapes.
 * Nothing downstream — the dispatch gate, RBAC, permissions — learns the
 * agent-auth shape (pinned by `agent-auth-seam-quarantine.test.ts`).
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
import { resolveAgentAuthEnablement } from "@atlas/api/lib/auth/agent-auth-gate";
import { errorMessage } from "@atlas/api/lib/audit";
import { auditAgentAuthEvent } from "@atlas/api/lib/auth/agent-auth-audit";
import { resolveAgentApprovalPage } from "@atlas/api/lib/auth/agent-approval-page";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { resolvePasskeyRpId } from "@atlas/api/lib/auth/rpid";
import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
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

/**
 * Map a resolver denial to its spec-compliant error envelope.
 *
 * `membership_lookup_failed` is NOT an authorization decision — it means the
 * membership READ itself failed (internal-DB blip, pool exhaustion). Dressing
 * that as a 403 would tell the agent's operator "this agent is not authorized"
 * for a transient infra fault, so it surfaces as a ref-stamped, retriable
 * 500 instead (CLAUDE.md: return 500, not a false negative; request IDs on all
 * 500s). The deny direction stays fail-closed either way — nothing executes.
 */
function denialError(reason: DenialReason): APIError {
  if (reason === "membership_lookup_failed") {
    const ref = crypto.randomUUID();
    log.error(
      { ref },
      "agent-auth: membership lookup failed — surfacing a retriable 500, not a denial",
    );
    return agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `Could not verify workspace membership (ref ${ref}). Retry shortly.`,
    );
  }
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
  // honor a per-workspace opt-out even when the platform default is on. The
  // tri-state keeps a settings-read failure distinguishable from a deliberate
  // opt-out: an infra blip is a retriable 500, never a 404 claiming the
  // workspace disabled the feature. Both directions fail closed.
  const enablement = await resolveAgentAuthEnablement(resolved.workspaceId);
  if (enablement === "indeterminate") {
    const ref = crypto.randomUUID();
    log.error(
      { workspaceId: resolved.workspaceId, agentId: identity.agentId, ref },
      "agent-auth: workspace enablement could not be resolved — failing closed with a retriable 500",
    );
    throw agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `Could not verify Agent Auth enablement for this workspace (ref ${ref}). Retry shortly.`,
    );
  }
  if (enablement === "off") {
    log.warn(
      { workspaceId: resolved.workspaceId, agentId: identity.agentId },
      "agent-auth capability execution sealed by workspace enablement override (tier 2)",
    );
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
export type MintWorkspaceToken = (input: {
  user: AtlasUser;
  workspaceId: string;
}) => Promise<string>;

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

/**
 * Coarse bound on live cached tokens (`user × workspace` keys). Expired/stale
 * entries are evicted on the write path, so this cap only matters under a flood
 * of distinct pairs; on overflow the stale sweep runs and, if still full, the
 * cache clears wholesale — a re-mint is cheap, unbounded key material in process
 * memory is not. Mirrors the audit sampler's `EXECUTE_TRACKED_KEYS_CAP` posture.
 */
const TOKEN_CACHE_MAX_ENTRIES = 1000;

/**
 * Caching wrapper around a token minter. Exported as a factory (mirroring
 * `createAgentAuthAuditor`) so the cache contract is directly testable: the
 * `${user.id}:${workspaceId}` key can never hand workspace A's token to a
 * workspace-B execution, entries refresh before expiry
 * ({@link WORKSPACE_KEY_REFRESH_BEFORE_MS}), and the cache stays bounded.
 */
export function createWorkspaceTokenMinter(
  mint: MintWorkspaceToken,
  opts?: {
    ttlSeconds?: number;
    refreshBeforeMs?: number;
    maxEntries?: number;
    now?: () => number;
  },
): MintWorkspaceToken {
  const ttlMs = (opts?.ttlSeconds ?? WORKSPACE_KEY_TTL_SECONDS) * 1000;
  const refreshBeforeMs = opts?.refreshBeforeMs ?? WORKSPACE_KEY_REFRESH_BEFORE_MS;
  const maxEntries = opts?.maxEntries ?? TOKEN_CACHE_MAX_ENTRIES;
  const now = opts?.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAtMs: number }>();

  return async ({ user, workspaceId }) => {
    const cacheKey = `${user.id}:${workspaceId}`;
    const t = now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs - t > refreshBeforeMs) return cached.token;
    if (cached) cache.delete(cacheKey); // stale — evict rather than overwrite later

    const token = await mint({ user, workspaceId });
    if (cache.size >= maxEntries) {
      for (const [key, entry] of cache) {
        if (entry.expiresAtMs - t <= refreshBeforeMs) cache.delete(key);
      }
      if (cache.size >= maxEntries) cache.clear();
    }
    cache.set(cacheKey, { token, expiresAtMs: t + ttlMs });
    return token;
  };
}

const mintWorkspaceApiKey: MintWorkspaceToken = createWorkspaceTokenMinter(
  async ({ user, workspaceId }) => {
    // Dynamic import: a static import of `auth/server` would pull its eager
    // `db/internal` graph into every consumer + break partial-mock tests. Mirrors
    // the dynamic-import pattern in `admin-workspace-keys.ts`.
    const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
    const rawCreateApiKey = (getAuthInstance().api as { createApiKey?: unknown }).createApiKey;
    // Runtime-narrow before trusting the third-party surface: a Better Auth bump
    // that reshapes/renames `createApiKey` must land on the loud fail-closed
    // branch in `mintWorkspaceApiKeyVia`, not be blind-cast and fail late.
    const createApiKey =
      typeof rawCreateApiKey === "function"
        ? (rawCreateApiKey as CreateWorkspaceApiKey)
        : undefined;
    return mintWorkspaceApiKeyVia(createApiKey, { user, workspaceId });
  },
);

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
  /**
   * The device-authorization approval page (#4411). Absolute WEB-origin URL so
   * the plugin's `verification_uri` resolves to the page that actually renders
   * (`packages/web` `src/app/agent/approve/page.tsx`) rather than a 404 on the
   * API host — see `resolveAgentApprovalPage`.
   */
  readonly deviceAuthorizationPage: string;
  /**
   * Enterprise (#4413, Slice 5a): when `true`, WRITE-method capabilities are
   * stamped with `approvalStrength: "webauthn"` and the plugin's
   * `proofOfPresence` is enabled, so a write requires a WebAuthn step-up
   * (physical presence) before approval — unbypassable by an autonomous agent
   * with browser control. When `false` (core / AGPL) writes keep the library
   * default (`"session"`) and no proof-of-presence is required. Resolved from the
   * core `enterprise-config.ts` mirror, never a direct `@atlas/ee` import, so
   * `check-ee-imports.sh` stays green. Orthogonal to `ATLAS_AGENT_AUTH_ENABLED`
   * (#4409), which gates whether the surface is reachable at all.
   */
  readonly stepUpWrites: boolean;
  /**
   * WebAuthn RP id + origin for `proofOfPresence`. `webauthnRpId` MUST match the
   * passkey plugin's enrollment RP — `server.ts` registers
   * `passkey({ rpID: resolvePasskeyRpId(process.env, getWebOrigin()) })` — or an
   * assertion made against an enrolled passkey would be rejected as RP-mismatched;
   * it is always a non-empty string (`resolvePasskeyRpId` falls back to
   * `DEFAULT_RP_ID`). `webauthnOrigin` is `null` when no web origin is configured,
   * in which case only the ORIGIN is omitted and the plugin derives it from its
   * `baseURL` — `rpId` is always supplied.
   */
  readonly webauthnRpId: string;
  readonly webauthnOrigin: string | null;
  /**
   * Enterprise (#4414, Slice 5b): when `true`, the Atlas-internal CIBA
   * (backchannel) approval method (§9) is advertised in the discovery document
   * and accepted by `/agent/ciba/authorize`, in addition to the core
   * device-authorization path. When `false` (core / AGPL) only
   * `device_authorization` is offered: the library omits `ciba` from
   * `approval_methods` and hard-rejects `/agent/ciba/authorize`
   * (`invalid_request`), and `resolveApprovalMethod` falls back to
   * `device_authorization` even for an agent that asks for
   * `preferredMethod: "ciba"`. Only Atlas-internal CIBA is in scope — the
   * library resolves the user from its own internal adapter by email login-hint;
   * native third-party-IdP CIBA integrations stay out of scope (#2058). Resolved
   * from the core `enterprise-config.ts` mirror, never a direct `@atlas/ee`
   * import, so `check-ee-imports.sh` stays green. Orthogonal to
   * `ATLAS_AGENT_AUTH_ENABLED` (#4409), which gates whether the surface is
   * reachable at all.
   */
  readonly cibaApproval: boolean;
}

/**
 * Resolve the injected seams to their production defaults, honoring any
 * overrides. Exported so the flag→feature wiring is directly testable — in
 * particular that `stepUpWrites` reads the enterprise decision through the core
 * `enterprise-config.ts` mirror (#4413 AC3) and that `webauthnRpId` matches the
 * passkey plugin's enrollment RP by construction (same resolver + args as
 * `server.ts`). Callers that want the plugin should use `buildAgentAuthPlugin`.
 */
export function resolveDeps(overrides?: Partial<AgentAuthPluginDeps>): AgentAuthPluginDeps {
  return {
    spec: overrides?.spec !== undefined ? overrides.spec : getAtlasOpenApiSpec(),
    fetch: overrides?.fetch ?? inProcessFetch,
    mintToken: overrides?.mintToken ?? mintWorkspaceApiKey,
    baseUrl: overrides?.baseUrl ?? resolveInternalApiBase(),
    deviceAuthorizationPage:
      overrides?.deviceAuthorizationPage ?? resolveAgentApprovalPage(getWebOrigin()),
    // Read the enterprise flag through the core mirror (getConfig() → env), NOT a
    // direct @atlas/ee import. Defaults false whenever config is unloaded / the
    // env flag is unset (e.g. isolated unit tests), keeping core behavior unless
    // enterprise is explicitly on.
    stepUpWrites: overrides?.stepUpWrites ?? isEnterpriseEnabled(),
    webauthnRpId: overrides?.webauthnRpId ?? resolvePasskeyRpId(process.env, getWebOrigin()),
    webauthnOrigin:
      overrides?.webauthnOrigin !== undefined ? overrides.webauthnOrigin : getWebOrigin(),
    // #4414 Slice 5b — read the same enterprise decision through the core mirror
    // (never a direct @atlas/ee import). Defaults false whenever config is
    // unloaded / the env flag is unset, so core offers only device-authorization
    // unless enterprise is explicitly on.
    cibaApproval: overrides?.cibaApproval ?? isEnterpriseEnabled(),
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
    // Enterprise-only (#4413): require a WebAuthn step-up on writes. Omitted in
    // core, so writes keep the library default ("session").
    ...(deps.stepUpWrites ? { writeApprovalStrength: "webauthn" as const } : {}),
  });

  // Wrap the adapter's proxy `onExecute` so an UNEXPECTED failure (upstream
  // brownout, a thrown transport error) does NOT (a) go silent on Atlas's side,
  // nor (b) echo a raw upstream error body back to the agent — the least-trusted
  // actor. Intentional denials (`resolveHeaders` throwing an `APIError`) and the
  // plugin's own typed errors are re-thrown unchanged so their status/envelope
  // survive; only opaque errors are collapsed to a non-leaking ref. (CLAUDE.md:
  // no silent swallow, no secrets in responses, requestId on 500s.)
  const proxyExecute = opts.onExecute;
  if (!proxyExecute) {
    // An adapter bump that stops returning `onExecute` would build a capability
    // surface with no execute path AND no protective wrapper — make that drift
    // loud instead of silent.
    log.error(
      "agent-auth openapi adapter returned no onExecute — capabilities will not execute",
    );
    return opts;
  }

  // Defense-in-depth for the containment set: as of 0.6.2 the library enforces
  // `blockedCapabilities` at grant/request/approve time but NOT at
  // `/capability/execute` — an active grant that exists anyway (seeded directly,
  // or a future library path that skips the block) would execute. Re-check at
  // the execute seam Atlas controls, so a blocked (write/admin) capability can
  // never reach the in-process proxy regardless of grant state.
  const blockedSet = new Set(opts.blockedCapabilities ?? []);

  const onExecute: NonNullable<AgentAuthOptions["onExecute"]> = async (ctx) => {
    const requestId = crypto.randomUUID();
    if (blockedSet.has(ctx.capability)) {
      log.warn(
        { capability: ctx.capability, requestId },
        "agent-auth: execute of a blocked capability rejected (execute-time re-check)",
      );
      throw agentError(
        "FORBIDDEN",
        AGENT_AUTH_ERROR_CODES.CAPABILITY_BLOCKED,
        `Capability "${ctx.capability}" is blocked by server policy.`,
      );
    }
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
          // `errorMessage` scrubs connection strings + truncates — the raw
          // upstream body embedded in the adapter's message is Atlas-log-only
          // and must be diagnosable without being persisted verbatim.
          { status: upstreamStatus, requestId, capability: ctx.capability, errMessage: errorMessage(err) },
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
          // Withheld from the agent (least-trusted actor), but logged scrubbed —
          // otherwise a 400-class capability failure is undiagnosable server-side.
          { status: upstreamStatus, requestId, capability: ctx.capability, errMessage: errorMessage(err) },
          "agent-auth openapi proxy: upstream rejected the request (client error)",
        );
        throw agentError(
          upstreamClientErrorLabel(upstreamStatus),
          AGENT_AUTH_ERROR_CODES.INVALID_REQUEST,
          `The Atlas API rejected this capability call (HTTP ${upstreamStatus}). Check the arguments — it will not succeed on retry unchanged (ref ${requestId}).`,
        );
      }

      log.error(
        // Scrub before logging: a driver-level error echoed through an upstream
        // 500 body can carry a connection string (same hygiene as the audit bridge).
        { err: errorMessage(err), requestId, capability: ctx.capability },
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
 * Assemble the full `agentAuth()` options object from resolved deps — the
 * capability set + proxy `onExecute` (from {@link buildOptions}) plus the
 * top-level plugin options (device-authorization page, enterprise step-up,
 * audit, branding). Extracted from {@link buildAgentAuthPlugin} so the
 * enterprise-gated `proofOfPresence` + the write-capability strength stamps are
 * assertable directly (the constructed plugin object hides its options), without
 * standing up a `betterAuth()` instance.
 */
export function buildAgentAuthPluginOptions(deps: AgentAuthPluginDeps): AgentAuthOptions {
  const options = buildOptions(deps);
  return {
    ...options,
    // Point the device-authorization approval flow (#4411) at the Atlas web
    // page. Absolute WEB-origin URL — a bare path would resolve against the API
    // origin and 404 (see `resolveAgentApprovalPage`). Set outside the OpenAPI
    // `options` spread because it's a top-level plugin option, not an adapter
    // field; the adapter never touches it, so ordering is immaterial.
    deviceAuthorizationPage: deps.deviceAuthorizationPage,
    // #4414 Slice 5b — CIBA (backchannel) approval, ENTERPRISE-ONLY. Core (AGPL)
    // offers ONLY device-authorization approval; the Atlas-internal CIBA
    // backchannel (§9.2) is advertised + accepted only when /ee is enabled. The
    // library gates its own CIBA surface on THIS list: `/agent/ciba/authorize`
    // hard-rejects (`invalid_request`) and `/agent-configuration` omits `ciba`
    // from `approval_methods` whenever `"ciba"` is absent — so a core deploy
    // cannot initiate a backchannel flow even if an agent asks for
    // `preferredMethod: "ciba"` (`resolveApprovalMethod` falls back to
    // `device_authorization`). This must be set explicitly: the library default
    // is `["ciba", "device_authorization"]`, i.e. CIBA-on, so leaving it unset
    // would offer CIBA in core. Native third-party-IdP CIBA integrations stay out
    // of scope (#2058) — this is Atlas-internal CIBA only (the library resolves
    // the user via its own internal adapter by email login-hint, not an external
    // IdP). The enterprise decision is read via the core `enterprise-config.ts`
    // mirror (no `@atlas/ee` import here). Orthogonal to `ATLAS_AGENT_AUTH_ENABLED`
    // (#4409), which gates whether the surface is reachable at all.
    approvalMethods: deps.cibaApproval
      ? ["device_authorization", "ciba"]
      : ["device_authorization"],
    // #4413 Slice 5a — WebAuthn step-up enforcement, ENTERPRISE-ONLY. When /ee is
    // enabled (`stepUpWrites`), write-method capabilities carry
    // `approvalStrength: "webauthn"` (stamped in `buildOptions`) and
    // proof-of-presence is REQUIRED before a write is approved — so even an
    // autonomous agent with browser control cannot self-approve a write; a human
    // with a physical authenticator must. `rpId` mirrors the passkey plugin's
    // enrollment RP (`server.ts`) so an assertion made against an enrolled passkey
    // validates; `origin` is the configured web origin. When the web origin is
    // unset, `origin` is omitted and the plugin derives it from its `baseURL`
    // (`rpId` is always supplied). Omitted entirely in core, where writes keep the
    // library-default "session" strength and no proof-of-presence is required.
    // The enterprise decision is read via the core `enterprise-config.ts` mirror
    // (no `@atlas/ee` import here). This is orthogonal to `ATLAS_AGENT_AUTH_ENABLED`
    // (#4409), which gates whether the surface is reachable at all.
    ...(deps.stepUpWrites
      ? {
          proofOfPresence: {
            enabled: true,
            rpId: deps.webauthnRpId,
            ...(deps.webauthnOrigin ? { origin: deps.webauthnOrigin } : {}),
          },
        }
      : {}),
    // #4412 Slice 4 — record the grant/approval/execute lifecycle in the admin
    // audit catalog (`ADMIN_ACTIONS.agent.*`). The bridge fails closed on the
    // `ATLAS_AGENT_AUTH_ENABLED` master switch, summarizes high-volume executes
    // (never one row per call), and never records capability args/output. See
    // `agent-auth-audit.ts`. The plugin's own `onEvent` dispatch is fire-and-forget
    // (`.catch`-logged), and the bridge additionally never rejects, so a
    // slow/failing audit write can never break an agent-auth request.
    onEvent: auditAgentAuthEvent,
    // AFTER the spread: `createFromOpenAPI` derives `providerName`/
    // `providerDescription` from the spec's `info` ("Atlas API" / the API
    // blurb), but the discovery document should carry Atlas's own branding and
    // the load-bearing "experimental" signal — so these literals must win.
    providerName: "Atlas",
    providerDescription:
      "Atlas — deploy-anywhere text-to-SQL data analyst agent (Agent Auth Protocol, experimental).",
  };
}

/**
 * Build the `agentAuth()` plugin. Kept as a factory (not a module-level
 * singleton) so `buildPlugins()` composes it like every other plugin and tests
 * can construct it in isolation with injected seams.
 */
export function buildAgentAuthPlugin(
  overrides?: Partial<AgentAuthPluginDeps>,
): ReturnType<typeof agentAuth> {
  const deps = resolveDeps(overrides);
  // Loud, non-secret signal of the resolved enterprise approval posture (#4413
  // WebAuthn step-up + #4414 CIBA) so an operator can confirm from logs which
  // enterprise controls are active on a licensed deploy — not infer them. If
  // config loads late (unresolved → false), this line is the only trace that
  // writes built at the weaker "session" strength / that CIBA is not offered.
  // rpId + booleans are not secrets (CLAUDE.md: no secrets in logs).
  log.info(
    {
      stepUpWrites: deps.stepUpWrites,
      webauthnRpId: deps.stepUpWrites ? deps.webauthnRpId : undefined,
      cibaApproval: deps.cibaApproval,
    },
    "agent-auth: resolved enterprise approval posture (WebAuthn step-up + CIBA)",
  );
  return agentAuth(buildAgentAuthPluginOptions(deps));
}
