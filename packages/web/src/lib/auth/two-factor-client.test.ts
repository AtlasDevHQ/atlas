import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

// `authClient` is the namespace `getTwoFactorClient` reads. Each test
// reassigns the `twoFactor` field below to exercise a different branch
// of the method-presence guard.
const authClientStub: { twoFactor?: unknown } = {};

mock.module("./client", () => ({
  authClient: authClientStub,
}));

import {
  unwrapTwoFactorResult,
  getTwoFactorClient,
  requireTwoFactorClient,
  type TwoFactorApiResult,
  type TwoFactorClient,
} from "./two-factor-client";

const consoleWarn = console.warn;
const warnCalls: unknown[][] = [];

beforeEach(() => {
  warnCalls.length = 0;
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as typeof console.warn;
  authClientStub.twoFactor = undefined;
});

afterEach(() => {
  console.warn = consoleWarn;
});

describe("unwrapTwoFactorResult", () => {
  test("ok=true on { data, error: null }", () => {
    const result: TwoFactorApiResult<{ token: string }> = {
      data: { token: "abc" },
      error: null,
    };
    const out = unwrapTwoFactorResult(result, "fallback");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.token).toBe("abc");
  });

  test("ok=false carries server message and raw error when error present", () => {
    const result: TwoFactorApiResult<unknown> = {
      data: null,
      error: { code: "INVALID_TOTP", message: "wrong code", status: 401 },
    };
    const out = unwrapTwoFactorResult(result, "fallback");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe("wrong code");
      expect(out.raw).toEqual({ code: "INVALID_TOTP", message: "wrong code", status: 401 });
    }
  });

  test("ok=false uses fallback when error has no message", () => {
    const result: TwoFactorApiResult<unknown> = {
      data: null,
      error: { code: "X" },
    };
    const out = unwrapTwoFactorResult(result, "fallback msg");
    if (!out.ok) expect(out.message).toBe("fallback msg");
  });

  test("empty envelope { data: null, error: null } emits breadcrumb and tags raw with EMPTY_ENVELOPE", () => {
    // Bypass the XOR — Better Auth occasionally produces this shape on a
    // 204-style response. The helper exists to catch it.
    const result = { data: null, error: null } as unknown as TwoFactorApiResult<unknown>;
    const out = unwrapTwoFactorResult(result, "fallback msg");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe("fallback msg");
      expect(out.raw).toEqual({ code: "EMPTY_ENVELOPE", message: "fallback msg" });
    }
    // Breadcrumb fired so support can distinguish wire-shape anomaly from
    // a normal failure.
    expect(warnCalls.length).toBe(1);
    expect(String(warnCalls[0][0])).toContain("empty envelope");
  });
});

describe("getTwoFactorClient — method-presence guard", () => {
  function fullStub(): Partial<TwoFactorClient> {
    return {
      enable: async () => ({ data: null, error: { code: "X" } }),
      disable: async () => ({ data: null, error: { code: "X" } }),
      verifyTotp: async () => ({ data: null, error: { code: "X" } }),
      verifyBackupCode: async () => ({ data: null, error: { code: "X" } }),
      generateBackupCodes: async () => ({ data: null, error: { code: "X" } }),
    };
  }

  test("returns null when plugin namespace is missing", () => {
    authClientStub.twoFactor = undefined;
    expect(getTwoFactorClient()).toBeNull();
  });

  test("returns null when namespace is present but enable is missing", () => {
    const stub = fullStub();
    delete stub.enable;
    authClientStub.twoFactor = stub;
    expect(getTwoFactorClient()).toBeNull();
  });

  test("returns null when verifyTotp is missing (Better Auth API drift)", () => {
    const stub = fullStub();
    delete stub.verifyTotp;
    authClientStub.twoFactor = stub;
    expect(getTwoFactorClient()).toBeNull();
  });

  test("returns null when verifyBackupCode is missing", () => {
    const stub = fullStub();
    delete stub.verifyBackupCode;
    authClientStub.twoFactor = stub;
    expect(getTwoFactorClient()).toBeNull();
  });

  test("returns null when a method is present but not callable", () => {
    const stub = fullStub() as Record<string, unknown>;
    stub.verifyTotp = "not a function";
    authClientStub.twoFactor = stub;
    expect(getTwoFactorClient()).toBeNull();
  });

  test("returns the namespace when every method is callable", () => {
    authClientStub.twoFactor = fullStub();
    const client = getTwoFactorClient();
    expect(client).not.toBeNull();
    expect(typeof client?.verifyTotp).toBe("function");
  });
});

describe("requireTwoFactorClient", () => {
  test("returns the client when present", () => {
    authClientStub.twoFactor = {
      enable: async () => ({ data: null, error: { code: "X" } }),
      disable: async () => ({ data: null, error: { code: "X" } }),
      verifyTotp: async () => ({ data: null, error: { code: "X" } }),
      verifyBackupCode: async () => ({ data: null, error: { code: "X" } }),
      generateBackupCodes: async () => ({ data: null, error: { code: "X" } }),
    };
    expect(() => requireTwoFactorClient()).not.toThrow();
  });

  test("throws when plugin missing", () => {
    authClientStub.twoFactor = undefined;
    expect(() => requireTwoFactorClient()).toThrow(/twoFactor client plugin is not loaded/);
  });
});
