/**
 * Tests for email installation storage — the load-bearing piece of #1542.
 *
 * Covers:
 *  - provider-tag injection on read (sibling column wins)
 *  - provider-tag strip on save (JSONB never persists the tag)
 *  - round-trip (save → load round-trips the provider variant)
 *  - corrupt-row handling (unknown provider, mismatched JSONB provider,
 *    non-object config) returns null with a warn log
 *
 * Post-#1832 the plaintext `config` JSONB column is gone — reads
 * decrypt `config_encrypted`, writes only populate the encrypted blob.
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

/**
 * Convenience: build a row shape that matches what the SELECT returns.
 * `config_encrypted` is the only carrier — the plaintext JSONB column
 * was dropped in 0040.
 */
function rowFor(config: Record<string, unknown>, base: {
  configId?: string;
  provider: string;
  senderAddress: string;
  orgId?: string | null;
}) {
  return {
    config_id: base.configId ?? "cfg-1",
    provider: base.provider,
    sender_address: base.senderAddress,
    config_encrypted: `enc:v1:test:${JSON.stringify(config)}`,
    org_id: base.orgId ?? "org-1",
    installed_at: "2026-04-20T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Read — tag injection
// ---------------------------------------------------------------------------

describe("parseInstallationRow (via getEmailInstallationByOrg)", () => {
  it("injects provider tag from sibling column into JSONB config (resend)", async () => {
    mockInternalQueryResult = [rowFor({ apiKey: "re_12345" }, {
      provider: "resend",
      senderAddress: "Acme <noreply@acme.com>",
    })];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).not.toBeNull();
    expect(install!.provider).toBe("resend");
    expect(install!.config.provider).toBe("resend");
    if (install!.config.provider === "resend") {
      expect(install!.config.apiKey).toBe("re_12345");
    }
  });

  it("injects provider tag for smtp variants (preserves all fields)", async () => {
    mockInternalQueryResult = [rowFor(
      { host: "smtp.example.com", port: 587, username: "u", password: "p", tls: true },
      { configId: "cfg-2", provider: "smtp", senderAddress: "smtp-sender@example.com" },
    )];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install!.config.provider).toBe("smtp");
    if (install!.config.provider === "smtp") {
      expect(install!.config.host).toBe("smtp.example.com");
      expect(install!.config.port).toBe(587);
    }
  });

  it("sibling column wins when JSONB carries a stale provider tag", async () => {
    // Legacy row encrypted before the save-path strip — the stale tag
    // inside the ciphertext must not override the authoritative sibling
    // column.
    mockInternalQueryResult = [rowFor(
      { provider: "resend", apiKey: "stale-key" },
      { configId: "cfg-drift", provider: "sendgrid", senderAddress: "sg@example.com" },
    )];
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
    mockInternalQueryResult = [rowFor(
      { apiKey: "mg-key" },
      { configId: "cfg-x", provider: "mailgun", senderAddress: "mg@example.com" },
    )];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
    const unknownWarn = warnLogs.find((w) =>
      w.msg.includes("references unknown provider"),
    );
    expect(unknownWarn).toBeDefined();
    expect(unknownWarn!.ctx.provider).toBe("mailgun");
  });

  it("returns null when config_encrypted is missing", async () => {
    mockInternalQueryResult = [
      {
        config_id: "cfg-null",
        provider: "resend",
        sender_address: "r@example.com",
        config_encrypted: null,
        org_id: "org-1",
        installed_at: "2026-04-20T00:00:00Z",
      },
    ];
    const install = await getEmailInstallationByOrg("org-1");
    expect(install).toBeNull();
  });

  it("returns null when config_id is missing", async () => {
    mockInternalQueryResult = [rowFor(
      { apiKey: "x" },
      { configId: "", provider: "resend", senderAddress: "r@example.com" },
    )];
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
  it("strips provider from resend config before encrypting + INSERT", async () => {
    await saveEmailInstallation("org-1", {
      provider: "resend",
      senderAddress: "r@example.com",
      config: { provider: "resend", apiKey: "re_saved" },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    expect(insert).toBeDefined();
    // Third param is the encrypted blob: enc:v1:test:<json>. Body is the
    // JSON we serialized after stripping the discriminator.
    const ciphertext = insert!.params[2] as string;
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext.startsWith("enc:v1:test:")).toBe(true);
    const persisted = JSON.parse(ciphertext.slice("enc:v1:test:".length));
    // Discriminator must NOT be in the JSONB — it lives in the sibling
    // column so we don't double-store / risk drift.
    expect(persisted.provider).toBeUndefined();
    expect(persisted.apiKey).toBe("re_saved");
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
    const ciphertext = insert!.params[2] as string;
    const persisted = JSON.parse(ciphertext.slice("enc:v1:test:".length));
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
    await saveEmailInstallation("org-1", {
      provider: "sendgrid",
      senderAddress: "sg@example.com",
      config: { provider: "sendgrid", apiKey: "sg_rtt" },
    });
    const insert = capturedQueries.find((q) => q.sql.includes("INSERT INTO email_installations"));
    const ciphertext = insert!.params[2] as string;

    // Simulate the SELECT returning the persisted row. The stored config
    // does NOT carry `provider` (strip confirmed above); parser must
    // re-inject from the sibling column.
    mockInternalQueryResult = [
      {
        config_id: "cfg-rtt",
        provider: "sendgrid",
        sender_address: "sg@example.com",
        config_encrypted: ciphertext,
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
