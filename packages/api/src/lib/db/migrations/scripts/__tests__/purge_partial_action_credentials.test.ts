/**
 * The one-shot partial-row cleanup (#5564).
 *
 * Two things are worth pinning about a script whose job is DELETE: that it
 * deletes exactly the rows the runtime would call partial (not its own idea of
 * partial), and that everything it is unsure about survives.
 *
 * @see packages/api/src/lib/db/migrations/scripts/purge_partial_action_credentials.ts
 */

import { describe, it, expect, mock } from "bun:test";

// The ciphertext column is an opaque string to this script, so the test's
// "encryption" is identity — what is being tested is the classification, not
// AES. The store's own suite covers the round trip.
void mock.module("@atlas/api/lib/db/secret-encryption", () => ({
  decryptSecret: (stored: string) => {
    if (stored === "CORRUPT") throw new Error("decrypt failed");
    return stored;
  },
  // The script reads only `decryptSecret`; the rest are here because the
  // credential store sits in its import graph and named imports resolve
  // eagerly (testing.md — mock ALL exports a module under mock provides).
  encryptSecret: (plaintext: string) => plaintext,
  activeKeyVersion: () => 1,
}));
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  // Same reason: the store imports it. This suite drives its own fake DB, so
  // a call through here would be a bug rather than a fallback.
  internalQuery: () => {
    throw new Error("purge script must not reach the internal-DB pool");
  },
}));
void mock.module("@atlas/api/lib/config", () => ({ getConfig: () => ({ deployMode: "saas" }) }));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// Types only — `import type` is erased, so it does not evaluate the module
// ahead of the `mock.module` calls above the way a value import would.
import type { StoredCredentialRow, PurgeDB } from "../purge_partial_action_credentials";

const { classifyRow, purgePartialRows } = await import("../purge_partial_action_credentials");

const COMPLETE_JIRA = JSON.stringify({
  JIRA_BASE_URL: "https://tenant.atlassian.net",
  JIRA_EMAIL: "admin@tenant.example",
  JIRA_API_TOKEN: "tenant-token",
});
const PARTIAL_JIRA = JSON.stringify({ JIRA_BASE_URL: "https://tenant.atlassian.net" });

function row(over: Partial<StoredCredentialRow>): StoredCredentialRow {
  return {
    id: "row-1",
    workspace_id: "ws-1",
    target: "jira",
    credentials_encrypted: COMPLETE_JIRA,
    ...over,
  };
}

describe("classifyRow", () => {
  it("a row satisfying every required field is complete", () => {
    expect(classifyRow(row({}))).toEqual({ kind: "complete" });
  });

  it("a row missing a required field is partial, and names the fields", () => {
    expect(classifyRow(row({ credentials_encrypted: PARTIAL_JIRA }))).toEqual({
      kind: "partial",
      missing: ["JIRA_EMAIL", "JIRA_API_TOKEN"],
    });
  });

  it("an OPTIONAL field left unset does not make a row partial", () => {
    // JIRA_DEFAULT_PROJECT is `required: false`. Treating optional fields as
    // required is the mistake that would make this script delete every row.
    expect(classifyRow(row({}))).toEqual({ kind: "complete" });
  });

  it("an empty bundle is partial, not complete — an empty map satisfies nothing", () => {
    const verdict = classifyRow(row({ credentials_encrypted: "{}" }));
    expect(verdict.kind).toBe("partial");
  });

  it("a row for an UNREGISTERED target is left alone", () => {
    // The registry cannot say what complete means for it, and a target can be
    // temporarily absent across a revert. "Unknown" is not "junk".
    expect(classifyRow(row({ target: "not-a-target" }))).toEqual({ kind: "unmanaged" });
  });

  it("a row that fails to decrypt is unreadable, never partial", () => {
    const verdict = classifyRow(row({ credentials_encrypted: "CORRUPT" }));
    expect(verdict.kind).toBe("unreadable");
  });

  it("a row whose plaintext is not a string→string map is unreadable", () => {
    const verdict = classifyRow(row({ credentials_encrypted: JSON.stringify({ JIRA_BASE_URL: 7 }) }));
    expect(verdict.kind).toBe("unreadable");
  });

  it("never echoes decrypted bytes in the verdict", () => {
    // `JSON.parse`'s own error message embeds its input, and the input here is
    // a decrypted tenant bundle (#4984).
    const verdict = classifyRow(row({ credentials_encrypted: "s3cr3t-not-json" }));
    expect(JSON.stringify(verdict)).not.toContain("s3cr3t");
  });
});

function fakeDB(rows: StoredCredentialRow[]): { db: PurgeDB; deletes: unknown[][] } {
  const deletes: unknown[][] = [];
  const db: PurgeDB = {
    // oxlint-disable-next-line no-explicit-any -- the fake answers two known
    // statements; a generic `{ rows }` is the whole contract `PurgeDB` states.
    query: (async (sql: string, params?: unknown[]) => {
      if (sql.trimStart().startsWith("DELETE")) {
        deletes.push(params ?? []);
        const ids = (params?.[0] ?? []) as string[];
        return { rows: ids.map((id) => ({ id })) };
      }
      return { rows };
    }) as PurgeDB["query"],
  };
  return { db, deletes };
}

describe("purgePartialRows", () => {
  const mixed = [
    row({ id: "a", credentials_encrypted: COMPLETE_JIRA }),
    row({ id: "b", credentials_encrypted: PARTIAL_JIRA }),
    row({ id: "c", target: "not-a-target" }),
    row({ id: "d", credentials_encrypted: "CORRUPT" }),
  ];

  it("dry run is the default — it classifies and writes nothing", async () => {
    const { db, deletes } = fakeDB(mixed);
    const summary = await purgePartialRows(db, { confirm: false, log: () => {} });

    expect(deletes).toHaveLength(0);
    expect(summary.deleted).toBe(0);
    expect(summary).toMatchObject({
      scanned: 4,
      partial: 1,
      complete: 1,
      unmanaged: 1,
      unreadable: 1,
    });
  });

  it("with --confirm it deletes the partial rows, and ONLY those", async () => {
    const { db, deletes } = fakeDB(mixed);
    const summary = await purgePartialRows(db, { confirm: true, log: () => {} });

    expect(deletes).toHaveLength(1);
    expect(deletes[0]![0]).toEqual(["b"]);
    expect(summary.deleted).toBe(1);
  });

  it("issues no DELETE at all when nothing is partial", async () => {
    const { db, deletes } = fakeDB([row({ id: "a" })]);
    await purgePartialRows(db, { confirm: true, log: () => {} });

    expect(deletes).toHaveLength(0);
  });

  it("reports env-var names, never values", async () => {
    const lines: string[] = [];
    const { db } = fakeDB([row({ id: "b", credentials_encrypted: PARTIAL_JIRA })]);
    await purgePartialRows(db, { confirm: false, log: (l) => lines.push(l) });

    const output = lines.join("\n");
    expect(output).toContain("JIRA_API_TOKEN");
    expect(output).not.toContain("tenant.atlassian.net");
  });
});
