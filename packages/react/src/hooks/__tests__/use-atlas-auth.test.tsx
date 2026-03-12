import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { AtlasProvider } from "../provider";
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

describe("useAtlasAuth", () => {
  it("starts in pending state", () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper });
    expect(result.current.authMode).toBeNull();
    expect(result.current.isPending).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("detects auth mode from health endpoint", async () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.authMode).toBe("simple-key");
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
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

  it("falls back to none on health endpoint failure", async () => {
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
  });

  it("exposes login/signup/logout functions", () => {
    const { result } = renderHook(() => useAtlasAuth(), { wrapper });
    expect(typeof result.current.login).toBe("function");
    expect(typeof result.current.signup).toBe("function");
    expect(typeof result.current.logout).toBe("function");
  });
});
