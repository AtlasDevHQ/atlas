import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { AtlasProvider } from "../../context";
import { useAtlasAuth } from "../use-atlas-auth";
import type { ReactNode } from "react";

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({ checks: { auth: { mode: "simple-key" } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
);

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider apiUrl="https://api.example.com" apiKey="test-key">
      {children}
    </AtlasProvider>
  );
}

/**
 * The per-test budget must EXCEED the 10000ms waiter budget below.
 *
 * bun's default per-test timeout is 5000ms, so a waiter allowed 10000ms
 * outlives the budget the whole test is given: under `--parallel`
 * contention the harness kills the test before the waiter can report, and the
 * failure carries no assertion — only "this test timed out after 5000ms".
 * Same defect as passkey-tile.test.tsx, where it was reproduced.
 */
const TEST_TIMEOUT = 30000;

describe("useAtlasAuth", () => {
  it("starts in loading state", () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper });
    expect(result.current.authMode).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("detects auth mode from health endpoint", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("reports unauthenticated when no API key for simple-key mode", async () => {
    function noKeyWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com">
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), {
      wrapper: noKeyWrapper,
    });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    expect(result.current.isAuthenticated).toBe(false);
  });

  it("reports authenticated for none auth mode without credentials", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ checks: { auth: { mode: "none" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    function noKeyWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com">
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), {
      wrapper: noKeyWrapper,
    });

    await waitFor(() => {
      expect(result.current.authMode).toBe("none");
    });

    expect(result.current.isAuthenticated).toBe(true);
  });

  it("reports authenticated for byot mode with API key", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ checks: { auth: { mode: "byot" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const { result } = renderHook(() => useAtlasAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("byot");
    });

    expect(result.current.isAuthenticated).toBe(true);
  });

  it("falls back to none and sets error on health endpoint failure", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("", { status: 500 })),
    );

    const { result } = renderHook(() => useAtlasAuth(), { wrapper });

    await waitFor(
      () => {
        expect(result.current.authMode).toBe("none");
      },
      { timeout: 10000 },
    );

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("500");
  }, TEST_TIMEOUT);

  it("falls back to none and sets error on network failure", async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error("Network unreachable")),
    );

    const { result } = renderHook(() => useAtlasAuth(), { wrapper });

    await waitFor(
      () => {
        expect(result.current.authMode).toBe("none");
      },
      { timeout: 10000 },
    );

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain("Network unreachable");
  }, TEST_TIMEOUT);

  it("login delegates to authClient and returns error", async () => {
    const mockSignIn = mock(() =>
      Promise.resolve({ error: { message: "Invalid credentials" } }),
    );
    const customAuthClient = {
      signIn: { email: mockSignIn },
      signUp: { email: async () => ({ error: null }) },
      signOut: async () => {},
      useSession: () => ({ data: null, isPending: false }),
    };

    function customWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com" authClient={customAuthClient}>
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: customWrapper });

    let loginResult: { error?: string } = {};
    await act(async () => {
      loginResult = await result.current.login("user@test.com", "wrong");
    });

    expect(mockSignIn).toHaveBeenCalledWith({
      email: "user@test.com",
      password: "wrong",
    });
    expect(loginResult.error).toBe("Invalid credentials");
  });

  it("login catches thrown exceptions from auth client", async () => {
    const customAuthClient = {
      signIn: { email: async () => { throw new Error("Network error"); } },
      signUp: { email: async () => ({ error: null }) },
      signOut: async () => {},
      useSession: () => ({ data: null, isPending: false }),
    };

    function customWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com" authClient={customAuthClient}>
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: customWrapper });

    let loginResult: { error?: string } = {};
    await act(async () => {
      loginResult = await result.current.login("user@test.com", "pass");
    });

    expect(loginResult.error).toBe("Network error");
  });

  it("logout returns error instead of throwing", async () => {
    const customAuthClient = {
      signIn: { email: async () => ({ error: null }) },
      signUp: { email: async () => ({ error: null }) },
      signOut: async () => { throw new Error("Session expired"); },
      useSession: () => ({ data: null, isPending: false }),
    };

    function customWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com" authClient={customAuthClient}>
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: customWrapper });

    let logoutResult: { error?: string } = {};
    await act(async () => {
      logoutResult = await result.current.logout();
    });

    expect(logoutResult.error).toBe("Session expired");
  });

  it("managed auth with active session is authenticated", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ checks: { auth: { mode: "managed" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const customAuthClient = {
      signIn: { email: async () => ({ error: null }) },
      signUp: { email: async () => ({ error: null }) },
      signOut: async () => {},
      useSession: () => ({
        data: { user: { email: "user@test.com" } },
        isPending: false,
      }),
    };

    function managedWrapper({ children }: { children: ReactNode }) {
      return (
        <AtlasProvider apiUrl="https://api.example.com" authClient={customAuthClient}>
          {children}
        </AtlasProvider>
      );
    }

    const { result } = renderHook(() => useAtlasAuth(), { wrapper: managedWrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("managed");
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.session?.user?.email).toBe("user@test.com");
  });
});
