/**
 * F-41 integration-credential encryption tests for the Teams store.
 *
 * Mirrors the contract every integration store is expected to satisfy:
 *   - saveInstallation dual-writes plaintext + encrypted params
 *   - getInstallation* prefers the decrypted encrypted column
 *   - legacy rows with only the plaintext column still parse
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
  saveTeamsInstallation,
  getTeamsInstallation,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  mockHasDB = true;
});

describe("F-41 teams dual-write + read priority", () => {
  it("saveTeamsInstallation dual-writes plaintext + encrypted app_password", async () => {
    // saveTeamsInstallation returns {tenant_id} from RETURNING.
    mockInternalQueryResult = [{ tenant_id: "tenant-1" }];
    await saveTeamsInstallation("tenant-1", {
      orgId: "org-1",
      tenantName: "Acme",
      appPassword: "teams-app-password",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO teams_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("app_password_encrypted");
    // params: [tenantId, orgId, tenantName, appPassword, appPasswordEncrypted]
    expect(insert!.params[3]).toBe("teams-app-password");
    expect(insert!.params[4]).toBe("enc:v1:test:teams-app-password");
  });

  it("saveTeamsInstallation leaves both password columns NULL for admin-consent installs", async () => {
    mockInternalQueryResult = [{ tenant_id: "tenant-1" }];
    await saveTeamsInstallation("tenant-1", { orgId: "org-1", tenantName: "Acme" });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO teams_installations"));
    expect(insert!.params[3]).toBeNull();
    expect(insert!.params[4]).toBeNull();
  });

  it("getTeamsInstallation prefers app_password_encrypted over plaintext", async () => {
    mockInternalQueryResult = [
      {
        tenant_id: "tenant-1",
        org_id: "org-1",
        tenant_name: "Acme",
        app_password: "stale-plaintext",
        app_password_encrypted: "enc:v1:test:fresh-password",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTeamsInstallation("tenant-1");
    expect(install?.app_password).toBe("fresh-password");
  });

  it("getTeamsInstallation falls back to plaintext when encrypted is NULL (legacy row)", async () => {
    mockInternalQueryResult = [
      {
        tenant_id: "tenant-1",
        org_id: "org-1",
        tenant_name: "Acme",
        app_password: "legacy-password",
        app_password_encrypted: null,
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTeamsInstallation("tenant-1");
    expect(install?.app_password).toBe("legacy-password");
  });
});
