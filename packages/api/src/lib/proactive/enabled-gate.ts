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
 * **Registration-probe contract (post-#2620).** The chat plugin's
 * `registerProactiveListener` calls `config.isEnabled("")` once at boot
 * to answer "is the listener even possible in this process?" — there's
 * no tenant yet. An empty `workspaceId` argument is the agreed sentinel
 * for that probe: this gate returns the enterprise-cached value and
 * skips the workspace SELECT (which would otherwise resolve `false` on
 * a row-missing lookup with `$1 = ''` and silently mis-gate the
 * listener on SaaS where EE is enabled). Real per-event calls always
 * pass an actual workspaceId, so they run the SELECT as usual.
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
 *   2. **Workspace check, re-read every call (real workspaceIds only).**
 *      Admins toggle `workspace_proactive_config.enabled` at runtime via
 *      `/admin/proactive-chat`; the kill-switch contract is that the next
 *      classified message must respect the new value. Cache would defeat
 *      that, so the SELECT runs on every call. The query hits the
 *      `workspace_id` primary key and is index-only — costs a small ms
 *      regardless. The registration probe (empty `workspaceId`) skips
 *      this step.
 *
 * Failure modes — every failure path returns `false` (fail-closed) and
 * never throws into the SDK event loop:
 *   - EE not loaded     → `requireEnabled` fails with `EnterpriseError`;
 *                          caches `enterpriseEnabled = false`. No DB query
 *                          made on this call or any future call.
 *   - Runtime defect    → `runtime.runPromise` rejects with a non-
 *                          `EnterpriseError` throw (Layer construction
 *                          failure, transient init race, etc.). Logs +
 *                          fails the current call closed, but leaves
 *                          `enterpriseEnabled` as `undefined` so the next
 *                          call retries. Without this distinction a single
 *                          boot-time blip would gate the process for life.
 *   - DB query throws   → catches, logs at `warn` with `{ workspaceId, err, code }`
 *                          (the `pg` error code helps operators tell a DB
 *                          blip from a missing migration), returns `false`.
 *                          Enterprise cache untouched.
 *   - Workspace row missing → SELECT returns 0 rows → treats as `enabled=false`.
 *
 * **Transient-retry caveat — registration-only callers can wedge.** The
 * "leave `enterpriseEnabled` as `undefined` so the next call retries"
 * contract only helps callers that invoke the gate again. The proactive
 * listener (`plugins/chat/src/proactive/listener.ts:306`) calls
 * `isEnabled("")` once at registration and short-circuits to a no-op
 * handle (`recentAnswers: null`) if it returns falsy — no per-event
 * call ever fires, so a transient runtime defect at boot becomes
 * permanent for the process lifetime. The mitigation is at the call
 * site, not here: if the registration is load-bearing, wrap it in
 * exponential-backoff retry (e.g. 3 attempts at 1s / 5s / 30s) or call
 * `__reset()` on a periodic timer. The gate intentionally stays
 * single-attempt — adding retry here would couple the boot path to a
 * scheduler the gate doesn't own. Today the proactive listener is
 * best-effort (process keeps running, other bridge features unaffected)
 * so we accept the wedge; revisit if SaaS dogfood surfaces a
 * registration regression.
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
 * Minimum runtime contract the factory needs. The production caller is
 * `getEnterpriseRuntime()` from `lib/effect/enterprise-layer.ts`, which
 * returns a `ManagedRuntime<EnterpriseSubsystem, never>` that satisfies
 * this shape — but we only require `ProactiveGate` in the requirements
 * channel so callers can pass a narrower test runtime that binds just
 * the gate (see `__tests__/enabled-gate.test.ts:buildRuntime`).
 */
export type ProactiveGateRuntime = ManagedRuntime.ManagedRuntime<
  ProactiveGate,
  never
>;

/**
 * Per-call `isEnabled` callback returned by
 * `createProactiveEnabledGate`. Satisfies the plugin-side
 * `ProactiveGateFn` (`(workspaceId: string) => Promise<boolean>`); also
 * carries a test-only `__reset()` hook that clears the per-closure
 * enterprise cache.
 *
 * Post-#2620 multi-tenant refactor: the closure is bound ONCE per
 * process (was once per workspace pre-refactor) — the EE check is
 * still per-process-cacheable because the license doesn't flip without
 * a restart, but the workspace SELECT now reads the per-call
 * `workspaceId` argument and re-runs every call.
 *
 * If the EE roadmap adds runtime license activation, hook `__reset`
 * into the config-reload path so the gate doesn't stay closed against
 * the new license state.
 */
export type ProactiveEnabledGate = ((workspaceId: string) => Promise<boolean>) & {
  /** @internal Test-only: clears the per-closure enterprise cache. */
  __reset: () => void;
};

/**
 * Build the proactive listener's `isEnabled` callback.
 *
 * The returned closure satisfies the plugin-side `ProactiveGateFn`
 * (`(workspaceId: string) => Promise<boolean>` — see
 * `plugins/chat/src/proactive/types.ts`). Post-#2620 the factory takes
 * no `workspaceId` argument — `workspaceId` is per-call, so one closure
 * serves N tenants in the same process.
 *
 * Returns `true` iff BOTH:
 *   - Enterprise is loaded (Tag's `requireEnabled` doesn't fail with
 *     `EnterpriseError`); AND
 *   - The workspace has `workspace_proactive_config.enabled = true`.
 *
 * Never throws. Every failure → `false` + structured `log.warn`.
 *
 * Pre-#2620 the factory took `workspaceId` so the SELECT closed over
 * a constant; that's what made the listener single-tenant. The
 * enterprise-result cache stays per-closure (still a process-lifetime
 * constant — license flips require a restart); the workspace SELECT
 * re-runs per call reading the arg, same semantics as before.
 */
export function createProactiveEnabledGate(
  runtime: ProactiveGateRuntime,
): ProactiveEnabledGate {
  // Cached enterprise result. `undefined` ⇒ not yet checked; `true` /
  // `false` ⇒ resolved (and never re-resolved for the lifetime of this
  // closure). Self-hosted's `NoopProactiveGateLayer` makes this a one-
  // shot `false`; SaaS-EE makes it a one-shot `true`.
  let enterpriseEnabled: boolean | undefined = undefined;

  const isProactiveEnabled = async function (
    workspaceId: string,
  ): Promise<boolean> {
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
        // ManagedRuntime defect path (Layer construction failure,
        // transient init race, etc.). Distinguish:
        //   - `EnterpriseError` thrown out the runtime (shouldn't
        //     happen — `Effect.catchAll` above swallows it — but
        //     belt-and-suspenders): legitimately permanent, cache `false`.
        //   - Any other throw: transient by assumption. Leave
        //     `enterpriseEnabled` as `undefined` so the next call retries.
        //     Without this, a single boot-time blip would close the gate
        //     for the whole process lifetime.
        const isEnterpriseShape =
          err instanceof Error && err.name === "EnterpriseError";
        log.warn(
          {
            workspaceId,
            err: err instanceof Error ? err.message : String(err),
            retry: !isEnterpriseShape,
          },
          isEnterpriseShape
            ? "Proactive enabled-gate: enterprise runtime threw EnterpriseError — caching disabled"
            : "Proactive enabled-gate: enterprise runtime threw (transient) — will retry on next call",
        );
        if (isEnterpriseShape) {
          enterpriseEnabled = false;
        }
        // Transient: enterpriseEnabled stays `undefined`; fall through
        // to the early-return below so this call still fails closed.
        if (enterpriseEnabled === undefined) return false;
      }
    }

    if (!enterpriseEnabled) return false;

    // ── 1.5. Registration-probe short-circuit ────────────────────
    // The chat plugin's `registerProactiveListener` calls this gate
    // once at boot with `workspaceId = ""` to answer "is the listener
    // even possible in this process?" — there's no tenant yet. Skip
    // the workspace SELECT: with `$1 = ''` it returns 0 rows and
    // resolves to `false`, which would silently mis-gate the listener
    // on SaaS where EE is enabled. Real per-event calls always pass
    // an actual id and fall through to the SELECT.
    if (workspaceId === "") {
      return true;
    }

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
      // `pg` errors carry a `.code` (e.g. `57P01` admin shutdown,
      // `53300` too-many-connections, `42P01` undefined-table) — the
      // operator needs this to distinguish a DB blip from a missing
      // migration. Spread it onto the warn payload when present.
      const code =
        err instanceof Error && "code" in err
          ? { code: (err as { code: unknown }).code }
          : {};
      log.warn(
        {
          workspaceId,
          err: err instanceof Error ? err.message : String(err),
          ...code,
        },
        "Proactive enabled-gate: workspace_proactive_config read failed — treating as disabled",
      );
      return false;
    }
  } as ProactiveEnabledGate;

  // Per-process cache; if EE roadmap adds runtime license activation,
  // hook this `__reset` into the config-reload path so a license that
  // flips from disabled-at-boot to enabled-at-runtime doesn't stay
  // gated off for the whole process lifetime.
  isProactiveEnabled.__reset = () => {
    enterpriseEnabled = undefined;
  };

  return isProactiveEnabled;
}
