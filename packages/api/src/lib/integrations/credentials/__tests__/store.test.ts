/**
 * Tests for the generic `integration_credentials` credential store (#2658).
 *
 * Coverage:
 *   - `saveCredentialBundle` encrypts the JSON-stringified bundle via
 *     `encryptSecret` and upserts on (workspace_id, catalog_id).
 *   - `readCredentialBundle` decrypts the round-trip and returns the
 *     original bundle, or null when no row exists.
 *   - `deleteCredentialBundle` returns true when a row was removed,
 *     false when nothing was there.
 *
 * The `internalQuery` mock returns deterministic shapes so the store
 * code paths can be exercised without a live Postgres. The encryption
 * helpers are imported real (no mock) so we exercise the actual AES-GCM
 * round-trip end to end.
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
 * Capture EVERY argument of every log call (#4984).
 *
 * Asserting on a payload field would miss the two ways a secret actually
 * reaches a sink: as a value under some other key, or interpolated into the
 * MESSAGE string. A whole-call capture sees both. Mirrors the harness in
 * `brain/ingest/__tests__/zoom-connector.test.ts`, which pins the same class
 * on the same kind of blob.
 *
 * `scrubErrSerializer` is passed through as identity here deliberately: this
 * suite is asserting what the STORE hands the logger, not what pino would
 * then do with it. The real serializer's behaviour is `logger.test.ts`'s.
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

const WSID = "ws-credential-test" as const;
const CATALOG_ID = "catalog:salesforce" as const;

const BUNDLE = {
  accessToken: "00D1x000000abcXYZ!ARQAQM0...",
  refreshToken: "5Aep861YEp_refresh_token_value",
  expiresAt: 1_900_000_000_000,
  tokenType: "Bearer",
  scope: "api refresh_token offline_access",
  instanceUrl: "https://na139.my.salesforce.com",
  extra: { id_token: "eyJhbGciOi..." },
} as const;

describe("saveCredentialBundle", () => {
  it("encrypts the bundle and upserts with versioned key", async () => {
    await store.saveCredentialBundle(WSID, CATALOG_ID, BUNDLE);

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO integration_credentials");
    expect(sql).toContain("ON CONFLICT (workspace_id, catalog_id) DO UPDATE");
    const paramsList = params as unknown[];
    expect(paramsList[0]).toBe(WSID);
    expect(paramsList[1]).toBe(CATALOG_ID);
    // The ciphertext must carry the versioned prefix — it is NOT the
    // original JSON.
    const ciphertext = paramsList[2] as string;
    expect(ciphertext).toMatch(/^enc:v\d+:/);
    expect(ciphertext).not.toContain(BUNDLE.refreshToken);
    expect(ciphertext).not.toContain(BUNDLE.accessToken);
    // Key version pinned to the active keyset entry.
    expect(paramsList[3]).toBe(1);
  });
});

describe("readCredentialBundle", () => {
  it("decrypts and returns the original bundle shape", async () => {
    // Capture the ciphertext written by saveCredentialBundle, then feed
    // it back as the SELECT result for readCredentialBundle. End-to-end
    // round-trip without a live DB.
    await store.saveCredentialBundle(WSID, CATALOG_ID, BUNDLE);
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[2] as string;
    const keyVersion = (params as unknown[])[3] as number;

    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([
        { credentials_encrypted: ciphertext, credentials_key_version: keyVersion },
      ]),
    );

    const result = await store.readCredentialBundle(WSID, CATALOG_ID);

    expect(result).toEqual(BUNDLE);
  });

  it("returns null when no row exists", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));

    const result = await store.readCredentialBundle(WSID, CATALOG_ID);

    expect(result).toBeNull();
  });

  it("throws on tampered ciphertext (auth-tag mismatch)", async () => {
    await store.saveCredentialBundle(WSID, CATALOG_ID, BUNDLE);
    const [, params] = mockInternalQuery.mock.calls[0];
    const ciphertext = (params as unknown[])[2] as string;
    // Flip a base64 char in the ciphertext segment (after the prefix).
    const tampered = ciphertext.slice(0, -4) + "AAAA";

    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ credentials_encrypted: tampered, credentials_key_version: 1 }]),
    );

    await expect(store.readCredentialBundle(WSID, CATALOG_ID)).rejects.toThrow();
  });

  describe("a row that decrypts cleanly but is not JSON (#4984)", () => {
    /**
     * Store a plaintext blob that is NOT JSON, encrypted under a live key, so
     * `decryptSecret` succeeds and `JSON.parse` is the thing that fails. That
     * is the reachable case: a hand-repaired row, a LEGACY PLAINTEXT secret
     * that was never JSON, or a partial decrypt. The AES-GCM auth tag rules
     * out "decrypted to garbage", which is why that was never the danger.
     *
     * ⚠️ DELIMITER-FREE on purpose. JSC's parse error echoes only the leading
     * IDENTIFIER, which stops at the first `-`, so a realistic `xoxb-<secret>`
     * shaped token leaks just its public prefix and a fragment assertion on it
     * passes against the bug. An opaque token leaks in FULL — that is the worst
     * case and the one worth pinning. Verified empirically under bun/JSC; the
     * sibling operator-credentials suite was vacuous for exactly this reason
     * before it was caught by mutation.
     */
    const LEGACY_PLAINTEXT_SECRET = "s3cr3tPassw0rdNotJson";

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
      return store.readCredentialBundle(WSID, CATALOG_ID).catch((err: unknown) => err);
    }

    it("⭐ logs no derivative of the decrypted plaintext", async () => {
      await readNonJsonRow();

      expect(LOG_CALLS.length).toBeGreaterThan(0);
      const written = JSON.stringify(LOG_CALLS);
      expect(written).not.toContain(LEGACY_PLAINTEXT_SECRET);
      // Not merely absent as a whole. `JSON.parse`'s message leaks a LEADING
      // FRAGMENT — under bun/JSC, `JSON Parse error: Unexpected identifier
      // "s3cr3t"` — so a test asserting only on the full value passes against
      // the bug it exists to catch.
      expect(written).not.toContain("s3cr3t");
      // MUTATION THIS CATCHES: restoring `err: err instanceof Error ?
      // err.message : String(err)` to the catch's log payload.
    });

    it("⭐ still names WHICH row failed — over-redaction is the opposite bug", async () => {
      await readNonJsonRow();

      const written = JSON.stringify(LOG_CALLS);
      expect(written).toContain(WSID);
      expect(written).toContain(CATALOG_ID);
      // …and the identifiers do not buy back the payload.
      expect(written).not.toContain("s3cr3t");
      // MUTATION THIS CATCHES: "fixing" the leak by logging `{}` — which
      // leaves an operator on a fleet with "a credential is unreadable" and no
      // way to tell whose. #4983's Zoom fix had to state this the same way.
    });

    it("throws an error carrying no cause chain back to the parse failure", async () => {
      const err = await readNonJsonRow();

      expect(err).toBeInstanceOf(Error);
      // The thrown message is composed from identifiers only, so it is safe —
      // but `cause` would re-attach the parse error whose message holds the
      // secret. Today no 500 renderer and no log serializer walks a cause
      // chain (verified in #4984); this asserts we do not DEPEND on that.
      expect((err as Error).cause).toBeUndefined();
      expect(JSON.stringify((err as Error).message)).not.toContain("s3cr3t");
      // MUTATION THIS CATCHES: restoring `{ cause: err }` on the throw.
    });
  });
});

describe("deleteCredentialBundle", () => {
  it("returns true when a row was deleted", async () => {
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ id: "uuid-1" }]),
    );

    const result = await store.deleteCredentialBundle(WSID, CATALOG_ID);

    expect(result).toBe(true);
    const [sql] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("DELETE FROM integration_credentials");
  });

  it("returns false when no row was present", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));

    const result = await store.deleteCredentialBundle(WSID, CATALOG_ID);

    expect(result).toBe(false);
  });
});
