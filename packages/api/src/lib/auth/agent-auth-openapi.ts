/**
 * The OpenAPI → Agent-Auth capability adapter (#4410 / #2058, Slice 2).
 *
 * Slice 1 shipped ONE hand-written capability. Slice 2 replaces it with the
 * `@better-auth/agent-auth` OpenAPI adapter so every documented Atlas API
 * operation becomes an Agent-Auth capability — derived from the spec, with no
 * hand-maintained list and no drift.
 *
 * ── Containing the capability explosion ─────────────────────────────────────
 *
 * `createFromOpenAPI` turns EVERY operation (~460 across the Atlas spec) into a
 * capability, including every write and every operator/admin route. Exposing all
 * of that just because it is documented is the risk this slice must contain.
 * Three cooperating controls do so, all driven by ONE `isSensitiveOperation`
 * predicate (method + path), so the visibility filter and the hard block can
 * never diverge:
 *
 *   1. `defaultHostCapabilities` — the caps auto-granted to a newly created host.
 *      Limited to the SAFE set: a read-only method (`GET`/`HEAD`) or a curated
 *      {@link READ_SAFE_OPERATIONS} entry, AND not under a sensitive path prefix
 *      (`/api/v1/admin`, `/api/v1/platform`). NB: the
 *      adapter's own `defaultHostCapabilities: ["GET","HEAD"]` filters by method
 *      ONLY, so it would auto-grant admin GETs — we compute the path-aware safe
 *      set ourselves and override it.
 *
 *   2. `resolveCapabilities` — the discovery-time filter (`GET /capability/list`,
 *      `/capability/describe`). Hides every sensitive capability so an agent
 *      never even discovers a write/admin route to ask for. (Visibility only —
 *      the plugin resolves execute/grant against the base `capabilities` array
 *      and consults `resolveCapabilities` only as a fallback when a cap is
 *      ABSENT from that array, so it can never REMOVE a base cap from execution,
 *      which is why control 3 is also required.)
 *
 *   3. `blockedCapabilities` — the hard teeth. The plugin rejects any GRANT for a
 *      blocked capability (`validateCapabilityIds` → `CAPABILITY_BLOCKED`), and
 *      execution requires an active grant, so a sensitive route can never be
 *      granted OR executed even if an agent guesses its `operationId`. This is
 *      the every-non-read-safe-write-and-admin set.
 *
 * Net: the only reachable adapter-derived surface is read-only, non-admin,
 * per-org API operations — the `GET`/`HEAD` surface plus the curated
 * read-safe POST allowlist ({@link READ_SAFE_OPERATIONS}, #4707: query /
 * explore / metric run / validate-sql, each verified read-only at the engine)
 * — exactly the analyst-agent surface, and nothing that mutates
 * customer/analytics data or reads the operator console (residual `postQuery`
 * side-effect avenues are documented at {@link READ_SAFE_OPERATIONS}).
 *
 * ── Pure by construction ────────────────────────────────────────────────────
 *
 * This module is pure spec-in / options-out: no DB, no Better Auth import, no
 * `app`. The per-org token binding (`resolveHeaders`) and the in-process proxy
 * (`fetch`) are injected by `agent-auth-plugin.ts`, keeping the classification
 * logic here trivially unit-testable against a fixture spec.
 */

import { createFromOpenAPI } from "@better-auth/agent-auth/openapi";
import type { AgentAuthOptions, ApprovalStrength } from "@better-auth/agent-auth";
import type { AtlasOpenApiSpec } from "@atlas/api/lib/auth/atlas-openapi-source";

/** Read-only HTTP methods — safe on any non-admin path without further curation. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Curated read-safe POST operations (#4707) — the analyst read actions that
 * compute and return data without mutating customer/analytics data, admitted
 * into the capability surface alongside the `GET`/`HEAD` set. Every OTHER
 * write-method operation stays sensitive (hidden + hard-blocked) exactly as
 * before; this list is the ONLY exception, and each entry is admitted only
 * under a verified read-only execution guarantee at the engine:
 *
 * - `POST /api/v1/query` — runs the analyst agent to answer a question. SQL
 *   executes only through the shared SELECT-only pipeline in `lib/tools/sql.ts`
 *   (`validateSQL`: one AST parse, DML/DDL rejected, table whitelist; auto
 *   LIMIT + statement timeout applied at execution). Consciously accepted
 *   residual, shared with every other `/query` surface (SDK, MCP, Slack): the
 *   agent loop also reaches workspace-installed integration tools (the
 *   `sendEmail` / `createLinearIssue` actions plus the `querySalesforce` read,
 *   execute-time gated per workspace — no more power than the granting user's
 *   own API key) and best-effort persists the Q&A as a conversation record when
 *   an internal DB exists. The always-registered core tool surface is pinned
 *   by the tripwire in `agent-auth-read-safe-engine.test.ts` so it cannot
 *   grow silently; env-gated operator opt-ins (`executePython`, the
 *   ATLAS_ACTIONS_ENABLED action tools) sit outside that pin by design.
 * - `POST /api/v1/explore` — read-only sandboxed exploration of `semantic/`;
 *   read-only by backend isolation (ephemeral microVM / read-only mounts),
 *   never a write path.
 * - `POST /api/v1/metrics/{id}/run` — executes a canonical metric's
 *   authoritative SQL through the same SELECT-only pipeline
 *   (`runUserQueryPipeline` → `validateSQL`); no agent loop, no action tools.
 * - `POST /api/v1/validate-sql` — validates SQL against the same pipeline
 *   without ever executing it.
 *
 * `POST /api/v1/chat` is deliberately EXCLUDED: it is the full interactive
 * chat surface — a streaming run lifecycle with durable-session parking and
 * resume, plus the dashboards-owning tool registry — which is out of scope
 * for the analyst capability set; the read-analyst loop is fully served by
 * query/explore/metrics/validate. A curated constant is preferred over a spec
 * annotation so the whole exception set is auditable in one place; keyed by
 * `"<METHOD> <spec path template>"` to match the {@link OperationMeta}
 * recovered from the spec.
 */
export const READ_SAFE_OPERATION_KEYS = [
  "POST /api/v1/query",
  "POST /api/v1/explore",
  "POST /api/v1/metrics/{id}/run",
  "POST /api/v1/validate-sql",
] as const;

/** One allowlisted `"<METHOD> <path>"` key — lets consumers (e.g. the per-entry
 * engine-guarantee registry in `agent-auth-read-safe-engine.test.ts`) make
 * "every entry is accounted for" a compile-time property, not just a test. */
export type ReadSafeOperationKey = (typeof READ_SAFE_OPERATION_KEYS)[number];

export const READ_SAFE_OPERATIONS: ReadonlySet<string> = new Set(READ_SAFE_OPERATION_KEYS);

/**
 * Path prefixes whose operations are operator/admin surface and therefore
 * sensitive EVEN when read-only — the admin console + platform-ops routes expose
 * tenant config, audit, approvals, abuse controls, residency, etc. Matched on a
 * segment boundary (`=== prefix` or `startsWith(prefix + "/")`) so a sibling
 * like `/api/v1/administrators` (hypothetical) is not swept in by a raw prefix.
 */
export const SENSITIVE_PATH_PREFIXES = ["/api/v1/admin", "/api/v1/platform"] as const;

/** The HTTP method + path an `operationId` maps to, recovered from the spec. */
export interface OperationMeta {
  readonly method: string;
  readonly path: string;
}

/** OpenAPI path-item keys that are not HTTP operations. */
const NON_OPERATION_KEYS = new Set(["parameters", "servers", "summary", "description"]);

/**
 * Recover `operationId → { method, path }` from the spec. `createFromOpenAPI`
 * strips the HTTP method from the `Capability` objects it returns, so we index
 * the spec ourselves to classify each derived capability. Mirrors the adapter's
 * own operation walk (skip non-operation keys, require an `operationId`).
 */
export function buildOperationIndex(spec: AtlasOpenApiSpec): Map<string, OperationMeta> {
  const index = new Map<string, OperationMeta>();
  const paths = spec.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (NON_OPERATION_KEYS.has(method)) continue;
      const operationId =
        operation && typeof operation === "object"
          ? (operation as { operationId?: unknown }).operationId
          : undefined;
      if (typeof operationId !== "string" || operationId.length === 0) continue;
      index.set(operationId, { method: method.toUpperCase(), path });
    }
  }
  return index;
}

/** True when `path` sits under a sensitive (operator/admin) prefix. */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * True when `meta` is on the curated read-safe allowlist (#4707). Fails
 * CLOSED: no meta → not read-safe. The `allowlist` parameter exists so tests
 * can pin the unconditional admin/platform path block against a hypothetical
 * allowlist entry; production call sites never pass it.
 */
export function isReadSafeOperation(
  meta: OperationMeta | undefined,
  allowlist: ReadonlySet<string> = READ_SAFE_OPERATIONS,
): boolean {
  return meta !== undefined && allowlist.has(`${meta.method.toUpperCase()} ${meta.path}`);
}

/**
 * A capability is SENSITIVE (blocked + hidden) unless it is a read-only method
 * OR a curated read-safe operation ({@link READ_SAFE_OPERATIONS}, #4707), on a
 * non-admin path. The admin/platform path block is UNCONDITIONAL — it runs
 * before the allowlist, so even a hypothetically allowlisted operation under
 * `/api/v1/admin` or `/api/v1/platform` stays sensitive. Fails CLOSED: an
 * operation missing from the index (no recoverable method/path) is sensitive.
 */
export function isSensitiveOperation(
  meta: OperationMeta | undefined,
  readSafeAllowlist: ReadonlySet<string> = READ_SAFE_OPERATIONS,
): boolean {
  if (!meta) return true;
  if (isSensitivePath(meta.path)) return true;
  if (READ_ONLY_METHODS.has(meta.method.toUpperCase())) return false;
  return !isReadSafeOperation(meta, readSafeAllowlist);
}

/**
 * True when `meta` is a WRITE operation — a non-read-only method
 * (`POST`/`PUT`/`PATCH`/`DELETE`/…) that is NOT on the curated read-safe
 * allowlist. Distinct from {@link isSensitiveOperation}, which ALSO flags
 * admin/platform READS: step-up approval strength (#4413) keys off the
 * METHOD, so an admin GET is sensitive-but-not-a-write and keeps the session
 * default. A read-safe POST (#4707) is likewise NOT a write — it must report
 * `session` strength even under the enterprise `stepUpWrites` flag, because it
 * does not mutate; the read-only exemption is explicit, never inherited. A cap
 * with no recoverable method is NOT treated as a write — it is already blocked
 * by {@link isSensitiveOperation}, so its approval strength is moot; leaving
 * it at the default avoids over-claiming a strength it never exercises.
 * `readSafeAllowlist` mirrors {@link isSensitiveOperation}'s injectable
 * (test-only) parameter so both predicates default to the same allowlist;
 * production call sites never pass it.
 */
export function isWriteOperation(
  meta: OperationMeta | undefined,
  readSafeAllowlist: ReadonlySet<string> = READ_SAFE_OPERATIONS,
): boolean {
  return (
    meta !== undefined &&
    !READ_ONLY_METHODS.has(meta.method.toUpperCase()) &&
    !isReadSafeOperation(meta, readSafeAllowlist)
  );
}

/** The subset of `AgentAuthOptions` this adapter produces, spreadable into `agentAuth()`. */
export type AgentAuthOpenApiOptions = Pick<
  AgentAuthOptions,
  | "providerName"
  | "providerDescription"
  | "capabilities"
  | "onExecute"
  | "defaultHostCapabilities"
  | "resolveCapabilities"
  | "blockedCapabilities"
>;

/**
 * The proxy transport shape. Deliberately looser than `typeof globalThis.fetch`
 * (which, under Bun's lib types, additionally requires a `preconnect` method the
 * in-process `app.fetch` does not implement) — only the call signature matters.
 */
export type ProxyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Injected runtime seams — the per-org token binding and the in-process proxy transport. */
export interface AgentAuthOpenApiDeps {
  /** Base URL the proxy handler prefixes each operation path with. */
  readonly baseUrl: string;
  /** Forwards a real per-org access token as request headers (mints the `x-api-key`). */
  readonly resolveHeaders: NonNullable<Parameters<typeof createFromOpenAPI>[1]["resolveHeaders"]>;
  /** Transport for the proxied call — the in-process `app.fetch` in production, a stub in tests. */
  readonly fetch?: ProxyFetch;
  /**
   * When set, stamp this approval strength on every WRITE-method capability
   * ({@link isWriteOperation}). Enterprise (#4413) passes `"webauthn"` to require
   * a WebAuthn step-up (physical presence) before a write can be approved —
   * unbypassable by an autonomous agent with browser control. Core (AGPL) leaves
   * it unset so writes keep the library default (`"session"`). Read-only caps and
   * curated read-safe POSTs ({@link READ_SAFE_OPERATIONS}, #4707) are never
   * restamped — they stay at the session default (#4413: `GET → session`).
   * Orthogonal to the containment controls: mutating writes remain blocked from
   * the derived surface today, so this stamps the enforcement policy the caps
   * carry for when they become reachable.
   */
  readonly writeApprovalStrength?: ApprovalStrength;
}

/**
 * Build the capability set + proxy `onExecute` + the three containment controls
 * from the Atlas OpenAPI document. Spread the result into `agentAuth({ ... })`.
 */
export function buildAgentAuthOpenApiOptions(
  spec: AtlasOpenApiSpec,
  deps: AgentAuthOpenApiDeps,
): AgentAuthOpenApiOptions {
  const base = createFromOpenAPI(spec, {
    baseUrl: deps.baseUrl,
    resolveHeaders: deps.resolveHeaders,
    // The adapter only ever calls `fetch(url, opts)`; the cast bridges the
    // `preconnect`-less proxy transport to its `typeof globalThis.fetch` slot.
    ...(deps.fetch ? { fetch: deps.fetch as unknown as typeof globalThis.fetch } : {}),
  });

  const index = buildOperationIndex(spec);
  const baseCapabilities = base.capabilities ?? [];

  const safeNames: string[] = [];
  const sensitiveNames = new Set<string>();
  for (const cap of baseCapabilities) {
    if (isSensitiveOperation(index.get(cap.name))) sensitiveNames.add(cap.name);
    else safeNames.push(cap.name);
  }

  // Stamp step-up strength on mutating-write capabilities when requested
  // (#4413, enterprise). Reads and read-safe POSTs (#4707) are left untouched
  // so they keep the library default ("session"). No-op passthrough when
  // `writeApprovalStrength` is unset (core).
  // Hoisted to a `const` local: TS PRESERVES the truthy-branch narrowing of a
  // `const` (`ApprovalStrength | undefined` → `ApprovalStrength`) into the nested
  // `.map` closure, but DROPS narrowing of a property access
  // (`deps.writeApprovalStrength`) at the closure boundary. The hoist therefore
  // gives the closure a provably-`ApprovalStrength` value rather than relying on
  // `Capability.approvalStrength` being optional to swallow a stray `undefined`.
  const writeStrength = deps.writeApprovalStrength;
  const capabilities = writeStrength
    ? baseCapabilities.map((cap) =>
        isWriteOperation(index.get(cap.name)) ? { ...cap, approvalStrength: writeStrength } : cap,
      )
    : baseCapabilities;

  return {
    ...base,
    // Capabilities carrying the step-up strength stamp (#4413) — overrides the
    // adapter's un-stamped set. Names/inputs are otherwise identical to `base`.
    capabilities,
    // Auto-grant only the non-sensitive surface (control 1): read-only +
    // read-safe, non-admin. Overrides the adapter's method-only default, which
    // would auto-grant admin GETs.
    defaultHostCapabilities: safeNames,
    // Hide sensitive caps from discovery (control 2).
    resolveCapabilities: ({ capabilities: caps }) => caps.filter((c) => !sensitiveNames.has(c.name)),
    // Hard-block grant/execute for sensitive caps (control 3).
    blockedCapabilities: [...sensitiveNames],
  };
}
