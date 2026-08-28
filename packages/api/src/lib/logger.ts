/**
 * Structured logger with request context propagation.
 *
 * - JSON output in production, pino-pretty in development
 * - Pino mixin + AsyncLocalStorage binds requestId to all log lines within a request
 * - Redaction paths prevent secrets from leaking into logs
 * - ATLAS_LOG_LEVEL env var controls verbosity (default: "info")
 * - ATLAS_LOG_STDERR=1 pins the destination to fd 2; see `logToStderr` below
 *   for why the default (fd 1) must stay the default
 */

import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "node:crypto";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { diagnosticValue } from "@atlas/api/lib/audit/diagnostic-scrub";

// --- Request context ---

/**
 * Discriminator on who initiated the request, threaded through audit_log
 * via #2067. The kinds are wired (#3615): web chat / `/api/v1/query`
 * stamp `human`, the scheduler stamps `scheduler`, the MCP dispatchers stamp
 * `mcp`, and `logQueryAudit` defaults any agent-loop SQL with no more-specific
 * actor to `agent` (the only `executeSQL` writer is the agent loop). Rows are
 * therefore never NULL for actor-scoped filters.
 *
 * `api_key` (#4046 / ADR-0027 §6) marks an UNATTENDED workspace-scoped API key
 * (Better Auth `apiKey()`) — distinct from `human`, which is a person who
 * approved a device-flow `atlas login`. The transport (`origin`) for both is
 * still `cli`; `actor_kind` is the *who*, so incident response can tell a
 * leaked CI key from a compromised human session. An API key is delegated human
 * access — it resolves to its real owning member's `userId`, never an anonymous
 * principal (the legacy god-key's `api-key-${hash}` synthetic identity is the
 * opposite, and lives on the separate `simple-key` auth path, not here).
 *
 * Modeled as a discriminated union so `clientId` / `toolName` are only
 * reachable on the `mcp` branch — the type system enforces the
 * "client_id only for mcp" invariant the migration's column shape
 * implies, and `audit.ts` can stamp the columns without per-field
 * truthy guards.
 */
export const ACTOR_KINDS = ["human", "agent", "mcp", "scheduler", "api_key"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type RequestActor =
  | { kind: "human" | "agent" | "scheduler" | "api_key" }
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
  /**
   * #3895 (ADR-0022) — per-conversation Group reach. The chat route stamps this
   * from the resolved conversation row (or the per-turn body override) so the
   * reach resolver in `executeSQL` (and the Source-catalog builder) bounds which
   * Connection groups the agent may query. `null` / undefined here = All sources
   * (every visible group reachable, the default); a `connection_group_id` value
   * = Focus → that group (hard/exclusive — only it is reachable, any other group
   * target is rejected). Stamped only when truthy, so the legacy "all" shape is
   * unchanged for non-focused conversations. Independent of `routingMode`
   * (intra-group) and the REST-scope fields (a separate axis).
   */
  groupReach?: string | null;
  /**
   * #5495 — whether THIS request's chat surface can render the
   * confirm-before-write banner (`rest-write-confirm-card.tsx`). Gates the WRITE
   * half of `executeRestOperation`: a staged write returns `needs_confirmation`
   * and goes nowhere unless the surface can POST
   * `/api/v1/rest-operations/confirm` on the user's behalf.
   *
   * Stamped by the chat route from the `x-atlas-write-confirm-ui` request
   * header, because this is the one capability the registry-build signal cannot
   * express: `packages/web` and the embeddable `@useatlas/react` widget POST the
   * SAME `/api/v1/chat` with the same auth and the same `defaultRegistry`, so
   * `dashboardUrlResolver` — which separates `createDashboard` / `correct_fact`
   * (#4566, #4915) — does not separate these two.
   *
   * **Undefined / false is the closed state**, and that is what makes the fix
   * reach consumers already on npm: every published `@useatlas/react` version
   * sends no such header, so it is correct without upgrading. A surface earns
   * writes by declaring it can finish them.
   *
   * Not a security control — see the note on the chat route's read of it.
   */
  restWriteConfirmationUi?: boolean;
  /**
   * #5486 — the conversation this turn belongs to, stamped by the chat route's
   * agent frames (initial turn and resume alike). Read by the `proposeFact`
   * staging tool so a confirmed proposal can name its originating session: the
   * session then materializes lazily as the fact's tier-3 source episode and
   * seeds its grant (ADR-0036 §T9 lock 3). Identity only — no consumer reads
   * conversation CONTENT through this field. Undefined on surfaces with no
   * conversation (MCP / scheduler / direct tool tests), which fall back to the
   * session-less proposal shape.
   */
  conversationId?: string;
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

// `bun test` sets NODE_ENV="test". That is NOT production, so before #2802 it
// took the `pino-pretty` branch below — and pino-pretty runs its transport in a
// `thread-stream` WORKER THREAD.
//
// ⚠️ That worker is why `bun test --parallel` could not be adopted, and the
// failure mode is worse than a red suite: when bun tears down a --parallel
// worker process, the logger's thread dies with `error: the worker thread
// exited`, which kills the process mid-run. MEASURED on `--parallel=8
// src/api/`: 1090 tests ran, 28 failed, 169 errors — and bun still exited
// reporting a tidy "Ran 1090 tests across 183 files" when 183 files actually
// hold 4818 tests. 3728 tests SILENTLY DID NOT RUN. With the worker gone:
// 4818 ran, 0 errors, ~10s.
//
// So test runs take the plain-JSON branch. This is not a behaviour change any
// assertion can see — nothing asserts on pretty-printing — and it deliberately
// does NOT reach for NODE_ENV="production", which would flip real app switches
// (e.g. scheduled-tasks.ts requires a tick secret under production, which is
// exactly the dev-path test that would then fail).
const isTest = process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV !== "production" && !isTest;

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
 * Driver diagnostic fields carried through the `Error` branch of
 * {@link scrubErrSerializer} (#4941).
 *
 * The serializer rebuilds an `Error` as `{ type, message, stack }` from `name`
 * / `message` / `stack`, then adds only the fields named here, read as own
 * non-accessor values. `cause` and every other driver field — `detail`,
 * `where`, `internalQuery`, `table` — are dropped. `code` and `constraint`
 * are what separate
 * "the write failed" from "WHICH invariant rejected the write" — `23505` a
 * unique violation, `23503` a foreign key, `42P01` a missing relation, `53300`
 * pool exhaustion — and without them a pg error in the log is materially less
 * actionable than the raw driver error was. `code` is also carried by Node
 * system errors (`ENOENT`) and most SDKs, so this is not pg-only.
 *
 * NOT extended to pg's other diagnostic fields, and that is the disclosure
 * line: `detail` echoes ROW VALUES (`Key (email)=(a@b.com) already exists`),
 * and `where`/`internalQuery` echo statement text. Those are user data. `code`
 * is a fixed SQLSTATE; `constraint` is a schema identifier — from this repo's
 * migrations, a plugin's, or the customer's own analytics schema, since this is
 * the GLOBAL `err` serializer and datasource errors pass through it too. None
 * of those is derived from a request, a credential, or a row value.
 *
 * Spread BEFORE `type` / `message` / `stack` at the call site, so a future
 * addition here can never clobber a scrubbed core field — and could only do so
 * for short values, which is the kind of intermittent corruption nobody spots.
 */
const ERROR_DIAGNOSTIC_FIELDS = ["code", "constraint"] as const;

type ErrorDiagnosticField = (typeof ERROR_DIAGNOSTIC_FIELDS)[number];

/**
 * Lift the whitelisted diagnostic fields off an error.
 *
 * Value normalization — number coercion, the length bound, the oversized
 * sentinel, the scrub — is `diagnosticValue` in `lib/audit/diagnostic-scrub.ts`,
 * shared with `brain/correction.ts`'s parallel top-level lift so one policy
 * governs both doors onto the same log line. What is local to here is the READ:
 *
 * Values are read as OWN, non-accessor properties (`getOwnPropertyDescriptor`,
 * never a plain index) and the whole loop has its own `catch`. Without both, a
 * hostile or half-initialized getter on `code` — or a Proxy trapping the
 * descriptor lookup — would land in `scrubErrSerializer`'s outer catch and
 * collapse the entire serialized error to `"[log scrub failed]"`, costing the
 * operator the type, message and stack it used to get for free. Each defense
 * has its own test because either alone leaves the other's mutation alive.
 *
 * On that trap path the fields are simply ABSENT — no sentinel, unlike the
 * over-length case. Deliberate: a sentinel would have to be a key outside
 * {@link ERROR_DIAGNOSTIC_FIELDS}, and the exact-key assertion in
 * `logger.test.ts` ("only these ever appear on a serialized error") is a
 * stronger property to keep than a marker for a case no real driver produces.
 * The prototype-accessor `code` some SDK classes expose is dropped the same
 * way, and for the same reason.
 */
function errorDiagnostics(err: Error): Partial<Record<ErrorDiagnosticField, string>> {
  const out: Partial<Record<ErrorDiagnosticField, string>> = {};
  try {
    for (const field of ERROR_DIAGNOSTIC_FIELDS) {
      const value = diagnosticValue(Object.getOwnPropertyDescriptor(err, field)?.value as unknown);
      if (value !== undefined) out[field] = value;
    }
  } catch (err_) {
    // intentionally ignored: a thrower whose diagnostic property is a trap must
    // not cost the caller the error's type/message/stack. `err_` is unusable
    // here — logging it would re-enter this serializer.
    void err_;
  }
  return out;
}

/**
 * Pino `serializers.err` handler. Funnels every error-shaped value through
 * `errorMessage()` so a driver-echoed connection string (`postgres://u:p@h/db`)
 * gets its userinfo stripped before the line reaches Loki / Railway / Datadog.
 *
 * Accepts:
 *   - Error instance → `{ type, message, stack }` with scrubbed message +
 *     stack, plus any {@link ERROR_DIAGNOSTIC_FIELDS} the error carries as a
 *     non-empty own value (coerced from a number; replaced by a sentinel when
 *     over-length — see {@link errorDiagnostics}). Note the whitelist guards
 *     this branch only: a PRE-SERIALIZED error-shape object (below) is passed
 *     through field-for-field. No live producer does that — pg's
 *     `DatabaseError` extends `Error`, so a real pg rejection always takes THIS
 *     branch — but a future one logging a raw pg object would carry `detail`
 *     straight through, which is the limit `logger.test.ts`'s
 *     pre-serialized-object test pins
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
        // Diagnostics FIRST — see ERROR_DIAGNOSTIC_FIELDS. A future whitelist
        // entry named `message`/`stack`/`type` must lose to the scrubbed core
        // fields, not overwrite them.
        ...errorDiagnostics(value),
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

// `satisfies`, not an annotation: an annotation erases the options' own generic
// (`LoggerOptions<CustomLevels>` collapses to `LoggerOptions<never, boolean>`),
// so a future `customLevels` would still typecheck here and fail at every call
// site of the returned logger instead. `satisfies` keeps both the inference and
// the excess-property check.
const rootLoggerOptions = {
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
} satisfies pino.LoggerOptions;

/**
 * Pin the root logger to fd 2 (stderr) instead of fd 1 (stdout).
 *
 * ⚠️ OFF BY DEFAULT, AND THE DEFAULT IS THE LOAD-BEARING PART. Structured logs
 * on **stdout** is the twelve-factor convention this app's deployments rely on
 * — Railway reads fd 1 — so the destination is not something to "fix" globally.
 * This switch exists for a process whose stdout is a MACHINE channel rather
 * than a diagnostic one: `atlas canonical-eval --json` pipes stdout into
 * `eval-mcp-llm-output.json`, and one pretty-printed frame there makes the
 * artifact unparseable (#5126). `packages/mcp/src/logger.ts` has the same shape
 * permanently (JSON-RPC owns stdout on the stdio transport) and pins fd 2
 * unconditionally; this is the opt-in form, for a process that is only
 * SOMETIMES in that shape.
 *
 * ⚠️ IT MUST BE SET BEFORE THIS MODULE IS FIRST IMPORTED, and there is no
 * runtime substitute. `rootLogger` is a module-scope `const`, pino resolves its
 * destination once at construction, and in the dev branch that destination
 * belongs to a `pino-pretty` WORKER THREAD with its own fds — so a later
 * `process.env` assignment changes nothing on either branch. The CLI stamps it
 * from `packages/cli/bin/eval-log-destination.ts`, which is `bin/atlas.ts`'s
 * first import for exactly this reason.
 *
 * Deliberately NOT in `SAAS_ENV_KEYS`: it is a per-process CLI knob, not part
 * of the SaaS boot contract, and no deployment should ever set it.
 */
const logToStderr = process.env.ATLAS_LOG_STDERR === "1";

function buildRootLogger(): pino.Logger {
  if (isDev) {
    return pino({
      ...rootLoggerOptions,
      transport: {
        target: "pino-pretty",
        // `destination` is pino-pretty's OWN option, read inside the transport
        // worker. Spreading `false` is a no-op, so with the switch off this
        // object is byte-identical to what shipped before #5126.
        options: { colorize: true, ...(logToStderr && { destination: 2 }) },
      },
    });
  }
  if (logToStderr) {
    // `sync: true` for the same reason `packages/mcp/src/logger.ts` uses it: a
    // short-lived CLI process may `process.exit` before an async buffer
    // flushes, and a diagnostic that never lands is worse than a slow one.
    //
    // ⚠️ IT COVERS THIS BRANCH ONLY, AND NOT THE ONE THE EVAL RUNS ON. The eval
    // runs with `NODE_ENV` unset (#5121), so `isDev` is true and it takes the
    // `pino-pretty` transport above — a worker thread with no equivalent flush
    // guarantee, whose queued frames `process.exit` can still drop. That is
    // accepted rather than solved: on that path the log frames are a secondary
    // diagnostic, and the record that matters is the fd-2 human transcript,
    // which `canonical-eval-run.ts` writes with blocking syscalls.
    return pino(rootLoggerOptions, pino.destination({ dest: 2, sync: true }));
  }
  return pino(rootLoggerOptions);
}

const rootLogger = buildRootLogger();

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
