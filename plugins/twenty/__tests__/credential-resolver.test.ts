/**
 * TwentyCredentialResolver unit tests — two-actor split (#2850).
 *
 * The split prevents cross-actor credential leaks:
 *   - {@link resolveOperatorCredentials}: env-only, reserved for
 *     `ee/src/saas-crm/`. Returns the operator's TWENTY_API_KEY.
 *   - {@link resolveWorkspaceCredentials}: DB-only (no env fallback),
 *     scoped to a workspace. `deployMode` only tailors the error
 *     message — both modes refuse to read env.
 *
 * The 7-case matrix from #2850 acceptance criteria, refined per the
 * "no installs use env" clarification:
 *
 *   saas × ee/saas-crm × env present  → returns env creds (operator path)
 *   saas × ee/saas-crm × env absent   → throws (Atlas not configured)
 *   saas × workspace   × DB present   → returns DB creds (env ignored)
 *   saas × workspace   × DB absent + env present → throws (no fallback)
 *   self-hosted × workspace × DB present → returns DB creds
 *   self-hosted × workspace × DB absent + env present → throws (DB-only)
 *   self-hosted × workspace × DB absent + env absent → throws
 *
 * Failure modes covered:
 *   transport-throw          → throws (resolver fails closed; no env fallback)
 *   decrypt-throw            → propagates (operator-visible misconfig)
 *   empty / whitespace key   → throws (treated as absent)
 */
import { describe, test, expect } from "bun:test";
import {
  resolveOperatorCredentials,
  tryResolveOperatorCredentials,
  resolveWorkspaceCredentials,
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
//  Operator path — env-only, reserved for ee/src/saas-crm/
// ─────────────────────────────────────────────────────────────────────

describe("resolveOperatorCredentials", () => {
  test("returns the apiKey when TWENTY_API_KEY is set; baseUrl is undefined without TWENTY_BASE_URL", () => {
    const result = resolveOperatorCredentials({
      env: { TWENTY_API_KEY: "abc123" },
    });
    expect(result.apiKey).toBe("abc123");
    expect(result.baseUrl).toBeUndefined();
    expect(result.source).toBe("env");
  });

  test("returns the configured baseUrl when TWENTY_BASE_URL is set", () => {
    const result = resolveOperatorCredentials({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
    expect(result.source).toBe("env");
  });

  test("trims trailing slashes on baseUrl", () => {
    const result = resolveOperatorCredentials({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com///" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
  });

  test("trims surrounding whitespace on apiKey", () => {
    const result = resolveOperatorCredentials({
      env: { TWENTY_API_KEY: "  abc  " },
    });
    expect(result.apiKey).toBe("abc");
  });

  test("throws TwentyCredentialError pointing operator at TWENTY_API_KEY when absent", () => {
    try {
      resolveOperatorCredentials({ env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      // Operator-path message mentions the env var by name AND explains
      // it's platform-only so the operator doesn't try to set it for a
      // per-workspace install.
      expect(msg).toContain("TWENTY_API_KEY");
      expect(msg).toContain("Atlas's own lead-capture pipeline");
    }
  });

  test("throws when TWENTY_API_KEY is the empty string", () => {
    expect(() =>
      resolveOperatorCredentials({ env: { TWENTY_API_KEY: "" } }),
    ).toThrow(TwentyCredentialError);
  });

  test("throws when TWENTY_API_KEY is whitespace only", () => {
    expect(() =>
      resolveOperatorCredentials({ env: { TWENTY_API_KEY: "   " } }),
    ).toThrow(TwentyCredentialError);
  });

  test("baseUrl is undefined when TWENTY_BASE_URL is empty", () => {
    const result = resolveOperatorCredentials({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "" },
    });
    expect(result.baseUrl).toBeUndefined();
  });
});

describe("tryResolveOperatorCredentials", () => {
  test("returns the resolved credentials when env is set", () => {
    const result = tryResolveOperatorCredentials({
      env: { TWENTY_API_KEY: "abc" },
    });
    expect(result?.apiKey).toBe("abc");
  });

  test("returns null when TWENTY_API_KEY is absent (no throw)", () => {
    const result = tryResolveOperatorCredentials({ env: {} });
    expect(result).toBeNull();
  });
});

// Back-compat re-exports of the operator path. New code should use the
// canonical names above; these aliases exist so older callers compile
// without churn during the transition.
describe("resolveCredentialsFromEnv (legacy alias for resolveOperatorCredentials)", () => {
  test("identical behavior to resolveOperatorCredentials", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc" },
    });
    expect(result.apiKey).toBe("abc");
    expect(result.source).toBe("env");
  });

  test("is referentially the same function as resolveOperatorCredentials", () => {
    expect(resolveCredentialsFromEnv).toBe(resolveOperatorCredentials);
  });
});

describe("tryResolveCredentialsFromEnv (legacy alias for tryResolveOperatorCredentials)", () => {
  test("is referentially the same function as tryResolveOperatorCredentials", () => {
    expect(tryResolveCredentialsFromEnv).toBe(tryResolveOperatorCredentials);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Workspace path — DB-only, no env fallback (#2850)
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

// ─── Combinatorial matrix — the 7 cases from #2850 ────────────────────

describe("resolveWorkspaceCredentials — combinatorial matrix (#2850)", () => {
  test("saas × DB row present → returns DB creds (env IGNORED even when set)", async () => {
    // Pin the leak prevention: even with TWENTY_API_KEY set in the
    // process env, SaaS workspace resolution must not consult it.
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "leaked-operator-key";
    try {
      const result = await resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
        lookup: lookupReturning({
          apiKey: "db-key",
          baseUrl: "https://db.example.com",
        }),
      });
      expect(result.apiKey).toBe("db-key");
      expect(result.baseUrl).toBe("https://db.example.com");
      expect(result.source).toBe("db");
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });

  test("saas × DB row absent × env present → throws (NO silent fallback — leak prevention)", async () => {
    // The case that motivated #2850. With a single-resolver design, an
    // env-fallback here would route a customer install at Atlas's
    // operator CRM (Direction-1 leak).
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "atlas-operator-key";
    try {
      await expect(
        resolveWorkspaceCredentials("ws-1", {
          deployMode: "saas",
          lookup: lookupReturning(null),
        }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });

  test("self-hosted × DB row present → returns DB creds", async () => {
    const result = await resolveWorkspaceCredentials("ws-1", {
      deployMode: "self-hosted",
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.apiKey).toBe("db-key");
    expect(result.baseUrl).toBe("https://db.example.com");
    expect(result.source).toBe("db");
  });

  test("self-hosted × DB row absent × env present → throws (DB-only, no env fallback per #2850)", async () => {
    // No "operator carve-out" — plugin installs always read workspace
    // settings, not env, even on self-hosted. The operator configures
    // via Admin → Integrations → Twenty or atlas.config.ts; env is
    // platform-only.
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "env-key";
    try {
      await expect(
        resolveWorkspaceCredentials("ws-1", {
          deployMode: "self-hosted",
          lookup: lookupReturning(null),
        }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });

  test("self-hosted × DB row absent × env absent → throws", async () => {
    const prev = process.env.TWENTY_API_KEY;
    delete process.env.TWENTY_API_KEY;
    try {
      await expect(
        resolveWorkspaceCredentials("ws-1", {
          deployMode: "self-hosted",
          lookup: lookupReturning(null),
        }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev !== undefined) process.env.TWENTY_API_KEY = prev;
    }
  });

  // The remaining two operator-path cases live under resolveOperatorCredentials
  // above. They're included in the conceptual matrix but the underlying
  // function is the operator resolver, not the workspace one — keeping
  // the assertions on that resolver's test block prevents duplication.
});

// ─── Additional behavior pins ────────────────────────────────────────

describe("resolveWorkspaceCredentials — DB row variants", () => {
  test("DB row with null baseUrl → baseUrl is undefined (env baseUrl NOT mixed in)", async () => {
    // Pre-#2850 behavior pulled TWENTY_BASE_URL when the DB row's
    // baseUrl was null. Removed: mixing env into a "db" source result
    // is exactly the cross-actor mixing #2850 forbids.
    const prev = process.env.TWENTY_BASE_URL;
    process.env.TWENTY_BASE_URL = "https://env.example.com";
    try {
      const result = await resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
        lookup: lookupReturning({ apiKey: "db-key", baseUrl: null }),
      });
      expect(result.apiKey).toBe("db-key");
      expect(result.baseUrl).toBeUndefined();
      expect(result.source).toBe("db");
    } finally {
      if (prev === undefined) delete process.env.TWENTY_BASE_URL;
      else process.env.TWENTY_BASE_URL = prev;
    }
  });

  test("DB row trims trailing slashes on baseUrl", async () => {
    const result = await resolveWorkspaceCredentials("ws-1", {
      deployMode: "self-hosted",
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com///",
      }),
    });
    expect(result.baseUrl).toBe("https://db.example.com");
  });

  test("lookup is invoked with the supplied workspaceId verbatim", async () => {
    const { fn, calls } = recordingLookup({
      apiKey: "db-key",
      baseUrl: "https://db.example.com",
    });
    await resolveWorkspaceCredentials("ws-42", {
      deployMode: "saas",
      lookup: fn,
    });
    expect(calls).toEqual(["ws-42"]);
  });

  test("DB row with empty apiKey → throws (treated as absent)", async () => {
    await expect(
      resolveWorkspaceCredentials("ws-1", {
        deployMode: "self-hosted",
        lookup: lookupReturning({ apiKey: "", baseUrl: "https://db.example.com" }),
      }),
    ).rejects.toBeInstanceOf(TwentyCredentialError);
  });

  test("DB row with whitespace-only apiKey → throws (treated as absent)", async () => {
    await expect(
      resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
        lookup: lookupReturning({ apiKey: "   ", baseUrl: "https://db.example.com" }),
      }),
    ).rejects.toBeInstanceOf(TwentyCredentialError);
  });

  test("DB row apiKey is trimmed before use", async () => {
    const result = await resolveWorkspaceCredentials("ws-1", {
      deployMode: "saas",
      lookup: lookupReturning({ apiKey: "  db-key  ", baseUrl: null }),
    });
    expect(result.apiKey).toBe("db-key");
  });

  test("works without a lookup supplied → throws (no env fallback)", async () => {
    // Pre-#2850 this would collapse to env. Now it throws — no env
    // fallback ever for workspace credentials.
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "env-key";
    try {
      await expect(
        resolveWorkspaceCredentials("ws-1", { deployMode: "self-hosted" }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });
});

describe("resolveWorkspaceCredentials — lookup failure modes", () => {
  test("transport-throw lookup → throws TwentyCredentialError (no silent env fallback)", async () => {
    // Pre-#2850 would have swallowed the transport error and fallen
    // back to env. Now it throws — a pg blip surfaces to the caller
    // rather than silently routing to the wrong (env) credentials.
    const failingLookup: DbCredentialLookup = async () => {
      throw new Error("pg connection refused");
    };
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "env-key";
    try {
      await expect(
        resolveWorkspaceCredentials("ws-1", {
          deployMode: "self-hosted",
          lookup: failingLookup,
        }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });

  test("decrypt-throw lookup → propagates TwentyDecryptError (fail-CLOSED on operator misconfig)", async () => {
    const decryptFailLookup: DbCredentialLookup = async () => {
      throw new TwentyDecryptError("key version v2 missing from ATLAS_ENCRYPTION_KEYS");
    };
    await expect(
      resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
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
      resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
        lookup: decryptFailLookup,
      }),
    ).rejects.toMatchObject({ decryptFailed: true });
  });
});

describe("resolveWorkspaceCredentials — error message tailoring", () => {
  test("saas message points at Admin → Integrations → Twenty and explains env is platform-only", async () => {
    try {
      await resolveWorkspaceCredentials("ws-1", {
        deployMode: "saas",
        lookup: lookupReturning(null),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      expect(msg).toContain("Admin → Integrations → Twenty");
      expect(msg).toContain("TWENTY_API_KEY is platform-only");
    }
  });

  test("self-hosted message also mentions atlas.config.ts as an install path", async () => {
    try {
      await resolveWorkspaceCredentials("ws-1", {
        deployMode: "self-hosted",
        lookup: lookupReturning(null),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      expect(msg).toContain("atlas.config.ts");
      expect(msg).toContain("platform-only");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Back-compat shim — resolveCredentialsForWorkspace (deprecated)
// ─────────────────────────────────────────────────────────────────────

describe("resolveCredentialsForWorkspace (legacy shim) — defaults deployMode to self-hosted", () => {
  test("DB row present → returns DB creds", async () => {
    const result = await resolveCredentialsForWorkspace("ws-1", {
      lookup: lookupReturning({
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
      }),
    });
    expect(result.source).toBe("db");
    expect(result.apiKey).toBe("db-key");
  });

  test("DB row absent → throws (post-#2850: no env fallback, even via the legacy shim)", async () => {
    const prev = process.env.TWENTY_API_KEY;
    process.env.TWENTY_API_KEY = "env-key";
    try {
      await expect(
        resolveCredentialsForWorkspace("ws-1", {
          lookup: lookupReturning(null),
        }),
      ).rejects.toBeInstanceOf(TwentyCredentialError);
    } finally {
      if (prev === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = prev;
    }
  });
});
