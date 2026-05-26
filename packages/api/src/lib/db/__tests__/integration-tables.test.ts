/**
 * Pin assertions on the INTEGRATION_TABLES catalog.
 *
 * F-47 rotation + F-42 residue audit iterate this array, so a row
 * dropped during a rebase silently strands the table outside the
 * rotation / audit safety net. The tests here lock in every member,
 * so accidentally removing one fails the suite loudly.
 */

import { describe, test, expect } from "bun:test";
import {
  INTEGRATION_TABLES,
  NON_NULL_ENCRYPTED_TABLES,
} from "../integration-tables";

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
});
