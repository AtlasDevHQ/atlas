/**
 * A tiny registry handing the agent-auth OpenAPI proxy an in-process transport
 * to the Atlas API — `app.fetch`, no network socket (#4410).
 *
 * The adapter's `onExecute` forwards each derived operation THROUGH the real
 * Atlas app so the normal middleware stack (auth, org scoping, RLS, rate limits,
 * the handler) runs exactly as for any client. That transport is `app.fetch`,
 * and `app` lives in `api/index.ts`. A `lib/` module must not import the `api/`
 * layer (CLAUDE.md — it pulls the app graph into every consumer and breaks
 * partial `mock.module()` mocks), so we invert the dependency exactly like
 * `atlas-openapi-source.ts`: `api/index.ts` REGISTERS the transport, and the
 * plugin READS it. Registration happens at module-eval of `api/index.ts` (a
 * one-line thunk, no cost), before any request can reach the lazy auth instance.
 *
 * `null` when unregistered (a non-API process): the plugin surfaces a clean
 * failure instead of executing — a process that never built the app has no
 * in-process API to proxy to.
 */

import type { ProxyFetch } from "@atlas/api/lib/auth/agent-auth-openapi";

let transport: ProxyFetch | null = null;

/** Register the in-process `app.fetch` transport. Called once from `api/index.ts`. */
export function registerInProcessApiFetch(fn: ProxyFetch): void {
  transport = fn;
}

/** The registered in-process API transport, or `null` if none was registered. */
export function getInProcessApiFetch(): ProxyFetch | null {
  return transport;
}

/** @internal test-only — reset the registry. */
export function __resetInProcessApiFetchForTest(): void {
  transport = null;
}
