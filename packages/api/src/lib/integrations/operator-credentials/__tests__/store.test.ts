/**
 * Tests for the operator-tier credential store (#3704).
 *
 * Coverage:
 *   - `saveOperatorCredentials` encrypts the JSON-stringified bundle via the
 *     real `encryptSecret` (versioned AES-GCM) and upserts on `platform`.
 *   - Empty-string fields are dropped before persisting (a half-filled form
 *     never clobbers a real secret with `""`).
 *   - `readOperatorCredentials` round-trips the decrypt and returns the
 *     original map, or null when no row exists; tampered ciphertext throws.
 *   - `readOperatorCredentialRecord` also returns `updatedAt`.
 *   - `deleteOperatorCredentials` reports whether a row was removed.
 *
 * The `internalQuery` mock returns deterministic shapes so the store paths run
 * without a live Postgres; the encryption helpers are imported real so the
 * AES-GCM round-trip is exercised end to end.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([]),
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

/**
 * Capture every argument of every log call (#4984) — a payload-field assertion
 * would miss a secret interpolated into the message string. Same harness as
 * `credentials/__tests__/store.test.ts`, pinning the same class on the sibling
 * store.
 */
const LOG_CALLS: unknown[][] = [];
function createCapturingLogger(): Record<string, (...args: unknown[]) => void> {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      LOG_CALLS.push([level, ...args]);
    };
  return {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  };
}
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  getLogger: () => createCapturingLogger(),
  createLogger: () => createCapturingLogger(),
  hashShareToken: (token: string) => token,
  setLogLevel: () => true,
}));

type StoreModule = typeof import("../store");
let store!: StoreModule;

beforeAll(async () => {
  store = await import("../store");
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-one";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
  mockInternalQuery.mockClear();
  LOG_CALLS.length = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

const PLATFORM = "slack" as const;
const BUNDLE = {
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_CLIENT_SECRET: "sec-abcdef0123456789",
  SLACK_SIGNING_SECRET: "sign-fedcba9876543210",
  SLACK_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
} as const;

describe("saveOperatorCredentials", () => {
  it("encrypts the bundle and upserts on platform with a versioned key", async () => {
    await store.saveOperatorCredentials(PLATFORM, BUNDLE);

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO operator_integration_credentials");
    expect(sql).toContain("ON CONFLICT (platform) DO UPDATE");
    const paramsList = params as unknown[];
    expect(paramsList[0]).toBe(PLATFORM);
    const ciphertext = paramsList[1] as string;
    expect(ciphertext).toMatch(/^enc:v\d+:/);
    // No plaintext secret survives in the ciphertext.
    expect(ciphertext).not.toContain(BUNDLE.SLACK_CLIENT_SECRET);
    expect(ciphertext).not.toContain(BUNDLE.SLACK_SIGNING_SECRET);
    expect(ciphertext).not.toContain(BUNDLE.SLACK_ENCRYPTION_KEY);
    expect(paramsList[2]).toBe(1);
  });

  it("drops empty-string fields before persisting", async () => {
    await store.saveOperatorCredentials(PLATFORM, {
      SLACK_CLIENT_ID: "1234.5678",
      SLACK_CLIENT_SECRET: "",
    });
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[1] as string;

    // Decrypt by feeding it back through readOperatorCredentials.
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ credentials_encrypted: ciphertext, credentials_key_version: 1 }]),
    );
    const round = await store.readOperatorCredentials(PLATFORM);
    expect(round).toEqual({ SLACK_CLIENT_ID: "1234.5678" });
  });

  it("rethrows (does not swallow) when the upsert query fails", async () => {
    // A persistence failure must propagate so the Admin route surfaces a 500
    // rather than reporting a successful rotation that wrote nothing.
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.reject(new Error("connection terminated unexpectedly")),
    );
    await expect(store.saveOperatorCredentials(PLATFORM, BUNDLE)).rejects.toThrow(
      /connection terminated/,
    );
  });
});

describe("readOperatorCredentials", () => {
  it("decrypts and returns the original map", async () => {
    await store.saveOperatorCredentials(PLATFORM, BUNDLE);
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[1] as string;
    const keyVersion = (params as unknown[])[2] as number;

    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([
        { credentials_encrypted: ciphertext, credentials_key_version: keyVersion },
      ]),
    );

    const result = await store.readOperatorCredentials(PLATFORM);
    expect(result).toEqual(BUNDLE);
  });

  it("returns null when no row exists", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));
    const result = await store.readOperatorCredentials(PLATFORM);
    expect(result).toBeNull();
  });

  it("throws on tampered ciphertext (auth-tag mismatch)", async () => {
    await store.saveOperatorCredentials(PLATFORM, BUNDLE);
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[1] as string;
    const tampered = ciphertext.slice(0, -4) + "AAAA";

    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ credentials_encrypted: tampered, credentials_key_version: 1 }]),
    );

    await expect(store.readOperatorCredentials(PLATFORM)).rejects.toThrow();
  });

  it("throws when the decrypted payload is not a string→string map (corruption)", async () => {
    // A row that decrypts cleanly but carries a non-string value is corruption;
    // it must fail loud at the trust boundary, not flow downstream mistyped.
    const { encryptSecret } = await import("@atlas/api/lib/db/secret-encryption");
    const badCiphertext = encryptSecret(JSON.stringify({ SLACK_CLIENT_ID: 1234 }));

    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ credentials_encrypted: badCiphertext, credentials_key_version: 1 }]),
    );

    await expect(store.readOperatorCredentials(PLATFORM)).rejects.toThrow(/validation failed/);
  });

  describe("a row that decrypts cleanly but is not JSON (#4984)", () => {
    /**
     * The sibling of `credentials/store.ts`'s leak, found by the same grep.
     * `parseBundle` wrapped BOTH the JSON parse and the Zod shape check in one
     * catch that logged `err.message` — and only one of those two errors can
     * echo a secret. They are split so the shape arm keeps its diagnostic.
     *
     * ⚠️ The fixture is DELIMITER-FREE on purpose, and the first draft of this
     * test was vacuous for want of that. JSC's message echoes only the leading
     * IDENTIFIER, which ends at the first `-`: a realistic `xoxb-<secret>` token
     * leaks just `"xoxb"` — a public prefix — and an assertion on any
     * secret-bearing fragment of it passes against the bug. An opaque
     * delimiter-free token leaks in FULL, so that is what this pins. (Verified
     * empirically against bun/JSC rather than assumed.)
     */
    const LEGACY_PLAINTEXT_SECRET = "s3cr3tSlackSigningValueNotJson";

    async function readNonJsonRow(): Promise<unknown> {
      const { encryptSecret } = await import("@atlas/api/lib/db/secret-encryption");
      mockInternalQuery.mockImplementationOnce(() =>
        Promise.resolve([
          {
            credentials_encrypted: encryptSecret(LEGACY_PLAINTEXT_SECRET),
            credentials_key_version: 1,
          },
        ]),
      );
      return store.readOperatorCredentials(PLATFORM).catch((err: unknown) => err);
    }

    it("⭐ logs no derivative of the decrypted plaintext, but still names the platform", async () => {
      await readNonJsonRow();

      expect(LOG_CALLS.length).toBeGreaterThan(0);
      const written = JSON.stringify(LOG_CALLS);
      expect(written).not.toContain(LEGACY_PLAINTEXT_SECRET);
      // The leading fragment is what `JSON.parse`'s message actually carries.
      expect(written).not.toContain("s3cr3t");
      // Over-redaction is the opposite bug: the platform is not a secret and
      // is the only thing that locates the row.
      expect(written).toContain(PLATFORM);
    });

    it("throws with no cause chain back to the parse failure", async () => {
      const err = await readNonJsonRow();

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeUndefined();
      expect((err as Error).message).not.toContain("s3cr3t");
    });

    it("⭐ the SHAPE arm keeps a diagnostic — the split is not a blanket redaction", async () => {
      // The whole point of splitting the two catches. `z.record(z.string(),
      // z.string())` issues carry the PATH (an env-var name, not a secret) and
      // an `invalid_type` code naming the received TYPE — never the value. A
      // fix that dropped diagnostics from BOTH arms would pass every assertion
      // above and lose this.
      const { encryptSecret } = await import("@atlas/api/lib/db/secret-encryption");
      mockInternalQuery.mockImplementationOnce(() =>
        Promise.resolve([
          {
            credentials_encrypted: encryptSecret(
              JSON.stringify({ SLACK_CLIENT_ID: 1234, SLACK_CLIENT_SECRET: "fine" }),
            ),
            credentials_key_version: 1,
          },
        ]),
      );

      await expect(store.readOperatorCredentials(PLATFORM)).rejects.toThrow(/validation failed/);

      const written = JSON.stringify(LOG_CALLS);
      expect(written).toContain("SLACK_CLIENT_ID");
      expect(written).toContain("invalid_type");
      // The offending VALUE is never logged, even though it is the thing that
      // failed — and neither is the sibling key's value.
      expect(written).not.toContain("fine");
    });
  });
});

describe("readOperatorCredentialRecord", () => {
  it("returns the bundle plus updatedAt", async () => {
    await store.saveOperatorCredentials(PLATFORM, BUNDLE);
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[1] as string;
    const when = "2026-06-17T12:00:00.000Z";

    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([
        { credentials_encrypted: ciphertext, credentials_key_version: 1, updated_at: when },
      ]),
    );

    const result = await store.readOperatorCredentialRecord(PLATFORM);
    expect(result?.bundle).toEqual(BUNDLE);
    expect(result?.updatedAt.toISOString()).toBe(when);
  });
});

describe("deleteOperatorCredentials", () => {
  it("returns true when a row was deleted", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([{ id: "uuid-1" }]));
    const result = await store.deleteOperatorCredentials(PLATFORM);
    expect(result).toBe(true);
    const [sql] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("DELETE FROM operator_integration_credentials");
  });

  it("returns false when no row was present", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));
    const result = await store.deleteOperatorCredentials(PLATFORM);
    expect(result).toBe(false);
  });
});
