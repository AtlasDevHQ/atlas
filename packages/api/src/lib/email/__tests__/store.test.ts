/**
 * Tests for email installation storage — the load-bearing piece of #1542.
 *
 * Covers:
 *  - provider-tag injection on read (sibling column wins)
 *  - provider-tag strip on save (JSONB never persists the tag)
 *  - round-trip (save → load round-trips the provider variant)
 *  - corrupt-row handling (unknown provider, mismatched JSONB provider,
 *    non-object config) returns null with a warn log
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mock internal DB ---

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

// F-41 secret encryption — deterministic passthrough for test assertions.
mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  encryptSecret: (plaintext: string) => `enc:v1:test:${plaintext}`,
  decryptSecret: (stored: string) =>
    stored.startsWith("enc:v1:test:") ? stored.slice("enc:v1:test:".length) : stored,
}));

// --- Capture warn logs so tests can assert corrupt-row breadcrumbs ---

let warnLogs: Array<{ ctx: Record<string, unknown>; msg: string }> = [];

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (ctx: Record<string, unknown>, msg: string) => {
      warnLogs.push({ ctx, msg });
    },
    error: () => {},
    debug: () => {},
  }),
}));

const {
  getEmailInstallationByOrg,
  saveEmailInstallation,
  deleteEmailInstallationByOrg,
} = await import("../store");

beforeEach(() => {
  capturedQueries = [];
  mockInternalQueryResult = [];
  warnLogs = [];
  mockHasDB = true;
});

// ---------------------------------------------------------------------------
// Read — tag injection
// ---------------------------------------------------------------------------

describe("parseInstallationRow (via getEmailInstallationByOrg)", () => {
  it("injects provider tag from sibling column into JSONB config (resend)", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-1",
        provider: "resend",
        sender_address: "Acme <noreply@acme.com>",
        config: { apiKey: "re_12345" },
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).not.toBeNull();
    expect(install!.provider).toBe("resend");
    expect(install!.config.provider).toBe("resend");
    if (install!.config.provider === "resend") {
      expect(install!.config.apiKey).toBe("re_12345");
    }
  });

  it("injects provider tag for smtp variants (preserves all fields)", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-2",
        provider: "smtp",
        sender_address: "smtp-sender@example.com",
        config: { host: "smtp.example.com", port: 587, username: "u", password: "p", tls: true },
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install!.config.provider).toBe("smtp");
    if (install!.config.provider === "smtp") {
      expect(install!.config.host).toBe("smtp.example.com");
      expect(install!.config.port).toBe(587);
    }
  });

  it("sibling column wins when JSONB carries a stale provider tag", async () => {
    // Legacy row written before the save-path strip — the stale tag in
    // the JSONB must not override the authoritative sibling column.
    mockInternalQueryResult = [
      {
        config_id: "cfg-drift",
        provider: "sendgrid",
        sender_address: "sg@example.com",
        config: { provider: "resend", apiKey: "stale-key" },
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install!.provider).toBe("sendgrid");
    expect(install!.config.provider).toBe("sendgrid");

    // Warn breadcrumb emitted so ops can reconcile the drift.
    const driftWarn = warnLogs.find((w) =>
      w.msg.includes("JSONB config.provider disagrees with sibling"),
    );
    expect(driftWarn).toBeDefined();
    expect(driftWarn!.ctx.columnProvider).toBe("sendgrid");
    expect(driftWarn!.ctx.jsonbProvider).toBe("resend");
  });
});

// ---------------------------------------------------------------------------
// Read — corrupt rows
// ---------------------------------------------------------------------------

describe("parseInstallationRow — corrupt rows return null", () => {
  it("returns null when provider column is not a recognized EmailProvider", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-x",
        provider: "mailgun",
        sender_address: "mg@example.com",
        config: { apiKey: "mg-key" },
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
    const unknownWarn = warnLogs.find((w) =>
      w.msg.includes("references unknown provider"),
    );
    expect(unknownWarn).toBeDefined();
    expect(unknownWarn!.ctx.provider).toBe("mailgun");
  });

  it("returns null when config is not an object", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-null",
        provider: "resend",
        sender_address: "r@example.com",
        config: null,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
  });

  it("returns null when config_id is missing", async () => {
    mockInternalQueryResult = [
      {
        config_id: "",
        provider: "resend",
        sender_address: "r@example.com",
        config: { apiKey: "x" },
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
  });

  it("returns null (not throws) when internal DB disabled", async () => {
    mockHasDB = false;
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
    expect(capturedQueries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Save — tag strip
// ---------------------------------------------------------------------------

describe("saveEmailInstallation — strips tag from JSONB", () => {
  it("strips provider from resend config before INSERT", async () => {
    await saveEmailInstallation("org-1", {
      provider: "resend",
      senderAddress: "r@example.com",
      config: { provider: "resend", apiKey: "re_saved" },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    expect(insert).toBeDefined();
    // Third param is the JSON-stringified plaintext config.
    const persistedJson = insert!.params[2];
    expect(typeof persistedJson).toBe("string");
    const persisted = JSON.parse(persistedJson as string);
    // Discriminator must NOT be in the JSONB — it lives in the sibling
    // column so we don't double-store / risk drift.
    expect(persisted.provider).toBeUndefined();
    expect(persisted.apiKey).toBe("re_saved");
    // F-41 dual-write: fourth param is the encrypted blob.
    expect(insert!.params[3]).toBe(`enc:v1:test:${persistedJson}`);
  });

  it("strips provider from smtp config while preserving other fields", async () => {
    await saveEmailInstallation("org-1", {
      provider: "smtp",
      senderAddress: "s@example.com",
      config: {
        provider: "smtp",
        host: "smtp.example.com",
        port: 587,
        username: "u",
        password: "p",
        tls: true,
      },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    const persisted = JSON.parse(insert!.params[2] as string);
    expect(persisted.provider).toBeUndefined();
    expect(persisted.host).toBe("smtp.example.com");
    expect(persisted.port).toBe(587);
    expect(persisted.password).toBe("p");
  });

  it("throws when internal DB not configured", async () => {
    mockHasDB = false;
    await expect(
      saveEmailInstallation("org-1", {
        provider: "resend",
        senderAddress: "r@example.com",
        config: { provider: "resend", apiKey: "x" },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip — save → load preserves the tagged variant
// ---------------------------------------------------------------------------

describe("save + load round-trip", () => {
  it("load after save restores the provider-tagged config", async () => {
    // Simulate the DB: capture the saved JSONB, then return it as the
    // next query's result.
    await saveEmailInstallation("org-1", {
      provider: "sendgrid",
      senderAddress: "sg@example.com",
      config: { provider: "sendgrid", apiKey: "sg_rtt" },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    const persistedJson = insert!.params[2] as string;
    const persistedConfig = JSON.parse(persistedJson);

    // Simulate the SELECT returning the persisted row. The stored config
    // does NOT carry `provider` (strip confirmed above); parser must
    // re-inject from the sibling column.
    mockInternalQueryResult = [
      {
        config_id: "cfg-rtt",
        provider: "sendgrid",
        sender_address: "sg@example.com",
        config: persistedConfig,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install!.config.provider).toBe("sendgrid");
    if (install!.config.provider === "sendgrid") {
      expect(install!.config.apiKey).toBe("sg_rtt");
    }
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F-41 — read-path prefers config_encrypted over plaintext JSONB
// ---------------------------------------------------------------------------

describe("F-41 encrypted-config read priority", () => {
  it("prefers decrypted config_encrypted over plaintext config", async () => {
    const freshConfig = { apiKey: "re_fresh_from_encrypted" };
    mockInternalQueryResult = [
      {
        config_id: "cfg-e1",
        provider: "resend",
        sender_address: "r@example.com",
        // Stale plaintext should be ignored once encrypted exists.
        config: { apiKey: "re_stale" },
        config_encrypted: `enc:v1:test:${JSON.stringify(freshConfig)}`,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install!.config.provider).toBe("resend");
    if (install!.config.provider === "resend") {
      expect(install!.config.apiKey).toBe("re_fresh_from_encrypted");
    }
  });

  it("falls back to plaintext JSONB when config_encrypted is NULL (legacy row)", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-e2",
        provider: "sendgrid",
        sender_address: "sg@example.com",
        config: { apiKey: "sg_legacy" },
        config_encrypted: null,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    if (install!.config.provider === "sendgrid") {
      expect(install!.config.apiKey).toBe("sg_legacy");
    }
  });
});

describe("deleteEmailInstallationByOrg", () => {
  it("returns true when a row was deleted", async () => {
    mockInternalQueryResult = [{ config_id: "cfg-del" }];
    const deleted = await deleteEmailInstallationByOrg("org-1");
    expect(deleted).toBe(true);
  });

  it("returns false when no matching row existed", async () => {
    mockInternalQueryResult = [];
    const deleted = await deleteEmailInstallationByOrg("org-1");
    expect(deleted).toBe(false);
  });

  it("throws when internal DB not configured", async () => {
    mockHasDB = false;
    await expect(deleteEmailInstallationByOrg("org-1")).rejects.toThrow();
  });
});
