import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { validateManaged } from "../managed";
import { _setAuthInstance } from "../server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock return type is intentionally untyped to simulate Better Auth session responses
const mockGetSession = mock((): Promise<any> => Promise.resolve(null));

describe("validateManaged()", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    // Inject a fake auth instance whose api.getSession is our mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- injecting partial auth mock for testing
    _setAuthInstance({ api: { getSession: mockGetSession } } as any);
  });

  afterEach(() => {
    _setAuthInstance(null);
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
});
