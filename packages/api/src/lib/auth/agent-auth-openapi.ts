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
 *      Limited to the SAFE set: read-only methods (`GET`/`HEAD`) AND not under a
 *      sensitive path prefix (`/api/v1/admin`, `/api/v1/platform`). NB: the
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
 *      the every-write-and-admin set.
 *
 * Net: the only reachable adapter-derived surface is read-only, non-admin,
 * per-org API operations — exactly the analyst-agent surface, and nothing that
 * mutates state or reads the operator console.
 *
 * ── Pure by construction ────────────────────────────────────────────────────
 *
 * This module is pure spec-in / options-out: no DB, no Better Auth import, no
 * `app`. The per-org token binding (`resolveHeaders`) and the in-process proxy
 * (`fetch`) are injected by `agent-auth-plugin.ts`, keeping the classification
 * logic here trivially unit-testable against a fixture spec.
 */

import { createFromOpenAPI } from "@better-auth/agent-auth/openapi";
import type { AgentAuthOptions } from "@better-auth/agent-auth";
import type { AtlasOpenApiSpec } from "@atlas/api/lib/auth/atlas-openapi-source";

/** Read-only HTTP methods — the only ones a derived capability may be safe on. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

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
 * A capability is SENSITIVE (blocked + hidden) unless it is a read-only method
 * on a non-admin path. Fails CLOSED: an operation missing from the index (no
 * recoverable method/path) is treated as sensitive.
 */
export function isSensitiveOperation(meta: OperationMeta | undefined): boolean {
  if (!meta) return true;
  if (!READ_ONLY_METHODS.has(meta.method.toUpperCase())) return true;
  return isSensitivePath(meta.path);
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
  const capabilities = base.capabilities ?? [];

  const safeNames: string[] = [];
  const sensitiveNames = new Set<string>();
  for (const cap of capabilities) {
    if (isSensitiveOperation(index.get(cap.name))) sensitiveNames.add(cap.name);
    else safeNames.push(cap.name);
  }

  return {
    ...base,
    // Auto-grant only the read-only, non-admin surface (control 1). Overrides
    // the adapter's method-only default, which would auto-grant admin GETs.
    defaultHostCapabilities: safeNames,
    // Hide sensitive caps from discovery (control 2).
    resolveCapabilities: ({ capabilities: caps }) => caps.filter((c) => !sensitiveNames.has(c.name)),
    // Hard-block grant/execute for sensitive caps (control 3).
    blockedCapabilities: [...sensitiveNames],
  };
}
