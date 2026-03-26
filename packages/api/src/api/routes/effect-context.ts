/**
 * Shared helper to bridge Hono request context into Effect Context layers.
 *
 * Provides RequestContext + AuthContext from the Hono `c.get()` values set
 * by middleware (standardAuth, adminAuth, withRequestId). Used by route
 * handlers that call `runEffect` with `Effect.gen` programs.
 *
 * @example
 * ```ts
 * import { honoContextLayer } from "./effect-context";
 *
 * const result = await runEffect(c, Effect.gen(function* () {
 *   const { requestId } = yield* RequestContext;
 *   const { orgId } = yield* AuthContext;
 *   // ...
 * }).pipe(Effect.provide(honoContextLayer(c))), { label: "do work" });
 * ```
 */

import { Layer } from "effect";
import type { Context } from "hono";
import {
  type RequestContext,
  type AuthContext,
  makeRequestContextLayer,
  makeAuthContextLayer,
} from "@atlas/api/lib/effect/services";
import type { AuthMode, AtlasUser } from "@useatlas/types/auth";

/**
 * Build a merged Layer that provides RequestContext + AuthContext
 * from the Hono request context variables.
 *
 * Reads `requestId` and `authResult` from `c.get()` (set by middleware).
 * If no `authResult` is set (e.g. public routes before auth middleware),
 * provides a fallback AuthContext with mode "none".
 */
export function honoContextLayer(
  c: Context,
): Layer.Layer<RequestContext | AuthContext> {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const requestLayer = makeRequestContextLayer(requestId);

  const authResult = c.get("authResult") as
    | { authenticated: true; mode: string; user?: { activeOrganizationId?: string } & Record<string, unknown> }
    | undefined;

  if (authResult) {
    const authLayer = makeAuthContextLayer(
      authResult.mode as AuthMode,
      authResult.user as AtlasUser | undefined,
    );
    return Layer.merge(requestLayer, authLayer);
  }

  const noAuthLayer = makeAuthContextLayer("none" as AuthMode, undefined);
  return Layer.merge(requestLayer, noAuthLayer);
}
