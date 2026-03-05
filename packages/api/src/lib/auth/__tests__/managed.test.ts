import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { validateManaged } from "../managed";
import { _setAuthInstance } from "../server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetSession = mock((): Promise<any> => Promise.resolve(null));

describe("validateManaged()", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    // Inject a fake auth instance whose api.getSession is our mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setAuthInstance({ api: { getSession: mockGetSession } } as any);
  });

  afterEach(() => {
    _setAuthInstance(null);
  });

  function makeRequest(headers?: Record<string, string>): Request {
    return new Request("http://localhost/api/chat", {
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
});
