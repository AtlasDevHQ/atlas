/**
 * Tests for `useMcpConnect`. Stub `@useatlas/sdk` via `mock.module` so
 * the hook never opens a real network connection — we drive
 * `beginConnect`/`completeConnect` manually and assert the lifecycle
 * (status transitions, sessionStorage bookkeeping, postMessage origin
 * guard, redirect-mode auto-complete, popup-closed watchdog).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";

// Mock the SDK module BEFORE importing the hook so the hook picks up
// the stubbed exports. Per the project rule "mock all named exports",
// we provide the full surface.
let beginConnectImpl = mock(async () => ({
  authorizationUrl: "https://atlas.test/authorize?mock",
  state: "stub-state",
  codeVerifier: "stub-verifier",
  clientId: "stub-client",
  tokenEndpoint: "https://atlas.test/api/auth/oauth2/token",
  issuer: "https://atlas.test/api/auth",
}));
let completeConnectImpl = mock(async () => ({
  accessToken: "tok-abc",
  refreshToken: "rfr-abc",
  expiresAt: Date.now() + 3600 * 1000,
  workspaceId: "ws-1",
}));

class StubAtlasMcpError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AtlasMcpError";
    this.code = code;
  }
}

mock.module("@useatlas/sdk", () => ({
  AtlasMcpError: StubAtlasMcpError,
  beginConnect: (...args: unknown[]) => beginConnectImpl(...(args as [])),
  completeConnect: (...args: unknown[]) => completeConnectImpl(...(args as [])),
  // Re-export only what the hook imports — the rest of the SDK isn't
  // needed for these tests. If the hook starts importing more, this
  // object should grow.
}));

import { useMcpConnect } from "../use-mcp-connect";

const APP_ORIGIN = "http://localhost:3000";
const REDIRECT = `${APP_ORIGIN}/oauth/callback`;

const baseOptions = {
  apiUrl: "https://atlas.test",
  clientName: "Test Embed",
  redirectUri: REDIRECT,
};

function resetSdkMocks() {
  beginConnectImpl = mock(async () => ({
    authorizationUrl: "https://atlas.test/authorize?mock",
    state: "stub-state",
    codeVerifier: "stub-verifier",
    clientId: "stub-client",
    tokenEndpoint: "https://atlas.test/api/auth/oauth2/token",
    issuer: "https://atlas.test/api/auth",
  }));
  completeConnectImpl = mock(async () => ({
    accessToken: "tok-abc",
    refreshToken: "rfr-abc",
    expiresAt: Date.now() + 3600 * 1000,
    workspaceId: "ws-1",
  }));
}

beforeEach(() => {
  resetSdkMocks();
  window.sessionStorage.clear();
  // happy-dom defaults to about:blank — pin the origin for the
  // postMessage same-origin guard. Tests that need to exercise
  // ?code/?state params write window.location.search directly.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.sessionStorage.clear();
});

// ── popup mode: same-origin postMessage guard ─────────────────────────

describe("useMcpConnect popup mode — postMessage origin guard", () => {
  it("ignores messages from foreign origins and stays in awaiting_callback", async () => {
    // Stub window.open to return a fake window-shape object so the
    // hook transitions into awaiting_callback without opening a real
    // popup.
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.status).toBe("awaiting_callback");
      expect(completeConnectImpl).not.toHaveBeenCalled();

      // Foreign-origin message must be dropped.
      await act(async () => {
        window.dispatchEvent(
          new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", {
            data: { type: "atlas-mcp-callback", code: "evil", state: "evil" },
            origin: "https://evil.example",
          }),
        );
      });

      expect(result.current.status).toBe("awaiting_callback");
      expect(completeConnectImpl).not.toHaveBeenCalled();
    } finally {
      window.open = originalOpen;
    }
  });

  it("accepts a same-origin callback and runs completeConnect", async () => {
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));

      await act(async () => {
        await result.current.connect();
      });

      await act(async () => {
        window.dispatchEvent(
          new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", {
            data: { type: "atlas-mcp-callback", code: "good-code", state: "stub-state" },
            origin: APP_ORIGIN,
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });
      expect(completeConnectImpl).toHaveBeenCalledTimes(1);
      if (result.current.status !== "success") throw new Error("expected success");
      expect(result.current.accessToken).toBe("tok-abc");
      expect(result.current.workspaceId).toBe("ws-1");
    } finally {
      window.open = originalOpen;
    }
  });

  it("surfaces callback_state_missing when sessionStorage was wiped mid-flow", async () => {
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));
      await act(async () => {
        await result.current.connect();
      });

      // Simulate the user clearing storage mid-flow.
      window.sessionStorage.clear();

      await act(async () => {
        window.dispatchEvent(
          new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", {
            data: { type: "atlas-mcp-callback", code: "good", state: "stub-state" },
            origin: APP_ORIGIN,
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.status).toBe("error");
      });
      if (result.current.status !== "error") throw new Error("expected error");
      const err = result.current.error as StubAtlasMcpError;
      expect(err.code).toBe("callback_state_missing");
    } finally {
      window.open = originalOpen;
    }
  });
});

// ── popup mode: closed watchdog ───────────────────────────────────────

describe("useMcpConnect popup mode — closed watchdog", () => {
  it("fires popup_closed when the user closes the popup before authorizing", async () => {
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.status).toBe("awaiting_callback");

      // Flip closed and let the watchdog interval observe it.
      fakePopup.closed = true;

      await waitFor(
        () => {
          expect(result.current.status).toBe("error");
        },
        { timeout: 2000 },
      );
      if (result.current.status !== "error") throw new Error("expected error");
      const err = result.current.error as StubAtlasMcpError;
      expect(err.code).toBe("popup_closed");
    } finally {
      window.open = originalOpen;
    }
  });

  it("surfaces popup_blocked when window.open returns null", async () => {
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => null;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.status).toBe("error");
      if (result.current.status !== "error") throw new Error("expected error");
      const err = result.current.error as StubAtlasMcpError;
      expect(err.code).toBe("popup_blocked");
    } finally {
      window.open = originalOpen;
    }
  });
});

// ── redirect mode auto-complete ───────────────────────────────────────

describe("useMcpConnect redirect mode — auto-complete on mount", () => {
  it("completes the exchange when ?code + ?state and persisted state are present", async () => {
    // Pre-seed sessionStorage as if a previous page had called connect()
    // and redirected.
    window.sessionStorage.setItem(
      `atlas-mcp-connect:${REDIRECT}`,
      JSON.stringify({
        state: "stub-state",
        codeVerifier: "stub-verifier",
        clientId: "stub-client",
        tokenEndpoint: "https://atlas.test/api/auth/oauth2/token",
        issuer: "https://atlas.test/api/auth",
        redirectUri: REDIRECT,
      }),
    );
    window.history.replaceState(
      null,
      "",
      `/oauth/callback?code=abc&state=stub-state`,
    );

    const { result } = renderHook(() =>
      useMcpConnect({ ...baseOptions, mode: "redirect" }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(completeConnectImpl).toHaveBeenCalledTimes(1);
    if (result.current.status !== "success") throw new Error("expected success");
    expect(result.current.accessToken).toBe("tok-abc");
    // Persisted entry is cleared after success.
    expect(window.sessionStorage.getItem(`atlas-mcp-connect:${REDIRECT}`)).toBeNull();
  });

  it("stays idle when ?code is missing", async () => {
    window.sessionStorage.setItem(
      `atlas-mcp-connect:${REDIRECT}`,
      JSON.stringify({
        state: "stub-state",
        codeVerifier: "stub-verifier",
        clientId: "stub-client",
        tokenEndpoint: "https://atlas.test/api/auth/oauth2/token",
        issuer: "https://atlas.test/api/auth",
        redirectUri: REDIRECT,
      }),
    );
    window.history.replaceState(null, "", `/oauth/callback?state=stub-state`);

    const { result } = renderHook(() =>
      useMcpConnect({ ...baseOptions, mode: "redirect" }),
    );

    // Give the effect a tick to no-op.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.status).toBe("idle");
    expect(completeConnectImpl).not.toHaveBeenCalled();
  });
});

// ── concurrent connect() calls ────────────────────────────────────────

describe("useMcpConnect concurrent connect() calls", () => {
  it("treats a second connect() call as a no-op while a flow is in flight", async () => {
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.status).toBe("awaiting_callback");
      expect(beginConnectImpl).toHaveBeenCalledTimes(1);

      // Second call should not re-enter beginConnect.
      await act(async () => {
        await result.current.connect();
      });
      expect(beginConnectImpl).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("awaiting_callback");
    } finally {
      window.open = originalOpen;
    }
  });
});

// ── reset ─────────────────────────────────────────────────────────────

describe("useMcpConnect reset()", () => {
  it("clears persisted state and returns to idle", async () => {
    const fakePopup = { closed: false, close: () => {} };
    const originalOpen = window.open;
    (window as unknown as { open: () => unknown }).open = () => fakePopup;

    try {
      const { result } = renderHook(() => useMcpConnect(baseOptions));

      await act(async () => {
        await result.current.connect();
      });

      await act(async () => {
        window.dispatchEvent(
          new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", {
            data: { type: "atlas-mcp-callback", code: "c", state: "stub-state" },
            origin: APP_ORIGIN,
          }),
        );
      });
      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.status).toBe("idle");
      if (result.current.status === "idle") {
        expect(result.current.accessToken).toBeNull();
        expect(result.current.error).toBeNull();
      }
    } finally {
      window.open = originalOpen;
    }
  });
});
