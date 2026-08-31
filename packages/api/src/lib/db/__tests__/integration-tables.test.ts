/**
 * Pin assertions + the completeness tripwire for the encryption axis.
 *
 * F-47 rotation + F-42 residue audit iterate `INTEGRATION_TABLES`, so a
 * row dropped during a rebase silently strands the table outside the
 * rotation / audit safety net. The pin tests lock in the members.
 *
 * The enumeration tests below are the axis's completeness guard — the
 * same shape `purge-scope.test.ts` and `bundle-scope.test.ts` give the
 * erasure and residency axes: walk the Drizzle schema and require every
 * `*_encrypted` column to be classified in `db/integration-tables.ts`,
 * either as a rotation participant or as a declared skip. Until this
 * landed, encryption was the one lifecycle axis with no such guard, and
 * the drift was live twice (`workspace_model_config` rotated only via a
 * hand-copy inside the rotation script; `email_outbox.payload` skipped
 * only by prose).
 *
 * Considered and declined: a source scan for `encryptSecret(` call
 * sites, to also catch ciphertext columns NOT named `*_encrypted`
 * (`email_outbox.payload`, `sso_providers.config`). ~56 files mention
 * the symbol — mostly comments, re-exports and multi-line imports — so
 * the scan would need comment-stripping plus an alias-proof import
 * parser to avoid crying wolf, and aliased imports evade it anyway. The
 * `_encrypted` suffix is the convention the security rule itself
 * mandates for new credential columns, so the suffix walk is the honest
 * load-bearing direction; non-suffix columns stay pinned by the two
 * skip entries and the JSONB selective-field walker's own coverage.
 */

import { describe, test, expect } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  ENCRYPTED_OUTSIDE_ROTATION,
  INTEGRATION_TABLES,
  NON_NULL_ENCRYPTED_TABLES,
  ROTATED_COLUMN_TABLES,
  STANDALONE_ROTATION_TABLES,
} from "../integration-tables";

/** Every Drizzle table config in the schema module. */
const ALL_TABLE_CONFIGS = Object.values(schema).flatMap((v) =>
  is(v, PgTable) ? [getTableConfig(v)] : [],
);

/** SQL column names per SQL table name. */
const SCHEMA_COLUMNS = new Map<string, ReadonlySet<string>>(
  ALL_TABLE_CONFIGS.map((cfg) => [cfg.name, new Set(cfg.columns.map((c) => c.name))]),
);

describe("INTEGRATION_TABLES registry", () => {
  test("twenty_integrations is registered with the expected column shape", () => {
    const entry = INTEGRATION_TABLES.find((t) => t.table === "twenty_integrations");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      table: "twenty_integrations",
      encrypted: "api_key_encrypted",
      keyVersionColumn: "api_key_key_version",
    });
  });

  test("twenty_integrations is in NON_NULL_ENCRYPTED_TABLES (api_key is required, not OAuth-only)", () => {
    const entry = NON_NULL_ENCRYPTED_TABLES.find((t) => t.table === "twenty_integrations");
    expect(entry).toBeDefined();
  });

  test("every entry carries pk / encrypted / keyVersionColumn strings", () => {
    for (const entry of INTEGRATION_TABLES) {
      expect(entry.table).toBeTypeOf("string");
      expect(entry.table.length).toBeGreaterThan(0);
      expect(entry.pk).toBeTypeOf("string");
      expect(entry.encrypted).toBeTypeOf("string");
      expect(entry.keyVersionColumn).toBeTypeOf("string");
    }
  });

  test("workspace_model_config rotates via STANDALONE_ROTATION_TABLES, not the integration list", () => {
    // The hand-copy this entry replaced lived inside rotate-encryption-key.ts.
    // It stays out of INTEGRATION_TABLES deliberately: legacy internal.ts
    // helper (plaintext passthrough without a keyset), so the F-42
    // ciphertext-shape audit would false-positive on self-hosted rows.
    expect(STANDALONE_ROTATION_TABLES.find((t) => t.table === "workspace_model_config")).toMatchObject({
      pk: "id",
      encrypted: "api_key_encrypted",
      keyVersionColumn: "api_key_key_version",
    });
    expect(INTEGRATION_TABLES.some((t) => t.table === "workspace_model_config")).toBe(false);
    expect(NON_NULL_ENCRYPTED_TABLES.some((t) => t.table === "workspace_model_config")).toBe(false);
  });
});

describe("encryption-axis completeness (schema enumeration)", () => {
  test("every *_encrypted column in the Drizzle schema is classified", () => {
    const classified = new Set<string>([
      ...ROTATED_COLUMN_TABLES.map((t) => `${t.table}.${t.encrypted}`),
      ...ENCRYPTED_OUTSIDE_ROTATION.map((s) => `${s.table}.${s.column}`),
    ]);
    const unclassified: string[] = [];
    for (const cfg of ALL_TABLE_CONFIGS) {
      for (const col of cfg.columns) {
        if (col.name.endsWith("_encrypted") && !classified.has(`${cfg.name}.${col.name}`)) {
          unclassified.push(`${cfg.name}.${col.name}`);
        }
      }
    }
    // A hit here means a new at-rest-encrypted column exists that neither
    // rotates (ROTATED_COLUMN_TABLES) nor declares why it doesn't
    // (ENCRYPTED_OUTSIDE_ROTATION). Classify it in db/integration-tables.ts —
    // absence must be a decision, not an omission.
    expect(unclassified).toEqual([]);
  });

  test("every rotation entry names a real table with real columns (stale direction)", () => {
    for (const entry of ROTATED_COLUMN_TABLES) {
      const columns = SCHEMA_COLUMNS.get(entry.table);
      expect(columns, `${entry.table} is in the rotation registry but not the Drizzle schema`).toBeDefined();
      if (!columns) continue;
      for (const col of [entry.pk, entry.encrypted, entry.keyVersionColumn]) {
        expect(columns.has(col), `${entry.table}.${col} named by the rotation registry does not exist`).toBe(true);
      }
    }
  });

  test("every declared skip names a real table + column, with a load-bearing reason", () => {
    for (const skip of ENCRYPTED_OUTSIDE_ROTATION) {
      const columns = SCHEMA_COLUMNS.get(skip.table);
      expect(columns, `${skip.table} is in ENCRYPTED_OUTSIDE_ROTATION but not the Drizzle schema`).toBeDefined();
      expect(columns?.has(skip.column), `${skip.table}.${skip.column} named by a skip does not exist`).toBe(true);
      // A one-liner can't carry the grounds a future reader needs to
      // decide whether the skip still holds.
      expect(skip.reason.length).toBeGreaterThan(80);
      expect(["manual", "expires"]).toContain(skip.rotation);
    }
  });

  test("no column is both a rotation participant and a declared skip", () => {
    const rotated = new Set(ROTATED_COLUMN_TABLES.map((t) => `${t.table}.${t.encrypted}`));
    for (const skip of ENCRYPTED_OUTSIDE_ROTATION) {
      expect(rotated.has(`${skip.table}.${skip.column}`)).toBe(false);
    }
  });

  test("ROTATED_COLUMN_TABLES is exactly the two source lists, no duplicates", () => {
    expect(ROTATED_COLUMN_TABLES.length).toBe(
      INTEGRATION_TABLES.length + STANDALONE_ROTATION_TABLES.length,
    );
    const names = ROTATED_COLUMN_TABLES.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });
});
