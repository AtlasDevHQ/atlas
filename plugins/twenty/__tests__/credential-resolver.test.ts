/**
 * TwentyCredentialResolver unit tests — env-var path AND
 * per-workspace DB-row precedence.
 *
 * The combinatorial matrix is exercised below:
 *
 *   env-var ✗  DB-row ✗  → throws (actionable message)
 *   env-var ✓  DB-row ✗  → env fallback
 *   env-var ✗  DB-row ✓  → DB row wins
 *   env-var ✓  DB-row ✓  → DB row wins (env ignored)
 *
 * Failure modes covered:
 *   transport-throw          → env fallback (fail-open against pg blips)
 *   decrypt-throw            → propagates (fail-closed — operator misconfig)
 *   empty / whitespace key   → falls through to env
 *
 * The `DbCredentialLookup` callback is injected by tests so we never
 * touch a real Postgres pool here — the lookup is the boundary
 * between the resolver and the integration-store layer.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveCredentialsFromEnv,
  resolveCredentialsForWorkspace,
  tryResolveCredentialsFromEnv,
  TwentyCredentialError,
  TwentyDecryptError,
  isTwentyDecryptError,
  assertTwentyApiKey,
  assertTwentyBaseUrl,
  type DbCredentialLookup,
  type DbCredentialLookupResult,
} from "../src/credential-resolver";

// The exact actionable message the resolver throws when neither
// the DB row nor env supplies credentials. Pinned so any future copy
// drift is caught.
const ABSENT_CREDS_MESSAGE =
  "Twenty credentials missing: set TWENTY_API_KEY (and optionally TWENTY_BASE_URL) in " +
  "the environment, or configure them under Admin → Integrations → Twenty.";

// ─────────────────────────────────────────────────────────────────────
//  Brand assertion helpers
// ─────────────────────────────────────────────────────────────────────

describe("assertTwentyApiKey", () => {
  test("trims surrounding whitespace and brands a non-empty key", () => {
    const key: string = assertTwentyApiKey("  abc-123  ");
    expect(key).toBe("abc-123");
  });

  test("throws TwentyCredentialError on empty / whitespace-only input", () => {
    expect(() => assertTwentyApiKey("")).toThrow(TwentyCredentialError);
    expect(() => assertTwentyApiKey("   ")).toThrow(TwentyCredentialError);
  });
});

describe("assertTwentyBaseUrl", () => {
  test("accepts https URLs and strips trailing slashes", () => {
    const baseUrl: string = assertTwentyBaseUrl("https://crm.example.com///");
    expect(baseUrl).toBe("https://crm.example.com");
  });

  test("accepts http URLs (dev / private network)", () => {
    const baseUrl: string = assertTwentyBaseUrl("http://localhost:3000");
    expect(baseUrl).toBe("http://localhost:3000");
  });

  test("rejects malformed URLs", () => {
    expect(() => assertTwentyBaseUrl("not-a-url")).toThrow(TwentyCredentialError);
  });

  test("rejects non-http(s) schemes", () => {
    expect(() => assertTwentyBaseUrl("ftp://crm.example.com")).toThrow(
      TwentyCredentialError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  isTwentyDecryptError type-guard
// ─────────────────────────────────────────────────────────────────────

describe("isTwentyDecryptError", () => {
  test("returns true for TwentyDecryptError instances", () => {
    expect(isTwentyDecryptError(new TwentyDecryptError("nope"))).toBe(true);
  });

  test("returns true for structural matches (decryptFailed === true)", () => {
    expect(isTwentyDecryptError({ decryptFailed: true })).toBe(true);
  });

  test("returns false for plain Errors and unrelated objects", () => {
    expect(isTwentyDecryptError(new Error("transport"))).toBe(false);
    expect(isTwentyDecryptError({})).toBe(false);
    expect(isTwentyDecryptError(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Env-var path
// ─────────────────────────────────────────────────────────────────────

describe("resolveCredentialsFromEnv", () => {
  test("returns the apiKey when TWENTY_API_KEY is set; baseUrl is undefined without TWENTY_BASE_URL", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc123" },
    });
    expect(result.apiKey).toBe("abc123");
    expect(result.baseUrl).toBeUndefined();
    expect(result.source).toBe("env");
  });

  test("returns the configured baseUrl when TWENTY_BASE_URL is set", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
    expect(result.source).toBe("env");
  });

  test("trims trailing slashes on baseUrl (no regex backtracking)", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com///" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
  });

  test("trims surrounding whitespace on apiKey", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "  abc  " },
    });
    expect(result.apiKey).toBe("abc");
  });

  test("throws TwentyCredentialError with the exact actionable message when TWENTY_API_KEY is absent", () => {
    try {
      resolveCredentialsFromEnv({ env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      expect((err as Error).message).toBe(ABSENT_CREDS_MESSAGE);
    }
  });

  test("throws when TWENTY_API_KEY is the empty string", () => {
    expect(() =>
      resolveCredentialsFromEnv({ env: { TWENTY_API_KEY: "" } }),
    ).toThrow(TwentyCredentialError);
  });

  test("throws when TWENTY_API_KEY is whitespace only", () => {
    expect(() =>
      resolveCredentialsFromEnv({ env: { TWENTY_API_KEY: "   " } }),
    ).toThrow(TwentyCredentialError);
  });

  test("baseUrl is undefined when TWENTY_BASE_URL is empty", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "" },
    });
    expect(result.baseUrl).toBeUndefined();
  });
});

describe("tryResolveCredentialsFromEnv", () => {
  test("returns the resolved credentials when env is set", () => {
    const result = tryResolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc" },
    });
    expect(result?.apiKey).toBe("abc");
  });

  test("returns null when TWENTY_API_KEY is absent (no throw)", () => {
    const result = tryResolveCredentialsFromEnv({ env: {} });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Per-workspace DB-row precedence
// ─────────────────────────────────────────────────────────────────────

/** Make a single-call DbCredentialLookup stub that returns the given row. */
function lookupReturning(row: DbCredentialLookupResult | null): DbCredentialLookup {
  return async (_workspaceId) => row;
}

/** Lookup that records every workspaceId it was called with. */
function recordingLookup(row: DbCredentialLookupResult | null): {
  readonly fn: DbCredentialLookup;
  readonly calls: ReadonlyArray<string>;
} {
  const calls: string[] = [];
  const fn: DbCredentialLookup = async (workspaceId) => {
    calls.push(workspaceId);
    return row;
  };
  return { fn, calls };
}

describe("resolveCredentialsForWorkspace — DB row precedence", () => {
  test("matrix: env=absent, db=absent → throws TwentyCredentialError", async () => {
    await expect(
      resolveCredentialsForWorkspace("ws-1", {
        env: {},
        lookup: lookupReturning(null),
      }),
    ).rejects.toBeInstanceOf(TwentyCredentialError);
  });

  test("matrix: env=present, db=absent → env fallback (source: env)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning(null),
    });
    expect(result.apiKey).toBe("env-key");
    expect(result.baseUrl).toBe("https://env.example.com");
    expect(result.source).toBe("env");
  });

  test("matrix: env=absent, db=present → DB row wins (source: db)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: {},
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://db.example.com");
    expect(result.source).toBe("db");
  });

  test("matrix: env=present, db=present → DB row wins (env ignored, source: db)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://db.example.com");
    expect(result.source).toBe("db");
  });

  test("DB row with null baseUrl → baseUrl falls back to env (still source: db)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning({ apiKey: "db-key", baseUrl: null }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://env.example.com");
    expect(result.source).toBe("db");
  });

  test("DB row with null baseUrl and no env baseUrl → baseUrl undefined", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: lookupReturning({ apiKey: "db-key", baseUrl: null }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBeUndefined();
  });

  test("DB row trims trailing slashes on baseUrl", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: {},
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com///",
      }),
    });
    expect(result.baseUrl).toBe("https://db.example.com");
  });

  test("lookup is invoked with the supplied workspaceId verbatim", async () => {
    const { fn, calls } = recordingLookup(null);
    await expect(
      resolveCredentialsForWorkspace("ws-42", {
        env: { TWENTY_API_KEY: "env-key" },
        lookup: fn,
      }),
    ).resolves.toMatchObject({ apiKey: "env-key" });
    expect(calls).toEqual(["ws-42"]);
  });

  test("transport-throw lookup → falls back to env (fail-open against pg blips)", async () => {
    const failingLookup: DbCredentialLookup = async () => {
      throw new Error("pg connection refused");
    };
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: failingLookup,
    });
    expect(result.apiKey).toBe("env-key");
    expect(result.source).toBe("env");
  });

  test("transport-throw AND env absent → throws TwentyCredentialError (no silent success)", async () => {
    const failingLookup: DbCredentialLookup = async () => {
      throw new Error("pg connection refused");
    };
    await expect(
      resolveCredentialsForWorkspace("ws-1", {
        env: {},
        lookup: failingLookup,
      }),
    ).rejects.toBeInstanceOf(TwentyCredentialError);
  });

  test("decrypt-throw lookup → propagates (fail-CLOSED — operator misconfig)", async () => {
    const decryptFailLookup: DbCredentialLookup = async () => {
      throw new TwentyDecryptError("key version v2 missing from ATLAS_ENCRYPTION_KEYS");
    };
    await expect(
      resolveCredentialsForWorkspace("ws-1", {
        env: { TWENTY_API_KEY: "env-key" },
        lookup: decryptFailLookup,
      }),
    ).rejects.toBeInstanceOf(TwentyDecryptError);
  });

  test("decrypt-throw lookup (structural decryptFailed flag) → propagates", async () => {
    const decryptFailLookup: DbCredentialLookup = async () => {
      const err = new Error("opaque decrypt failure");
      Object.assign(err, { decryptFailed: true });
      throw err;
    };
    await expect(
      resolveCredentialsForWorkspace("ws-1", {
        env: { TWENTY_API_KEY: "env-key" },
        lookup: decryptFailLookup,
      }),
    ).rejects.toMatchObject({ decryptFailed: true });
  });

  test("DB row with empty apiKey is treated as absent → falls back to env", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: lookupReturning({ apiKey: "", baseUrl: "https://db.example.com" }),
    });
    expect(result.apiKey).toBe("env-key");
    expect(result.source).toBe("env");
  });

  test("DB row with whitespace-only apiKey is treated as absent → falls back to env", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: lookupReturning({ apiKey: "   ", baseUrl: "https://db.example.com" }),
    });
    expect(result.apiKey).toBe("env-key");
  });

  test("DB row apiKey is trimmed before use", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: {},
      lookup: lookupReturning({ apiKey: "  db-key  ", baseUrl: null }),
    });
    expect(result.apiKey).toBe("db-key");
  });

  test("absence error message matches the exact actionable copy", async () => {
    try {
      await resolveCredentialsForWorkspace("ws-1", {
        env: {},
        lookup: lookupReturning(null),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      expect((err as Error).message).toBe(ABSENT_CREDS_MESSAGE);
    }
  });

  test("works with no lookup supplied — pure env path (back-compat)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
    });
    expect(result.apiKey).toBe("env-key");
    expect(result.source).toBe("env");
  });
});
