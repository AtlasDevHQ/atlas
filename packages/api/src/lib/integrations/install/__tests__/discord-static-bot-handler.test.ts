/**
 * Tests for {@link DiscordStaticBotInstallHandler} — slice 11 of 1.5.3
 * (issue #2749). Discord is the second concrete implementation of the
 * `StaticBotInstallHandler` interface keystoned by Telegram (#2748).
 *
 * The shared contract pinned by `telegram-static-bot-handler.test.ts`
 * carries over (validate identifier → reachability round-trip → UPSERT
 * → tagged errors → no half-installed rows). The Discord-specific
 * divergences this suite exercises:
 *
 *   - Routing identifier is a Discord **guild snowflake** (17–20 digit
 *     unsigned integer) rather than a Telegram chat_id. Pasted `@server`
 *     handles or guild invite codes are rejected before the API call.
 *   - Reachability is verified via `GET /api/v10/guilds/{guild_id}` with
 *     the operator bot token. Discord's failure envelope is
 *     `{ message, code }` (not Telegram's `description`/`error_code`),
 *     and the surface message preserves Discord's `message` verbatim.
 *   - Optional `guild_name` rides through `extras` analogous to
 *     Telegram's `display_name` — admin-facing label only, dropped
 *     silently when malformed.
 *
 * `mock.module()` stubs the two module dependencies the handler reaches
 * into: `lib/db/internal` (`internalQuery`) and the global `fetch` used
 * for the Discord API call. Each mock exports every named export it
 * shadows (CLAUDE.md "mock all exports" rule).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([{ id: "install-discord-row-1" }]),
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

function setFetchOk(payload: Record<string, unknown> = { id: "1234567890123456789", name: "Test Guild" }): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function setFetchDiscordError(message: string, code: number, status = 404): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ message, code }), {
      status,
      headers: { "content-type": "application/json" },
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
  mockInternalQuery.mockImplementation(() => Promise.resolve([{ id: "install-discord-row-1" }]));
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
  DiscordStaticBotInstallHandler,
  DISCORD_CATALOG_ID,
  DISCORD_SLUG,
} from "../discord-static-bot-handler";

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("DiscordStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    expect(handler.kind).toBe("static-bot");
  });

  it("refuses to construct when botToken is empty — actionable env name in the error", () => {
    expect(
      () => new DiscordStaticBotInstallHandler({ botToken: "", clientId: "111" }),
    ).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("refuses to construct when clientId is empty — actionable env name in the error", () => {
    expect(
      () => new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "" }),
    ).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("exports DISCORD_SLUG and DISCORD_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(DISCORD_SLUG).toBe("discord");
    expect(DISCORD_CATALOG_ID).toBe("catalog:discord");
  });
});

// ---------------------------------------------------------------------------
// guild_id validation
// ---------------------------------------------------------------------------

describe("DiscordStaticBotInstallHandler.confirmInstall — guild_id validation", () => {
  it("rejects empty guild_id", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/guild_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects guild_id with non-numeric characters (e.g. invite codes or @handles)", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    // Discord guild ids are unsigned 64-bit snowflakes — `@my-server`,
    // invite codes (`https://discord.gg/abc123`), and short usernames
    // are common admin mistakes; reject before the API call.
    await expect(handler.confirmInstall(wsid, "@my-server")).rejects.toThrow(/guild_id/);
    await expect(handler.confirmInstall(wsid, "discord.gg/abc")).rejects.toThrow(/guild_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects guild_id that's too short to be a snowflake (Discord ids are 17–20 digits)", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(/guild_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts a well-formed 18-digit Discord snowflake", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    const result = await handler.confirmInstall(wsid, "123456789012345678");
    expect(result.installRecord.catalogId).toBe(DISCORD_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (GET /guilds/{guild_id})
// ---------------------------------------------------------------------------

describe("DiscordStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls Discord API GET /guilds/{guild_id} with the operator bot token in the Authorization header", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn-secret", clientId: "111" });
    await handler.confirmInstall(wsid, "123456789012345678");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("discord.com/api/v10/guilds/123456789012345678");
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    // Bot token is sent as `Authorization: Bot <token>` per Discord's
    // bot-auth convention — distinct from Bearer (user OAuth) tokens.
    expect(headers.Authorization || headers.authorization).toMatch(/^Bot tkn-secret$/);
  });

  it("throws with a clear error when Discord returns Unknown Guild (404)", async () => {
    setFetchDiscordError("Unknown Guild", 10004, 404);
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "999999999999999999")).rejects.toThrow(
      /Unknown Guild/i,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws with a clear error when the bot is not in the guild (403)", async () => {
    setFetchDiscordError("Missing Access", 50001, 403);
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(
      /missing access/i,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws when the Discord API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(/discord/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("treats Discord's generic 'code: 0' error as a real failure (HTTP status is the discriminator)", async () => {
    // Discord's code 0 is the "generic" error — using absence-of-code
    // as the discriminator would silently narrow into the success branch
    // and double-process. The HTTP-status-keyed parser keeps the right
    // posture: 4xx → err regardless of code value.
    setFetchDiscordError("Generic error from upstream", 0, 400);
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(
      /Generic error from upstream/i,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws unavailable when the API returns 2xx without a guild id (contract violation)", async () => {
    setFetchOk({ /* no id field */ name: "Orphan" });
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(
      /unexpected response shape/i,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("DiscordStaticBotInstallHandler.confirmInstall — persistence", () => {
  it("UPSERTs workspace_plugins with the catalog id + guild_id config payload", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await handler.confirmInstall(wsid, "123456789012345678", undefined, {
      guild_name: "Acme Engineering",
    });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    const sqlText = String(sql);
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 (codex P0 regression
    // catcher) — the INSERT must name pillar + install_id explicitly,
    // and chat-pillar installs target the partial singleton index via
    // the WHERE clause on the conflict target so re-install is
    // idempotent.
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);

    const paramsArr = params as unknown[];
    expect(paramsArr).toContain(wsid);
    expect(paramsArr).toContain(DISCORD_CATALOG_ID);
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("guild_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.guild_id).toBe("123456789012345678");
    expect(parsed.guild_name).toBe("Acme Engineering");
  });

  it("omits guild_name from config when neither extras nor the API response supply a name", async () => {
    // Discord's GET /guilds/{id} returns the guild object — `name` is
    // documented as required, but when the upstream omits it we should
    // not synthesize a value.
    setFetchOk({ id: "123456789012345678" });
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await handler.confirmInstall(wsid, "123456789012345678");
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("guild_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.guild_id).toBe("123456789012345678");
    expect("guild_name" in parsed).toBe(false);
  });

  it("falls back to the guild name from the Discord API response when extras don't supply one", async () => {
    setFetchOk({ id: "123456789012345678", name: "From API" });
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await handler.confirmInstall(wsid, "123456789012345678");
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("guild_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.guild_name).toBe("From API");
  });

  it("returns the persisted install id from RETURNING (re-install idempotency)", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ id: "existing-install-row" }]),
    );
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    const result = await handler.confirmInstall(wsid, "123456789012345678");
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(DISCORD_SLUG);
  });

  it("throws when RETURNING comes back empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new DiscordStaticBotInstallHandler({
      botToken: "tkn",
      clientId: "111",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    await expect(handler.confirmInstall(wsid, "123456789012345678")).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for Discord today
// ---------------------------------------------------------------------------

describe("DiscordStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified server-side via GET /guilds", async () => {
    const handler = new DiscordStaticBotInstallHandler({ botToken: "tkn", clientId: "111" });
    const result = await handler.confirmInstall(wsid, "123456789012345678", "ignored-proof");
    expect(result.installRecord.catalogId).toBe(DISCORD_SLUG);
    expect(fetchCalls).toHaveLength(1);
  });
});
