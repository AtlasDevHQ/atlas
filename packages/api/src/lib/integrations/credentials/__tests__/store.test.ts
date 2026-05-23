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
