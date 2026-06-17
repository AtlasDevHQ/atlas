/**
 * Tests for operator credential resolution precedence (#3704):
 * DB row (Admin-set) → operator env var → unset.
 *
 * `readOperatorCredentials` + `hasInternalDB` are mocked so we drive the
 * resolver with controlled DB state; env is set per-case on a clone.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

const mockRead: Mock<(platform: string) => Promise<Record<string, string> | null>> = mock(() =>
  Promise.resolve(null),
);
const mockHasInternalDB: Mock<() => boolean> = mock(() => true);

mock.module("../store", () => ({
  readOperatorCredentials: mockRead,
}));
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
}));

import {
  resolveOperatorAdapterEnv,
  getOperatorPlatformStatus,
  getMissingOperatorEnvForCatalogSlug,
  resolveOperatorFieldValue,
} from "../resolver";
import { OPERATOR_PLATFORMS } from "../platforms";

beforeEach(() => {
  mockRead.mockReset();
  mockRead.mockResolvedValue(null);
  mockHasInternalDB.mockReset();
  mockHasInternalDB.mockReturnValue(true);
});

afterEach(() => {
  mockRead.mockReset();
});

const slackEnvFull: NodeJS.ProcessEnv = {
  SLACK_CLIENT_ID: "env-id",
  SLACK_CLIENT_SECRET: "env-secret",
  SLACK_SIGNING_SECRET: "env-sign",
  SLACK_ENCRYPTION_KEY: "env-enc",
};

describe("resolveOperatorAdapterEnv", () => {
  it("returns DB values as the overlay (DB wins over env)", async () => {
    mockRead.mockResolvedValue({ SLACK_SIGNING_SECRET: "db-sign" });
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    expect(overlay.SLACK_SIGNING_SECRET).toBe("db-sign");
    // Fields not in the DB row are NOT in the overlay (env passes through).
    expect(overlay.SLACK_CLIENT_ID).toBeUndefined();
  });

  it("returns an empty overlay when no DB row exists (pure env fallback)", async () => {
    mockRead.mockResolvedValue(null);
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    expect(overlay).toEqual({});
  });

  it("returns an empty overlay (no DB read) when no internal DB is configured", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    expect(overlay).toEqual({});
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("ignores empty-string DB values (no clobber)", async () => {
    mockRead.mockResolvedValue({ SLACK_SIGNING_SECRET: "" });
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    expect(overlay.SLACK_SIGNING_SECRET).toBeUndefined();
  });

  it("propagates a decrypt failure rather than degrading to env-only", async () => {
    mockRead.mockRejectedValue(new Error("auth tag mismatch"));
    await expect(resolveOperatorAdapterEnv(OPERATOR_PLATFORMS)).rejects.toThrow(
      /auth tag mismatch/,
    );
  });

  // #3741 — a not-yet-migrated table (first boot before migration 0140) is
  // benign: degrade to env-fallback instead of taking the adapter down.
  it("tolerates a missing table (pg 42P01) and degrades to env-fallback", async () => {
    const undefinedTable = Object.assign(
      new Error('relation "operator_integration_credentials" does not exist'),
      { code: "42P01" },
    );
    mockRead.mockRejectedValue(undefinedTable);
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    // No throw; empty overlay → callers fall through to env exactly as an
    // empty table would.
    expect(overlay).toEqual({});
  });

  it("tolerates a missing table identified by message alone (no .code)", async () => {
    mockRead.mockRejectedValue(
      new Error('relation "operator_integration_credentials" does not exist'),
    );
    const overlay = await resolveOperatorAdapterEnv(OPERATOR_PLATFORMS);
    expect(overlay).toEqual({});
  });

  it("still propagates a decrypt failure even after the missing-table carve-out", async () => {
    // A wrapped payload-validation error carries no 42P01 code and does not
    // match the relation-missing message → must still rethrow.
    mockRead.mockRejectedValue(
      new Error("operator_integration_credentials payload validation failed for platform=slack"),
    );
    await expect(resolveOperatorAdapterEnv(OPERATOR_PLATFORMS)).rejects.toThrow(
      /payload validation failed/,
    );
  });
});

describe("resolveOperatorFieldValue", () => {
  const field = OPERATOR_PLATFORMS[0].fields[0]; // SLACK_CLIENT_ID

  it("prefers the DB value", () => {
    expect(resolveOperatorFieldValue(field, { SLACK_CLIENT_ID: "db" }, { SLACK_CLIENT_ID: "env" })).toBe("db");
  });
  it("falls back to env when DB is absent", () => {
    expect(resolveOperatorFieldValue(field, null, { SLACK_CLIENT_ID: "env" })).toBe("env");
  });
  it("returns undefined when neither source has it", () => {
    expect(resolveOperatorFieldValue(field, null, {})).toBeUndefined();
  });
  it("treats an empty DB value as absent and falls back to env", () => {
    expect(resolveOperatorFieldValue(field, { SLACK_CLIENT_ID: "" }, { SLACK_CLIENT_ID: "env" })).toBe("env");
  });
});

describe("getOperatorPlatformStatus", () => {
  it("marks configured when all required fields resolve from env", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getOperatorPlatformStatus("slack", slackEnvFull);
    expect(status?.configured).toBe(true);
    expect(status?.hasDbOverride).toBe(false);
    expect(status?.fields.every((f) => f.source === "env")).toBe(true);
    // No secret values are present on the status, only presence + source.
    for (const f of status!.fields) {
      expect(Object.keys(f)).not.toContain("value");
    }
  });

  it("reports the DB source and not configured when a required field is missing everywhere", async () => {
    mockRead.mockResolvedValue({ SLACK_CLIENT_ID: "db-id" });
    const status = await getOperatorPlatformStatus("slack", {});
    expect(status?.hasDbOverride).toBe(true);
    expect(status?.configured).toBe(false);
    const clientId = status?.fields.find((f) => f.envVar === "SLACK_CLIENT_ID");
    expect(clientId?.source).toBe("db");
    const signing = status?.fields.find((f) => f.envVar === "SLACK_SIGNING_SECRET");
    expect(signing?.source).toBe("unset");
    expect(signing?.present).toBe(false);
  });

  it("returns null for an unmanaged platform", async () => {
    const status = await getOperatorPlatformStatus("not-a-platform", {});
    expect(status).toBeNull();
  });
});

describe("getMissingOperatorEnvForCatalogSlug (boot-guard helper)", () => {
  const REQUIRED = [
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_ENCRYPTION_KEY",
  ];

  it("returns [] when the DB row supplies a key env is missing (DB satisfies)", async () => {
    mockRead.mockResolvedValue({ SLACK_ENCRYPTION_KEY: "db-enc" });
    const envMissingEncKey: NodeJS.ProcessEnv = {
      SLACK_CLIENT_ID: "e",
      SLACK_CLIENT_SECRET: "e",
      SLACK_SIGNING_SECRET: "e",
    };
    const missing = await getMissingOperatorEnvForCatalogSlug("slack", REQUIRED, envMissingEncKey);
    expect(missing).toEqual([]);
  });

  it("reports keys absent from BOTH sources", async () => {
    mockRead.mockResolvedValue({ SLACK_CLIENT_ID: "db-id" });
    const missing = await getMissingOperatorEnvForCatalogSlug("slack", REQUIRED, {});
    expect([...missing].sort()).toEqual([
      "SLACK_CLIENT_SECRET",
      "SLACK_ENCRYPTION_KEY",
      "SLACK_SIGNING_SECRET",
    ]);
  });

  it("collapses to env-only when no internal DB (self-host) — no DB read", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const missing = await getMissingOperatorEnvForCatalogSlug("slack", REQUIRED, {
      SLACK_CLIENT_ID: "e",
      SLACK_CLIENT_SECRET: "e",
      SLACK_SIGNING_SECRET: "e",
      SLACK_ENCRYPTION_KEY: "e",
    });
    expect(missing).toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("collapses to env-only for an unmanaged slug (no DB read)", async () => {
    const missing = await getMissingOperatorEnvForCatalogSlug("discord", ["DISCORD_BOT_TOKEN"], {
      DISCORD_BOT_TOKEN: "set",
    });
    expect(missing).toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("propagates a decrypt failure rather than masquerading as configured/missing", async () => {
    // The boot guard wraps this in `Effect.orDie`, so a thrown read fails boot
    // loud. It must NOT be swallowed into "[]" (configured) or "everything
    // missing" — a broken rotation must never silently look fine.
    mockRead.mockRejectedValue(new Error("auth tag mismatch"));
    await expect(
      getMissingOperatorEnvForCatalogSlug("slack", REQUIRED, slackEnvFull),
    ).rejects.toThrow(/auth tag mismatch/);
  });
});
