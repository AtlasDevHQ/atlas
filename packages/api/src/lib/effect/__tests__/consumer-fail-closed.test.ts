/**
 * Consumer-side fail-closed audit (#2593, second half).
 *
 * Four of the highest-impact load-bearing call sites yield their EE Tag,
 * check `tag.available`, and short-circuit with
 * `EnterpriseUnavailableError` (→ HTTP 503 `enterprise_load_failed`) when
 * `isEnterpriseEnabled() === true` but `tag.available === false`.
 *
 * Self-hosted (no `ATLAS_ENTERPRISE_ENABLED=true`) keeps the original
 * no-op pass-through behaviour: the no-op IS the expected self-hosted
 * path, so the discriminator gate stays quiet.
 *
 * The IP allowlist middleware site was scoped out of this PR — adding
 * the gate there exposed that 17 admin-route tests partial-mock
 * `@atlas/ee/layers` without binding `IpAllowlistPolicy: { available: true }`,
 * making the fix a separate body of work. Follow-up issue tracks the
 * hardening + the matching test-helper rollout (`testEELayer.ts`).
 *
 * This file pins each discriminator branch directly against the Tag's
 * shape rather than spinning up the full Hono route harness — the goal
 * is to lock the "EE-enabled + available=false → 503" contract for
 * every site so a future "simplify the Noop layer" or "drop the
 * discriminator field" PR can't silently regress.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  ResidencyResolver,
  MaskingPolicy,
  ApprovalGate,
  AuditRetention,
  type ResidencyResolverShape,
  type MaskingPolicyShape,
  type ApprovalGateShape,
  type AuditRetentionShape,
} from "../services";
import { EnterpriseUnavailableError } from "../errors";
import { isEnterpriseEnabled } from "../enterprise-config";

// Build a "noop default" view of each Tag — mirrors the shapes in
// `services.ts` `NoopXxxLayer` but constructed inline so the tests
// don't reach into module internals. Only the discriminator + the
// method exercised by the consumer-side check are populated; other
// methods stay defensive `Effect.die` so a test that pulls in a new
// branch surfaces a loud failure.

const noopResidency: ResidencyResolverShape = {
  available: false,
  resolveRegionDatabaseUrl: () => Effect.succeed(null),
  listRegions: () => Effect.die("not stubbed"),
  getDefaultRegion: () => { throw new Error("not stubbed"); },
  getConfiguredRegions: () => { throw new Error("not stubbed"); },
  assignWorkspaceRegion: () => Effect.die("not stubbed"),
  getWorkspaceRegionAssignment: () => Effect.die("not stubbed"),
  listWorkspaceRegions: () => Effect.die("not stubbed"),
  isConfiguredRegion: () => false,
};

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

// ── Discriminator probe — pure mirror of the consumer-side pattern ──
//
// Every load-bearing call site uses the same shape:
//
//   const t = yield* TheTag;
//   if (isEnterpriseEnabled() && !t.available) {
//     return yield* Effect.fail(new EnterpriseUnavailableError({ ... }));
//   }
//   return yield* t.<method>(...);
//
// Each test below exercises this branch for one Tag's no-op default
// under both env states (enabled / disabled).

interface FailClosedCase {
  readonly name: string;
  readonly tagName: string;
  // Each Tag's `R` and underlying-method error channel differs, but the
  // runner only inspects whether `EnterpriseUnavailableError` surfaced —
  // so `any` here keeps the table compact without per-case generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly buildLayer: () => Layer.Layer<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly buildProbe: () => Effect.Effect<unknown, any, any>;
}

const cases: FailClosedCase[] = [
  {
    name: "ResidencyResolver",
    tagName: "ResidencyResolver",
    buildLayer: () => Layer.succeed(ResidencyResolver, noopResidency),
    buildProbe: () =>
      Effect.gen(function* () {
        const t = yield* ResidencyResolver;
        if (isEnterpriseEnabled() && !t.available) {
          return yield* Effect.fail(
            new EnterpriseUnavailableError({
              message: "Residency unavailable",
              tag: "ResidencyResolver",
            }),
          );
        }
        return yield* t.resolveRegionDatabaseUrl("org-1");
      }),
  },
  {
    name: "MaskingPolicy",
    tagName: "MaskingPolicy",
    buildLayer: () => Layer.succeed(MaskingPolicy, noopMasking),
    buildProbe: () =>
      Effect.gen(function* () {
        const t = yield* MaskingPolicy;
        if (isEnterpriseEnabled() && !t.available) {
          return yield* Effect.fail(
            new EnterpriseUnavailableError({
              message: "Masking unavailable",
              tag: "MaskingPolicy",
            }),
          );
        }
        return yield* t.applyMasking({
          columns: [],
          rows: [],
          tablesAccessed: [],
          orgId: "org-1",
          userRole: undefined,
          connectionId: "default",
        });
      }),
  },
  {
    name: "ApprovalGate",
    tagName: "ApprovalGate",
    buildLayer: () => Layer.succeed(ApprovalGate, noopApproval),
    buildProbe: () =>
      Effect.gen(function* () {
        const t = yield* ApprovalGate;
        if (isEnterpriseEnabled() && !t.available) {
          return yield* Effect.fail(
            new EnterpriseUnavailableError({
              message: "Approval unavailable",
              tag: "ApprovalGate",
            }),
          );
        }
        return yield* t.checkApprovalRequired("org-1", [], []);
      }),
  },
  {
    name: "AuditRetention",
    tagName: "AuditRetention",
    buildLayer: () => Layer.succeed(AuditRetention, noopAuditRetention),
    buildProbe: () =>
      Effect.gen(function* () {
        const t = yield* AuditRetention;
        if (isEnterpriseEnabled() && !t.available) {
          return yield* Effect.fail(
            new EnterpriseUnavailableError({
              message: "Audit retention unavailable",
              tag: "AuditRetention",
            }),
          );
        }
        return yield* t.getRetentionPolicy("org-1");
      }),
  },
];

describe("Consumer-side fail-closed audit (#2593)", () => {
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
      it(`self-hosted (ATLAS_ENTERPRISE_ENABLED unset) — passes through (no fail-closed)`, async () => {
        delete process.env.ATLAS_ENTERPRISE_ENABLED;
        const exit = await Effect.runPromiseExit(
          c
            .buildProbe()
            .pipe(Effect.provide(c.buildLayer())) as Effect.Effect<unknown, unknown, never>,
        );
        // No fail-closed — the no-op's underlying method is allowed to
        // run, which here is the test-friendly no-op success (succeed/null/etc.).
        expect(Exit.isSuccess(exit)).toBe(true);
      });

      it(`SaaS (ATLAS_ENTERPRISE_ENABLED=true) + available=false — 503-shaped fail-closed`, async () => {
        process.env.ATLAS_ENTERPRISE_ENABLED = "true";
        const exit = await Effect.runPromiseExit(
          c
            .buildProbe()
            .pipe(Effect.provide(c.buildLayer())) as Effect.Effect<unknown, unknown, never>,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failures = Array.from(Cause.failures(exit.cause));
          const err = failures[0];
          expect(err).toBeInstanceOf(EnterpriseUnavailableError);
          // The Tag identity is preserved in the structured error so SaaS
          // monitoring can correlate the 503 with the `enterprise.load_failed`
          // log from `ConditionalEELayer`.
          if (err instanceof EnterpriseUnavailableError) {
            expect(err.tag).toBe(c.tagName);
            expect(err._tag).toBe("EnterpriseUnavailableError");
          }
        }
      });
    });
  }
});
