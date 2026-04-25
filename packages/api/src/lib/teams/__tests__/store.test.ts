/**
 * F-41 integration-credential encryption tests for the Teams store.
 * Post-#1832 the plaintext column is gone — reads decrypt
 * `app_password_encrypted`, writes only populate the encrypted column.
 *
 * Teams's app_password column is nullable on the encrypted side too
 * because admin-consent installs persist no password — the OAuth-only
 * path leaves the encrypted column NULL and that's a healthy state.
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

// Mock decryptSecret with three branches:
//   `enc:v1:test:<value>` → returns <value>
//   `enc:v1:throw:<reason>` → throws (lets tests exercise the catch path)
//   anything else → returns unchanged (legacy plaintext passthrough)
mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) => {
    if (stored.startsWith("enc:v1:throw:")) {
      throw new Error(`mock decrypt failure: ${stored.slice("enc:v1:throw:".length)}`);
    }
    return stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored;
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

describe("F-41 teams encrypted-only writes + reads", () => {
  it("saveTeamsInstallation writes only the encrypted app_password", async () => {
    mockInternalQueryResult = [{ tenant_id: "tenant-1" }];
    await saveTeamsInstallation("tenant-1", {
      orgId: "org-1",
      tenantName: "Acme",
      appPassword: "teams-app-password",
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO teams_installations"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("app_password_encrypted");
    // params: [tenantId, orgId, tenantName, appPasswordEncrypted, keyVersion]
    expect(insert!.params[3]).toBe("enc:v1:test:teams-app-password");
  });

  it("saveTeamsInstallation leaves the encrypted column NULL for admin-consent installs", async () => {
    mockInternalQueryResult = [{ tenant_id: "tenant-1" }];
    await saveTeamsInstallation("tenant-1", { orgId: "org-1", tenantName: "Acme" });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO teams_installations"));
    expect(insert!.params[3]).toBeNull();
    expect(insert!.params[4]).toBeNull();
  });

  it("getTeamsInstallation decrypts app_password_encrypted", async () => {
    mockInternalQueryResult = [
      {
        tenant_id: "tenant-1",
        org_id: "org-1",
        tenant_name: "Acme",
        app_password_encrypted: "enc:v1:test:fresh-password",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTeamsInstallation("tenant-1");
    expect(install?.app_password).toBe("fresh-password");
  });

  it("getTeamsInstallation surfaces app_password: null when encrypted is NULL (admin-consent install)", async () => {
    mockInternalQueryResult = [
      {
        tenant_id: "tenant-1",
        org_id: "org-1",
        tenant_name: "Acme",
        app_password_encrypted: null,
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTeamsInstallation("tenant-1");
    expect(install?.app_password).toBeNull();
  });

  it("getTeamsInstallation hides the row when decryptSecret throws (decrypt failure ≠ admin-consent)", async () => {
    // Pin the M2 fix: a row with garbled `app_password_encrypted` must
    // not surface as `{ ..., app_password: null }` — that would be
    // indistinguishable from a legitimate admin-consent install and
    // the caller would treat the broken row as healthy. Returning
    // null for the whole row matches Slack/Telegram and forces the
    // operator to investigate via the F-42 audit script.
    mockInternalQueryResult = [
      {
        tenant_id: "tenant-1",
        org_id: "org-1",
        tenant_name: "Acme",
        app_password_encrypted: "enc:v1:throw:auth-tag-failure",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getTeamsInstallation("tenant-1");
    expect(install).toBeNull();
  });
});
