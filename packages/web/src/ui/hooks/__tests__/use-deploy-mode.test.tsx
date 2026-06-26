import { describe, expect, test, mock } from "bun:test";
import { renderHook } from "@testing-library/react";
import { buildFetchError } from "@/ui/lib/fetch-error";

// Capture the opts `useAdminFetch` was called with so we can assert
// `enabled` is forwarded — that's the contract the chat-surface palette
// relies on to skip the admin-only fetch for member/viewer sessions.
// `fetchReturn` is mutable so each test can stage loading / error / data
// states without re-mocking the module.
let lastOpts: { enabled?: boolean } | undefined;
let fetchReturn: {
  data: unknown;
  loading: boolean;
  error: unknown;
  refetch: () => void;
} = { data: null, loading: false, error: null, refetch: () => {} };

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (_path: string, opts?: { enabled?: boolean }) => {
    lastOpts = opts;
    return fetchReturn;
  },
  useInProgressSet: () => ({
    has: () => false,
    start: () => {},
    stop: () => {},
  }),
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { useDeployMode } = await import("../use-deploy-mode");

function staged(overrides: Partial<typeof fetchReturn>) {
  fetchReturn = {
    data: null,
    loading: false,
    error: null,
    refetch: () => {},
    ...overrides,
  };
}

describe("useDeployMode { enabled } forwarding", () => {
  test("default (no opts) leaves enabled undefined — useAdminFetch fetches by default", () => {
    staged({});
    lastOpts = undefined;
    renderHook(() => useDeployMode());
    expect(lastOpts).toEqual({ enabled: undefined });
  });

  test("explicit enabled: false threads through to skip the fetch", () => {
    // This is the security/perf contract for the chat-surface palette:
    // members and viewers must NOT fire `/api/v1/admin/settings`.
    staged({});
    lastOpts = undefined;
    renderHook(() => useDeployMode({ enabled: false }));
    expect(lastOpts).toEqual({ enabled: false });
  });

  test("explicit enabled: true also threads through", () => {
    staged({});
    lastOpts = undefined;
    renderHook(() => useDeployMode({ enabled: true }));
    expect(lastOpts).toEqual({ enabled: true });
  });

  test("falls back to the hostname guess when the fetch is disabled", () => {
    // On the test runner the URL is localhost (set in test-setup.ts);
    // localhost always resolves to self-hosted.
    staged({});
    const { result } = renderHook(() => useDeployMode({ enabled: false }));
    expect(result.current.deployMode).toBe("self-hosted");
  });
});

describe("useDeployMode resolved (guess vs authoritative, #3378)", () => {
  // `resolved` is the consumer contract for the deploy-mode parity rules
  // (Rule 2 in docs/development/enterprise-gating.md): view-swapping and
  // value-writing consumers must not commit to the mode unless it came
  // from the server. It must be false on ALL three guess paths — loading,
  // fetch error, and `enabled: false` — the last of which `loading`/`error`
  // alone cannot distinguish from a successful resolve.

  test("resolved is true when the server answered, and the server value wins over the guess", () => {
    // Test runner host is localhost → guess would say "self-hosted"; the
    // server says "saas". The authoritative answer must win.
    staged({ data: { settings: [], manageable: true, deployMode: "saas" } });
    const { result } = renderHook(() => useDeployMode());
    expect(result.current.resolved).toBe(true);
    expect(result.current.deployMode).toBe("saas");
  });

  test("resolved is false while loading", () => {
    staged({ loading: true });
    const { result } = renderHook(() => useDeployMode());
    expect(result.current.resolved).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  test("resolved is false on fetch error — the returned mode is only a guess", () => {
    staged({ error: buildFetchError({ message: "HTTP 403", status: 403 }) });
    const { result } = renderHook(() => useDeployMode());
    expect(result.current.resolved).toBe(false);
    expect(result.current.error).not.toBeNull();
    // The guess is still returned for cosmetic-tier consumers.
    expect(result.current.deployMode).toBe("self-hosted");
  });

  test("resolved is false when the fetch is disabled (enabled: false reports loading: false, error: null)", () => {
    staged({});
    const { result } = renderHook(() => useDeployMode({ enabled: false }));
    expect(result.current.resolved).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
