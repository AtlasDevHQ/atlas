/**
 * Tests for `DataCandidateFormInstallHandler` (v0.0.2 slice 6a, #3028). Drives
 * the slim candidate install path with an injected probe `fetch` (no live HTTP) +
 * a mocked `internalQuery`, asserting: the slim form rejects spec-URL / auth-kind
 * fields (locked), the probe uses the candidate's pre-filled URL, `auth_value` is
 * encrypted, and the row is inserted under the candidate's catalog id.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { DataCandidateFormDataSchema } from "../data-candidate-form-handler";
import { STRIPE_DATA_CANDIDATE } from "@atlas/api/lib/openapi/data-candidates";

describe("DataCandidateFormDataSchema", () => {
  it("accepts a minimal credential-only install", () => {
    const parsed = DataCandidateFormDataSchema.safeParse({ auth_value: "sk_live_x" });
    expect(parsed.success).toBe(true);
  });

  it("requires auth_value", () => {
    const parsed = DataCandidateFormDataSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects a whitespace-only auth_value (trim runs before min(1))", () => {
    expect(DataCandidateFormDataSchema.safeParse({ auth_value: "   " }).success).toBe(false);
  });

  it("rejects a locked field (openapi_url / auth_kind) via the strict schema", () => {
    expect(
      DataCandidateFormDataSchema.safeParse({ auth_value: "x", openapi_url: "https://evil/spec" })
        .success,
    ).toBe(false);
    expect(
      DataCandidateFormDataSchema.safeParse({ auth_value: "x", auth_kind: "none" }).success,
    ).toBe(false);
  });
});

describe("DataCandidateFormInstallHandler.validateConfig", () => {
  const STRIPE_FIXTURE_SPEC = {
    openapi: "3.0.0",
    info: { title: "Stripe API", version: "2024-06-20" },
    servers: [{ url: "https://api.stripe.com/" }],
    paths: {
      "/v1/customers": {
        get: { operationId: "GetCustomers", responses: { "200": { description: "ok" } } },
      },
    },
  };

  let queryCalls: Array<{ sql: string; params: unknown[] }>;
  let probedUrls: string[];
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    queryCalls = [];
    probedUrls = [];
    // Set an encryption keyset so auth_value is actually encrypted at rest
    // (mirrors openapi-generic-form-handler.test.ts:setKeys) — without it the
    // keyless dev passthrough stores plaintext and the encryption assertions fail.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-data-candidate-handler-unit-tests-32b";
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_DEPLOY_MODE;
    _resetEncryptionKeyCache();
    // Mock every export the install graph might import (partial mock.module trips
    // "Export not found" on a transitive import — CLAUDE.md).
    mock.module("@atlas/api/lib/db/internal", () => ({
      internalQuery: async (sql: string, params: unknown[]) => {
        queryCalls.push({ sql, params });
        return [{ id: (params[0] as string) ?? "generated-id" }];
      },
      hasInternalDB: () => true,
      getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
    }));
  });

  afterEach(() => {
    mock.restore();
    process.env = { ...ORIGINAL_ENV };
    _resetEncryptionKeyCache();
  });

  it("probes the candidate's locked spec URL, encrypts auth_value, inserts under its catalog id", async () => {
    const { DataCandidateFormInstallHandler } = await import("../data-candidate-form-handler");
    const handler = new DataCandidateFormInstallHandler(STRIPE_DATA_CANDIDATE, {
      idGenerator: () => "fixed-uuid",
      now: () => "2026-05-30T00:00:00.000Z",
      fetchImpl: (async (input: string | URL) => {
        probedUrls.push(typeof input === "string" ? input : input.toString());
        return new Response(JSON.stringify(STRIPE_FIXTURE_SPEC), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await handler.validateConfig("ws-1" as never, { auth_value: "sk_live_secret" });

    expect(result.credentialWritten).toBe(true);
    expect(result.installRecord.id).toBe("fixed-uuid");
    // InstallRecord carries the candidate slug.
    expect(result.installRecord.catalogId).toBe("stripe-data");
    // The probe used the candidate's pre-filled spec URL (admin never supplied one).
    expect(probedUrls[0]).toBe(STRIPE_DATA_CANDIDATE.openapiUrl);

    const insertCall = queryCalls.find((c) => c.sql.includes("INSERT INTO workspace_plugins"));
    expect(insertCall).toBeDefined();
    // Row inserted under the candidate catalog id (catalog:stripe-data), encrypted.
    expect(insertCall!.params[2]).toBe(STRIPE_DATA_CANDIDATE.catalogId);
    const configJson = insertCall!.params[3] as string;
    expect(configJson).toContain("enc:"); // versioned ciphertext prefix
    expect(configJson).not.toContain("sk_live_secret");
    // The locked spec URL + auth kind are persisted from the candidate, not the form.
    expect(configJson).toContain(STRIPE_DATA_CANDIDATE.openapiUrl);
  });
});
