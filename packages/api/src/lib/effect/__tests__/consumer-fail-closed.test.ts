/**
 * Consumer-side fail-closed audit (#2593).
 *
 * The load-bearing enterprise call sites resolve their EE Tag through the
 * shared `yieldFailClosed` helper (`enterprise-layer.ts`), which
 * short-circuits with `EnterpriseUnavailableError` (→ HTTP 503
 * `enterprise_load_failed`) when `isEnterpriseEnabled() === true` but the
 * resolved service is still the no-op default (`available === false`) —
 * i.e. SaaS where the `@atlas/ee/layers` load failed.
 *
 * This test exercises the REAL `yieldFailClosed` (not a re-typed copy of
 * the guard) against test layers binding each Tag available/unavailable,
 * with `isEnterpriseEnabled` toggled via `ATLAS_ENTERPRISE_ENABLED`. It
 * locks the "EE-enabled + available=false → 503" contract for every Tag
 * the helper guards, so a future "simplify the Noop layer" or "drop the
 * discriminator field" PR can't silently regress the call sites.
 *
 * The ResidencyResolver site (`getRegionAwareConnection`) was retired in
 * ADR-0024 — region is a deploy-time constant, so there is no per-request
 * residency routing site left to fail closed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  MaskingPolicy,
  ApprovalGate,
  AuditRetention,
  type MaskingPolicyShape,
  type ApprovalGateShape,
  type AuditRetentionShape,
} from "../services";
import { EnterpriseUnavailableError } from "../errors";
import { yieldFailClosed } from "../enterprise-layer";

// "noop default" views of each Tag — mirror the shapes in `services.ts`
// `NoopXxxLayer` but constructed inline so the tests don't reach into
// module internals. Only the discriminator + the methods a consumer
// exercises are populated; other methods stay defensive `Effect.die` so
// a test that pulls in a new branch surfaces a loud failure. Each has an
// `available: true` twin (spread + override) for the "EE bound" case.

const noopMasking: MaskingPolicyShape = {
  available: false,
  applyMasking: (ctx) => Effect.succeed(ctx.rows),
  listPIIClassifications: () => Effect.succeed([]),
  updatePIIClassification: () => Effect.die("not stubbed"),
  deletePIIClassification: () => Effect.die("not stubbed"),
  invalidateClassificationCache: () => {},
};

const noopApproval: ApprovalGateShape = {
  available: false,
  checkApprovalRequired: () => Effect.succeed({ required: false, matchedRules: [] }),
  hasApprovedRequest: () => Effect.succeed(false),
  createApprovalRequest: () => Effect.die("not stubbed"),
  listApprovalRules: () => Effect.succeed([]),
  createApprovalRule: () => Effect.die("not stubbed"),
  updateApprovalRule: () => Effect.die("not stubbed"),
  deleteApprovalRule: () => Effect.die("not stubbed"),
  listApprovalRequests: () => Effect.succeed([]),
  getApprovalRequest: () => Effect.succeed(null),
  reviewApprovalRequest: () => Effect.die("not stubbed"),
  expireStaleRequests: () => Effect.succeed(0),
  getPendingCount: () => Effect.succeed(0),
};

const noopAuditRetention: AuditRetentionShape = {
  available: false,
  getRetentionPolicy: () => Effect.succeed(null),
  setRetentionPolicy: () => Effect.die("not stubbed"),
  purgeExpiredEntries: () => Effect.die("not stubbed"),
  hardDeleteExpired: () => Effect.die("not stubbed"),
  exportAuditLog: () => Effect.die("not stubbed"),
  getAdminActionRetentionPolicy: () => Effect.succeed(null),
  setAdminActionRetentionPolicy: () => Effect.die("not stubbed"),
  purgeAdminActionExpired: () => Effect.die("not stubbed"),
  anonymizeUserAdminActions: () => Effect.die("not stubbed"),
  previewAdminActionErasure: () => Effect.die("not stubbed"),
};

// ── Cases ────────────────────────────────────────────────────────────
//
// Each case runs the real `yieldFailClosed(tag, message)` against a test
// layer that binds the Tag to either its no-op default (`available:
// false`) or an "EE bound" twin (`available: true`). The runner inspects
// only the Exit (fail-closed vs pass-through) and the resolved service's
// `available` flag, so the return type widening to `{ available: boolean }`
// keeps the table uniform without per-case generics.

interface FailClosedCase {
  readonly name: string;
  // The Tag's runtime identifier — `yieldFailClosed` stamps `tag.key`
  // into the error's `tag` field, and the SaaS 503 correlates on it.
  readonly tagKey: string;
  readonly runProbe: (
    available: boolean,
  ) => Effect.Effect<{ readonly available: boolean }, EnterpriseUnavailableError, never>;
}

const cases: FailClosedCase[] = [
  {
    name: "MaskingPolicy",
    tagKey: "MaskingPolicy",
    runProbe: (available) =>
      yieldFailClosed(MaskingPolicy, "Masking unavailable").pipe(
        Effect.provide(
          Layer.succeed(MaskingPolicy, available ? { ...noopMasking, available: true } : noopMasking),
        ),
      ),
  },
  {
    name: "ApprovalGate",
    tagKey: "ApprovalGate",
    runProbe: (available) =>
      yieldFailClosed(ApprovalGate, "Approval unavailable").pipe(
        Effect.provide(
          Layer.succeed(ApprovalGate, available ? { ...noopApproval, available: true } : noopApproval),
        ),
      ),
  },
  {
    name: "AuditRetention",
    tagKey: "AuditRetention",
    runProbe: (available) =>
      yieldFailClosed(AuditRetention, "Audit retention unavailable").pipe(
        Effect.provide(
          Layer.succeed(
            AuditRetention,
            available ? { ...noopAuditRetention, available: true } : noopAuditRetention,
          ),
        ),
      ),
  },
];

describe("Consumer-side fail-closed via yieldFailClosed (#2593)", () => {
  let priorEnterprise: string | undefined;

  beforeEach(() => {
    priorEnterprise = process.env.ATLAS_ENTERPRISE_ENABLED;
  });

  afterEach(() => {
    if (priorEnterprise === undefined) {
      delete process.env.ATLAS_ENTERPRISE_ENABLED;
    } else {
      process.env.ATLAS_ENTERPRISE_ENABLED = priorEnterprise;
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("EE off (ATLAS_ENTERPRISE_ENABLED unset) + available=false — returns service (no fail-closed)", async () => {
        delete process.env.ATLAS_ENTERPRISE_ENABLED;
        const exit = await Effect.runPromiseExit(c.runProbe(false));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          // The no-op pass-through IS the expected self-hosted path.
          expect(exit.value.available).toBe(false);
        }
      });

      it("EE on (ATLAS_ENTERPRISE_ENABLED=true) + available=true — returns service", async () => {
        process.env.ATLAS_ENTERPRISE_ENABLED = "true";
        const exit = await Effect.runPromiseExit(c.runProbe(true));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.available).toBe(true);
        }
      });

      it("EE on (ATLAS_ENTERPRISE_ENABLED=true) + available=false — 503-shaped fail-closed", async () => {
        process.env.ATLAS_ENTERPRISE_ENABLED = "true";
        const exit = await Effect.runPromiseExit(c.runProbe(false));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failures = Array.from(Cause.failures(exit.cause));
          const err = failures[0];
          expect(err).toBeInstanceOf(EnterpriseUnavailableError);
          // The Tag identity is preserved in the structured error so SaaS
          // monitoring can correlate the 503 with the `enterprise.load_failed`
          // log from `ConditionalEELayer`.
          if (err instanceof EnterpriseUnavailableError) {
            expect(err.tag).toBe(c.tagKey);
            expect(err._tag).toBe("EnterpriseUnavailableError");
          }
        }
      });
    });
  }
});
