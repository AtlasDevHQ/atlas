/**
 * Tests for `OAuthDatasourceInstallHandler` (v0.0.2 slice 6c, #3030 — the OQ5
 * deliverable). Drives the GitHub-as-datasource OAuth install end-to-end with an
 * injected `fetch` (no live HTTP), an injected encryption keyset, and a mocked
 * `internalQuery`, asserting:
 *
 *   - state-token forgery / replay / wrong-catalog → null (no persistence)
 *   - the user-OAuth code-exchange + installation-ownership verification (the
 *     cross-tenant binding guard) runs against the injected fetch
 *   - a successful install probes the pre-wired spec, mints a health-check
 *     installation token, encrypts the installation_id, and inserts a
 *     `pillar='datasource'` multi-instance row with `config.status='ok'`
 *   - a failed health-check mint flips the install to "reconnect needed"
 *     (`credentialResult.written=false`, `config.status='reconnect_needed'`)
 *     while still persisting the row
 *   - an installation the user does NOT own (cross-org) is rejected
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "crypto";
import type { WorkspaceId } from "@useatlas/types";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { __resetInstallationTokenCacheForTests } from "@atlas/api/lib/github/installation-token";
import { mintOAuthStateToken } from "../oauth-state-token";
import {
  OAuthDatasourceInstallHandler,
  type OAuthDatasourceHandlerConfig,
} from "../oauth-datasource-handler";

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const WSID = "ws-github-data-1" as WorkspaceId;
const OTHER_WSID = "ws-github-data-2" as WorkspaceId;
const SLUG = "github-data";
const CATALOG_ID = "catalog:github-data";
const INSTALLATION_ID = "55667788";
const SPEC_URL = "https://example.test/github-openapi.json";

const CONFIG: OAuthDatasourceHandlerConfig = {
  slug: SLUG,
  catalogId: CATALOG_ID,
  openapiUrl: SPEC_URL,
  appSlug: "atlas-test-app",
  appId: "424242",
  clientId: "Iv1.testclient",
  clientSecret: "test-client-secret",
  privateKey: APP_PRIVATE_KEY,
  redirectUri: "https://atlas.test/api/v1/integrations/github-data/callback",
};

/** A minimal valid OpenAPI 3.x spec the probe normalizes — GitHub-shaped. */
const GITHUB_FIXTURE_SPEC = {
  openapi: "3.1.0",
  info: { title: "GitHub v3 REST API", version: "1.1.4" },
  servers: [{ url: "https://api.github.com" }],
  paths: {
    "/repos/{owner}/{repo}/pulls": {
      get: {
        operationId: "pulls/list",
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "state", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

interface FetchScenario {
  /** installation ids the authenticating user owns (drives the ownership check). */
  ownedInstallationIds?: string[];
  /** HTTP status the installation-token mint endpoint returns (201 = success). */
  mintStatus?: number;
}

/** Build a fetch stub routing the four GitHub round-trips a full install makes. */
function buildFetch(scenario: FetchScenario): {
  fetchImpl: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const owned = scenario.ownedInstallationIds ?? [INSTALLATION_ID];
  const fetchImpl = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "user-oauth-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/user/installations")) {
      return new Response(
        JSON.stringify({
          installations: owned.map((id) => ({
            id: Number(id),
            account: { login: "acme-org", type: "Organization" },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/access_tokens")) {
      const status = scenario.mintStatus ?? 201;
      if (status >= 200 && status < 300) {
        return new Response(
          JSON.stringify({
            token: "ghs_health_check",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unauthorized", { status });
    }
    if (url === SPEC_URL) {
      return new Response(JSON.stringify(GITHUB_FIXTURE_SPEC), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

let queryCalls: Array<{ sql: string; params: unknown[] }>;

beforeEach(() => {
  queryCalls = [];
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-oauth-datasource-handler-unit-tests-32b";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
  __resetInstallationTokenCacheForTests();

  mock.module("@atlas/api/lib/db/internal", () => ({
    internalQuery: async (sql: string, params: unknown[]) => {
      queryCalls.push({ sql, params });
      return [{ id: params[0] ?? "generated-id" }];
    },
    hasInternalDB: () => true,
    getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  }));
});

afterEach(() => {
  __resetInstallationTokenCacheForTests();
});

/** Pull the persisted (encrypted) config JSON off the captured INSERT. */
function persistedConfig(): Record<string, unknown> {
  const insert = queryCalls.find((c) => c.sql.includes("INSERT INTO workspace_plugins"));
  expect(insert).toBeDefined();
  const jsonParam = insert!.params.find(
    (p): p is string => typeof p === "string" && p.trimStart().startsWith("{"),
  );
  expect(jsonParam).toBeDefined();
  return JSON.parse(jsonParam!) as Record<string, unknown>;
}

describe("OAuthDatasourceInstallHandler.startInstall", () => {
  it("redirects to the GitHub App install URL with a state token bound to the slug", async () => {
    const { fetchImpl } = buildFetch({});
    const handler = new OAuthDatasourceInstallHandler(CONFIG, { fetchImpl });
    const { redirectUrl, stateToken } = await handler.startInstall(WSID);
    expect(redirectUrl).toContain("github.com/apps/atlas-test-app/installations/new");
    expect(redirectUrl).toContain(`state=${encodeURIComponent(stateToken)}`);
    expect(stateToken.length).toBeGreaterThan(0);
  });
});

describe("OAuthDatasourceInstallHandler.handleCallback — state gate", () => {
  it("returns null for a forged / unverifiable state token", async () => {
    const { fetchImpl, calls } = buildFetch({});
    const handler = new OAuthDatasourceInstallHandler(CONFIG, { fetchImpl });
    const result = await handler.handleCallback("code", "not-a-real-token", {
      installationId: INSTALLATION_ID,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0); // never reached GitHub
    expect(queryCalls).toHaveLength(0); // never persisted
  });

  it("returns null when the state token is bound to a different catalog", async () => {
    const { fetchImpl } = buildFetch({});
    const handler = new OAuthDatasourceInstallHandler(CONFIG, { fetchImpl });
    const wrongState = mintOAuthStateToken(WSID, "some-other-catalog");
    const result = await handler.handleCallback("code", wrongState, {
      installationId: INSTALLATION_ID,
    });
    expect(result).toBeNull();
  });
});

describe("OAuthDatasourceInstallHandler.handleCallback — successful install", () => {
  it("verifies ownership, probes the spec, mints a token, and persists a datasource row", async () => {
    const { fetchImpl, calls } = buildFetch({ ownedInstallationIds: [INSTALLATION_ID] });
    const handler = new OAuthDatasourceInstallHandler(CONFIG, {
      fetchImpl,
      idGenerator: () => "fixed-install-id",
      now: () => "2026-05-30T00:00:00.000Z",
    });
    const state = mintOAuthStateToken(WSID, SLUG);

    const result = await handler.handleCallback("user-code", state, {
      installationId: INSTALLATION_ID,
    });

    expect(result).not.toBeNull();
    expect(result!.credentialResult.written).toBe(true);
    expect(result!.catalogId).toBe(SLUG);
    expect(result!.installRecord.id).toBe("fixed-install-id");

    // The four round-trips fired: token exchange, ownership lookup, spec probe, mint.
    expect(calls.some((u) => u.includes("/login/oauth/access_token"))).toBe(true);
    expect(calls.some((u) => u.includes("/user/installations"))).toBe(true);
    expect(calls.some((u) => u === SPEC_URL)).toBe(true);
    expect(calls.some((u) => u.includes("/access_tokens"))).toBe(true);

    // Persistence: pillar='datasource', multi-instance, fresh install_id.
    const insert = queryCalls.find((c) => c.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert!.sql).toContain("'datasource'");
    expect(insert!.sql).toMatch(/install_id/);

    const config = persistedConfig();
    // installation_id encrypted at rest, round-trips back to the plaintext id.
    expect(typeof config.installation_id).toBe("string");
    expect(config.installation_id as string).toContain("enc:");
    expect(decryptSecret(config.installation_id as string)).toBe(INSTALLATION_ID);
    // snapshot cached + credential health recorded.
    expect(config.openapi_snapshot).toBeDefined();
    expect(config.status).toBe("ok");
    expect(config.openapi_url).toBe(SPEC_URL);
    // First-ever discovery seeds a baseline diff (#2976) keyed off the snapshot's
    // probedAt — re-discovery later overwrites it with a computed drift.
    expect(config.openapi_last_diff).toMatchObject({
      previousProbedAt: null,
      currentProbedAt: (config.openapi_snapshot as { probedAt: string }).probedAt,
      diff: null,
    });
    // the raw installation id never lands in plaintext anywhere in the row.
    expect(JSON.stringify(config)).not.toContain(`"${INSTALLATION_ID}"`);
  });
});

describe("OAuthDatasourceInstallHandler.handleCallback — partial failure", () => {
  it("flips to reconnect-needed when the health-check mint fails, but still persists the row", async () => {
    const { fetchImpl } = buildFetch({ ownedInstallationIds: [INSTALLATION_ID], mintStatus: 401 });
    const handler = new OAuthDatasourceInstallHandler(CONFIG, {
      fetchImpl,
      idGenerator: () => "fixed-install-id",
      now: () => "2026-05-30T00:00:00.000Z",
    });
    const state = mintOAuthStateToken(WSID, SLUG);

    const result = await handler.handleCallback("user-code", state, {
      installationId: INSTALLATION_ID,
    });

    expect(result).not.toBeNull();
    expect(result!.credentialResult.written).toBe(false);
    expect(result!.credentialResult.reason).toBeTruthy();

    // The row IS persisted (snapshot + installation_id) but marked reconnect-needed.
    const config = persistedConfig();
    expect(config.status).toBe("reconnect_needed");
    expect(decryptSecret(config.installation_id as string)).toBe(INSTALLATION_ID);
  });
});

describe("OAuthDatasourceInstallHandler.handleCallback — cross-org isolation", () => {
  it("rejects an installation the authenticating user does not own (cross-tenant binding guard)", async () => {
    // The user owns a DIFFERENT installation than the one supplied on the callback.
    const { fetchImpl } = buildFetch({ ownedInstallationIds: ["99999999"] });
    const handler = new OAuthDatasourceInstallHandler(CONFIG, { fetchImpl });
    const state = mintOAuthStateToken(WSID, SLUG);

    await expect(
      handler.handleCallback("user-code", state, { installationId: INSTALLATION_ID }),
    ).rejects.toMatchObject({ upstreamError: "installation_not_owned" });

    // Nothing persisted for the cross-tenant attempt.
    expect(queryCalls.find((c) => c.sql.includes("INSERT INTO workspace_plugins"))).toBeUndefined();
  });

  it("binds the install to the workspace from the verified state token, not a caller-supplied one", async () => {
    const { fetchImpl } = buildFetch({ ownedInstallationIds: [INSTALLATION_ID] });
    const handler = new OAuthDatasourceInstallHandler(CONFIG, {
      fetchImpl,
      idGenerator: () => "fixed-install-id",
      now: () => "2026-05-30T00:00:00.000Z",
    });
    // State minted for OTHER_WSID — the persisted row must scope to OTHER_WSID.
    const state = mintOAuthStateToken(OTHER_WSID, SLUG);
    const result = await handler.handleCallback("user-code", state, {
      installationId: INSTALLATION_ID,
    });
    expect(result!.workspaceId).toBe(OTHER_WSID);
    const insert = queryCalls.find((c) => c.sql.includes("INSERT INTO workspace_plugins"));
    expect(insert!.params).toContain(OTHER_WSID);
  });
});
