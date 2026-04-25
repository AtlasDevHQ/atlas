/**
 * F-41 integration-credential encryption tests for the WhatsApp store.
 * Post-#1832: the plaintext column has been dropped — reads come from
 * `access_token_encrypted` only, writes only populate the encrypted column.
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

describe("F-41 whatsapp encrypted-only writes + reads", () => {
  it("saveWhatsAppInstallation writes only the encrypted access_token", async () => {
    mockInternalQueryResult = [{ phone_number_id: "p-1" }];
    await saveWhatsAppInstallation("p-1", {
      orgId: "org-1",
      displayPhone: "+1 555 1234",
      accessToken: "wa_cloud_token",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO whatsapp_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("access_token_encrypted");
    // params: [phoneNumberId, accessTokenEncrypted, displayPhone, orgId, keyVersion]
    expect(insert!.params[1]).toBe("enc:v1:test:wa_cloud_token");
  });

  it("getWhatsAppInstallation decrypts access_token_encrypted", async () => {
    mockInternalQueryResult = [
      {
        phone_number_id: "p-1",
        access_token_encrypted: "enc:v1:test:fresh-token",
        display_phone: "+1 555 1234",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getWhatsAppInstallation("p-1");
    expect(install?.access_token).toBe("fresh-token");
  });

  it("returns null when access_token_encrypted is missing (malformed row)", async () => {
    mockInternalQueryResult = [
      {
        phone_number_id: "p-1",
        access_token_encrypted: null,
        display_phone: "+1 555 1234",
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getWhatsAppInstallation("p-1");
    expect(install).toBeNull();
  });
});
