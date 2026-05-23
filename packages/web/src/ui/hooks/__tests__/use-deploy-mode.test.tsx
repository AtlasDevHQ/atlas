import { describe, expect, test, mock } from "bun:test";
import { renderHook } from "@testing-library/react";

// Capture the opts `useAdminFetch` was called with so we can assert
// `enabled` is forwarded — that's the contract the chat-surface palette
// relies on to skip the admin-only fetch for member/viewer sessions.
let lastOpts: { enabled?: boolean } | undefined;
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (_path: string, opts?: { enabled?: boolean }) => {
    lastOpts = opts;
    return { data: null, loading: false, error: null, refetch: () => {} };
  },
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

mock.module("@/lib/api-url", () => ({
  setRegionalApiUrl: () => {},
  getApiUrl: () => "http://localhost:3001",
}));

const { useDeployMode } = await import("../use-deploy-mode");

describe("useDeployMode { enabled } forwarding", () => {
  test("default (no opts) leaves enabled undefined — useAdminFetch fetches by default", () => {
    lastOpts = undefined;
    renderHook(() => useDeployMode());
    expect(lastOpts).toEqual({ enabled: undefined });
  });

  test("explicit enabled: false threads through to skip the fetch", () => {
    // This is the security/perf contract for the chat-surface palette:
    // members and viewers must NOT fire `/api/v1/admin/settings`.
    lastOpts = undefined;
    renderHook(() => useDeployMode({ enabled: false }));
    expect(lastOpts).toEqual({ enabled: false });
  });

  test("explicit enabled: true also threads through", () => {
    lastOpts = undefined;
    renderHook(() => useDeployMode({ enabled: true }));
    expect(lastOpts).toEqual({ enabled: true });
  });

  test("falls back to the hostname guess when the fetch is disabled", () => {
    // On the test runner the URL is localhost (set in test-setup.ts);
    // localhost always resolves to self-hosted.
    const { result } = renderHook(() => useDeployMode({ enabled: false }));
    expect(result.current.deployMode).toBe("self-hosted");
  });
});
