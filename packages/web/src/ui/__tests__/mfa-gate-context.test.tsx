import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  MfaGateProvider,
  useMfaGate,
  useMfaGateOptional,
  consumeOriginPath,
} from "../components/admin/mfa-gate-context";

let mockPathname = "/admin/users";

mock.module("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const ORIGIN_PATH_KEY = "atlas:mfa-origin-path";

function providerWrapper({ children }: { children: ReactNode }) {
  return createElement(MfaGateProvider, null, children);
}

beforeEach(() => {
  mockPathname = "/admin/users";
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("MfaGateProvider.trigger", () => {
  test("opens the gate and stashes the current pathname", () => {
    mockPathname = "/admin/sandbox";
    const { result } = renderHook(() => useMfaGate(), { wrapper: providerWrapper });

    act(() => {
      result.current.trigger("/admin/account-security");
    });

    expect(result.current.state).not.toBeNull();
    expect(result.current.state!.enrollmentUrl).toBe("/admin/account-security");
    expect(window.sessionStorage.getItem(ORIGIN_PATH_KEY)).toBe("/admin/sandbox");
  });

  test("no-op when on the enrollment page", () => {
    mockPathname = "/admin/account-security";
    const { result } = renderHook(() => useMfaGate(), { wrapper: providerWrapper });

    act(() => {
      result.current.trigger("/admin/account-security");
    });

    expect(result.current.state).toBeNull();
    expect(window.sessionStorage.getItem(ORIGIN_PATH_KEY)).toBeNull();
  });

  test("no-op on nested security page paths", () => {
    mockPathname = "/admin/account-security/audit-log";
    const { result } = renderHook(() => useMfaGate(), { wrapper: providerWrapper });

    act(() => {
      result.current.trigger("/admin/account-security");
    });

    expect(result.current.state).toBeNull();
  });

  test("idempotent — first call wins, second is dropped", () => {
    // Concurrent fan-out (parallel admin queries on a fresh page load) must
    // not stomp the first failure's stashed origin path.
    mockPathname = "/admin/users";
    const { result } = renderHook(() => useMfaGate(), { wrapper: providerWrapper });

    act(() => {
      result.current.trigger("/admin/account-security");
    });

    const firstState = result.current.state;
    expect(firstState).not.toBeNull();
    expect(window.sessionStorage.getItem(ORIGIN_PATH_KEY)).toBe("/admin/users");

    // Simulate a different pathname for the second call (impossible in
    // practice with a stable usePathname, but proves the sessionStorage
    // write is gated by the prev=null branch).
    act(() => {
      result.current.trigger("/admin/different-target");
    });

    expect(result.current.state!.enrollmentUrl).toBe("/admin/account-security");
    expect(window.sessionStorage.getItem(ORIGIN_PATH_KEY)).toBe("/admin/users");
  });

  test("clear() resets state", () => {
    const { result } = renderHook(() => useMfaGate(), { wrapper: providerWrapper });

    act(() => {
      result.current.trigger("/admin/account-security");
    });
    expect(result.current.state).not.toBeNull();

    act(() => {
      result.current.clear();
    });
    expect(result.current.state).toBeNull();
  });
});

describe("consumeOriginPath", () => {
  test("reads + clears the stashed origin atomically", () => {
    window.sessionStorage.setItem(ORIGIN_PATH_KEY, "/admin/sandbox");

    expect(consumeOriginPath()).toBe("/admin/sandbox");
    expect(window.sessionStorage.getItem(ORIGIN_PATH_KEY)).toBeNull();
    expect(consumeOriginPath()).toBeNull();
  });

  test("returns null when no origin was stashed", () => {
    expect(consumeOriginPath()).toBeNull();
  });

  test("fails open when sessionStorage throws", () => {
    const originalGetItem = window.sessionStorage.getItem;
    window.sessionStorage.getItem = mock(() => {
      throw new Error("private mode");
    }) as typeof window.sessionStorage.getItem;

    try {
      expect(consumeOriginPath()).toBeNull();
    } finally {
      window.sessionStorage.getItem = originalGetItem;
    }
  });
});

describe("useMfaGate without provider", () => {
  test("throws — admin surfaces must mount the provider", () => {
    // Suppress React's error-boundary console output during the throw.
    const originalError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    try {
      expect(() => renderHook(() => useMfaGate())).toThrow(
        /must be used inside.*MfaGateProvider/,
      );
    } finally {
      console.error = originalError;
    }
  });
});

describe("useMfaGateOptional without provider", () => {
  test("returns a no-op gate that does not throw", () => {
    const originalWarn = console.warn;
    const warnSpy = mock(() => {}) as typeof console.warn;
    console.warn = warnSpy;

    try {
      const { result } = renderHook(() => useMfaGateOptional());
      expect(result.current.state).toBeNull();

      act(() => {
        result.current.trigger("/admin/account-security");
      });

      expect(result.current.state).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
