/**
 * F-41 integration-credential encryption tests for the WhatsApp store.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

type CapturedQuery = { sql: string; params: unknown[] };
let capturedQueries: CapturedQuery[] = [];
let mockInternalQueryResult: unknown[] = [];
let mockHasDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock((sql: string, params: unknown[] = []) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve(mockInternalQueryResult);
  }),
}));

mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) =>
    stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored,
  pickDecryptedSecret: (encrypted: unknown, plaintext: unknown): string | null => {
    if (typeof encrypted === "string" && encrypted.length > 0) {
      return encrypted.startsWith("enc:v1:test:") ? encrypted.slice("enc:v1:test:".length) : encrypted;
    }
    if (typeof plaintext === "string" && plaintext.length > 0) return plaintext;
    return null;
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  saveWhatsAppInstallation,
  getWhatsAppInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 whatsapp dual-write + read priority", () => {
  it("saveWhatsAppInstallation dual-writes plaintext + encrypted access_token", async () => {
    mockInternalQueryResult = [{ phone_number_id: "p-1" }];
    await saveWhatsAppInstallation("p-1", {
      orgId: "org-1",
      displayPhone: "+1 555 1234",
      accessToken: "wa_cloud_token",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO whatsapp_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("access_token_encrypted");
    // params: [phoneNumberId, accessToken, accessTokenEncrypted, displayPhone, orgId]
    expect(insert!.params[1]).toBe("wa_cloud_token");
    expect(insert!.params[2]).toBe("enc:v1:test:wa_cloud_token");
  });

  it("getWhatsAppInstallation prefers access_token_encrypted over plaintext", async () => {
    mockInternalQueryResult = [
      {
        phone_number_id: "p-1",
        access_token: "stale-token",
        access_token_encrypted: "enc:v1:test:fresh-token",
        display_phone: "+1 555 1234",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getWhatsAppInstallation("p-1");
    expect(install?.access_token).toBe("fresh-token");
  });

  it("falls back to plaintext when encrypted is NULL", async () => {
    mockInternalQueryResult = [
      {
        phone_number_id: "p-1",
        access_token: "legacy-token",
        access_token_encrypted: null,
        display_phone: "+1 555 1234",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getWhatsAppInstallation("p-1");
    expect(install?.access_token).toBe("legacy-token");
  });
});
