/**
 * Per-request live-actor ALS for hosted MCP (#3569).
 *
 * Gate 3 of the MCP dispatch pipeline enforces RBAC by reading the actor's
 * role from the dispatch-gate context. For EXISTING sessions the gate context
 * is built from the actor captured at session-creation time — a demoted admin
 * would retain admin tools for the life of the session.
 *
 * The fix threads the freshly-resolved actor (from `bindFactoryContext`,
 * which issues a LIVE DB lookup per request) through a SEPARATE
 * AsyncLocalStorage key so that gate-3 can read the current role WITHOUT
 * being overwritten by the nested `withRequestContext` calls in tool
 * dispatch bodies (those replace the api-layer ALS, not this one).
 *
 * Usage:
 *   - `hosted.ts` calls `withLiveActor(factoryCtx.user, () => transport.handleRequest(req))`
 *     before every dispatch so the store is populated for the duration of the
 *     tool call chain.
 *   - `dispatch-gate.ts` gate-3 calls `getLiveActor()` and uses it instead of
 *     `ctx.actor` when present, giving demotion-immediate enforcement.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const store = new AsyncLocalStorage<AtlasUser>();

/**
 * Run `fn` with `actor` as the live per-request actor available via
 * {@link getLiveActor}. Nested tool-dispatch contexts do not override this
 * store, so the live role is visible throughout the entire tool call chain.
 */
export function withLiveActor<T>(actor: AtlasUser, fn: () => T): T {
  return store.run(actor, fn);
}

/**
 * Read the live per-request actor set by {@link withLiveActor}. Returns
 * `undefined` outside of a hosted MCP request (stdio, tests that don't set
 * the store, etc.).
 */
export function getLiveActor(): AtlasUser | undefined {
  return store.getStore();
}
