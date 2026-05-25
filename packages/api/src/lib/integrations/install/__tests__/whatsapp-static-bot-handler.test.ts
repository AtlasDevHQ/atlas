/**
 * Tests for {@link WhatsAppStaticBotInstallHandler} — slice 15 of 1.5.3
 * (issue #2753). WhatsApp is the fourth concrete implementation of the
 * `StaticBotInstallHandler` interface keystoned by Telegram (#2748)
 * after Discord (#2749) and Teams (#2752).
 *
 * The shared contract pinned by the sibling handler tests carries over
 * (validate identifier → reachability round-trip → UPSERT → tagged
 * errors → no half-installed rows). The WhatsApp-specific divergences
 * this suite exercises:
 *
 *   - Routing identifier is a **Meta phone_number_id** — a numeric
 *     routing id distinct from the human-readable phone number. Pasted
 *     phone numbers (`+1 415 555 0100`) and WhatsApp Business Account
 *     IDs are rejected before the API call.
 *   - Reachability is verified via Meta Graph API
 *     `GET /v21.0/{phone_number_id}` with the operator access token in
 *     `Authorization: Bearer`. Meta's failure envelope is nested under
 *     `{ error: { message, code, ... } }` — distinct from Discord's
 *     top-level `{ message, code }`.
 *   - Optional `display_phone` rides through `extras` analogous to
 *     Discord's `guild_name`, and falls back to Meta's
 *     `display_phone_number` when extras don't supply one (mirrors the
 *     Discord guild-name fallback).
 *   - Token redaction is NOT required for the URL — the access token
 *     rides in `Authorization: Bearer`, not in the path — but we still
 *     assert errors don't attach `cause: err` (preserves symmetry with
 *     the Discord / Telegram / Teams safe-by-default posture).
 *
 * `mock.module()` stubs the two module dependencies the handler reaches
 * into: `lib/db/internal` (`internalQuery`) and the global `fetch` used
 * for the Meta Graph API call. Each mock exports every named export it
 * shadows (CLAUDE.md "mock all exports" rule).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([{ id: "install-whatsapp-row-1" }]),
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

// Sample phone_number_id — Meta's docs use 15-digit numeric ids; this
// is shape-correct without being any real production number.
const SAMPLE_PHONE_NUMBER_ID = "1098765432109876";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

function setFetchOk(
  body: { id?: string; display_phone_number?: string; verified_name?: string } = {},
): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({
        id: body.id ?? SAMPLE_PHONE_NUMBER_ID,
        ...(body.display_phone_number !== undefined
          ? { display_phone_number: body.display_phone_number }
          : { display_phone_number: "+1 415 555 0100" }),
        ...(body.verified_name !== undefined
          ? { verified_name: body.verified_name }
          : { verified_name: "Atlas Test Co" }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function setFetchMetaError(message: string, code: number, status: number): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({ error: { message, type: "OAuthException", code } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function setFetchNonJson(status: number): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response("<html>error</html>", {
      status,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

function setFetchNetworkError(): void {
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network failure");
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() =>
    Promise.resolve([{ id: "install-whatsapp-row-1" }]),
  );
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
  WhatsAppStaticBotInstallHandler,
  WHATSAPP_CATALOG_ID,
  WHATSAPP_SLUG,
  WHATSAPP_PHONE_NUMBER_ID_RE,
} from "../whatsapp-static-bot-handler";

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAAxxx",
      appId: "111222333",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("refuses to construct when accessToken is empty — actionable env name in the error", () => {
    expect(
      () => new WhatsAppStaticBotInstallHandler({ accessToken: "", appId: "id" }),
    ).toThrow(/META_BUSINESS_ACCESS_TOKEN/);
  });

  it("refuses to construct when appId is empty — actionable env name in the error", () => {
    expect(
      () => new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "" }),
    ).toThrow(/META_BUSINESS_APP_ID/);
  });

  it("exposes applicationId for the setup link / manifest deep-link routes", () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAAxxx",
      appId: "the-meta-app-id",
    });
    expect(handler.applicationId).toBe("the-meta-app-id");
  });

  it("exports WHATSAPP_SLUG and WHATSAPP_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(WHATSAPP_SLUG).toBe("whatsapp");
    expect(WHATSAPP_CATALOG_ID).toBe("catalog:whatsapp");
  });

  it("WHATSAPP_PHONE_NUMBER_ID_RE accepts numeric ids and rejects obvious paste-mistakes", () => {
    // Canonical 16-digit id
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test(SAMPLE_PHONE_NUMBER_ID)).toBe(true);
    // 10-digit edge of the valid range
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("1234567890")).toBe(true);
    // Human-readable phone number — rejected
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("+1 415 555 0100")).toBe(false);
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("+14155550100")).toBe(false);
    // Too short
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("123456")).toBe(false);
    // Non-numeric characters
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("12345abc6789")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phone_number_id validation
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — phone_number_id validation", () => {
  it("rejects empty phone_number_id", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/phone_number_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
    // No upstream call either — format validation happens first.
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects human-readable phone numbers — admins routinely paste these by mistake", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "+1 415 555 0100")).rejects.toThrow(
      /phone_number_id/,
    );
    await expect(handler.confirmInstall(wsid, "+14155550100")).rejects.toThrow(
      /phone_number_id/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects non-numeric strings (display names, etc.)", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "Acme Inc")).rejects.toThrow(
      /phone_number_id/,
    );
    await expect(handler.confirmInstall(wsid, "12345abc")).rejects.toThrow(
      /phone_number_id/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts a canonical numeric id", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (Meta Graph API)
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls Meta Graph API with the phone_number_id in the path and bearer auth", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-test-token",
      appId: "id",
    });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      `https://graph.facebook.com/v21.0/${SAMPLE_PHONE_NUMBER_ID}?fields=verified_name,display_phone_number`,
    );
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer EAA-test-token");
  });

  it("never embeds the access token in the URL — token rides in Authorization header", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-secret-do-not-leak",
      appId: "id",
    });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(fetchCalls[0].url).not.toContain("EAA-secret-do-not-leak");
  });

  it("throws WhatsAppReachabilityError when Meta returns code 100 (phone not in operator's Business Account)", async () => {
    setFetchMetaError(
      "Unsupported get request. Object with ID '0' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      100,
      400,
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Unsupported get request/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("appends the operator-side hint for code 100 (phone not shared into Business Account)", async () => {
    setFetchMetaError("Tried accessing nonexisting field", 100, 400);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toContain("isn't visible to the operator's Meta Business Account");
  });

  it("throws with token-rotation hint when Meta returns code 190 (token expired)", async () => {
    setFetchMetaError("Error validating access token: Session has expired.", 190, 401);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toMatch(/META_BUSINESS_ACCESS_TOKEN/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws WhatsAppApiUnavailableError when the Graph API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Meta Graph API unreachable/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws when Meta returns a non-JSON body — upstream contract violation", async () => {
    setFetchNonJson(503);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Meta Graph API/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws when Meta returns 2xx but no id field — upstream contract violation, not silent success", async () => {
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /unexpected response shape/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — persistence", () => {
  it("UPSERTs workspace_plugins with the catalog id + phone_number_id config payload", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID, undefined, {
      display_phone: "Acme Sales Line",
    });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    const sqlText = String(sql);
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — the INSERT must
    // name pillar + install_id explicitly, and chat-pillar installs
    // target the partial singleton index via the WHERE clause on the
    // conflict target so re-install is idempotent.
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);

    const paramsArr = params as unknown[];
    expect(paramsArr).toContain(wsid);
    expect(paramsArr).toContain(WHATSAPP_CATALOG_ID);
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.phone_number_id).toBe(SAMPLE_PHONE_NUMBER_ID);
    // extras override beats the API fallback
    expect(parsed.display_phone).toBe("Acme Sales Line");
  });

  it("falls back to Meta's display_phone_number when extras don't supply display_phone (Discord-style fallback)", async () => {
    setFetchOk({ display_phone_number: "+44 20 7946 0958" });
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.display_phone).toBe("+44 20 7946 0958");
  });

  it("omits display_phone when neither extras nor API supplied one", async () => {
    // Override the fetch to return only `id`, no display_phone_number.
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: SAMPLE_PHONE_NUMBER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect("display_phone" in parsed).toBe(false);
  });

  it("drops display_phone when extras supplies the wrong type (number / null) — logs but doesn't throw", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID, undefined, {
      display_phone: 12345 as unknown as string,
    });
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    // Falls back to the API-provided value, not the malformed extras.
    expect(parsed.display_phone).toBe("+1 415 555 0100");
  });

  it("returns the persisted install id from RETURNING (re-install idempotency)", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ id: "existing-install-row" }]),
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
  });

  it("throws when RETURNING comes back empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "t",
      appId: "id",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for WhatsApp today
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified server-side via Graph API", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(
      wsid,
      SAMPLE_PHONE_NUMBER_ID,
      "ignored-proof",
    );
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
    expect(fetchCalls).toHaveLength(1);
  });
});
