/**
 * TwentyCredentialResolver unit tests — env-var path AND
 * per-workspace DB-row precedence (Slice 7 / #2732).
 *
 * The combinatorial matrix is exercised below:
 *
 *   env-var ✗  DB-row ✗  → throws (actionable message)
 *   env-var ✓  DB-row ✗  → env fallback
 *   env-var ✗  DB-row ✓  → DB row wins
 *   env-var ✓  DB-row ✓  → DB row wins (env ignored)
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
  type DbCredentialLookup,
  type DbCredentialLookupResult,
} from "../src/credential-resolver";

// ─────────────────────────────────────────────────────────────────────
//  Env-var path (existing — unchanged in Slice 7)
// ─────────────────────────────────────────────────────────────────────

describe("resolveCredentialsFromEnv", () => {
  test("returns the apiKey when TWENTY_API_KEY is set; baseUrl is undefined without TWENTY_BASE_URL", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc123" },
    });
    expect(result.apiKey).toBe("abc123");
    // No hard-coded fallback — caller supplies its own default.
    expect(result.baseUrl).toBeUndefined();
  });

  test("returns the configured baseUrl when TWENTY_BASE_URL is set", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
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

  test("throws TwentyCredentialError with actionable message when TWENTY_API_KEY is absent", () => {
    try {
      resolveCredentialsFromEnv({ env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      expect(msg).toContain("TWENTY_API_KEY");
      expect(msg).toContain("TWENTY_BASE_URL");
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
//  Per-workspace DB-row precedence (Slice 7 / #2732)
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

  test("matrix: env=present, db=absent → env fallback", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning(null),
    });
    expect(result.apiKey).toBe("env-key");
    expect(result.baseUrl).toBe("https://env.example.com");
  });

  test("matrix: env=absent, db=present → DB row wins", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: {},
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://db.example.com");
  });

  test("matrix: env=present, db=present → DB row wins (env ignored)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://db.example.com");
  });

  test("DB row with null baseUrl → baseUrl falls back to env", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key", TWENTY_BASE_URL: "https://env.example.com" },
      lookup: lookupReturning({ apiKey: "db-key", baseUrl: null }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://env.example.com");
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

  test("lookup that throws → falls back to env (fail-open against transient DB blips)", async () => {
    const failingLookup: DbCredentialLookup = async () => {
      throw new Error("pg connection refused");
    };
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: failingLookup,
    });
    // The resolver swallows the lookup error and falls back to env so a
    // pg blip doesn't break dispatch. The DB-row path is "optional override",
    // not a hard requirement — env is the documented fallback.
    expect(result.apiKey).toBe("env-key");
  });

  test("lookup throws AND env absent → throws TwentyCredentialError (no silent success)", async () => {
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

  test("DB row with empty apiKey is treated as absent → falls back to env", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: lookupReturning({ apiKey: "", baseUrl: "https://db.example.com" }),
    });
    expect(result.apiKey).toBe("env-key");
  });

  test("DB row with whitespace-only apiKey is treated as absent → falls back to env", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
      lookup: lookupReturning({ apiKey: "   ", baseUrl: "https://db.example.com" }),
    });
    expect(result.apiKey).toBe("env-key");
  });

  test("error message references both env var and admin UI path", async () => {
    try {
      await resolveCredentialsForWorkspace("ws-1", {
        env: {},
        lookup: lookupReturning(null),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      expect(msg).toContain("TWENTY_API_KEY");
      expect(msg).toContain("Admin");
      expect(msg).toContain("Twenty");
    }
  });

  test("works with no lookup supplied — pure env path (back-compat)", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      env: { TWENTY_API_KEY: "env-key" },
    });
    expect(result.apiKey).toBe("env-key");
  });
});
