/**
 * `DiscordStaticBotInstallHandler` — slice 11 of 1.5.3 Phase D (issue
 * #2749). Second concrete implementation of {@link StaticBotInstallHandler}
 * after the Telegram keystone (#2748).
 *
 * Discord follows the same operator-shared static-bot pattern as Telegram:
 * one operator-owned Discord application (env: `DISCORD_CLIENT_ID` +
 * `DISCORD_BOT_TOKEN`) serves every customer; each workspace's routing
 * identifier is a Discord **guild snowflake** captured from the OAuth
 * bot-install callback. Optional `guild_name` rides through `extras`
 * analogous to Telegram's `display_name`.
 *
 * Per-Workspace credential note: there isn't one. The bot's auth lives
 * with the operator; per-Workspace state is just `{ guild_id, guild_name? }`,
 * which is non-secret (`guild_id` leaks in every interaction envelope).
 * This handler writes `workspace_plugins.config` directly via
 * `internalQuery` (mirroring telegram-static-bot-handler.ts), so
 * `encryptSecretFields` is not in the write path at all.
 *
 * Reachability verification: rather than relying on the OAuth redirect
 * alone (which proves the user authorized the bot but doesn't survive
 * a subsequent kick / role change), we call Discord's
 * `GET /api/v10/guilds/{guild_id}` with the operator bot token before
 * persisting. Success means the bot is currently a member of the guild
 * and Discord can route messages there; failure surfaces the upstream
 * Discord `message` verbatim (e.g. "Unknown Guild", "Missing Access")
 * so the admin sees the actionable text.
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see ./telegram-static-bot-handler.ts — the keystone shape this mirrors
 * @see https://discord.com/developers/docs/resources/guild#get-guild
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import {
  DiscordApiUnavailableError,
  DiscordGuildIdInvalidError,
  DiscordReachabilityError,
} from "@atlas/api/lib/effect/errors";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";
import { persistSingletonInstall } from "./persist-form-install";
import { makeChatIntegrationCapGate } from "./chat-integration-cap-gate";
import { isRoutingIdUniqueViolation } from "./routing-id-conflict";

const log = createLogger("integrations.install.discord");

/** Catalog slug — the dispatch key in `registerStaticBotHandler`. */
export const DISCORD_SLUG: CatalogId = "discord";

/**
 * Stable `plugin_catalog.id` for Discord. The seeder derives row ids as
 * `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`). Kept as a
 * named constant so the install row's FK target stays in lockstep with
 * the seeder rename rule — a seed rename without updating this string
 * would produce FK violations at first install.
 */
export const DISCORD_CATALOG_ID = "catalog:discord";

/**
 * Surfaced when a guild_id is already bound to a different workspace — by the
 * pre-check below AND by `confirmInstall`'s catch when the migration-0120
 * partial unique index rejects a concurrent claim. Single source so both paths
 * return identical, actionable text (#3167).
 */
const DISCORD_ROUTING_CONFLICT_MESSAGE =
  "This Discord server is already connected to a different Atlas workspace. Each server can be linked to only one workspace — disconnect it there first, or contact your admin if you believe this is an error.";

/**
 * Cross-workspace ownership guard (#3154 / #3167). The OAuth bot-install
 * redirect proves an admin of the guild authorized the operator bot, but a
 * guild id is non-secret (it leaks in every Discord message envelope and is
 * copyable by any member via Developer Mode). So reject a guild_id already
 * bound to a *different* workspace before persisting — otherwise a second
 * workspace can claim the same guild and the read-side resolver in
 * `executeQuery.ts` fail-closes on `rows.length > 1`, disabling BOTH
 * workspaces (a griefing / availability vector). The `workspace_id <> $3`
 * filter excludes the installing workspace so a reconnect (same workspace
 * re-binding its own guild) is never blocked.
 *
 * This read-only pre-check catches the common case cheaply. The
 * simultaneous-race case (two workspaces binding a never-before-seen guild_id
 * at the same instant) is now closed by the partial unique index from
 * migration 0120 (#3167): the losing writer's UPSERT fails with a 23505 that
 * `confirmInstall`'s catch maps back to {@link DISCORD_ROUTING_CONFLICT_MESSAGE},
 * so both paths return the same error.
 */
async function assertGuildIdUnboundElsewhere(
  guildId: string,
  workspaceId: WorkspaceId,
): Promise<void> {
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'guild_id' = $2
        AND workspace_id <> $3
      LIMIT 1`,
    [DISCORD_CATALOG_ID, guildId, workspaceId],
  );
  if (rows.length > 0) {
    log.warn(
      { workspaceId, conflictingWorkspaceId: rows[0]?.workspace_id },
      "Discord install rejected — guild_id already bound to a different workspace",
    );
    throw new DiscordGuildIdInvalidError({
      message: DISCORD_ROUTING_CONFLICT_MESSAGE,
    });
  }
}

/**
 * Discord guild ids are unsigned 64-bit snowflakes — currently rendered
 * as 17–20 digit decimal strings ([snowflake docs](https://discord.com/developers/docs/reference#snowflakes)).
 * Discord's earliest live snowflakes (mid-2015, ~5 months post-epoch) are
 * 17 digits; older theoretical values are unreachable in practice. The
 * 20-digit ceiling gives headroom for the theoretical 19-digit max of an
 * unsigned 64-bit int plus one for forward compatibility.
 *
 * Pasted invite codes (`discord.gg/abc`), guild names, or `@server`
 * handles fail this gate before any API roundtrip.
 *
 * Exported so the executeQuery dispatcher can reuse the same regex on
 * inbound webhook envelopes — keeps the snowflake invariant on a single
 * source of truth across install + receive paths.
 */
export const DISCORD_GUILD_ID_RE = /^\d{17,20}$/;

/**
 * Reachability call timeout. Discord's API is normally sub-second; 10s
 * gives ample headroom for transient latency while keeping the install
 * POST bounded. Mirrors `telegram-static-bot-handler.ts`.
 */
const DISCORD_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. The constructor refuses to build without both
 * `botToken` and `clientId` so direct callers (tests, future programmatic
 * install paths) get the same env-gated guarantee `register.ts` already
 * has.
 *
 * `clientId` is captured here even though `confirmInstall` doesn't use
 * it — the install URL the customer-admin route builds needs it, and
 * the handler is the single source of truth for "Discord is wired" so
 * the env-gate at construction time fails loud if either var is missing.
 */
export interface DiscordStaticBotHandlerConfig {
  /** Bot token from the operator's Discord application. */
  readonly botToken: string;
  /** Application id (also called client id) from the operator's Discord app. */
  readonly clientId: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
}

/** Shape persisted into `workspace_plugins.config` JSONB. */
export interface DiscordInstallConfig {
  /** Discord guild id (snowflake string). */
  readonly guild_id: string;
  /** Optional admin-friendly label rendered in the integrations card. */
  readonly guild_name?: string;
}

/**
 * Discord API `GET /guilds/{id}` parsed response. The on-the-wire shape
 * has neither an `ok` boolean (like Telegram) nor a status-only signal —
 * Discord returns `{ id, name, ... }` on success and `{ message, code }`
 * on failure, with overlap pitfalls (notably `code: 0` is the "generic"
 * error code, so absence-of-`code` is NOT a safe discriminator).
 *
 * We normalize at the parser via {@link parseDiscordGuildResponse} into
 * an explicit `kind: "ok" | "err"` union — the consumer narrows on the
 * tag like a discriminated union from a TaggedError. The 2xx HTTP
 * status is what really separates branches; `kind` carries that decision
 * forward in a single field.
 */
type DiscordGuildResponse =
  | { readonly kind: "ok"; readonly id: string; readonly name?: string }
  | { readonly kind: "err"; readonly message: string; readonly code: number };

/**
 * Parse a Discord `GET /guilds/{id}` response into the
 * {@link DiscordGuildResponse} discriminated union.
 *
 * The HTTP status is the primary discriminator (2xx → ok, 4xx/5xx → err)
 * because Discord's `code: 0` "generic" error is a real value, not a
 * sentinel, and the wire-shape overlap would otherwise force unsafe
 * narrowing. Returns `null` when the body doesn't fit either branch
 * (e.g. a 2xx with no `id`, or a 4xx with no `message`) — the caller
 * surfaces this as a contract violation via `DiscordApiUnavailableError`.
 */
function parseDiscordGuildResponse(
  raw: unknown,
  httpStatus: number,
): DiscordGuildResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (httpStatus >= 200 && httpStatus < 300) {
    if (typeof body.id !== "string" || body.id.length === 0) return null;
    return {
      kind: "ok" as const,
      id: body.id,
      ...(typeof body.name === "string" && body.name.length > 0
        ? { name: body.name }
        : {}),
    };
  }
  const message = typeof body.message === "string" ? body.message : "";
  const code = typeof body.code === "number" ? body.code : 0;
  if (message.length === 0 && code === 0 && httpStatus >= 200 && httpStatus < 600) {
    // Empty error body with no signal — let the caller treat as upstream
    // contract violation rather than fabricating an err envelope.
    return null;
  }
  return { kind: "err" as const, message, code };
}

export class DiscordStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;
  // Discord captures its routing identifier (guild snowflake) through an OAuth
  // bot-install redirect, so the form-based `/install-form` route refuses it
  // (#3140) — see {@link StaticBotInstallHandler.oauthShaped}. The four
  // form-shaped platforms leave this unset.
  readonly oauthShaped = true as const;

  private readonly botToken: string;
  private readonly clientId: string;
  private readonly newId: () => string;

  constructor(config: DiscordStaticBotHandlerConfig) {
    if (!config.botToken || config.botToken.length === 0) {
      throw new Error(
        "DiscordStaticBotInstallHandler requires a non-empty botToken — set DISCORD_BOT_TOKEN in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    if (!config.clientId || config.clientId.length === 0) {
      throw new Error(
        "DiscordStaticBotInstallHandler requires a non-empty clientId — set DISCORD_CLIENT_ID in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    this.botToken = config.botToken;
    this.clientId = config.clientId;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
  }

  /**
   * Application id (Discord client_id). Exposed so the install route can
   * build the operator-shared bot-install URL without re-reading env.
   */
  get applicationId(): string {
    return this.clientId;
  }

  async confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    _verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly installRecord: InstallRecord }> {
    // ── 1. Validate the routing identifier ─────────────────────────
    if (!routingIdentifier || routingIdentifier.length === 0) {
      throw new DiscordGuildIdInvalidError({
        message:
          "Discord install requires a non-empty guild_id (snowflake — the numeric id of your Discord server). Enable Developer Mode in Discord, right-click the server icon, and select Copy Server ID.",
      });
    }
    if (!DISCORD_GUILD_ID_RE.test(routingIdentifier)) {
      throw new DiscordGuildIdInvalidError({
        message: `Discord guild_id "${routingIdentifier}" is not a valid snowflake (17–20 digits). Server invite codes (discord.gg/...) and server names aren't accepted — enable Developer Mode in Discord and Copy Server ID from the right-click menu.`,
      });
    }

    // ── 2. Reachability via GET /api/v10/guilds/{guild_id} ─────────
    // Throws on API errors / network failures *before* any DB write, so
    // a failed verification never leaves a half-installed row behind.
    const apiGuildName = await this.verifyReachability(routingIdentifier);

    // ── 2b. Cross-workspace ownership guard (#3154 / #3167) ─────────
    // Reachability proves the operator bot is in the guild, NOT that THIS
    // workspace owns it — guild ids are non-secret. Reject a guild_id already
    // bound to a *different* workspace so a second workspace can't claim it and
    // collapse the read-side resolver onto a `rows.length > 1` fail-closed
    // (which would disable both). A reconnect by the same workspace is excluded
    // by the `workspace_id <> $3` filter. The simultaneous-race residual is
    // closed by the migration-0120 partial unique index, whose 23505 the
    // cap-gate catch below maps to the same error (#3167).
    await assertGuildIdUnboundElsewhere(routingIdentifier, workspaceId);

    // ── 2c. Plan cap + install row — atomic (#2953, #3001) ─────────
    // Enforce the chat-integration cap and persist the workspace_plugins row
    // in ONE transaction guarded by a per-workspace advisory lock, so two
    // *distinct* net-new platforms installing concurrently can't both slip
    // past the cap. Reconnecting Discord (already installed) is never blocked
    // — the gate excludes Discord's own row from the count, and the UPSERT
    // collapses the duplicate. The upsert SQL, the cap-result → error mapping,
    // the concurrent-routing-conflict re-surface, and the RETURNING invariant
    // all live in `persistSingletonInstall` (issue #4352) — the one tested
    // spine every singleton (chat/action) install writes through.
    const configPayload: DiscordInstallConfig = {
      guild_id: routingIdentifier,
      ...extractGuildName(extras, apiGuildName, workspaceId),
    };

    const persistedId = await persistSingletonInstall({
      workspaceId,
      catalogId: DISCORD_CATALOG_ID,
      displayName: "Discord",
      log,
      config: { ...configPayload },
      newId: this.newId,
      pillar: "chat",
      capGate: makeChatIntegrationCapGate({
        orgId: workspaceId,
        catalogId: DISCORD_CATALOG_ID,
        displayName: "Discord",
        log,
      }),
      routingConflictClassifier: (err) => {
        if (!isRoutingIdUniqueViolation(err)) return null;
        // Another workspace claimed this guild_id between our pre-check and
        // our UPSERT; the migration-0120 partial unique index rejected us
        // (#3167). Surface the same actionable error the pre-check returns
        // rather than a raw 500 — first writer wins, we lost the race.
        log.warn(
          { workspaceId },
          "Discord install rejected — guild_id claimed by another workspace concurrently (unique index)",
        );
        return new DiscordGuildIdInvalidError({
          message: DISCORD_ROUTING_CONFLICT_MESSAGE,
        });
      },
    });

    log.info(
      {
        workspaceId,
        installId: persistedId,
        guildIdFingerprint: fingerprintGuildId(routingIdentifier),
      },
      "Discord install completed (guild reachable, install row UPSERTed)",
    );

    return {
      installRecord: {
        id: persistedId,
        workspaceId,
        catalogId: DISCORD_SLUG,
      },
    };
  }

  /**
   * Round-trip the Discord API to confirm the bot is currently a member
   * of the guild and Discord can route messages there. Returns the
   * guild's name when present so the install row can fall back to it
   * when extras don't supply one.
   *
   * Token redaction: `fetch` errors from `undici` may stringify the
   * request headers. Discord bot tokens are sent in `Authorization` —
   * not in the URL path — so the URL-based redaction Telegram needs
   * isn't required here. Errors are not attached as `cause` to preserve
   * symmetry with the Telegram handler's safe-by-default posture.
   */
  private async verifyReachability(guildId: string): Promise<string | null> {
    const url = `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, DISCORD_FETCH_TIMEOUT_MS, {
        // Discord bot auth uses the `Bot <token>` scheme, NOT `Bearer`
        // (Bearer is for user OAuth tokens). Wrong scheme returns 401
        // with code 0 (generic unauthorized).
        Authorization: `Bot ${this.botToken}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          guildIdFingerprint: fingerprintGuildId(guildId),
          fetchError: message,
        },
        "Discord API unreachable when verifying guild_id",
      );
      throw new DiscordApiUnavailableError({
        message: `Discord API unreachable when verifying guild_id (${message}). Retry, or check operator-side DISCORD_BOT_TOKEN wiring.`,
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          guildIdFingerprint: fingerprintGuildId(guildId),
          status: response.status,
          parseError: message,
        },
        "Discord API returned non-JSON response",
      );
      throw new DiscordApiUnavailableError({
        message: `Discord API returned a non-JSON response when verifying guild_id "${guildId}" (status ${response.status}).`,
      });
    }

    const parsed = parseDiscordGuildResponse(rawBody, response.status);
    if (parsed === null) {
      // 2xx with no id, or non-2xx with empty body — upstream contract
      // violation. Surface as unavailable; admin can retry.
      throw new DiscordApiUnavailableError({
        message: `Discord API returned an unexpected response shape when verifying guild_id "${guildId}" (status ${response.status}).`,
      });
    }
    if (parsed.kind === "err") {
      const hint = hintForDiscordError(parsed.code, response.status, parsed.message);
      throw new DiscordReachabilityError({
        message: `Discord rejected guild_id "${guildId}": ${parsed.message || "unknown error"}${hint ? ` — ${hint}` : ""}`,
        errorCode: parsed.code,
      });
    }

    return parsed.name ?? null;
  }
}

/**
 * Extract the optional `guild_name` field. Order of preference:
 *   1. `extras.guild_name` if supplied by the install caller (admin UI
 *      override, or callback route forwarding `guild_name` from
 *      Discord's OAuth response).
 *   2. The name returned by the reachability API call (`GET /guilds/{id}`).
 *   3. Omit — the admin UI renders the guild id alone.
 *
 * Drops any other keys from `extras` silently — the catalog
 * `config_schema` declares the contract; new fields land via a new
 * schema row, not via arbitrary extras injection. Logs at `warn` when
 * `guild_name` arrives at the wrong type so the silent drop is
 * observable in server logs.
 */
function extractGuildName(
  extras: Record<string, unknown> | undefined,
  apiFallback: string | null,
  workspaceId: WorkspaceId,
): { guild_name?: string } {
  if (extras !== undefined && "guild_name" in extras) {
    const raw = extras.guild_name;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string") {
        log.warn(
          { workspaceId, rawType: typeof raw },
          "Discord extras.guild_name is not a string — dropping and falling back to API name",
        );
      } else {
        const trimmed = raw.trim();
        if (trimmed.length > 0) return { guild_name: trimmed };
      }
    }
  }
  if (apiFallback && apiFallback.length > 0) return { guild_name: apiFallback };
  return {};
}

/**
 * Per-error-code follow-up text appended to Discord's `message`. Logs a
 * warn when the code is novel so operators see observability gaps before
 * users do — the verbatim message still propagates in the thrown error,
 * so the user gets *some* info, but a recurring null-return signals a
 * new failure mode worth a follow-up entry here.
 *
 * Discord's [error codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes)
 * are stable numeric tags; we key on `code` first and fall back to HTTP
 * status for transport-layer issues that don't have a specific code.
 */
function hintForDiscordError(
  code: number,
  httpStatus: number,
  description: string,
): string | null {
  // Code 0 is Discord's "generic" error tag — it carries no semantic
  // signal of its own, so we deliberately do NOT branch on it. Any
  // failure carrying `code: 0` is keyed by its HTTP status in the
  // checks below.
  if (code === 10004) {
    return "double-check the snowflake id — enable Developer Mode in Discord and Copy Server ID from the right-click menu";
  }
  if (code === 50001) {
    return "add the Atlas bot to the server first — use the install link from /admin/integrations to grant the bot access";
  }
  if (httpStatus === 401 || code === 40001) {
    return "the operator-side DISCORD_BOT_TOKEN may be revoked or wrong";
  }
  if (httpStatus === 403) {
    return "the bot lacks permission to read this guild — re-run the install link to grant the required scopes";
  }
  log.warn(
    { errorCode: code, httpStatus, description },
    "Discord error code not mapped in hintForDiscordError — consider adding a hint branch",
  );
  return null;
}

/**
 * Short, log-safe fingerprint of the guild_id — last 4 chars only. The
 * guild_id is a routing identifier, not a secret, but logging the full
 * value in every install line is noisy.
 */
function fingerprintGuildId(guildId: string): string {
  return guildId.length <= 4 ? guildId : `…${guildId.slice(-4)}`;
}

/**
 * `fetch` with a timeout. Bun's fetch has no built-in timeout in
 * serverless runtimes; without an AbortController-driven cap a hung
 * Discord upstream would hold the install POST open indefinitely.
 * Mirrors `telegram-static-bot-handler.ts`'s `fetchWithTimeout`.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}
