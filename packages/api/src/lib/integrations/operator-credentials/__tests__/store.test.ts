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

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
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
