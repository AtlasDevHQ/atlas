/**
 * Unit tests for `lib/auth/scim-provenance.ts` — the F-57 guard helper.
 *
 * Covers the resolution table (EE off / no internal DB / table missing /
 * positive provisioned hit / org scoping / genuine error propagation), the
 * policy parser, and the `evaluateSCIMGuard` decision wiring. The route
 * integration tests in `api/routes/__tests__/scim-provenance-enforcement.test.ts`
 * cover the per-handler 409 / override-stamp behaviour.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { Effect } from "effect";

// ── Mocks (must be installed before importing the helper) ───────────

let mockEnterpriseEnabled = true;
let mockHasInternalDB = true;
let mockSettingValue: string | undefined;
const mockInternalQuery = mock(
  async (_sql: string, _params?: unknown[]): Promise<Record<string, unknown>[]> => [],
);

mock.module("@atlas/ee/index", () => ({
  isEnterpriseEnabled: () => mockEnterpriseEnabled,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (_key: string, _orgId?: string) => mockSettingValue,
}));

const {
  isSCIMProvisioned,
  evaluateSCIMGuard,
  evaluateSCIMGuardAsync,
  parseSCIMOverridePolicy,
  getSCIMOverridePolicy,
  scimManagedBlockBody,
  DEFAULT_SCIM_OVERRIDE_POLICY,
  SCIM_OVERRIDE_POLICIES,
  SCIM_OVERRIDE_POLICY_SETTING_KEY,
} = await import("../scim-provenance");

beforeEach(() => {
  mockEnterpriseEnabled = true;
  mockHasInternalDB = true;
  mockSettingValue = undefined;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(async () => []);
});

afterEach(() => {
  mockInternalQuery.mockReset();
});

describe("parseSCIMOverridePolicy", () => {
  it("returns 'override' only for the literal 'override'", () => {
    expect(parseSCIMOverridePolicy("override")).toBe("override");
  });

  it("falls back to 'strict' for 'strict', undefined, empty string, and any unrecognized input", () => {
    // Strict is the safer fail-closed default — exotic / typo'd / unset
    // values must NOT silently flip the workspace into override mode.
    expect(parseSCIMOverridePolicy("strict")).toBe("strict");
    expect(parseSCIMOverridePolicy(undefined)).toBe("strict");
    expect(parseSCIMOverridePolicy("")).toBe("strict");
    expect(parseSCIMOverridePolicy("OVERRIDE")).toBe("strict");
    expect(parseSCIMOverridePolicy("nope")).toBe("strict");
  });

  it("DEFAULT_SCIM_OVERRIDE_POLICY is 'strict'", () => {
    expect(DEFAULT_SCIM_OVERRIDE_POLICY).toBe("strict");
  });

  it("SCIM_OVERRIDE_POLICIES enumerates exactly the two valid values", () => {
    expect([...SCIM_OVERRIDE_POLICIES]).toEqual(["strict", "override"]);
  });

  it("SCIM_OVERRIDE_POLICY_SETTING_KEY matches the registry key", () => {
    expect(SCIM_OVERRIDE_POLICY_SETTING_KEY).toBe("ATLAS_SCIM_OVERRIDE_POLICY");
  });
});

describe("getSCIMOverridePolicy", () => {
  it("reads from getSettingAuto and parses", () => {
    mockSettingValue = "override";
    expect(getSCIMOverridePolicy("org-1")).toBe("override");
  });

  it("defaults to 'strict' when the setting is absent", () => {
    mockSettingValue = undefined;
    expect(getSCIMOverridePolicy("org-1")).toBe("strict");
  });
});

describe("isSCIMProvisioned", () => {
  it("returns false when enterprise mode is disabled (no SCIM contract at all)", async () => {
    mockEnterpriseEnabled = false;
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns false when no internal DB is available", async () => {
    mockHasInternalDB = false;
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns false when the scimProvider table does not exist (42P01)", async () => {
    // EE flag flipped on but the @better-auth/scim plugin migration hasn't
    // run — common during staged rollouts. Treat as "no SCIM contract"
    // rather than fail closed; admins can still mutate users.
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error('relation "scimProvider" does not exist');
    });
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(false);
  });

  it("returns false when the scimProvider table missing error surfaces with code 42P01 only", async () => {
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("query failed: 42P01");
    });
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(false);
  });

  it("returns true when the join finds at least one row", async () => {
    mockInternalQuery.mockImplementationOnce(async () => [{ "?column?": 1 }]);
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(true);
  });

  it("returns false when the join finds no rows", async () => {
    mockInternalQuery.mockImplementationOnce(async () => []);
    const result = await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(result).toBe(false);
  });

  it("scopes the query to orgId when provided", async () => {
    mockInternalQuery.mockImplementationOnce(async () => []);
    await Effect.runPromise(isSCIMProvisioned("user-1", "org-1"));
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain('"organizationId" = $2');
    expect(params).toEqual(["user-1", "org-1"]);
  });

  it("omits the org filter when orgId is not provided (platform-admin path)", async () => {
    mockInternalQuery.mockImplementationOnce(async () => []);
    await Effect.runPromise(isSCIMProvisioned("user-1"));
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).not.toContain('"organizationId" =');
    expect(params).toEqual(["user-1"]);
  });

  it("propagates genuine query errors so the route fails closed", async () => {
    // Returning false on a transient DB blip would silently let the
    // mutation through against a SCIM-managed user — the F-57 contract
    // is fail closed, not fail open.
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });
    await expect(Effect.runPromise(isSCIMProvisioned("user-1", "org-1"))).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("evaluateSCIMGuard", () => {
  it("returns { kind: 'non_scim' } when the user is not SCIM-provisioned", async () => {
    mockInternalQuery.mockImplementationOnce(async () => []);
    const decision = await Effect.runPromise(
      evaluateSCIMGuard({ userId: "user-1", orgId: "org-1", requestId: "req-1" }),
    );
    expect(decision.kind).toBe("non_scim");
  });

  it("returns { kind: 'override' } under override policy when the user is SCIM-provisioned", async () => {
    mockInternalQuery.mockImplementationOnce(async () => [{ "?column?": 1 }]);
    mockSettingValue = "override";
    const decision = await Effect.runPromise(
      evaluateSCIMGuard({ userId: "user-1", orgId: "org-1", requestId: "req-1" }),
    );
    expect(decision.kind).toBe("override");
  });

  it("returns { kind: 'block', status: 409, body: SCIM_MANAGED } under strict policy", async () => {
    mockInternalQuery.mockImplementationOnce(async () => [{ "?column?": 1 }]);
    mockSettingValue = "strict";
    const decision = await Effect.runPromise(
      evaluateSCIMGuard({ userId: "user-1", orgId: "org-1", requestId: "req-block" }),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.status).toBe(409);
    expect(decision.body.error).toBe("scim_managed");
    expect(decision.body.code).toBe("SCIM_MANAGED");
    expect(decision.body.requestId).toBe("req-block");
  });

  it("defaults to strict when the policy setting is unset", async () => {
    mockInternalQuery.mockImplementationOnce(async () => [{ "?column?": 1 }]);
    mockSettingValue = undefined;
    const decision = await Effect.runPromise(
      evaluateSCIMGuard({ userId: "user-1", orgId: "org-1", requestId: "req" }),
    );
    expect(decision.kind).toBe("block");
  });
});

describe("evaluateSCIMGuardAsync", () => {
  it("resolves with the same decision shape as the Effect variant", async () => {
    mockInternalQuery.mockImplementationOnce(async () => [{ "?column?": 1 }]);
    mockSettingValue = "strict";
    const decision = await evaluateSCIMGuardAsync({
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-async",
    });
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.status).toBe(409);
    expect(decision.body.code).toBe("SCIM_MANAGED");
  });

  it("rejects on genuine query errors (fail-closed at the route layer)", async () => {
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });
    await expect(
      evaluateSCIMGuardAsync({
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-err",
      }),
    ).rejects.toThrow();
  });
});

describe("scimManagedBlockBody", () => {
  it("returns a stable code that the UI can match on", () => {
    const body = scimManagedBlockBody("req-1");
    expect(body.code).toBe("SCIM_MANAGED");
    expect(body.error).toBe("scim_managed");
    expect(body.requestId).toBe("req-1");
    expect(body.message).toContain("SCIM");
  });
});
