/**
 * Regression suite for the enterprise Noop layers' fix-up in PR #2594.
 *
 * The bugs caught during the milestone-#48 cross-slice review (and
 * fixed in this PR) were all silent-failure-shaped:
 *
 *   - `MaskingPolicy` no-op spread `[...ctx.rows]` broke the
 *     `maskingApplied = maskedRows !== result.rows` reference-identity
 *     contract in `tools/sql.ts`, falsely reporting `maskingApplied: true`
 *     on every self-hosted query against a classified table.
 *
 *   - `AuditRetention.anonymizeUserAdminActions` returned
 *     `Effect.succeed({ anonymizedRowCount: 0 })` so a GDPR erasure
 *     request appeared to complete while leaving every row in place AND
 *     emitting no forensic audit row.
 *
 *   - Several Noop methods used `Effect.die(...)` for the "EE not
 *     installed" path. `Effect.die` produces a defect that bypasses the
 *     typed error channel and `Effect.catchAll`, so a route that catches
 *     would still see an opaque 500 instead of a clean 403 EnterpriseError.
 *
 *   - 7 destructive Noop methods (`deleteWorkspaceModelConfig`,
 *     `deleteApprovalRule`, `acknowledgeAlert`, `removeIPAllowlistEntry`,
 *     `deleteSSOProvider`, SCIM `deleteConnection`/`deleteGroupMapping`)
 *     returned `Effect.succeed(false)` → routes mapped to 404, silently
 *     lying that the resource was already gone.
 *
 * The fixes are documented in the per-commit messages; this file pins
 * them so a future "simplify the Noop layer" PR doesn't regress them
 * with passing tests elsewhere.
 *
 * Strategy: each test resolves the Noop layer's service via
 * `Effect.provide(<Tag>, NoopXxxLayer)`, calls the method, and asserts
 * either reference identity (Masking) or that the failure is an
 * `Effect.fail(EnterpriseError)` typed failure — not an `Effect.die`
 * defect.
 */

import { describe, it, expect } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  NoopApprovalGateLayer,
  NoopAuditRetentionLayer,
  NoopBackupsManagerLayer,
  NoopIpAllowlistPolicyLayer,
  NoopMaskingPolicyLayer,
  NoopModelRouterLayer,
  NoopSCIMProvenanceLayer,
  NoopSlaMetricsLayer,
  NoopSSOPolicyLayer,
  ApprovalGate,
  AuditRetention,
  BackupsManager,
  IpAllowlistPolicy,
  MaskingPolicy,
  ModelRouter,
  SCIMProvenance,
  SlaMetrics,
  SSOPolicy,
} from "../services";

/**
 * Run `program` against `layer` and return the Exit so tests can assert
 * on the failure cause (typed failure vs defect) instead of just
 * succeed/fail.
 */
function runWithLayer<A, E, R>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
}

/** Assert an Exit is a typed failure (Effect.fail), not a defect (Effect.die). */
function expectTypedFailure(exit: Exit.Exit<unknown, unknown>, expectedTag: string): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") return;
  const err = failure.value as { readonly _tag?: string };
  expect(err._tag).toBe(expectedTag);
  // Crucial: there must be no defect in the cause — `Effect.die` would
  // surface here and bypass route-layer `catchAll`.
  const defects = Array.from(Cause.defects(exit.cause));
  expect(defects).toHaveLength(0);
}

// ── MaskingPolicy — reference identity (the `maskingApplied` audit bug) ──

describe("NoopMaskingPolicyLayer", () => {
  it("applyMasking returns the SAME rows reference (preserves `maskingApplied = maskedRows !== result.rows` contract)", async () => {
    const rows = [{ id: 1, ssn: "111-22-3333" }];
    const program = Effect.gen(function* () {
      const masking = yield* MaskingPolicy;
      return yield* masking.applyMasking({ rows, orgId: "o", tables: [], columns: [] });
    });
    const exit = await runWithLayer(program, NoopMaskingPolicyLayer);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      // `Object.is` is what `!==` checks. A spread (`[...rows]`) would
      // break this even though the contents are equal.
      expect(Object.is(exit.value, rows)).toBe(true);
    }
  });
});

// ── AuditRetention — GDPR pretend-succeed regression ──────────────

describe("NoopAuditRetentionLayer", () => {
  it("anonymizeUserAdminActions fails with EnterpriseError (NOT silently succeeds)", async () => {
    const program = Effect.gen(function* () {
      const r = yield* AuditRetention;
      return yield* r.anonymizeUserAdminActions("user-1", "platform_admin");
    });
    const exit = await runWithLayer(program, NoopAuditRetentionLayer);
    expectTypedFailure(exit, "EnterpriseError");
  });

  it.each([
    "purgeExpiredEntries",
    "hardDeleteExpired",
    "purgeAdminActionExpired",
    "previewAdminActionErasure",
  ] as const)("%s fails with EnterpriseError (destructive op MUST NOT silent-succeed)", async (method) => {
    const program = Effect.gen(function* () {
      const r = yield* AuditRetention;
      switch (method) {
        case "purgeExpiredEntries":
          return yield* r.purgeExpiredEntries();
        case "hardDeleteExpired":
          return yield* r.hardDeleteExpired();
        case "purgeAdminActionExpired":
          return yield* r.purgeAdminActionExpired();
        case "previewAdminActionErasure":
          return yield* r.previewAdminActionErasure("user-1");
      }
    });
    const exit = await runWithLayer(program, NoopAuditRetentionLayer);
    expectTypedFailure(exit, "EnterpriseError");
  });

  it("getRetentionPolicy returns null (pure read — 'no policy configured' is honest)", async () => {
    const program = Effect.gen(function* () {
      const r = yield* AuditRetention;
      return yield* r.getRetentionPolicy("org-1");
    });
    const exit = await runWithLayer(program, NoopAuditRetentionLayer);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeNull();
    }
  });
});

// ── Destructive Noops that previously returned `succeed(false)` ──

describe("destructive Noop methods now fail with EnterpriseError", () => {
  it("ModelRouter.deleteWorkspaceModelConfig", async () => {
    const program = Effect.gen(function* () {
      const r = yield* ModelRouter;
      return yield* r.deleteWorkspaceModelConfig("org-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopModelRouterLayer), "EnterpriseError");
  });

  it("ApprovalGate.deleteApprovalRule", async () => {
    const program = Effect.gen(function* () {
      const r = yield* ApprovalGate;
      return yield* r.deleteApprovalRule("org-1", "rule-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopApprovalGateLayer), "EnterpriseError");
  });

  it("SlaMetrics.acknowledgeAlert", async () => {
    const program = Effect.gen(function* () {
      const r = yield* SlaMetrics;
      return yield* r.acknowledgeAlert("alert-1", "actor-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopSlaMetricsLayer), "EnterpriseError");
  });

  it("IpAllowlistPolicy.removeIPAllowlistEntry (SECURITY — admin must not silently believe IP was removed)", async () => {
    const program = Effect.gen(function* () {
      const r = yield* IpAllowlistPolicy;
      return yield* r.removeIPAllowlistEntry("org-1", "entry-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopIpAllowlistPolicyLayer), "EnterpriseError");
  });

  it("SSOPolicy.deleteSSOProvider (SECURITY — provider must not silently stay routing)", async () => {
    const program = Effect.gen(function* () {
      const r = yield* SSOPolicy;
      return yield* r.deleteSSOProvider("org-1", "provider-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopSSOPolicyLayer), "EnterpriseError");
  });

  it("SCIMProvenance.deleteConnection", async () => {
    const program = Effect.gen(function* () {
      const r = yield* SCIMProvenance;
      return yield* r.deleteConnection("org-1", "conn-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopSCIMProvenanceLayer), "EnterpriseError");
  });

  it("SCIMProvenance.deleteGroupMapping", async () => {
    const program = Effect.gen(function* () {
      const r = yield* SCIMProvenance;
      return yield* r.deleteGroupMapping("org-1", "mapping-1");
    });
    expectTypedFailure(await runWithLayer(program, NoopSCIMProvenanceLayer), "EnterpriseError");
  });
});

// ── Effect.die → Effect.fail conversions (slice 5/6/8) ──────────────

describe("previously-Effect.die methods now fail through typed channel", () => {
  it("ApprovalGate.createApprovalRequest", async () => {
    const program = Effect.gen(function* () {
      const g = yield* ApprovalGate;
      return yield* g.createApprovalRequest({
        orgId: "o", ruleId: "r", ruleName: "rn", requesterId: "u",
        requesterEmail: null, querySql: "SELECT 1", explanation: null,
        connectionId: null, tablesAccessed: [], columnsAccessed: [],
      });
    });
    expectTypedFailure(await runWithLayer(program, NoopApprovalGateLayer), "EnterpriseError");
  });

  it("SlaMetrics.getWorkspaceSLADetail", async () => {
    const program = Effect.gen(function* () {
      const s = yield* SlaMetrics;
      return yield* s.getWorkspaceSLADetail("w");
    });
    expectTypedFailure(await runWithLayer(program, NoopSlaMetricsLayer), "EnterpriseError");
  });

  it("BackupsManager.createBackup", async () => {
    const program = Effect.gen(function* () {
      const b = yield* BackupsManager;
      return yield* b.createBackup();
    });
    expectTypedFailure(await runWithLayer(program, NoopBackupsManagerLayer), "EnterpriseError");
  });

  it("IpAllowlistPolicy.addIPAllowlistEntry", async () => {
    const program = Effect.gen(function* () {
      const p = yield* IpAllowlistPolicy;
      return yield* p.addIPAllowlistEntry("o", "192.0.2.0/24", null, null);
    });
    expectTypedFailure(await runWithLayer(program, NoopIpAllowlistPolicyLayer), "EnterpriseError");
  });
});
