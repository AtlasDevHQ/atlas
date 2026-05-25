/**
 * Tests for {@link GitHubPatFormInstallHandler} (#2751, Phase D PAT mode).
 *
 * Mirrors {@link ./linear-apikey-form-handler.test.ts}; GitHub-PAT-specific
 * pins:
 *
 *   - Only the `pat` field is `secret: true` and round-trips through
 *     `encryptSecretFields`; `default_owner` stays plaintext.
 *   - INSERT uses the post-0092 explicit `pillar='action'` + `install_id`
 *     shape with the partial unique index conflict target.
 *   - SaaS keyset gate fails closed even though the catalog row carries
 *     `saas_eligible: false` (defense in depth — if the integrations-
 *     catalog filter is ever bypassed, the handler still refuses to
 *     persist plaintext).
 *   - Validation pins the owner-name regex (alphanumeric + hyphens,
 *     leading alphanumeric) so a typo like a leading hyphen surfaces
 *     before the upstream GitHub call.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import type { WorkspaceId } from "@useatlas/types";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const WSID = "ws-github-pat-1" as WorkspaceId;

type HandlerCtor = typeof import("../github-pat-form-handler").GitHubPatFormInstallHandler;
type ValidationErrCtor = typeof import("../github-pat-form-handler").FormInstallValidationError;
let GitHubPatFormInstallHandler!: HandlerCtor;
let FormInstallValidationError!: ValidationErrCtor;

beforeAll(async () => {
  const mod = await import("../github-pat-form-handler");
  GitHubPatFormInstallHandler = mod.GitHubPatFormInstallHandler;
  FormInstallValidationError = mod.FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

function validForm(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pat: "ghp_testtokenabcdefghijklmnopqrstuvwxyz1234",
    default_owner: "acme-corp",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys("v1:test-key-for-github-pat-handler-unit-tests-must-be-long-enough");
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("GitHubPatFormInstallHandler.validateConfig — input validation", () => {
  it("rejects missing pat with FormInstallValidationError", async () => {
    const handler = new GitHubPatFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { default_owner: "acme-corp" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.pat).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects pat with characters GitHub never uses (whitespace / punctuation)", async () => {
    const handler = new GitHubPatFormInstallHandler();
    await expect(
      handler.validateConfig(WSID, validForm({ pat: "has spaces and !" })),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts both classic (ghp_) and fine-grained (github_pat_) token shapes", async () => {
    const handler = new GitHubPatFormInstallHandler();
    // Classic
    await handler.validateConfig(WSID, validForm({ pat: "ghp_classic40charsABCDEFGHIJKLMNOPQRSTUV" }));
    // Fine-grained — long string of underscore + alphanum after the prefix
    await handler.validateConfig(WSID, validForm({ pat: "github_pat_abc_DEF_123_xyz_789_long_enough" }));
    expect(mockInternalQuery).toHaveBeenCalledTimes(2);
  });

  it("rejects default_owner with a leading hyphen (GitHub owner-name rule)", async () => {
    const handler = new GitHubPatFormInstallHandler();
    await expect(
      handler.validateConfig(WSID, validForm({ default_owner: "-bad-leading" })),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts a missing default_owner (optional)", async () => {
    const handler = new GitHubPatFormInstallHandler();
    const result = await handler.validateConfig(WSID, { pat: "ghp_only_token_no_owner" });
    expect(result.credentialWritten).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — encryption round-trip + INSERT shape
// ---------------------------------------------------------------------------

describe("GitHubPatFormInstallHandler.validateConfig — happy path", () => {
  it("encrypts only the pat field and persists default_owner plaintext", async () => {
    const handler = new GitHubPatFormInstallHandler();

    await handler.validateConfig(WSID, validForm());

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string | undefined;
    expect(configJson).toBeDefined();
    const persisted = JSON.parse(configJson!) as Record<string, unknown>;

    // pat is encrypted at rest — should NOT round-trip as plaintext.
    expect(persisted.pat).toBeTypeOf("string");
    expect(persisted.pat).not.toBe("ghp_testtokenabcdefghijklmnopqrstuvwxyz1234");
    expect(persisted.pat as string).toMatch(/^enc:/);
    // Decrypt to verify the round-trip.
    expect(decryptSecret(persisted.pat as string)).toBe("ghp_testtokenabcdefghijklmnopqrstuvwxyz1234");

    // default_owner stays plaintext — admin UI reads need no decrypt.
    expect(persisted.default_owner).toBe("acme-corp");
  });

  it("INSERT names pillar='action' and install_id explicitly (post-0092 shape)", async () => {
    const handler = new GitHubPatFormInstallHandler();
    await handler.validateConfig(WSID, validForm());

    const [sql] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/install_id/);
    expect(sql).toMatch(/pillar/);
    expect(sql).toMatch(/'action'/);
    expect(sql).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    // Catalog id must be `catalog:github-pat` — the dispatch key.
    const params = mockInternalQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("catalog:github-pat");
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate — defense in depth even though catalog hides this row
// ---------------------------------------------------------------------------

describe("GitHubPatFormInstallHandler.validateConfig — SaaS keyset gate", () => {
  it("refuses to persist when SaaS + no keyset (would leak plaintext)", async () => {
    // The catalog row carries `saas_eligible: false`, so the
    // integrations-catalog filter already hides github-pat on SaaS.
    // The keyset gate stays as defense in depth: if a SaaS deploy
    // somehow surfaces this install path (filter bypass, dev-mode
    // operator, future regression), refuse to persist plaintext.
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const handler = new GitHubPatFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /Encryption keyset unavailable/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
