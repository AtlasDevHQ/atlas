import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Module mock for the internal-DB adapter must be installed BEFORE
// `validateManaged` is imported so its transitive `hasInternalDB` /
// `internalQuery` references resolve to these stubs. Tests flip the
// closures (mockHasInternalDB / mockInternalQuery) to cover the
// resolvePasskeyCount branches that aren't reachable via env-only setup.
let mockHasInternalDB = false;
let mockInternalQuery: (sql: string, params: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: (sql: string, params: unknown[]) => mockInternalQuery(sql, params),
}));

import { validateManaged } from "../managed";
import { _setAuthInstance } from "../server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return type is intentionally untyped to simulate Better Auth session responses
const mockGetSession = mock((): Promise<any> => Promise.resolve(null));

describe("validateManaged()", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    mockGetSession.mockReset();
    // Inject a fake auth instance whose api.getSession is our mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance({ api: { getSession: mockGetSession } } as any);
    // Internal-DB mock defaults: no DB available, no rows. Individual tests
    // override these closures to exercise the positive / failure paths.
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    _setAuthInstance(null);
    mockHasInternalDB = false;
    mockInternalQuery = () => Promise.resolve([]);
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  function makeRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: headers ?? {},
    });
  }

  it("returns authenticated with user when session exists", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "usr_123", email: "alice@example.com", name: "Alice" },
      session: { id: "sess_abc", userId: "usr_123" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toMatchObject({
      authenticated: true,
      mode: "managed",
      user: {
        id: "usr_123",
        mode: "managed",
        label: "alice@example.com",
      },
    });
    // Verify claims are populated from session user
    if (result.authenticated && result.user) {
      expect(result.user.claims).toBeDefined();
      expect(result.user.claims!.sub).toBe("usr_123");
      expect(result.user.claims!.email).toBe("alice@example.com");
    }
  });

  it("returns 401 when no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "Not signed in",
    });
  });

  it("passes request headers to getSession", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = makeRequest({ Authorization: "Bearer some-token" });
    await validateManaged(req);

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    const calls = mockGetSession.mock.calls as unknown as Array<[{ headers: Headers }]>;
    expect(calls[0][0].headers.get("authorization")).toBe("Bearer some-token");
  });

  it("returns 500 when session exists but user.id is missing", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { email: "ghost@example.com" },
      session: { id: "sess_456" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 500,
      error: "Session data is incomplete",
    });
  });

  it("returns 500 when session exists but user.id is empty string", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "", email: "empty@example.com" },
      session: { id: "sess_789" },
    });

    const result = await validateManaged(makeRequest());

    expect(result).toEqual({
      authenticated: false,
      mode: "managed",
      status: 500,
      error: "Session data is incomplete",
    });
  });

  it("propagates errors from auth instance", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(validateManaged(makeRequest())).rejects.toThrow(
      "DB connection failed",
    );
  });

  describe("role extraction from session", () => {
    it("session with user.role: 'admin' propagates to user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("session with user.role: 'invalid' falls back — no role on user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "invalid" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("session without role field — no role on user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("session with non-string role (number) is ignored", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: 42 },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });
  });

  describe("session timeout enforcement", () => {
    afterEach(() => {
      delete process.env.ATLAS_SESSION_IDLE_TIMEOUT;
      delete process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT;
    });

    function validSession(overrides?: { updatedAt?: string; createdAt?: string }) {
      const now = new Date().toISOString();
      return {
        user: { id: "usr_123", email: "alice@example.com" },
        session: {
          id: "sess_abc",
          userId: "usr_123",
          updatedAt: overrides?.updatedAt ?? now,
          createdAt: overrides?.createdAt ?? now,
        },
      };
    }

    it("authenticates when timeouts are disabled (default)", async () => {
      mockGetSession.mockResolvedValueOnce(validSession());
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("authenticates when session is within idle timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "3600";
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("rejects session that exceeds idle timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "60"; // 60 seconds
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session expired (idle timeout)");
      }
    });

    it("authenticates when session is within absolute timeout", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(true);
    });

    it("rejects session that exceeds absolute timeout", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "3600"; // 1 hour
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: new Date(Date.now() - 7200_000).toISOString(), // 2 hours ago
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session expired");
      }
    });

    it("rejects session with invalid updatedAt date (fail-closed)", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "3600";
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: "not-a-date",
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session data is invalid");
      }
    });

    it("rejects session with invalid createdAt date (fail-closed)", async () => {
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      mockGetSession.mockResolvedValueOnce(validSession({
        createdAt: "garbage",
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("Session data is invalid");
      }
    });

    it("idle timeout checked before absolute timeout", async () => {
      process.env.ATLAS_SESSION_IDLE_TIMEOUT = "60";
      process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT = "86400";
      // Session is idle-expired but not absolute-expired
      mockGetSession.mockResolvedValueOnce(validSession({
        updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min idle
        createdAt: new Date(Date.now() - 600_000).toISOString(), // 10 min old
      }));
      const result = await validateManaged(makeRequest());
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.error).toBe("Session expired (idle timeout)");
      }
    });
  });

  // -------------------------------------------------------------------------
  // activeOrganizationId extraction
  // -------------------------------------------------------------------------

  describe("activeOrganizationId extraction", () => {
    it("extracts activeOrganizationId from session data", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com", role: "admin" },
        session: { id: "sess_abc", userId: "usr_123", activeOrganizationId: "org-456" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBe("org-456");
        expect(result.user.claims?.org_id).toBe("org-456");
      }
    });

    it("leaves activeOrganizationId undefined when not in session", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBeUndefined();
        expect(result.user.claims?.org_id).toBeUndefined();
      }
    });

    it("treats null activeOrganizationId as no org", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123", activeOrganizationId: null },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.activeOrganizationId).toBeUndefined();
        expect(result.user.claims?.org_id).toBeUndefined();
      }
    });
  });

  // passkeyCount is read by `mfaRequired` to admit passkey-only admins.
  // The claim must always be present and authoritative — a missing field
  // silently locks out passkey users; a spread-overridable field lets a
  // hostile session-user payload inflate the count.
  describe("passkeyCount claim", () => {
    it("populates passkeyCount: 0 in claims when internal DB is unavailable", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
        expect(typeof result.user.claims?.passkeyCount).toBe("number");
      }
    });

    it("populates passkeyCount with the value from the passkey table when DB is up", async () => {
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([{ count: 2 }]);
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(2);
      }
    });

    it("returns 0 when the count row is missing entirely", async () => {
      // pg returns no rows — should land 0, not NaN/undefined, so the gate's
      // `typeof === "number"` narrow continues to read a valid number.
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.resolve([]);
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
        expect(Number.isFinite(result.user.claims?.passkeyCount as number)).toBe(true);
      }
    });

    it("falls back to 0 when internalQuery throws (transient infra error)", async () => {
      // Auth must still succeed — failing the whole login because of a
      // passkey-count read would be a much worse outcome than gating the user.
      mockHasInternalDB = true;
      mockInternalQuery = () => Promise.reject(new Error("connection refused"));
      mockGetSession.mockResolvedValueOnce({
        user: { id: "usr_123", email: "alice@example.com" },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
      }
    });

    it("attacker-controlled passkeyCount on the session user cannot bypass the gate", async () => {
      // Computed fields land AFTER the spread (managed.ts), so a hostile
      // session-user payload that already carries `passkeyCount: "9999"`
      // gets shadowed by the resolver's authoritative 0.
      mockHasInternalDB = false; // resolver returns 0
      mockGetSession.mockResolvedValueOnce({
        user: {
          id: "usr_123",
          email: "alice@example.com",
          passkeyCount: "9999" as unknown as number,
        },
        session: { id: "sess_abc", userId: "usr_123" },
      });

      const result = await validateManaged(makeRequest());

      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.claims?.passkeyCount).toBe(0);
      }
    });
  });
});
