/**
 * Tests for {@link GchatStaticBotInstallHandler} — slice 16 of 1.5.3
 * (issue #2754). Google Chat is the fourth concrete implementation of
 * the `StaticBotInstallHandler` interface keystoned by Telegram (#2748).
 *
 * The shared contract pinned by `telegram-static-bot-handler.test.ts`
 * carries over (validate identifier → reachability round-trip → UPSERT
 * → tagged errors → no half-installed rows). The Google Chat-specific
 * divergences this suite exercises:
 *
 *   - Routing identifier is a Google Workspace **customer id** (e.g.
 *     `C01abc234`) rather than a Telegram chat id. Pasted domains
 *     (`acme.com`) and empty strings are rejected before any upstream
 *     call.
 *   - Reachability is verified via a Pub/Sub publish round-trip — the
 *     handler publishes one synthetic message to the operator-shared
 *     topic and requires a non-empty `messageIds` array in the
 *     response. The OAuth2 token mint is short-circuited with the
 *     `accessTokenForTests` injection so the suite doesn't need a real
 *     RSA private key.
 *   - Optional `workspace_domain` rides through `extras` analogous to
 *     Telegram's `display_name` and Discord's `guild_name`.
 *
 * `mock.module()` stubs the two module dependencies the handler reaches
 * into: `lib/db/internal` (`internalQuery`) and the global `fetch` used
 * for the Pub/Sub publish call.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([{ id: "install-gchat-row-1" }]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const wsid = "org-test" as WorkspaceId;

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

const VALID_TOPIC = "projects/atlas-test/topics/gchat-events";
const VALID_WORKSPACE_ID = "C01abc234";

/**
 * Stand-in service account that satisfies {@link parseServiceAccountJson}
 * shape requirements (the `accessTokenForTests` injection short-circuits
 * the actual JWT signing path, so the PEM doesn't need to be valid).
 */
const FAKE_SERVICE_ACCOUNT = {
  client_email: "atlas-sa@atlas-test.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfake-test-key-not-used-for-signing\n-----END PRIVATE KEY-----\n",
  project_id: "atlas-test",
};

function setFetchOk(payload: Record<string, unknown> = { messageIds: ["msg-001"] }): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function setFetchPubsubError(
  message: string,
  status: string,
  httpStatus = 403,
): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({ error: { code: httpStatus, message, status } }),
      {
        status: httpStatus,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
}

function setFetchNetworkError(): void {
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network failure");
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([{ id: "install-gchat-row-1" }]));
  fetchCalls.length = 0;
  setFetchOk();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Handler import (after mocks)
// ---------------------------------------------------------------------------

import {
  GchatStaticBotInstallHandler,
  GCHAT_CATALOG_ID,
  GCHAT_SLUG,
  parseServiceAccountJson,
  assertValidPubsubTopic,
} from "../gchat-static-bot-handler";

function buildHandler(overrides: {
  serviceAccount?: typeof FAKE_SERVICE_ACCOUNT;
  pubsubTopic?: string;
  idGenerator?: () => string;
  accessTokenForTests?: () => Promise<string>;
} = {}): GchatStaticBotInstallHandler {
  return new GchatStaticBotInstallHandler({
    serviceAccount: overrides.serviceAccount ?? FAKE_SERVICE_ACCOUNT,
    pubsubTopic: overrides.pubsubTopic ?? VALID_TOPIC,
    ...(overrides.idGenerator ? { idGenerator: overrides.idGenerator } : {}),
    accessTokenForTests:
      overrides.accessTokenForTests ?? (async () => "ya29.fake-access-token-for-test"),
  });
}

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    expect(buildHandler().kind).toBe("static-bot");
  });

  it("refuses to construct when the service account is missing required fields — actionable env name in the error", () => {
    expect(
      () =>
        new GchatStaticBotInstallHandler({
          serviceAccount: { client_email: "", private_key: "anything" } as never,
          pubsubTopic: VALID_TOPIC,
        }),
    ).toThrow(/GCHAT_SERVICE_ACCOUNT_JSON/);
  });

  it("refuses to construct when the pubsub topic is empty — actionable env name in the error", () => {
    expect(
      () =>
        new GchatStaticBotInstallHandler({
          serviceAccount: FAKE_SERVICE_ACCOUNT,
          pubsubTopic: "",
        }),
    ).toThrow(/GCHAT_PUBSUB_TOPIC/);
  });

  it("refuses to construct when the pubsub topic isn't a fully-qualified path", () => {
    expect(
      () =>
        new GchatStaticBotInstallHandler({
          serviceAccount: FAKE_SERVICE_ACCOUNT,
          pubsubTopic: "gchat-events",
        }),
    ).toThrow(/fully-qualified topic path/);
  });

  it("exports GCHAT_SLUG and GCHAT_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(GCHAT_SLUG).toBe("gchat");
    expect(GCHAT_CATALOG_ID).toBe("catalog:gchat");
  });
});

// ---------------------------------------------------------------------------
// parseServiceAccountJson + assertValidPubsubTopic helpers
// ---------------------------------------------------------------------------

describe("parseServiceAccountJson", () => {
  it("parses a well-formed service account JSON", () => {
    const result = parseServiceAccountJson(JSON.stringify(FAKE_SERVICE_ACCOUNT));
    expect(result.client_email).toBe(FAKE_SERVICE_ACCOUNT.client_email);
    expect(result.private_key).toBe(FAKE_SERVICE_ACCOUNT.private_key);
    expect(result.project_id).toBe(FAKE_SERVICE_ACCOUNT.project_id);
  });

  it("throws a clear error when the JSON is unparseable", () => {
    expect(() => parseServiceAccountJson("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when client_email is missing", () => {
    const raw = JSON.stringify({ ...FAKE_SERVICE_ACCOUNT, client_email: undefined });
    expect(() => parseServiceAccountJson(raw)).toThrow(/client_email/);
  });

  it("throws when private_key is missing the PEM header", () => {
    const raw = JSON.stringify({ ...FAKE_SERVICE_ACCOUNT, private_key: "garbage" });
    expect(() => parseServiceAccountJson(raw)).toThrow(/private_key/);
  });
});

describe("assertValidPubsubTopic", () => {
  it("accepts a fully-qualified topic path", () => {
    expect(() => assertValidPubsubTopic("projects/p/topics/t")).not.toThrow();
  });

  it("rejects bare topic names", () => {
    expect(() => assertValidPubsubTopic("just-the-topic")).toThrow(/fully-qualified/);
  });
});

// ---------------------------------------------------------------------------
// workspace_id validation
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — workspace_id validation", () => {
  it("rejects empty workspace_id", async () => {
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/workspace_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects a pasted primary domain (common admin mistake)", async () => {
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, "acme.com")).rejects.toThrow(/workspace_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects values containing spaces or invalid chars", async () => {
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, "C01 abc")).rejects.toThrow(/workspace_id/);
  });

  it("accepts the literal 'my_customer' self-install marker", async () => {
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, "my_customer");
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
  });

  it("accepts a well-formed alphanumeric customer id", async () => {
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (Pub/Sub publish round-trip)
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls the Pub/Sub publish endpoint with a Bearer access token and a base64 message", async () => {
    const handler = buildHandler();
    await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      `https://pubsub.googleapis.com/v1/${VALID_TOPIC}:publish`,
    );
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization || headers.authorization).toMatch(
      /^Bearer ya29\.fake-access-token-for-test$/,
    );
    const body = JSON.parse(String(fetchCalls[0].init?.body ?? "{}")) as {
      messages: Array<{ data: string; attributes?: Record<string, string> }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].attributes?.["atlas-install-verify"]).toBe("true");
    // The data field is base64-encoded JSON — decode and check the kind.
    const decoded = Buffer.from(body.messages[0].data, "base64").toString("utf8");
    const payload = JSON.parse(decoded) as { kind: string };
    expect(payload.kind).toBe("atlas.install.verify");
  });

  it("throws a clear error when Pub/Sub returns PERMISSION_DENIED (operator missing pubsub.publisher)", async () => {
    setFetchPubsubError(
      "User not authorized to perform this action.",
      "PERMISSION_DENIED",
      403,
    );
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/User not authorized/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws a clear error when the topic doesn't exist (NOT_FOUND)", async () => {
    setFetchPubsubError("Topic not found", "NOT_FOUND", 404);
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/Topic not found/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws when the Pub/Sub API fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/Pub\/Sub API unreachable/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws an unavailable error when Pub/Sub returns 2xx without messageIds (contract violation)", async () => {
    setFetchOk({ /* no messageIds */ });
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/no messageIds/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("propagates token-mint failures from accessTokenForTests as an unavailable error", async () => {
    const handler = buildHandler({
      accessTokenForTests: async () => {
        throw new Error("token endpoint hiccup");
      },
    });
    // The handler awaits accessTokenForTests inside verifyReachability;
    // a thrown error there bubbles to the caller. The thrown shape is
    // an Error, not a tagged error, because the test injection
    // short-circuits the production token-mint path that wraps in a
    // GchatApiUnavailableError.
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/token endpoint hiccup/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — persistence", () => {
  it("UPSERTs workspace_plugins with the catalog id + workspace_id config payload", async () => {
    const handler = buildHandler();
    await handler.confirmInstall(wsid, VALID_WORKSPACE_ID, undefined, {
      workspace_domain: "acme.com",
    });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    const sqlText = String(sql);
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — the INSERT must name
    // pillar + install_id explicitly, and chat-pillar installs target
    // the partial singleton index via the WHERE clause on the conflict
    // target so re-install is idempotent.
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);

    const paramsArr = params as unknown[];
    expect(paramsArr).toContain(wsid);
    expect(paramsArr).toContain(GCHAT_CATALOG_ID);
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("workspace_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.workspace_id).toBe(VALID_WORKSPACE_ID);
    expect(parsed.workspace_domain).toBe("acme.com");
  });

  it("omits workspace_domain from config when extras don't supply one", async () => {
    const handler = buildHandler();
    await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("workspace_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.workspace_id).toBe(VALID_WORKSPACE_ID);
    expect("workspace_domain" in parsed).toBe(false);
  });

  it("drops a malformed extras.workspace_domain silently (logged at warn — not asserted here)", async () => {
    const handler = buildHandler();
    await handler.confirmInstall(wsid, VALID_WORKSPACE_ID, undefined, {
      workspace_domain: 42 as unknown as string,
    });
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("workspace_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect("workspace_domain" in parsed).toBe(false);
  });

  it("returns the persisted install id from RETURNING (re-install idempotency)", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ id: "existing-install-row" }]),
    );
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
  });

  it("throws when RETURNING comes back empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = buildHandler({ idGenerator: () => "candidate-id-xyz" });
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/RETURNING must always populate/);
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for Google Chat today
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified via the Pub/Sub round-trip", async () => {
    const handler = buildHandler();
    const result = await handler.confirmInstall(
      wsid,
      VALID_WORKSPACE_ID,
      "ignored-proof",
    );
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
    expect(fetchCalls).toHaveLength(1);
  });
});
