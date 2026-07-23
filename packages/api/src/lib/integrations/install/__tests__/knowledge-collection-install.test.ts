/**
 * Unit tests for the two knowledge-collection install gates (#4235):
 * the pre-write {@link assertCollectionInstallable} and the atomic
 * {@link upsertKnowledgeCollectionRow}.
 *
 * The point of both is the DISPOSITION: a genuine cap hit must surface the
 * standard 403 `plan_upgrade_required` envelope (naming a real upgrade target),
 * while an inability to DETERMINE the count must fail closed as a transient 503
 * — never a misleading "upgrade your plan".
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PlanTier, WorkspaceId } from "@useatlas/types";
import { buildInternalDbMockDefaults } from "@atlas/api/__mocks__/api-test-mocks";

type LimitResult =
  | { allowed: true }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };

let PRECHECK: LimitResult = { allowed: true };
let INSTALL: LimitResult | { allowed: true; rows: Array<{ id: string }> } = {
  allowed: true,
  rows: [{ id: "row-1" }],
};
let TIER: PlanTier | null = "starter";
let TIER_THROWS: Error | null = null;

/** Rows the cross-catalog slug guard sees; empty = slug is free. */
let CROSS_CATALOG_ROWS: Array<{ catalog_id: string }> = [];
const internalQuery = mock(async () => CROSS_CATALOG_ROWS);

void mock.module("@atlas/api/lib/db/internal", () =>
  buildInternalDbMockDefaults({ internalQuery }),
);
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkKnowledgeCollectionLimit: async () => PRECHECK,
  checkKnowledgeCollectionLimitAndInstall: async () => INSTALL,
}));
void mock.module("@atlas/api/lib/billing/knowledge-limits", () => ({
  resolveKnowledgeTierLimits: async () => {
    if (TIER_THROWS) throw TIER_THROWS;
    return TIER === null ? null : { tier: TIER, limits: {} };
  },
  lowestTierAdmitting: (_field: string, _required: number, current: PlanTier) =>
    current === "starter" ? "pro" : null,
}));
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const { assertCollectionInstallable, upsertKnowledgeCollectionRow } = await import(
  "@atlas/api/lib/integrations/install/knowledge-collection-install"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/email-form-handler"
);
const { BillingCheckFailedError, FeatureEntitlementError } = await import(
  "@atlas/api/lib/effect/errors"
);

const WORKSPACE = "org-1" as WorkspaceId;
const noopLog = { error: () => {}, info: () => {} };

beforeEach(() => {
  PRECHECK = { allowed: true };
  INSTALL = { allowed: true, rows: [{ id: "row-1" }] };
  TIER = "starter";
  TIER_THROWS = null;
  CROSS_CATALOG_ROWS = [];
  internalQuery.mockClear();
});

describe("assertCollectionInstallable", () => {
  it("passes when the slug is free and the tier has room", async () => {
    await expect(
      assertCollectionInstallable(WORKSPACE, "docs", "catalog:okf-upload", noopLog),
    ).resolves.toBeUndefined();
  });

  it("rejects a slug owned by another knowledge catalog with a field-level 400", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    const err = await assertCollectionInstallable(
      WORKSPACE,
      "docs",
      "catalog:okf-upload",
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormInstallValidationError);
  });

  it("checks the slug BEFORE the cap — a taken slug is a 400, not an upgrade prompt", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    PRECHECK = { allowed: false, reason: "cap_reached", errorMessage: "nope", limit: 1 };
    const err = await assertCollectionInstallable(
      WORKSPACE,
      "docs",
      "catalog:okf-upload",
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormInstallValidationError);
  });

  it("turns a cap hit into the 403 upgrade envelope naming a real target", async () => {
    PRECHECK = { allowed: false, reason: "cap_reached", errorMessage: "nope", limit: 1 };
    const err = await assertCollectionInstallable(
      WORKSPACE,
      "docs",
      "catalog:okf-upload",
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    const typed = err as InstanceType<typeof FeatureEntitlementError>;
    expect(typed.currentPlan).toBe("starter");
    expect(typed.requiredPlan).toBe("pro");
    expect(typed.message).toContain("1 knowledge collection");
  });

  it("fails CLOSED as a 503 when the count could not be determined", async () => {
    // NOT a 429/403 "upgrade": we don't know the count, so telling the customer
    // to buy a bigger plan would be a guess.
    PRECHECK = { allowed: false, reason: "check_failed", errorMessage: "try again" };
    const err = await assertCollectionInstallable(
      WORKSPACE,
      "docs",
      "catalog:okf-upload",
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingCheckFailedError);
  });

  it("still emits a 403 (naming the top plan) when the tier can't be resolved for the prompt", async () => {
    // The cap decision is authoritative; a prompt-cosmetics fault must not
    // downgrade a correct 403 into a 503.
    PRECHECK = { allowed: false, reason: "cap_reached", errorMessage: "nope", limit: 3 };
    TIER_THROWS = new Error("db down");
    const err = await assertCollectionInstallable(
      WORKSPACE,
      "docs",
      "catalog:okf-upload",
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    const typed = err as InstanceType<typeof FeatureEntitlementError>;
    expect(typed.currentPlan).toBe("free");
    expect(typed.requiredPlan).toBe("business");
  });
});

describe("upsertKnowledgeCollectionRow", () => {
  const input = {
    workspaceId: WORKSPACE,
    collectionSlug: "docs",
    sql: "INSERT ... RETURNING id",
    params: ["cand-1"],
    candidateId: "cand-1",
    log: noopLog,
  };

  it("returns the persisted row id from RETURNING", async () => {
    // Deliberately NOT candidateId — on the ON-CONFLICT path the row keeps its
    // existing id, so echoing the candidate would be wrong.
    INSTALL = { allowed: true, rows: [{ id: "existing-row" }] };
    expect(await upsertKnowledgeCollectionRow(input)).toBe("existing-row");
  });

  it("fails loud when RETURNING yields no row", async () => {
    INSTALL = { allowed: true, rows: [] };
    await expect(upsertKnowledgeCollectionRow(input)).rejects.toThrow(/returned no id/);
  });

  it("turns an under-lock cap hit into the 403 upgrade envelope", async () => {
    INSTALL = { allowed: false, reason: "cap_reached", errorMessage: "nope", limit: 1 };
    const err = await upsertKnowledgeCollectionRow(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    expect((err as InstanceType<typeof FeatureEntitlementError>).requiredPlan).toBe("pro");
  });

  it("fails CLOSED as a 503 when the under-lock count check failed", async () => {
    INSTALL = { allowed: false, reason: "check_failed", errorMessage: "try again" };
    await expect(upsertKnowledgeCollectionRow(input)).rejects.toBeInstanceOf(
      BillingCheckFailedError,
    );
  });
});
