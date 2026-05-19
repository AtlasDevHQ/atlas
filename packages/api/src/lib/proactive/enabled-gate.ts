/**
 * Proactive listener enabled-gate (#2616, slice 2c of #2607).
 *
 * Bridges the Effect-only `ProactiveGate` Tag (lives in
 * `lib/effect/services.ts`, fails closed with `EnterpriseError` when EE
 * isn't loaded) into the sync/promise callback shape the
 * `@useatlas/chat` proactive listener consumes from outside the Effect
 * runtime.
 *
 * The listener calls `config.isEnabled()` once at registration
 * (`listener.ts:267`) and then again on every channel message
 * (`listener.ts:329`, `:612`, ...), so the gate is on the hot path —
 * potentially several calls per second on busy workspaces.
 *
 * Two-tier resolution:
 *   1. **Enterprise check, cached per-closure.** `ProactiveGate.requireEnabled`
 *      reads `process.env.ATLAS_ENTERPRISE_ENABLED` plus the optional
 *      `enterprise.enabled` config flag (see
 *      `lib/effect/enterprise-layer.ts:isEnterpriseEnabledLocal`); both are
 *      resolved at boot and never flip without a restart. We yield the Tag
 *      ONCE per closure and cache the boolean — re-yielding on every
 *      message would pay an Effect runtime hop just to read a process-
 *      lifetime constant.
 *   2. **Workspace check, re-read every call.** Admins toggle
 *      `workspace_proactive_config.enabled` at runtime via
 *      `/admin/proactive-chat`; the kill-switch contract is that the next
 *      classified message must respect the new value. Cache would defeat
 *      that, so the SELECT runs on every call. The query hits the
 *      `workspace_id` primary key and is index-only — costs a small ms
 *      regardless.
 *
 * Failure modes — every failure path returns `false` (fail-closed) and
 * never throws into the SDK event loop:
 *   - EE not loaded     → `requireEnabled` fails with `EnterpriseError`;
 *                          caches `enterpriseEnabled = false`. No DB query
 *                          made on this call or any future call.
 *   - DB query throws   → catches, logs at `warn` with `{ workspaceId, err }`,
 *                          returns `false`. Enterprise cache untouched so a
 *                          transient DB blip doesn't permanently degrade.
 *   - Workspace row missing → SELECT returns 0 rows → treats as `enabled=false`.
 *
 * The factory captures a `ManagedRuntime` at boot (the host wiring slice
 * passes `getEnterpriseRuntime()` from `lib/effect/enterprise-layer.ts`),
 * so this module doesn't import `@atlas/ee` directly — the EE check flows
 * entirely through the `ProactiveGate` Tag, satisfying the
 * `core → ee` inversion rule from CLAUDE.md.
 *
 * @module
 */

import type { ManagedRuntime } from "effect";
import { Effect } from "effect";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { ProactiveGate } from "@atlas/api/lib/effect/services";

const log = createLogger("proactive:enabled-gate");

/**
 * Minimum runtime contract the factory needs. The host's
 * `getEnterpriseRuntime()` (from `lib/effect/enterprise-layer.ts`)
 * returns a `ManagedRuntime<EnterpriseSubsystem, never>` which satisfies
 * this — but we only require `ProactiveGate` in the requirements channel
 * so callers can pass a narrower test runtime that binds just the gate.
 */
export type ProactiveGateRuntime = ManagedRuntime.ManagedRuntime<
  ProactiveGate,
  never
>;

/**
 * Build a per-workspace `isEnabled` callback for the proactive listener.
 *
 * The returned closure satisfies the plugin-side `ProactiveGateFn`
 * (`() => Promise<boolean>` — see
 * `plugins/chat/src/proactive/types.ts`). Bind one per workspace at
 * plugin boot; the closure carries its own enterprise-result cache.
 *
 * Returns `true` iff BOTH:
 *   - Enterprise is loaded (Tag's `requireEnabled` doesn't fail with
 *     `EnterpriseError`); AND
 *   - The workspace has `workspace_proactive_config.enabled = true`.
 *
 * Never throws. Every failure → `false` + structured `log.warn`.
 */
export function createProactiveEnabledGate(
  runtime: ProactiveGateRuntime,
  workspaceId: string,
): () => Promise<boolean> {
  // Cached enterprise result. `undefined` ⇒ not yet checked; `true` /
  // `false` ⇒ resolved (and never re-resolved for the lifetime of this
  // closure). Self-hosted's `NoopProactiveGateLayer` makes this a one-
  // shot `false`; SaaS-EE makes it a one-shot `true`.
  let enterpriseEnabled: boolean | undefined = undefined;

  return async function isProactiveEnabled(): Promise<boolean> {
    // ── 1. Enterprise check (cached) ─────────────────────────────
    if (enterpriseEnabled === undefined) {
      const program = Effect.gen(function* () {
        const gate = yield* ProactiveGate;
        yield* gate.requireEnabled();
        return true;
      }).pipe(
        // Any failure in the E channel (EnterpriseError or otherwise)
        // → enterprise is unavailable. Log unexpected errors so a
        // misconfigured Tag is operator-visible; `EnterpriseError` is
        // the expected self-hosted path and stays silent.
        Effect.catchAll((err) => {
          const name =
            err instanceof Error ? err.name : String(err);
          if (name !== "EnterpriseError") {
            log.warn(
              {
                workspaceId,
                err: err instanceof Error ? err.message : String(err),
              },
              "Proactive enabled-gate: unexpected enterprise check failure — treating as disabled",
            );
          }
          return Effect.succeed(false);
        }),
      );

      try {
        enterpriseEnabled = await runtime.runPromise(program);
      } catch (err) {
        // ManagedRuntime defect path (Layer construction failure, etc.)
        // — log + cache `false`. The next call returns false without
        // a runtime hop.
        log.warn(
          {
            workspaceId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Proactive enabled-gate: enterprise runtime threw — treating as disabled",
        );
        enterpriseEnabled = false;
      }
    }

    if (!enterpriseEnabled) return false;

    // ── 2. Workspace check (re-read every call) ──────────────────
    try {
      const rows = await internalQuery<{ enabled: boolean }>(
        `SELECT enabled
           FROM workspace_proactive_config
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (rows.length === 0) return false;
      return rows[0]!.enabled === true;
    } catch (err) {
      log.warn(
        {
          workspaceId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Proactive enabled-gate: workspace_proactive_config read failed — treating as disabled",
      );
      return false;
    }
  };
}
