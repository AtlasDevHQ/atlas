/**
 * Structured logger with request context propagation.
 *
 * - JSON output in production, pino-pretty in development
 * - Pino mixin + AsyncLocalStorage binds requestId to all log lines within a request
 * - Redaction paths prevent secrets from leaking into logs
 * - ATLAS_LOG_LEVEL env var controls verbosity (default: "info")
 */

import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "node:crypto";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

// --- Request context ---

/**
 * Discriminator on who initiated the request, threaded through audit_log
 * via #2067. All four kinds are wired (#3615): web chat / `/api/v1/query`
 * stamp `human`, the scheduler stamps `scheduler`, the MCP dispatchers stamp
 * `mcp`, and `logQueryAudit` defaults any agent-loop SQL with no more-specific
 * actor to `agent` (the only `executeSQL` writer is the agent loop). Rows are
 * therefore never NULL for actor-scoped filters.
 *
 * Modeled as a discriminated union so `clientId` / `toolName` are only
 * reachable on the `mcp` branch — the type system enforces the
 * "client_id only for mcp" invariant the migration's column shape
 * implies, and `audit.ts` can stamp the columns without per-field
 * truthy guards.
 */
export const ACTOR_KINDS = ["human", "agent", "mcp", "scheduler"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type RequestActor =
  | { kind: "human" | "agent" | "scheduler" }
  | {
      kind: "mcp";
      /** Hosted-MCP OAuth client_id (e.g. `claude-desktop`, a DCR UUID). Stdio MCP leaves this undefined. */
      clientId?: string;
      /** MCP tool dispatched (`executeSQL`, `runMetric`, etc). Required because every dispatch site is named. */
      toolName: string;
    };

interface RequestContext {
  requestId: string;
  user?: AtlasUser;
  /** Resolved atlas mode for this request. When "published", tools should restrict to published entities only. */
  atlasMode?: import("@useatlas/types/auth").AtlasMode;
  /** See `lib/auth/trust-device-cookie.ts`. Surfaced into `admin_action_log` metadata via `logAdminAction`. */
  trustDeviceIdentifier?: string;
  /** #2067 — request-shape discriminator persisted to `audit_log.{actor_kind, client_id, tool_name}`. */
  actor?: RequestActor;
  /**
   * #2072 — agent origin for origin-scoped approval rule matching
   * (renamed from "surface" in ADR-0015). Stamped by every agent-facing
   * route (chat / query / slack / teams / webhook / mcp / scheduler) so
   * `checkApprovalRequired` can apply `WHERE origin = $req OR origin =
   * 'any'`. Distinct from `actor.kind` (which is the audit-log
   * discriminator and uses a different value space — `human` / `agent` /
   * `mcp` / `scheduler`).
   */
  agentOrigin?: import("@useatlas/types").ApprovalRequestOrigin;
  /**
   * #3654 — best-effort client IP for the current request, resolved via
   * `getClientIP` and stamped by unauthenticated bootstrap surfaces (the MCP
   * onboarding router) so a per-session MCP tool handler can read the
   * per-request IP for attempt rate-limiting without re-threading the raw
   * `Request`. `null` when no trusted proxy is configured (`ATLAS_TRUST_PROXY`
   * unset) — the per-IP limiter then collapses to one shared bucket. Undefined
   * on non-onboarding requests, which resolve the IP at their own seam.
   */
  clientIp?: string | null;
  /**
   * #3504 — OAuth token scopes (from the JWT `scope` claim) on hosted MCP
   * requests, threaded by `verifyMcpBearer` through the dispatch frame.
   * The dispatch seam gates write tools on `mcp:write` (see
   * `writeScopeOrNull` in packages/mcp/src/tools.ts). Undefined for stdio
   * MCP and non-MCP requests, which carry no OAuth bearer.
   */
  scopes?: readonly string[];
  /**
   * #2345 — group-aware chat routing.
   *
   * `connectionId` is the *execution target* for SQL on this request —
   * a per-turn override that supersedes the conversation's stored
   * `connection_id` for one turn only. Falls back to the conversation
   * value when undefined.
   *
   * `connectionGroupId` is the *content scope* for entity / dashboard
   * overlays. Decoupled from `connectionId` so a multi-member "prod"
   * group can resolve content while a per-turn override targets a
   * single replica (e.g. "us-int" for one question, "eu" for the next).
   */
  connectionId?: string;
  connectionGroupId?: string;
  /**
   * #2518 — three-state Auto/Pin/All cross-environment picker state for
   * the conversation. The chat route stamps this from the resolved
   * conversation row (or the per-turn body override) so `executeSQL`
   * can pass it to {@link resolveRoutingPlan} as `pickerMode`. NULL in
   * the DB / undefined here is treated as `"pin"` for back-compat —
   * pre-#2518 conversations whose `connection_id` already names a
   * single member keep single-execution semantics.
   */
  routingMode?: import("@atlas/api/lib/env-routing").RoutingMode;
  /**
   * #3066 — per-conversation REST datasource exclude-set. The chat route
   * stamps this from the resolved conversation row (or the per-turn body
   * override) so the REST datasource resolver drops these `install_id`s
   * BEFORE the prompt + the bound `executeRestOperation` tool see them.
   * Undefined here = exclude nothing (every in-scope REST datasource stays
   * queryable). SQL routing (`routingMode`) is unaffected. `readonly` to match
   * the rest of the internal exclude-set vocabulary (`ResolveWorkspaceDeps`,
   * the preference store) — consumers only read it.
   */
  restExcludedDatasourceIds?: readonly string[];
  /**
   * #3067 — per-conversation REST-only focus. The chat route stamps this
   * from the resolved conversation row (or the per-turn body override) when
   * the conversation is focused on a single REST datasource. When set, the
   * agent loop resolves only that datasource and SUSPENDS `executeSQL`;
   * `restExcludedDatasourceIds` and SQL routing are ignored for the turn.
   * Undefined / null here = not focused (default scope). Stamped only when
   * truthy, so the legacy shape is unchanged for non-focused conversations.
   */
  restFocusDatasourceId?: string | null;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return requestStore.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

// --- Logger ---

const isDev = process.env.NODE_ENV !== "production";

// Redaction covers top-level fields, one-level nested (*.field), array
// element access ([*].field), and known deep structures. fast-redact does
// not support ** glob wildcards, so deep paths must be listed explicitly.
//
// The F-44 block adds credential-bearing field names that showed up during
// the Phase 5 secret-surface audit — webhook bodies, OAuth replies, Slack /
// Teams / Discord integration configs, and HTTP headers. `set-cookie` uses
// bracket-quoted notation because fast-redact requires it for dash-bearing
// property names.
const CREDENTIAL_FIELDS = [
  "connectionString",
  "databaseUrl",
  "apiKey",
  "password",
  "secret",
  "authorization",
  "url",
  // F-44: expanded field coverage for webhook / OAuth / chat / header leaks.
  "cookie",
  "bearer",
  "token",
  "refreshToken",
  "botToken",
  "signingSecret",
  "clientSecret",
  "webhookSecret",
  "appPassword",
  "serverToken",
] as const;

export const redactPaths = [
  // top level
  ...CREDENTIAL_FIELDS,
  '["set-cookie"]',
  // one-level nested (object-valued parent: `{foo: {clientSecret: ...}}`)
  ...CREDENTIAL_FIELDS.map((f) => `*.${f}`),
  '*["set-cookie"]',
  // one-level nested (array-valued parent: `{integrations: [{clientSecret: ...}]}`)
  ...CREDENTIAL_FIELDS.map((f) => `*[*].${f}`),
  '*[*]["set-cookie"]',
  // root is an array: `log.info([{clientSecret: ...}])` — rare but preserved.
  ...CREDENTIAL_FIELDS.map((f) => `[*].${f}`),
  '[*]["set-cookie"]',
  // Deep structures: datasource config, connection registry, plugin config
  "datasources.*.url",
  "datasources.*.connectionString",
  "datasources.*.password",
  "config.datasources.*.url",
  "config.datasources.*.connectionString",
  "connection.url",
  "connection.connectionString",
  "connection.password",
  "connections.*.url",
  "connections.*.connectionString",
  "connections.*.password",
];

// `scheme://user:pass@` detector used by the formatter. Anchored by a word
// boundary so we don't clip identifiers that happen to end in `://`. Case-
// insensitive because pg/mysql drivers sometimes uppercase in error text.
const CREDENTIAL_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s@/]*@/i;

/**
 * Pino `serializers.err` handler. Funnels every error-shaped value through
 * `errorMessage()` so a driver-echoed connection string (`postgres://u:p@h/db`)
 * gets its userinfo stripped before the line reaches Loki / Railway / Datadog.
 *
 * Accepts:
 *   - Error instance → `{ type, message, stack }` with scrubbed message + stack
 *   - pre-serialized error-shape object (`{ message, ... }`) → same object
 *     with scrubbed `message`
 *   - string → scrubbed string (this is the hot path — most call sites
 *     collapse `err` to `err.message` before logging)
 *   - anything else → `errorMessage()` coercion (truncates + scrubs)
 *
 * Fail-open: if scrubbing throws for any reason, we emit a placeholder instead
 * of dropping the log line. Logs are forensic evidence — losing one because
 * the scrubber couldn't parse a weird value defeats the purpose.
 */
export function scrubErrSerializer(value: unknown): unknown {
  try {
    if (value instanceof Error) {
      const scrubbedStack = value.stack ? errorMessage(value.stack) : undefined;
      return {
        type: value.name,
        message: errorMessage(value),
        ...(scrubbedStack !== undefined && { stack: scrubbedStack }),
      };
    }
    if (typeof value === "string") return errorMessage(value);
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.message === "string") {
        return { ...obj, message: errorMessage(obj.message) };
      }
    }
    return errorMessage(value);
  } catch {
    return "[log scrub failed]";
  }
}

/**
 * Pino `formatters.log` — second-line defense that walks every top-level
 * string field on the log record and scrubs any value that echoes a
 * `scheme://user:pass@` URI. Complements `redact.paths` (which covers known
 * field *names*) by catching cases where a connection string lands in an
 * unexpected field — a caller reason string, a serialized cause object, a
 * bystander debug field.
 *
 * Scoped to top-level strings deliberately. Nested known-name fields are
 * already covered by `redact.paths` wildcards; recursing deeper would pay an
 * allocation cost on every log call for diminishing returns.
 *
 * Copy-on-write: pino passes the caller's merged object by reference. If a
 * caller logs a long-lived reference (e.g. `log.warn(entry.lastHealth, ...)`)
 * and we mutated it, the scrubbed string would replace the original in the
 * caller's in-memory state. We clone on the first match so the caller's
 * object is never touched. Common case (no match) stays allocation-free.
 *
 * Fail-open: any exception returns the original object so the line still
 * emits.
 */
export function scrubLogFormatter(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  try {
    let out: Record<string, unknown> = obj;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === "string" && CREDENTIAL_URI_PATTERN.test(value)) {
        if (out === obj) out = { ...obj };
        out[key] = errorMessage(value);
      }
    }
    return out;
  } catch {
    return obj;
  }
}

const rootLogger = pino({
  level: process.env.ATLAS_LOG_LEVEL ?? "info",
  redact: redactPaths,
  serializers: { err: scrubErrSerializer },
  formatters: { log: scrubLogFormatter },
  mixin() {
    const ctx = requestStore.getStore();
    if (!ctx) return {};
    const base: Record<string, unknown> = { requestId: ctx.requestId };
    if (ctx.user) {
      base.userId = ctx.user.id;
      base.authMode = ctx.user.mode;
    }
    return base;
  },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
});

/**
 * Get the root logger. Request context (requestId) is injected
 * automatically at log-emission time via pino mixin.
 */
export function getLogger(): pino.Logger {
  return rootLogger;
}

/**
 * Create a named child logger for a specific component.
 * Request context (requestId) is injected automatically at
 * log-emission time via pino mixin — safe to call at module scope.
 */
export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

const VALID_LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/**
 * Redact a share token for logging. Returns the first 16 hex chars of SHA-256.
 *
 * Share tokens are bearer credentials — anyone with log access to a plaintext
 * token can read the share. A truncated hash preserves cross-log correlation
 * (same token → same hash) without exposing a usable credential.
 *
 * Throws on non-string input rather than coercing. `String(undefined)` would
 * produce a stable hash of the literal "undefined", silently poisoning
 * cross-log correlation during triage.
 */
export function hashShareToken(token: string): string {
  if (typeof token !== "string") {
    throw new TypeError(
      `hashShareToken: expected string, got ${typeof token}`,
    );
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Update the root logger level at runtime.
 *
 * Used by the settings hot-reload system to apply ATLAS_LOG_LEVEL changes
 * in SaaS mode without a server restart. Pino propagates the level change
 * to all child loggers automatically.
 *
 * @returns true if the level was applied, false if the level is invalid.
 */
export function setLogLevel(level: string): boolean {
  if (!VALID_LOG_LEVELS.has(level)) return false;
  rootLogger.level = level;
  return true;
}
