/**
 * A tiny registry that hands the agent-auth plugin the Atlas API's own OpenAPI
 * document at plugin-build time WITHOUT a static import cycle (#4410 / #2058,
 * Slice 2).
 *
 * ── Why a registry, not a disk read ─────────────────────────────────────────
 *
 * Slice 2 derives one Agent-Auth capability per `operationId` from the Atlas API
 * spec (`createFromOpenAPI`). The issue points at `apps/docs/openapi.json` as
 * "the auto-generated source of truth" — but that file is a BUILD artifact that
 * is NOT copied into the runtime API image (see `deploy/api/Dockerfile`, which
 * copies `packages/api` but not `apps/docs/openapi.json`). Reading it from disk
 * at runtime would fail-closed to zero capabilities in the deployed SaaS API.
 *
 * The spec `apps/docs/openapi.json` is itself produced by fetching
 * `GET /api/v1/openapi.json` from the live app (`scripts/extract-openapi.ts`).
 * So the equivalent, always-present source is to generate the merged document
 * IN-PROCESS from the same route definitions — which is exactly what the
 * `/api/v1/openapi.json` handler already does. That handler lives on the `app`
 * instance in `api/index.ts`; `agent-auth-plugin.ts` cannot statically import
 * `app` (that module builds the app and mounts the auth handler, so the import
 * would be circular). This registry inverts the dependency: `api/index.ts`
 * REGISTERS a thunk that builds the document, and the plugin READS it.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 *
 * `getAuthInstance()` (which calls `buildAgentAuthPlugin()`) is lazy — it first
 * runs on a request, by which time `api/index.ts` has fully evaluated and
 * registered the source. The thunk is invoked at most once and memoized, so the
 * ~2.5 MB document is generated a single time on first agent-auth plugin build,
 * never eagerly at boot (agent-auth is experimental / default-off).
 *
 * FAIL SOFT, LOUD: in a process that never imported `api/index.ts` (a CLI, the
 * MCP package, a unit test that builds the auth instance in isolation) no source
 * is registered, so `getAtlasOpenApiSpec()` returns `null` and the plugin
 * advertises zero capabilities. That is safe — the surface is default-off and
 * request-gated — but it is logged so a genuinely missing registration in the
 * real API process is visible rather than silent.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { createFromOpenAPI } from "@better-auth/agent-auth/openapi";

const log = createLogger("auth:atlas-openapi-source");

/**
 * The OpenAPI 3.x document shape `createFromOpenAPI` consumes. Derived from its
 * parameter type so a `@better-auth/agent-auth` bump that reshapes the accepted
 * spec surfaces here as a type error rather than at runtime. (`@better-auth/
 * agent-auth/openapi` does not export the `OpenAPISpec` interface itself.)
 */
export type AtlasOpenApiSpec = Parameters<typeof createFromOpenAPI>[0];

let source: (() => AtlasOpenApiSpec) | null = null;
let cached: AtlasOpenApiSpec | null = null;

/**
 * Register the thunk that builds the in-process Atlas OpenAPI document. Called
 * once from `api/index.ts` after the app + routes are defined. Registering
 * clears any memoized document so a re-registration (only tests do this) is
 * honored.
 */
export function registerAtlasOpenApiSource(fn: () => AtlasOpenApiSpec): void {
  source = fn;
  cached = null;
}

/**
 * The registered Atlas OpenAPI document, generated once and memoized. Returns
 * `null` when no source is registered or when generation throws — the plugin
 * treats that as "zero capabilities", keeping the (default-off) surface inert
 * rather than crashing the auth-instance build.
 */
export function getAtlasOpenApiSpec(): AtlasOpenApiSpec | null {
  if (cached) return cached;
  if (!source) {
    log.warn(
      "No Atlas OpenAPI source registered — agent-auth will advertise zero capabilities. " +
        "Expected in non-API processes (CLI/MCP/isolated tests); a warning here in the API process means api/index.ts did not register the source.",
    );
    return null;
  }
  try {
    cached = source();
    return cached;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Atlas OpenAPI source threw while building the spec — agent-auth will advertise zero capabilities",
    );
    return null;
  }
}

/** @internal test-only — reset the registry so a suite starts from a clean slate. */
export function __resetAtlasOpenApiSourceForTest(): void {
  source = null;
  cached = null;
}
