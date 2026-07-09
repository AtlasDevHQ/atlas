/**
 * Role-policy tests for {@link authorizeStripeReference} (#3416).
 *
 * Contract (the plugin maps `false` → 401 UNAUTHORIZED):
 *   - platform_admin (user.role) → allowed for every action, no member lookup.
 *   - owner / admin member of the referenced org → allowed for all 5 actions.
 *   - plain member → allowed ONLY for list-subscription; denied for the
 *     four money-moving actions (upgrade / cancel / restore / billing-portal).
 *   - non-member → denied for everything (including list).
 *   - member-table lookup error → throws 503 (retryable server error, not
 *     a 401 false-negative), logged at error. Still authorizes nothing.
 *   - no internal DB → denied (org-scoped billing requires managed auth).
 *   - customerType ≠ "organization" → denied for everyone, including
 *     platform_admin and org owners (Atlas has no user-scoped
 *     subscriptions; a user-mode call with an org referenceId would bill
 *     the user's Stripe customer against an org reference).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AuthorizeReferenceAction } from "@better-auth/stripe";
// "Mock all exports" rule: the factory supplies the complete db/internal
// export surface; this file only steers internalQuery/hasInternalDB.
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

let mockHasInternalDB = true;
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => mockHasInternalDB,
  }),
}));

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogError: Mock<(...args: unknown[]) => void> = mock(() => {});

const mockLoggerInstance = () => ({
  info: mock(() => {}),
  warn: mockLogWarn,
  error: mockLogError,
  debug: mock(() => {}),
});

// Full export surface of lib/logger (mock-all-exports rule) — only
// createLogger matters to the unit under test; the rest are inert
// pass-throughs so unrelated importers can't hit a missing named export.
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler"],
  createLogger: mockLoggerInstance,
  getLogger: mockLoggerInstance,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  hashShareToken: (token: string) => token,
  setLogLevel: () => false,
}));

const { authorizeStripeReference } = await import("../stripe-authorize-reference");

const MUTATING_ACTIONS = [
  "upgrade-subscription",
  "cancel-subscription",
  "restore-subscription",
  "billing-portal",
] as const satisfies readonly AuthorizeReferenceAction[];

const ALL_ACTIONS = [...MUTATING_ACTIONS, "list-subscription"] as const;

function withMemberRole(role: string | null) {
  mockInternalQuery.mockImplementation(() =>
    Promise.resolve(role === null ? [] : [{ role }]),
  );
}

beforeEach(() => {
  mockHasInternalDB = true;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockLogWarn.mockClear();
  mockLogError.mockClear();
});

describe("authorizeStripeReference — platform_admin", () => {
  it("allows every action without a member lookup", async () => {
    for (const action of ALL_ACTIONS) {
      expect(
        await authorizeStripeReference({
          customerType: "organization",
          user: { id: "user-1", role: "platform_admin" },
          referenceId: "org-1",
          action,
        }),
      ).toBe(true);
    }
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("authorizeStripeReference — org admin/owner", () => {
  it.each(["owner", "admin"])("allows all 5 actions for member role %s", async (role) => {
    withMemberRole(role);
    for (const action of ALL_ACTIONS) {
      expect(
        await authorizeStripeReference({
          customerType: "organization",
          user: { id: "user-1", role: "user" },
          referenceId: "org-1",
          action,
        }),
      ).toBe(true);
    }
  });

  it("looks up the member row scoped to the referenced org, not the active org", async () => {
    withMemberRole("owner");
    await authorizeStripeReference({
      customerType: "organization",
      user: { id: "user-7" },
      referenceId: "org-referenced",
      action: "upgrade-subscription",
    });
    const [, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["user-7", "org-referenced"]);
  });
});

describe("authorizeStripeReference — plain member", () => {
  it("denies the four money-moving actions", async () => {
    withMemberRole("member");
    for (const action of MUTATING_ACTIONS) {
      expect(
        await authorizeStripeReference({
          customerType: "organization",
          user: { id: "user-1", role: "user" },
          referenceId: "org-1",
          action,
        }),
      ).toBe(false);
    }
    expect(mockLogWarn).toHaveBeenCalledTimes(MUTATING_ACTIONS.length);
  });

  it("allows list-subscription (read-only)", async () => {
    withMemberRole("member");
    expect(
      await authorizeStripeReference({
        customerType: "organization",
        user: { id: "user-1", role: "user" },
        referenceId: "org-1",
        action: "list-subscription",
      }),
    ).toBe(true);
  });
});

describe("authorizeStripeReference — non-member", () => {
  it("denies every action, including list", async () => {
    withMemberRole(null);
    for (const action of ALL_ACTIONS) {
      expect(
        await authorizeStripeReference({
          customerType: "organization",
          user: { id: "intruder", role: "user" },
          referenceId: "org-1",
          action,
        }),
      ).toBe(false);
    }
  });
});

describe("authorizeStripeReference — org-scope requirement", () => {
  it.each([undefined, "user", "", null])(
    "denies every action when customerType is %p, even for owners",
    async (customerType) => {
      withMemberRole("owner");
      for (const action of ALL_ACTIONS) {
        expect(
          await authorizeStripeReference({
            customerType,
            user: { id: "user-1", role: "user" },
            referenceId: "org-1",
            action,
          }),
        ).toBe(false);
      }
      expect(mockInternalQuery).not.toHaveBeenCalled();
    },
  );

  it("denies platform_admin too when the call is not org-scoped", async () => {
    expect(
      await authorizeStripeReference({
        customerType: "user",
        user: { id: "user-1", role: "platform_admin" },
        referenceId: "org-1",
        action: "upgrade-subscription",
      }),
    ).toBe(false);
  });
});

describe("authorizeStripeReference — failure modes", () => {
  it("throws 503 when the member lookup errors — a DB blip must not become a 401 false-negative", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg blip")));
    await expect(
      authorizeStripeReference({
        customerType: "organization",
        user: { id: "user-1", role: "user" },
        referenceId: "org-1",
        action: "upgrade-subscription",
      }),
    ).rejects.toMatchObject({ status: "SERVICE_UNAVAILABLE" });
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it("denies when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    expect(
      await authorizeStripeReference({
        customerType: "organization",
        user: { id: "user-1", role: "user" },
        referenceId: "org-1",
        action: "billing-portal",
      }),
    ).toBe(false);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
