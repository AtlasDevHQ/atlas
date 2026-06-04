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
 * `mock.module()` stubs the module dependencies the handler reaches into:
 * `lib/billing/enforcement` (`checkChatIntegrationLimitAndInstall` — the
 * atomic cap-gate that owns the `workspace_plugins` UPSERT post-#3001, which
 * gchat adopted in #3143) and the global `fetch` used for the Pub/Sub publish
 * call. Each mock exports every named export it shadows.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

// The handler's cross-workspace ownership guard (#3154) reads
// `workspace_plugins` via `internalQuery` before the cap gate. Default returns
// [] (no conflict); the guard test overrides it to a matching row.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);
mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// The chat-integration cap + the workspace_plugins UPSERT run atomically
// through `checkChatIntegrationLimitAndInstall` (#3001) — the gate owns the
// write and returns the RETURNING rows. We stub it to "allowed" with a scripted
// row id so these handler tests stay focused on the install contract
// (workspace_id validation, Pub/Sub reachability, config payload) and assert
// the UPSERT shape via the gate's `insert` arg. The cap-enforcement decision +
// transaction sequencing live in `billing/__tests__/enforcement.test.ts`.
type GateResult =
  | { allowed: true; rows: Array<Record<string, unknown>> }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };
const mockCheckChatLimitAndInstall: Mock<
  (
    orgId: string | undefined,
    catalogId: string,
    insert: { sql: string; params: readonly unknown[] },
  ) => Promise<GateResult>
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: "install-gchat-row-1" }] }));

// Mock every value export — a partial `mock.module()` causes a `SyntaxError`
// in other files importing the missing exports (per CLAUDE.md "Mock all
// exports"). Only `checkChatIntegrationLimitAndInstall` is exercised here.
mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkChatIntegrationLimitAndInstall: mockCheckChatLimitAndInstall,
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
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
  mockCheckChatLimitAndInstall.mockClear();
  mockCheckChatLimitAndInstall.mockImplementation(() =>
    Promise.resolve({ allowed: true as const, rows: [{ id: "install-gchat-row-1" }] }),
  );
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
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
  asPubsubTopicPath,
} from "../gchat-static-bot-handler";
import type { PubsubTopicPath } from "../gchat-static-bot-handler";

function buildHandler(overrides: {
  pubsubTopic?: string;
  idGenerator?: () => string;
  accessTokenProvider?: () => Promise<string>;
} = {}): GchatStaticBotInstallHandler {
  // Both fields are brand-protected — go through the validated minters
  // (`parseServiceAccountJson` / `asPubsubTopicPath`) rather than
  // unsafe casts, so tests exercise the same construction path
  // production uses.
  const sa = parseServiceAccountJson(JSON.stringify(FAKE_SERVICE_ACCOUNT));
  const topic = asPubsubTopicPath(overrides.pubsubTopic ?? VALID_TOPIC);
  return new GchatStaticBotInstallHandler({
    serviceAccount: sa,
    pubsubTopic: topic,
    ...(overrides.idGenerator ? { idGenerator: overrides.idGenerator } : {}),
    accessTokenProvider:
      overrides.accessTokenProvider ?? (async () => "ya29.fake-access-token-for-test"),
  });
}

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    expect(buildHandler().kind).toBe("static-bot");
  });

  it("exports GCHAT_SLUG and GCHAT_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(GCHAT_SLUG).toBe("gchat");
    expect(GCHAT_CATALOG_ID).toBe("catalog:gchat");
  });

  // Note: construction-time validation for the SA + topic now lives in
  // the brand minters (`parseServiceAccountJson` / `asPubsubTopicPath`),
  // tested below. The handler's constructor trusts the brands, so
  // there's no longer a duplicate runtime guard to assert here.
});

// ---------------------------------------------------------------------------
// Brand minters: parseServiceAccountJson + asPubsubTopicPath
// ---------------------------------------------------------------------------

describe("parseServiceAccountJson", () => {
  it("parses a well-formed service account JSON", () => {
    const result = parseServiceAccountJson(JSON.stringify(FAKE_SERVICE_ACCOUNT));
    expect(result.client_email).toBe(FAKE_SERVICE_ACCOUNT.client_email);
    expect(result.private_key).toBe(FAKE_SERVICE_ACCOUNT.private_key);
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

  it("never echoes PEM bytes back through the JSON.parse error message — SECURITY guard", () => {
    // A malformed JSON whose corruption falls inside the private_key
    // body. On modern V8 `JSON.parse` errors include an excerpt of the
    // input near the failure offset; without the `sanitizeParseError`
    // step the excerpt would land in the thrown message → log lines.
    const corruptedJson =
      '{"client_email":"x","private_key":"-----BEGIN PRIVATE KEY-----\\nFAKE_KEY_BYTES_aBcDeF12345\\n-----END PRIVATE KEY-----\\n"' +
      // Deliberately malformed — trailing comma + unterminated value.
      ', "project_id": "atlas-test", }';
    let threw = false;
    try {
      parseServiceAccountJson(corruptedJson);
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      // The sanitizer must redact the PEM block and cap the message
      // length — neither the literal key bytes nor a multi-line PEM
      // excerpt should survive.
      expect(msg).not.toMatch(/FAKE_KEY_BYTES_aBcDeF12345/);
      expect(msg).not.toMatch(/BEGIN PRIVATE KEY/);
      // Cap at the 200-char clamp the sanitizer applies + the wrapper
      // prose (the constructed envelope is short by design).
      expect(msg.length).toBeLessThan(400);
    }
    expect(threw).toBe(true);
  });

  it("never attaches the raw err as cause — defense against pino's `err` serializer", () => {
    try {
      parseServiceAccountJson("not-json");
    } catch (err) {
      // The thrown Error must NOT carry a cause chain — pino's default
      // `err` serializer walks `cause` and would surface the original
      // SyntaxError's input excerpt (containing PEM bytes for real
      // malformed-SA cases).
      const cause = (err as Error & { cause?: unknown }).cause;
      expect(cause).toBeUndefined();
    }
  });
});

describe("asPubsubTopicPath", () => {
  it("accepts a fully-qualified topic path and returns it as a branded PubsubTopicPath", () => {
    const t: PubsubTopicPath = asPubsubTopicPath("projects/p/topics/t");
    // The brand is structural-only — at runtime the value is a plain
    // string, so a coerced compare confirms the path round-trips.
    expect(String(t)).toBe("projects/p/topics/t");
  });

  it("rejects bare topic names", () => {
    expect(() => asPubsubTopicPath("just-the-topic")).toThrow(/fully-qualified/);
  });

  it("rejects empty topic strings", () => {
    expect(() => asPubsubTopicPath("")).toThrow(/fully-qualified/);
  });
});

// ---------------------------------------------------------------------------
// workspace_id validation
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — workspace_id validation", () => {
  it("rejects empty workspace_id", async () => {
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/workspace_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects a pasted primary domain (common admin mistake)", async () => {
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, "acme.com")).rejects.toThrow(/workspace_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
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
// Cross-workspace ownership guard (#3154 GAP 2)
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — cross-workspace guard", () => {
  it("rejects a workspace_id already bound to a different workspace, and never reaches the cap gate", async () => {
    // The Pub/Sub round-trip proves the SA can publish, not that THIS workspace
    // owns the customer id. The guard SELECT finds an existing bind in another
    // workspace and refuses before the cap gate runs.
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ workspace_id: "org-victim" }]),
    );
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, VALID_WORKSPACE_ID)).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // The guard scopes its lookup to (catalog:gchat, enabled, the workspace_id,
    // workspace_id <> self) so a reconnect by the same workspace is never caught.
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(String(sql)).toMatch(/config->>'workspace_id'/);
    expect(String(sql)).toMatch(/workspace_id\s*<>\s*\$3/);
    expect(params).toEqual([GCHAT_CATALOG_ID, VALID_WORKSPACE_ID, wsid]);
  });

  it("allows the install when the workspace_id is bound only to the installing workspace (reconnect)", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the uniqueness pre-check query errors — aborts before the cap gate", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("db down")));
    const handler = buildHandler();
    await expect(handler.confirmInstall(wsid, VALID_WORKSPACE_ID)).rejects.toThrow(/db down/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
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
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws a clear error when the topic doesn't exist (NOT_FOUND)", async () => {
    setFetchPubsubError("Topic not found", "NOT_FOUND", 404);
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/Topic not found/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws when the Pub/Sub API fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/Pub\/Sub API unreachable/i);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws an unavailable error when Pub/Sub returns 2xx without messageIds (contract violation)", async () => {
    setFetchOk({ /* no messageIds */ });
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/no messageIds/i);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("classifies Pub/Sub 5xx as ApiUnavailable (retryable), not Reachability (admin-correctable)", async () => {
    // Google's `topics.publish` can return 500/503 during backend
    // incidents — operators should see "retry" guidance, not "fix
    // your config" guidance. The 4xx → 400 reachability path stays
    // for genuinely user-correctable failures (PERMISSION_DENIED,
    // NOT_FOUND).
    setFetchPubsubError("Backend service unavailable", "UNAVAILABLE", 503);
    const handler = buildHandler();
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/transient 503/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("propagates token-mint failures from accessTokenProvider as a thrown error before any DB write", async () => {
    const handler = buildHandler({
      accessTokenProvider: async () => {
        throw new Error("token endpoint hiccup");
      },
    });
    // The handler awaits accessTokenProvider inside verifyReachability;
    // a thrown error there bubbles to the caller. The thrown shape is
    // an Error, not a tagged error, because the test injection
    // short-circuits the production token-mint path that wraps in a
    // GchatApiUnavailableError.
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/token endpoint hiccup/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — chat-integration cap", () => {
  it("throws ChatIntegrationLimitError and writes no install row when at cap", async () => {
    // The gate rolls back its UPSERT internally on a cap denial and returns
    // `cap_reached` — the row is never committed.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
      }),
    );
    const handler = buildHandler();

    await expect(handler.confirmInstall(wsid, VALID_WORKSPACE_ID)).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });

    // The gate enforced the cap (after the Pub/Sub round-trip), keyed on the
    // workspace + gchat catalog id, with the UPSERT it would have committed.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog, gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(wsid);
    expect(gateCatalog).toBe(GCHAT_CATALOG_ID);
    expect(gateInsert.sql).toMatch(/INSERT INTO workspace_plugins/);
  });

  it("throws BillingCheckFailedError (not the cap error) when the count check fails closed", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "check_failed" as const,
        errorMessage: "Unable to verify plan limits. Please try again.",
      }),
    );
    const handler = buildHandler();

    await expect(handler.confirmInstall(wsid, VALID_WORKSPACE_ID)).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("grandfathers a reconnect — the gate allows an already-installed workspace and returns the existing id", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("GchatStaticBotInstallHandler.confirmInstall — persistence", () => {
  /** Pull the gate's `insert` arg from the most recent call. */
  function lastGateInsert(): { sql: string; params: readonly unknown[] } {
    const calls = mockCheckChatLimitAndInstall.mock.calls;
    return calls[calls.length - 1][2];
  }

  it("UPSERTs workspace_plugins with the catalog id + workspace_id config payload via the cap gate", async () => {
    const handler = buildHandler();
    await handler.confirmInstall(wsid, VALID_WORKSPACE_ID, undefined, {
      workspace_domain: "acme.com",
    });

    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const insert = lastGateInsert();
    const sqlText = insert.sql;
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — the INSERT must name
    // pillar + install_id explicitly, and chat-pillar installs target
    // the partial singleton index via the WHERE clause on the conflict
    // target so re-install is idempotent.
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    // The gate runs the UPSERT under the lock, so RETURNING id must be present.
    expect(sqlText).toMatch(/RETURNING id/);

    const paramsArr = insert.params as unknown[];
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
    const configJson = (lastGateInsert().params as unknown[]).find(
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
    const configJson = (lastGateInsert().params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("workspace_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect("workspace_domain" in parsed).toBe(false);
  });

  it("returns the persisted install id from the gate's RETURNING rows (re-install idempotency)", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = buildHandler();
    const result = await handler.confirmInstall(wsid, VALID_WORKSPACE_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(GCHAT_SLUG);
  });

  it("throws when the gate's RETURNING rows are empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [] }),
    );
    const handler = buildHandler({ idGenerator: () => "candidate-id-xyz" });
    await expect(
      handler.confirmInstall(wsid, VALID_WORKSPACE_ID),
    ).rejects.toThrow(/RETURNING must always populate/);
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    // The gate throws on a genuine write-path failure (after rolling back).
    mockCheckChatLimitAndInstall.mockImplementation(() => Promise.reject(new Error("DB down")));
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
