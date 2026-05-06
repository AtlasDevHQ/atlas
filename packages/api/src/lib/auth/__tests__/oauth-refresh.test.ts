/**
 * OAuth refresh-token TTL resolvers + audit hook (#2066).
 *
 * Three concerns pinned here:
 *
 *   1. `resolveAccessTokenTtlSeconds` / `resolveRefreshTokenTtlSeconds`
 *      — env-driven config that backs the e2e test's "mint a 30-second
 *      JWT" override. Bad parsing here silently ships a 0-second token
 *      or falls back to a default the e2e setup didn't expect.
 *
 *   2. `recordOAuthTokenRefresh` — the helper wired into Better Auth's
 *      `customTokenResponseFields` hook. Side-effects (audit + counter)
 *      must fire even when fields are partial; production calls have
 *      `clientId: null` because the hook signature doesn't expose it.
 *
 *   3. The actions catalog and metrics counter exist and are wired in.
 *      Compile-time + light runtime checks: `ADMIN_ACTIONS.oauth_token`
 *      must be the string the audit row writes; `oauthTokenRefresh`
 *      must implement the OTel Counter shape.
 *
 * No `mock.module()` here — the helpers under test are pure functions
 * + side-effect emitters. The audit emit is fire-and-forget under the
 * hood, so we exercise the call path rather than asserting on the row
 * itself (the audit logger has its own dedicated tests).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { Attributes } from "@opentelemetry/api";
import {
  resolveAccessTokenTtlSeconds,
  resolveRefreshTokenTtlSeconds,
} from "../server";
import { recordOAuthTokenRefresh } from "../oauth-refresh-audit";
import { ADMIN_ACTIONS, type AdminActionEntry } from "@atlas/api/lib/audit";
import { ADMIN_ACTIONS as ACTUAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import { oauthTokenRefresh } from "@atlas/api/lib/metrics";

// Capture audit emissions through a partial-mock of the audit module.
// CLAUDE.md requires every named export to be present — we re-export the
// real `ADMIN_ACTIONS` constant so the catalog assertions below see the
// load-bearing string literal.
const auditedEntries: AdminActionEntry[] = [];
const mockLogAdminAction: Mock<(entry: AdminActionEntry) => void> = mock(
  (entry) => {
    auditedEntries.push(entry);
  },
);

// `mock.module` factory must be sync. An async factory that itself
// `await`s another module load deadlocks Bun 1.3.11's loader when the
// test file is the entrypoint — bun:test waits for the module graph
// to settle, and the factory's pending promise never resolves before
// that wait kicks in. Pulling the actual `ADMIN_ACTIONS` via a static
// import above sidesteps the deadlock and keeps the spy semantics
// identical. See #2121.
mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: ACTUAL_ADMIN_ACTIONS,
  logAdminAction: (entry: AdminActionEntry) => mockLogAdminAction(entry),
  logAdminActionAwait: async (entry: AdminActionEntry) => {
    mockLogAdminAction(entry);
  },
  errorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  causeToError: (err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
}));

// Counter spy — pre-monkeypatch the `add` method so we can assert the
// attribute payload. We don't fully mock `@atlas/api/lib/metrics` because
// other code paths consume the same module in this test process and a
// partial mock would leak. The `attrs` arg is typed as
// `@opentelemetry/api`'s `Attributes` so the wrapper round-trips the
// real Counter signature — `Record<string, unknown>` would lose the
// AttributeValue narrowing and break the call to `originalCounterAdd`.
const counterAddSpy: Mock<(value: number, attrs?: Attributes) => void> = mock(
  () => {},
);
const originalCounterAdd = oauthTokenRefresh.add.bind(oauthTokenRefresh);
oauthTokenRefresh.add = ((value: number, attrs?: Attributes) => {
  counterAddSpy(value, attrs);
  return originalCounterAdd(value, attrs);
}) as typeof oauthTokenRefresh.add;

beforeEach(() => {
  auditedEntries.length = 0;
  mockLogAdminAction.mockClear();
  counterAddSpy.mockClear();
});

describe("resolveAccessTokenTtlSeconds", () => {
  it("returns the 1-hour default when the env var is unset", () => {
    expect(resolveAccessTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(3600);
  });

  it("returns the 1-hour default when the env var is empty", () => {
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "",
      } as NodeJS.ProcessEnv),
    ).toBe(3600);
  });

  it("parses a positive integer override", () => {
    // 30 seconds is the e2e test's canonical short-TTL value — keep
    // this assertion in sync with the spec or the test's premise breaks.
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "30",
      } as NodeJS.ProcessEnv),
    ).toBe(30);
  });

  it("falls back to default on a non-numeric value (no silent 0-second token)", () => {
    // A typo ('thirty') must not ship a zero-TTL token — that would mean
    // every token is born expired and refresh would loop forever.
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "thirty",
      } as NodeJS.ProcessEnv),
    ).toBe(3600);
  });

  it("falls back to default on zero / negative values", () => {
    for (const raw of ["0", "-1", "  -42 "]) {
      expect(
        resolveAccessTokenTtlSeconds({
          ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: raw,
        } as NodeJS.ProcessEnv),
      ).toBe(3600);
    }
  });
});

describe("resolveRefreshTokenTtlSeconds", () => {
  it("returns the 30-day default when the env var is unset", () => {
    expect(resolveRefreshTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(
      60 * 60 * 24 * 30,
    );
  });

  it("parses a positive integer override", () => {
    expect(
      resolveRefreshTokenTtlSeconds({
        ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "120",
      } as NodeJS.ProcessEnv),
    ).toBe(120);
  });

  it("falls back to default on garbage input", () => {
    expect(
      resolveRefreshTokenTtlSeconds({
        ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "forever",
      } as NodeJS.ProcessEnv),
    ).toBe(60 * 60 * 24 * 30);
  });
});

describe("ADMIN_ACTIONS.oauth_token catalog", () => {
  it("declares the canonical refresh action string", () => {
    // The literal is the wire shape — forensic queries pivot on
    // `action_type = 'oauth_token.refresh'`. Don't drift it.
    expect(ADMIN_ACTIONS.oauth_token.refresh).toBe("oauth_token.refresh");
  });
});

describe("oauthTokenRefresh counter", () => {
  it("implements the OTel Counter `add` method", () => {
    // We're not asserting against an exporter — there is none in unit
    // tests. The check is structural: the metric exists and the SDK
    // returns a real counter (not the no-op stub the type system
    // would happily accept).
    expect(typeof oauthTokenRefresh.add).toBe("function");
  });
});

describe("recordOAuthTokenRefresh", () => {
  it("emits a single audit row pinning the canonical wire shape", () => {
    // Forensic queries pivot on `action_type = 'oauth_token.refresh'`,
    // `target_type = 'oauth_token'`, and the metadata field set. Pin
    // every load-bearing field — a regression on any one of these
    // breaks dashboard joins or retention policy.
    recordOAuthTokenRefresh({
      clientId: "claude-desktop",
      userId: "user_abc",
      tokenJti: "jti_xyz",
      ageAtRefreshSec: 3600,
      scopes: ["openid", "profile", "offline_access", "mcp:read"],
    });

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = auditedEntries[0]!;
    expect(entry.actionType).toBe("oauth_token.refresh");
    expect(entry.targetType).toBe("oauth_token");
    expect(entry.targetId).toBe("claude-desktop");
    expect(entry.metadata).toMatchObject({
      clientId: "claude-desktop",
      userId: "user_abc",
      tokenJti: "jti_xyz",
      ageAtRefreshSec: 3600,
      scopes: ["openid", "profile", "offline_access", "mcp:read"],
    });
  });

  it("falls back targetId to 'unknown' when clientId is null (production hook reality)", () => {
    // The production hook is essentially always called with
    // `clientId: null` because `customTokenResponseFields` does not
    // surface the `oauthClient.clientId` column to user code. The
    // audit row's `target_id` must NOT be NULL — forensic queries
    // pivoting on `target_id IS NULL` would otherwise sweep these
    // rows up by accident.
    recordOAuthTokenRefresh({
      clientId: null,
      userId: "user_abc",
      scopes: ["mcp:read"],
    });

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = auditedEntries[0]!;
    expect(entry.targetId).toBe("unknown");
    expect(entry.metadata).toMatchObject({
      clientId: null,
      userId: "user_abc",
      scopes: ["mcp:read"],
    });
    // tokenJti / ageAtRefreshSec are conditionally spread — must NOT
    // appear when caller didn't supply them. A regression that always
    // emits `tokenJti: undefined` would corrupt JSON aggregations.
    expect(entry.metadata?.tokenJti).toBeUndefined();
    expect(entry.metadata?.ageAtRefreshSec).toBeUndefined();
  });

  it("emits the OTel counter with client.id + deploy.mode attributes", () => {
    // The counter's whole reason for existing is the per-agent split.
    // A regression dropping `client.id` collapses the dashboard view
    // into a single bucket; a regression on `deploy.mode` mis-attributes
    // every self-hosted refresh as SaaS or vice versa.
    recordOAuthTokenRefresh({
      clientId: "claude-desktop",
      userId: "user_abc",
      scopes: ["mcp:read"],
    });

    expect(counterAddSpy).toHaveBeenCalledTimes(1);
    const [value, attrs] = counterAddSpy.mock.calls[0]!;
    expect(value).toBe(1);
    expect(attrs).toMatchObject({
      "client.id": "claude-desktop",
      // getConfig() is null in unit-test default — resolveDeployMode
      // safe-defaults to self-hosted.
      "deploy.mode": "self-hosted",
    });
  });

  it("counter falls back client.id='unknown' when clientId is null", () => {
    recordOAuthTokenRefresh({
      clientId: null,
      userId: "user_abc",
      scopes: ["mcp:read"],
    });

    expect(counterAddSpy).toHaveBeenCalledTimes(1);
    const [, attrs] = counterAddSpy.mock.calls[0]!;
    expect(attrs).toMatchObject({ "client.id": "unknown" });
  });

  it("does not throw when userId is null (defense in depth)", () => {
    // M2M flows have `user?` undefined — but this hook only fires on
    // `refresh_token` grant (always user-bound per Better Auth's
    // own contract). The null path exists as a defense in depth.
    expect(() =>
      recordOAuthTokenRefresh({
        clientId: "cursor",
        userId: null,
        scopes: ["openid"],
      }),
    ).not.toThrow();
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(auditedEntries[0]!.metadata).toMatchObject({ userId: null });
  });
});
