/**
 * Tests for the F-42 plaintext-residue audit script. Drives `runAudit`
 * with a hand-rolled mock pg client so the per-row branching (F-41
 * column-level invariant + F-42 JSONB walk + corrupt-schema fail-closed)
 * is exercised without standing up a real DB.
 */

import { describe, it, expect } from "bun:test";
import {
  runAudit,
  auditIntegrationTable,
  type ResidueFinding,
} from "../../../../scripts/audit-plugin-config-residue";

interface MockRow {
  [key: string]: unknown;
}

/**
 * Minimal pg-pool stub. Maps SQL substrings to canned row-arrays so the
 * tests can assert per-table behaviour without parsing the SQL.
 */
function makeClient(byTable: Record<string, MockRow[]>) {
  return {
    query: async <T extends Record<string, unknown>>(sql: string) => {
      for (const [needle, rows] of Object.entries(byTable)) {
        if (sql.includes(needle)) return { rows: rows as T[] };
      }
      return { rows: [] as T[] };
    },
  };
}

describe("auditIntegrationTable", () => {
  it("flags missing encrypted column when enforceNotNull=true", async () => {
    const client = {
      query: async <T extends Record<string, unknown>>(): Promise<{ rows: T[] }> => ({
        rows: [
          { id: "row-clean", encrypted: "enc:v1:abc:def:ghi" },
          { id: "row-missing", encrypted: null },
          { id: "row-empty", encrypted: "" },
        ] as unknown as T[],
      }),
    };
    const result = await auditIntegrationTable(
      client,
      { table: "slack_installations", pk: "team_id", encrypted: "bot_token_encrypted" },
      true,
    );
    expect(result.scanned).toBe(3);
    const reasons = result.findings.map((f) => `${f.rowId}:${f.reason}`).sort();
    expect(reasons).toEqual([
      "row-empty:missing_encrypted_column",
      "row-missing:missing_encrypted_column",
    ]);
  });

  it("ignores missing encrypted column when enforceNotNull=false (Teams/Discord)", async () => {
    const client = {
      query: async <T extends Record<string, unknown>>(): Promise<{ rows: T[] }> => ({
        rows: [
          { id: "admin-consent", encrypted: null }, // legitimate state
          { id: "byot", encrypted: "enc:v1:abc:def:ghi" },
        ] as unknown as T[],
      }),
    };
    const result = await auditIntegrationTable(
      client,
      { table: "teams_installations", pk: "tenant_id", encrypted: "app_password_encrypted" },
      false,
    );
    expect(result.findings).toEqual([]);
  });

  it("flags plaintext-shaped values regardless of enforceNotNull", async () => {
    const client = {
      query: async <T extends Record<string, unknown>>(): Promise<{ rows: T[] }> => ({
        rows: [
          { id: "leaked", encrypted: "xoxb-1234-plaintext-bot-token" },
        ] as unknown as T[],
      }),
    };
    const enforced = await auditIntegrationTable(
      client,
      { table: "slack_installations", pk: "team_id", encrypted: "bot_token_encrypted" },
      true,
    );
    expect(enforced.findings).toEqual([
      { table: "slack_installations", rowId: "leaked", reason: "plaintext_secret_field" },
    ]);
  });

  it("rejects invalid SQL identifiers (defense-in-depth on the table catalog)", async () => {
    const client = { query: async () => ({ rows: [] }) };
    await expect(
      auditIntegrationTable(client, { table: "drop;--", pk: "id", encrypted: "x" }, true),
    ).rejects.toThrow("not a valid SQL identifier");
  });
});

describe("runAudit", () => {
  /**
   * Helper: build a clean state where every integration table has one
   * properly-encrypted row and the plugin tables are empty. Tests
   * compose findings on top of this baseline.
   */
  function cleanIntegrationState(): Record<string, MockRow[]> {
    return {
      "FROM slack_installations": [{ id: "T1", encrypted: "enc:v1:1:2:3" }],
      "FROM teams_installations": [{ id: "tn1", encrypted: "enc:v1:1:2:3" }],
      "FROM discord_installations": [{ id: "g1", encrypted: "enc:v1:1:2:3" }],
      "FROM telegram_installations": [{ id: "b1", encrypted: "enc:v1:1:2:3" }],
      "FROM gchat_installations": [{ id: "p1", encrypted: "enc:v1:1:2:3" }],
      "FROM github_installations": [{ id: "u1", encrypted: "enc:v1:1:2:3" }],
      "FROM linear_installations": [{ id: "u1", encrypted: "enc:v1:1:2:3" }],
      "FROM whatsapp_installations": [{ id: "p1", encrypted: "enc:v1:1:2:3" }],
      "FROM email_installations": [{ id: "c1", encrypted: "enc:v1:1:2:3" }],
      "FROM sandbox_credentials": [{ id: "s1", encrypted: "enc:v1:1:2:3" }],
      "FROM plugin_settings ps": [],
      "FROM workspace_plugins wp": [],
    };
  }

  it("returns ok:true when every table is clean", async () => {
    const client = makeClient(cleanIntegrationState());
    const report = await runAudit(client);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.scanned.integrationRows).toBe(10);
  });

  it("flags F-42 plaintext secret in workspace_plugins when schema is parsed", async () => {
    const state = cleanIntegrationState();
    state["FROM workspace_plugins wp"] = [
      {
        id: "wp-leaky",
        config: { apiKey: "sk-PLAIN-leaked-key", region: "us-east-1" },
        config_schema: [
          { key: "apiKey", type: "string", secret: true },
          { key: "region", type: "string", secret: false },
        ],
      },
    ];
    const report = await runAudit(makeClient(state));
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({
      table: "workspace_plugins",
      rowId: "wp-leaky",
      reason: "plaintext_secret_field",
      key: "apiKey",
    } satisfies ResidueFinding);
    // The non-secret value must NOT be flagged.
    expect(report.findings.find((f) => f.key === "region")).toBeUndefined();
  });

  it("counts secret fields verified clean for ops triage output", async () => {
    const state = cleanIntegrationState();
    state["FROM workspace_plugins wp"] = [
      {
        id: "wp-clean",
        config: { apiKey: "enc:v1:iv:tag:ct", debug: false },
        config_schema: [
          { key: "apiKey", type: "string", secret: true },
          { key: "debug", type: "boolean", secret: false },
        ],
      },
    ];
    const report = await runAudit(makeClient(state));
    expect(report.ok).toBe(true);
    expect(report.scanned.secretFieldsVerified).toBe(1);
  });

  it("fails-closed under corrupt schema — every plaintext string flagged", async () => {
    const state = cleanIntegrationState();
    state["FROM plugin_settings ps"] = [
      {
        id: "broken-schema",
        // Schema is corrupt (string instead of array). Encrypt-walker
        // would over-encrypt; audit walker over-flags. Symmetric.
        config: { someKey: "looks-like-plaintext", encryptedKey: "enc:v1:fine" },
        config_schema: "not-an-array",
      },
    ];
    const report = await runAudit(makeClient(state));
    expect(report.ok).toBe(false);
    const flagged = report.findings
      .filter((f) => f.table === "plugin_settings")
      .map((f) => `${f.key}:${f.reason}`);
    expect(flagged).toEqual(["someKey:plaintext_string_under_corrupt_schema"]);
  });

  it("redacts values from findings — only IDs and keys leak", async () => {
    const state = cleanIntegrationState();
    state["FROM workspace_plugins wp"] = [
      {
        id: "wp-leaky",
        config: { apiKey: "VERY-SECRET-KEY-DO-NOT-LEAK" },
        config_schema: [{ key: "apiKey", type: "string", secret: true }],
      },
    ];
    const report = await runAudit(makeClient(state));
    const json = JSON.stringify(report);
    // The secret value must not appear anywhere in the report.
    expect(json).not.toContain("VERY-SECRET-KEY-DO-NOT-LEAK");
    // But the row ID + key must be present so operators can investigate.
    expect(json).toContain("wp-leaky");
    expect(json).toContain("apiKey");
  });
});
