import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePasswordStatus } from "../hooks/use-password-status";
import { AtlasProvider } from "../context";

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
      },
      children,
    ),
  );
}

const originalFetch = globalThis.fetch;

function mockResp(status: number, body?: unknown): typeof fetch {
  return mock(() =>
    Promise.resolve(
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
    ),
  ) as unknown as typeof fetch;
}

describe("usePasswordStatus discriminated result", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test('200 → kind: "allowed" with passwordChangeRequired', async () => {
    globalThis.fetch = mockResp(200, {
      passwordChangeRequired: true,
      mfaRequired: false,
      enrollmentUrl: "/admin/account-security",
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "allowed",
      passwordChangeRequired: true,
    });
  });

  test('403 forbidden_role → kind: "denied"', async () => {
    globalThis.fetch = mockResp(403, { error: "forbidden_role", message: "x" });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({ kind: "denied" });
  });

  test('403 mfa_enrollment_required → kind: "mfa-required" with enrollmentUrl', async () => {
    globalThis.fetch = mockResp(403, {
      error: "mfa_enrollment_required",
      enrollmentUrl: "/admin/account-security",
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "mfa-required",
      enrollmentUrl: "/admin/account-security",
    });
  });

  test('403 with non-JSON body → kind: "denied" (safer default)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({ kind: "denied" });
  });

  test('403 mfa_enrollment_required without enrollmentUrl → uses default URL', async () => {
    globalThis.fetch = mockResp(403, { error: "mfa_enrollment_required" });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "mfa-required",
      enrollmentUrl: "/admin/account-security",
    });
  });

  // #2486 — the primary path. 200 + mfaRequired:true must produce the same
  // `mfa-required` discriminant as the 403 fallback, so the layout's
  // `data.kind === "mfa-required"` branch fires from either source.
  test('200 mfaRequired:true → kind: "mfa-required" with enrollmentUrl', async () => {
    globalThis.fetch = mockResp(200, {
      passwordChangeRequired: false,
      mfaRequired: true,
      enrollmentUrl: "/admin/account-security",
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "mfa-required",
      enrollmentUrl: "/admin/account-security",
    });
  });

  test("200 mfaRequired:true takes precedence over passwordChangeRequired", async () => {
    // An unenrolled admin who ALSO has a password change pending must hit
    // the MFA gate first; the change-password dialog comes later, after
    // enrollment unblocks the rest of the admin tree.
    globalThis.fetch = mockResp(200, {
      passwordChangeRequired: true,
      mfaRequired: true,
      enrollmentUrl: "/admin/account-security",
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "mfa-required",
      enrollmentUrl: "/admin/account-security",
    });
  });

  test("200 mfaRequired:true without enrollmentUrl → uses default URL", async () => {
    globalThis.fetch = mockResp(200, {
      passwordChangeRequired: false,
      mfaRequired: true,
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "mfa-required",
      enrollmentUrl: "/admin/account-security",
    });
  });

  // #2486 — strict typeof rejection. If a future server build drops the
  // `mfaRequired` field from the 200 body, the hook MUST throw instead of
  // silently classifying as `allowed` — otherwise the layout-level gate
  // would silently disappear (server-side middleware still enforces, so
  // it's not a security hole, but the user-facing gate this PR ships
  // would regress invisibly). Pair with the wire-shape lock on the API
  // side that asserts the field is always emitted.
  test("200 missing mfaRequired field → throws (contract regression)", async () => {
    // Hook's TanStack `retry: 1` retries once before surfacing isError.
    // Silence the expected console.warn so it doesn't pollute test output.
    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;
    try {
      globalThis.fetch = mockResp(200, {
        passwordChangeRequired: false,
        // mfaRequired intentionally omitted
        enrollmentUrl: "/admin/account-security",
      });

      const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error?.message ?? "").toContain("unexpected response");
    } finally {
      console.warn = originalWarn;
    }
  });

  test('200 mfaRequired:false → kind: "allowed" (gate stays closed)', async () => {
    globalThis.fetch = mockResp(200, {
      passwordChangeRequired: false,
      mfaRequired: false,
      enrollmentUrl: "/admin/account-security",
    });

    const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data).toEqual({
      kind: "allowed",
      passwordChangeRequired: false,
    });
  });

  test("500 throws → isError, no data", async () => {
    // The hook configures `retry: 1` so a 500 retries once before erroring.
    // Bump waitFor's timeout above the default 1s to cover the retry window.
    const originalWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      globalThis.fetch = mockResp(500);

      const { result } = renderHook(() => usePasswordStatus(true), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });

      expect(result.current.data).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("disabled when enabled=false — never fetches", () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("should not be called")),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => usePasswordStatus(false), { wrapper });

    expect(result.current.isPending).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});
