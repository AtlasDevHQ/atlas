/**
 * F-41 real-AES round-trip test for the email store.
 *
 * The sibling `store.test.ts` mocks `secret-encryption` with a
 * deterministic `enc:v1:test:${plaintext}` prefix so params are
 * easy to assert. That mock can't catch cipher-format drift — a
 * regression where the save path's `JSON.stringify(config)` mismatches
 * the read path's `JSON.parse(decryptSecret(…))` passes the prefix-
 * concat mock but would fail against real AES-GCM.
 *
 * This file uses the real `encryptSecret` / `decryptSecret` (no
 * `mock.module` for `secret-encryption`) and proves the save → read
 * round-trip end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/internal";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];

// Mock ONLY internal DB — leave secret-encryption intact so the real
// AES-GCM surface is exercised.
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockInternalQueryResult);
  }),
  // Re-export the real getEncryptionKey + _resetEncryptionKeyCache so
  // `secret-encryption.ts` (which imports from this module) still works.
  getEncryptionKey: () => {
    const raw = process.env.ATLAS_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
    if (!raw) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(raw).digest();
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { saveEmailInstallation, getEmailInstallationByOrg } = await import("../store");

describe("F-41 email real-AES round-trip", () => {
  const savedKey = process.env.ATLAS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ATLAS_ENCRYPTION_KEY = "atlas-email-roundtrip-key";
    _resetEncryptionKeyCache();
    capturedQueries = [];
    mockInternalQueryResult = [];
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
    _resetEncryptionKeyCache();
  });

  it("save → read returns the original provider config via real AES-GCM", async () => {
    await saveEmailInstallation("org-1", {
      provider: "resend",
      senderAddress: "r@example.com",
      config: { provider: "resend", apiKey: "re_real_round_trip" },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    const plaintextJson = insert!.params[2] as string;
    const encryptedBlob = insert!.params[3] as string;

    // Encrypted blob must not contain the plaintext secret.
    expect(encryptedBlob.startsWith("enc:v1:")).toBe(true);
    expect(encryptedBlob).not.toContain("re_real_round_trip");

    // Simulate a SELECT returning the row we just wrote.
    mockInternalQueryResult = [
      {
        config_id: "cfg-rt",
        provider: "resend",
        sender_address: "r@example.com",
        config: JSON.parse(plaintextJson),
        config_encrypted: encryptedBlob,
        org_id: "org-1",
        installed_at: "2026-04-24T00:00:00Z",
      },
    ];
    const loaded = await getEmailInstallationByOrg("org-1");
    expect(loaded!.config.provider).toBe("resend");
    if (loaded!.config.provider === "resend") {
      expect(loaded!.config.apiKey).toBe("re_real_round_trip");
    }
  });
});
