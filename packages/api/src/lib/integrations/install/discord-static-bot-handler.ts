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
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  DiscordApiUnavailableError,
  DiscordGuildIdInvalidError,
  DiscordReachabilityError,
} from "@atlas/api/lib/effect/errors";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";

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
 * Discord guild ids are unsigned 64-bit snowflakes — currently rendered
 * as 17–20 digit decimal strings ([snowflake docs](https://discord.com/developers/docs/reference#snowflakes)).
 * The 17-digit floor is the historical minimum (snowflakes minted shortly
 * after Discord's epoch); the 20-digit ceiling gives headroom for the
 * theoretical 19-digit maximum of a 64-bit unsigned integer plus one for
 * forward compatibility.
 *
 * Pasted invite codes (`discord.gg/abc`), guild names, or `@server`
 * handles fail this gate before any API roundtrip.
 */
const DISCORD_GUILD_ID_RE = /^\d{17,20}$/;

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
 * Discord API `GET /guilds/{id}` response envelope. The success branch
 * carries the guild's id + name (we use the name as a fallback display
 * label); the error branch is `{ message, code }`. Modeled as a
 * discriminated union via the presence of `code` so the success path
 * narrows cleanly.
 *
 * `code` is Discord's numeric error code, distinct from the HTTP
 * status. Example: HTTP 404 + `code: 10004` ("Unknown Guild"). The
 * combination is the actionable signal — bare HTTP status alone collapses
 * "guild doesn't exist" and "bot is missing the right scope" into the
 * same bucket.
 */
type DiscordGuildResponse =
  | { readonly id: string; readonly name?: string; readonly code?: undefined }
  | { readonly message: string; readonly code: number; readonly id?: undefined };

export class DiscordStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

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

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // Mirrors the email-form-handler and telegram-static-bot-handler
    // pattern: candidate id on INSERT, RETURNING id so a CONFLICT lands
    // on the existing row's id (idempotent re-install).
    const candidateId = this.newId();
    const configPayload: DiscordInstallConfig = {
      guild_id: routingIdentifier,
      ...extractGuildName(extras, apiGuildName, workspaceId),
    };

    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, DISCORD_CATALOG_ID, JSON.stringify(configPayload)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING`
        // returns the row on both insert and update. Empty here means a
        // driver / wrapper regression — fail loudly rather than ship a
        // stale id back (on re-install the DB row has the existing id;
        // falling back to the fresh candidateId would strand subsequent
        // lookups).
        throw new Error(
          `workspace_plugins UPSERT returned no id for Discord install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist Discord install record — aborting install",
      );
      throw err;
    }

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

    let parsed: DiscordGuildResponse;
    try {
      parsed = (await response.json()) as DiscordGuildResponse;
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

    if (parsed.code !== undefined) {
      const desc = parsed.message || "unknown error";
      const code = parsed.code;
      const hint = hintForDiscordError(code, response.status, desc);
      throw new DiscordReachabilityError({
        message: `Discord rejected guild_id "${guildId}": ${desc}${hint ? ` — ${hint}` : ""}`,
        errorCode: code,
      });
    }

    if (typeof parsed.id !== "string") {
      // 2xx success envelope but no `id` field — Discord's contract says
      // every guild payload includes `id`, so this is an upstream
      // contract violation. Surface as unavailable; admin can retry.
      throw new DiscordApiUnavailableError({
        message: `Discord API returned a 2xx response without a guild id for "${guildId}" (status ${response.status}).`,
      });
    }

    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
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
  // 0 is Discord's "generic" code — often auth failures don't carry a
  // specific code, so fall through to the HTTP-status branch below.
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
