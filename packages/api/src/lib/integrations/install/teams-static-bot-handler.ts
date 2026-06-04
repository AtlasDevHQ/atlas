/**
 * `TeamsStaticBotInstallHandler` — slice 14 of 1.5.3 Phase D (issue
 * #2752). Third concrete implementation of {@link StaticBotInstallHandler}
 * after the Telegram keystone (#2748) and Discord (#2749).
 *
 * Teams follows the same operator-shared static-bot pattern: one
 * operator-owned Microsoft Entra ID app registration (env: `TEAMS_APP_ID`
 * + `TEAMS_APP_PASSWORD`) serves every customer in MultiTenant mode.
 * Each workspace's routing identifier is the **Microsoft tenant GUID**
 * supplied by the customer admin — either pasted into the install modal
 * after a manifest upload, or captured automatically from an AppSource
 * Marketplace webhook (a follow-up slice; manifest path is the install
 * surface this handler binds today). Optional `tenant_name` rides
 * through `extras` analogous to Discord's `guild_name` / Telegram's
 * `display_name`.
 *
 * Per-Workspace credential note: there isn't one. The bot's auth lives
 * with the operator (`TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`), and Bot
 * Framework token acquisition is keyed on the app credentials — NOT on
 * the customer tenant — in MultiTenant mode. The catalog `tenant_id` is
 * a routing identifier, not a secret: it shows up in every Bot
 * Framework activity envelope's `channelData.tenant.id`. The
 * `workspace_plugins.config` row is written by the chat-integration cap
 * gate (`checkChatIntegrationLimitAndInstall`, mirroring
 * discord-static-bot-handler.ts), which owns the advisory-locked UPSERT,
 * so `encryptSecretFields` is not in the write path at all.
 *
 * Cap gate (#3142): like Discord and Slack, the install UPSERT runs
 * through `checkChatIntegrationLimitAndInstall` so an over-cap net-new
 * install is refused with `ChatIntegrationLimitError` (→ 429) and a
 * reconnect is grandfathered. This replaced the original bare
 * `internalQuery` UPSERT when Teams joined the unified install path under
 * umbrella #2994 (which also added the Teams runtime branch in
 * `lib/chat-plugin/executeQuery.ts` + the `@chat-adapter/teams` webhook
 * receive route).
 *
 * Reachability verification: instead of acquiring a Bot Framework token
 * (which would only confirm the operator credentials work, not the
 * customer tenant), we call Microsoft's OIDC discovery endpoint
 * `https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration`.
 * A 200 confirms the tenant exists in Microsoft Entra ID; a 400 means
 * the GUID isn't a real tenant. The endpoint is public (no auth) so it
 * doesn't leak operator credentials, and it's the canonical Microsoft
 * "tenant exists" check used across Microsoft Identity Platform docs.
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see ./discord-static-bot-handler.ts — the cousin shape this mirrors
 * @see https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-protocols-oidc
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import {
  BillingCheckFailedError,
  ChatIntegrationLimitError,
  TeamsApiUnavailableError,
  TeamsReachabilityError,
  TeamsTenantIdInvalidError,
} from "@atlas/api/lib/effect/errors";
import { checkChatIntegrationLimitAndInstall } from "@atlas/api/lib/billing/enforcement";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";
import { isRoutingIdUniqueViolation } from "./routing-id-conflict";

const log = createLogger("integrations.install.teams");

/** Catalog slug — the dispatch key in `registerStaticBotHandler`. */
export const TEAMS_SLUG: CatalogId = "teams";

/**
 * Stable `plugin_catalog.id` for Teams. The seeder derives row ids as
 * `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`). Kept as a
 * named constant so the install row's FK target stays in lockstep with
 * the seeder rename rule — a seed rename without updating this string
 * would produce FK violations at first install.
 */
export const TEAMS_CATALOG_ID = "catalog:teams";

/**
 * Surfaced when a tenant_id is already bound to a different workspace — by the
 * pre-check below AND by `confirmInstall`'s catch when the migration-0120
 * partial unique index rejects a concurrent claim. Single source so both paths
 * return identical, actionable text (#3167).
 */
const TEAMS_ROUTING_CONFLICT_MESSAGE =
  "This Microsoft Teams tenant is already connected to a different Atlas workspace. Each tenant can be linked to only one workspace — disconnect it there first, or contact your admin if you believe this is an error.";

/**
 * Cross-workspace ownership guard (#3154 / #3167). Teams captures its tenant_id
 * through the Azure AD admin-consent callback, so the id is ownership-proven
 * for the consenting admin — but the tenant GUID is non-secret (it rides in
 * every Bot Framework activity envelope's `channelData.tenant.id`), and two
 * distinct Atlas workspaces controlled from the same Microsoft tenant could
 * both legitimately consent it. Binding the same tenant_id to two workspaces
 * collapses the read-side resolver in `executeQuery.ts` onto a
 * `rows.length > 1` fail-closed, disabling BOTH. So this is a
 * uniqueness/availability guard (first binder wins): reject a tenant_id already
 * bound to a *different* workspace. The `workspace_id <> $3` filter excludes a
 * reconnect of the same workspace.
 *
 * This read-only pre-check catches the common case cheaply. The
 * simultaneous-race case (two workspaces consenting a never-before-seen
 * tenant_id at the same instant) is now closed by the partial unique index
 * from migration 0120 (#3167): the losing writer's UPSERT fails with a 23505
 * that `confirmInstall`'s catch maps back to {@link TEAMS_ROUTING_CONFLICT_MESSAGE},
 * so both paths return the same error.
 */
async function assertTenantIdUnboundElsewhere(
  tenantId: string,
  workspaceId: WorkspaceId,
): Promise<void> {
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'tenant_id' = $2
        AND workspace_id <> $3
      LIMIT 1`,
    [TEAMS_CATALOG_ID, tenantId, workspaceId],
  );
  if (rows.length > 0) {
    log.warn(
      { workspaceId, conflictingWorkspaceId: rows[0]?.workspace_id },
      "Teams install rejected — tenant_id already bound to a different workspace",
    );
    throw new TeamsTenantIdInvalidError({
      message: TEAMS_ROUTING_CONFLICT_MESSAGE,
    });
  }
}

/**
 * Microsoft Entra ID tenant ids are GUIDs in the canonical 8-4-4-4-12
 * hex-digit format (e.g. `72f988bf-86f1-41af-91ab-2d7cd011db47`) — see
 * the [tenant id reference](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-find-tenant).
 *
 * Pasted onmicrosoft domains (`contoso.onmicrosoft.com`), display
 * names, or `tid:` URI prefixes fail this gate before any Microsoft
 * roundtrip. The check is case-insensitive — Azure renders tenant
 * GUIDs in lowercase but admins routinely paste them in uppercase from
 * portal links.
 *
 * Exported so the executeQuery dispatcher can reuse the same regex on
 * inbound webhook envelopes — keeps the tenant_id invariant on a single
 * source of truth across install + receive paths.
 */
export const TEAMS_TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reachability call timeout. Microsoft's OIDC discovery endpoint is
 * normally sub-second; 10s gives ample headroom for transient latency
 * while keeping the install POST bounded. Mirrors the pattern in
 * `discord-static-bot-handler.ts`.
 */
const TEAMS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. The constructor refuses to build without both
 * `appId` and `appPassword` so direct callers (tests, future
 * programmatic install paths) get the same env-gated guarantee
 * `register.ts` already has.
 *
 * `appId` and `appPassword` are captured here even though
 * `confirmInstall` doesn't use them directly — the install URL the
 * customer-admin route builds and the manifest download both need
 * them, and the handler is the single source of truth for "Teams is
 * wired" so the env-gate at construction time fails loud if either
 * var is missing.
 */
export interface TeamsStaticBotHandlerConfig {
  /** Microsoft App ID (client id) from the operator's Azure Bot registration. */
  readonly appId: string;
  /** Microsoft App Password (client secret) from the operator's Azure Bot registration. */
  readonly appPassword: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
}

/** Shape persisted into `workspace_plugins.config` JSONB. */
export interface TeamsInstallConfig {
  /** Microsoft Entra ID tenant GUID (lowercase). */
  readonly tenant_id: string;
  /** Optional admin-friendly label rendered in the integrations card. */
  readonly tenant_name?: string;
}

export class TeamsStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;
  // Teams captures its routing identifier (Microsoft Entra ID tenant GUID)
  // through the Azure AD **admin-consent** OAuth callback — the consent
  // happens in the admin's own tenant and Azure returns the verified tenant
  // id, which IS the ownership proof (analogous to Discord's bot-install
  // redirect). So the form-based `/install-form` route refuses it (#3142);
  // the dedicated OAuth callback in `routes/teams.ts` dispatches into
  // `confirmInstall` instead. See {@link StaticBotInstallHandler.oauthShaped}.
  readonly oauthShaped = true as const;

  private readonly appId: string;
  private readonly newId: () => string;

  constructor(config: TeamsStaticBotHandlerConfig) {
    if (!config.appId || config.appId.length === 0) {
      throw new Error(
        "TeamsStaticBotInstallHandler requires a non-empty appId — set TEAMS_APP_ID in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    if (!config.appPassword || config.appPassword.length === 0) {
      throw new Error(
        "TeamsStaticBotInstallHandler requires a non-empty appPassword — set TEAMS_APP_PASSWORD in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    // appPassword is validated at construction (fail-loud env gate) but
    // not stored — reachability uses the public OIDC discovery endpoint
    // which takes no auth, and the chat adapter (`@chat-adapter/teams`)
    // consumes the password through its own AdapterRegistry path. Keeping
    // the secret off this object cuts the surface that could leak it via
    // logging or a future serializer.
    this.appId = config.appId;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
  }

  /**
   * Microsoft App ID (client id). Exposed so the install route can
   * build the manifest download URL or the AppSource deep link without
   * re-reading env.
   */
  get applicationId(): string {
    return this.appId;
  }

  async confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    _verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly installRecord: InstallRecord }> {
    // ── 1. Validate the routing identifier ─────────────────────────
    if (!routingIdentifier || routingIdentifier.length === 0) {
      throw new TeamsTenantIdInvalidError({
        message:
          "Teams install requires a non-empty tenant_id (Microsoft Entra ID tenant GUID — 8-4-4-4-12 hex digits). Find it in the Microsoft Entra admin center under Overview → Tenant ID, or run `az account show --query tenantId` in the Azure CLI.",
      });
    }
    if (!TEAMS_TENANT_ID_RE.test(routingIdentifier)) {
      throw new TeamsTenantIdInvalidError({
        message: `Teams tenant_id "${routingIdentifier}" is not a valid Microsoft Entra ID tenant GUID (expected 8-4-4-4-12 hex digits, e.g. 72f988bf-86f1-41af-91ab-2d7cd011db47). Tenant domains (contoso.onmicrosoft.com) and display names aren't accepted — find the GUID in the Microsoft Entra admin center under Overview → Tenant ID.`,
      });
    }

    // Normalize to lowercase for storage — Microsoft renders tenant
    // GUIDs in lowercase across the portal, the OIDC discovery payload,
    // and the Bot Framework activity envelope. Pasting from a portal
    // link occasionally yields uppercase letters; lowercasing here
    // keeps lookups by tenant_id consistent regardless of paste source.
    const normalizedTenantId = routingIdentifier.toLowerCase();

    // ── 2. Reachability via Microsoft OIDC discovery ───────────────
    // Throws on tenant-not-found / network failures *before* any DB
    // write, so a failed verification never leaves a half-installed
    // row behind.
    await this.verifyReachability(normalizedTenantId);

    // ── 2b. Cross-workspace ownership guard (#3154 / #3167) ─────────
    // Even though admin-consent proves tenant ownership, the tenant GUID is
    // non-secret and two Atlas workspaces in the same Microsoft tenant could
    // both consent it — binding it twice collapses the read-side resolver onto
    // a `rows.length > 1` fail-closed (disabling both). Reject a tenant_id
    // already bound to a *different* workspace; a reconnect is excluded by
    // `workspace_id <> $3`. The simultaneous-race residual is closed by the
    // migration-0120 partial unique index, whose 23505 the cap-gate catch
    // below maps to the same error (#3167).
    await assertTenantIdUnboundElsewhere(normalizedTenantId, workspaceId);

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // Mirrors the discord-static-bot-handler pattern: candidate id on
    // INSERT, RETURNING id so a CONFLICT lands on the existing row's
    // id (idempotent re-install).
    const candidateId = this.newId();
    const configPayload: TeamsInstallConfig = {
      tenant_id: normalizedTenantId,
      ...extractTenantName(extras, workspaceId),
    };

    let capCheck;
    try {
      // Schema notes:
      //   - `pillar` + `install_id` became NOT NULL in migration 0092
      //     (#2739) and the auto-fill trigger was dropped in 0096
      //     (#2744). Every writer must name both columns explicitly.
      //   - Chat-pillar installs are singletons per (workspace, catalog),
      //     enforced by the `workspace_plugins_singleton` partial unique
      //     index (`WHERE pillar IN ('chat','action')` from migration
      //     0092). We target it via the inference clause
      //     `ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat','action')`
      //     so re-install lands on the existing row (idempotent UPSERT).
      //   - For chat-pillar there's only one install per (workspace,
      //     catalog), so `install_id` mirrors `id` — WorkspaceInstaller's
      //     datasource path uses a caller-supplied installId; static-bot
      //     chat installs don't have that surface, so we reuse the row id.
      //   - The cap gate (#3142) wraps the UPSERT in a per-workspace
      //     advisory-locked transaction so concurrent net-new installs
      //     can't both slip past the chat-integration cap; reconnect is
      //     grandfathered inside the gate.
      capCheck = await checkChatIntegrationLimitAndInstall<{ id: string }>(
        workspaceId,
        TEAMS_CATALOG_ID,
        {
          sql: `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
          params: [candidateId, workspaceId, TEAMS_CATALOG_ID, JSON.stringify(configPayload)],
        },
      );
    } catch (err) {
      if (isRoutingIdUniqueViolation(err)) {
        // Another workspace consented this tenant_id between our pre-check and
        // our UPSERT; the migration-0120 partial unique index rejected us
        // (#3167). Surface the same actionable error the pre-check returns
        // rather than a raw 500 — first binder wins, we lost the race.
        log.warn(
          { workspaceId },
          "Teams install rejected — tenant_id claimed by another workspace concurrently (unique index)",
        );
        throw new TeamsTenantIdInvalidError({
          message: TEAMS_ROUTING_CONFLICT_MESSAGE,
        });
      }
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist Teams install record — aborting install",
      );
      throw err;
    }
    if (!capCheck.allowed) {
      if (capCheck.reason === "check_failed") {
        // Count couldn't be determined — fail closed, but as a transient
        // 503 "try again", not a misleading 429 "upgrade your plan".
        log.error(
          { workspaceId },
          "Teams install blocked — chat-integration count check failed (failing closed)",
        );
        throw new BillingCheckFailedError({
          message: capCheck.errorMessage,
          workspaceId,
        });
      }
      log.info(
        { workspaceId, limit: capCheck.limit },
        "Teams install blocked — workspace at chat-integration cap",
      );
      throw new ChatIntegrationLimitError({
        message: capCheck.errorMessage,
        workspaceId,
        limit: capCheck.limit,
      });
    }

    const returned = capCheck.rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING` returns
      // the row on both insert and update. Empty here means a driver /
      // wrapper regression — fail loudly rather than ship a stale id back (on
      // re-install the DB row has the existing id; falling back to the fresh
      // candidateId would strand subsequent lookups). #2807 cemented this
      // no-fallback posture across the static-bot family.
      throw new Error(
        `workspace_plugins UPSERT returned no id for Teams install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
      );
    }
    const persistedId: string = returned;

    log.info(
      {
        workspaceId,
        installId: persistedId,
        tenantIdFingerprint: fingerprintTenantId(normalizedTenantId),
      },
      "Teams install completed (tenant reachable, install row UPSERTed)",
    );

    return {
      installRecord: {
        id: persistedId,
        workspaceId,
        catalogId: TEAMS_SLUG,
      },
    };
  }

  /**
   * Round-trip Microsoft's OIDC discovery endpoint to confirm the
   * tenant exists in Microsoft Entra ID. The endpoint is public and
   * documented at
   * https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-protocols-oidc#fetch-the-openid-connect-metadata-document
   * — a 200 returns the tenant's OIDC metadata, a 400 with
   * `error: invalid_tenant` means the GUID isn't a real tenant.
   *
   * No operator credentials are sent on the wire (the endpoint takes
   * no auth), so there's no token-redaction surface to worry about.
   * Errors are not attached as `cause` for symmetry with the Discord /
   * Telegram handlers' safe-by-default posture.
   */
  private async verifyReachability(tenantId: string): Promise<void> {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, TEAMS_FETCH_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          tenantIdFingerprint: fingerprintTenantId(tenantId),
          fetchError: message,
        },
        "Microsoft tenant discovery unreachable when verifying tenant_id",
      );
      throw new TeamsApiUnavailableError({
        message: `Microsoft tenant discovery unreachable when verifying tenant_id (${message}). Retry, or check operator-side egress to login.microsoftonline.com.`,
      });
    }

    if (response.status >= 200 && response.status < 300) {
      // The OIDC discovery payload is JSON, but we don't need anything
      // from it — the 2xx confirms the tenant exists. Skip the parse
      // entirely to avoid a JSON.parse round-trip in the install hot
      // path.
      return;
    }

    // Non-2xx — most commonly 400 with `{ error: "invalid_tenant",
    // error_description: "AADSTS90002: Tenant '…' not found." }`. Pull
    // the description verbatim when present so the admin sees
    // Microsoft's actionable text rather than a generic "install
    // failed".
    let upstreamMessage = "";
    try {
      const body = (await response.json()) as {
        error_description?: unknown;
        error?: unknown;
      };
      if (typeof body.error_description === "string") {
        upstreamMessage = body.error_description;
      } else if (typeof body.error === "string") {
        upstreamMessage = body.error;
      }
    } catch (err) {
      // Non-JSON body (or empty) — fall through to the status-only
      // message. Logged at debug because the status is the real signal;
      // a parse failure here is incidental.
      log.debug(
        {
          tenantIdFingerprint: fingerprintTenantId(tenantId),
          status: response.status,
          parseError: err instanceof Error ? err.message : String(err),
        },
        "Microsoft tenant discovery returned a non-JSON body — falling back to status-only message",
      );
    }

    // Only append a hint when Microsoft didn't give us an
    // `error_description` — the AADSTS strings ("Tenant '…' not
    // found.") already carry the actionable text the admin needs, so
    // duplicating it via a paraphrased hint just adds noise. The hint
    // is the fallback voice for status-only failures (non-JSON bodies,
    // 5xx outages), not a unilateral postscript.
    const hint = upstreamMessage.length === 0 ? hintForTeamsStatus(response.status) : null;
    throw new TeamsReachabilityError({
      message: `Microsoft rejected tenant_id "${tenantId}": ${upstreamMessage || `HTTP ${response.status}`}${hint ? ` — ${hint}` : ""}`,
      status: response.status,
    });
  }
}

/**
 * Extract the optional `tenant_name` field. Order of preference:
 *   1. `extras.tenant_name` if supplied by the install caller (admin UI
 *      override, or AppSource webhook forwarding the tenant's display
 *      name).
 *   2. Omit — the admin UI renders the tenant id alone. (Unlike
 *      Discord's `GET /guilds/{id}` response, the OIDC discovery payload
 *      doesn't carry a human-readable tenant name; the canonical source
 *      for it is `https://graph.microsoft.com/v1.0/organization`, which
 *      requires operator credentials we choose not to spend on a label.)
 *
 * Drops any other keys from `extras` silently — the catalog
 * `config_schema` declares the contract; new fields land via a new
 * schema row, not via arbitrary extras injection. Logs at `warn` when
 * `tenant_name` arrives at the wrong type so the silent drop is
 * observable in server logs.
 */
function extractTenantName(
  extras: Record<string, unknown> | undefined,
  workspaceId: WorkspaceId,
): { tenant_name?: string } {
  if (extras === undefined || !("tenant_name" in extras)) return {};
  const raw = extras.tenant_name;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    log.warn(
      { workspaceId, rawType: typeof raw },
      "Teams extras.tenant_name is not a string — dropping",
    );
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  return { tenant_name: trimmed };
}

/**
 * Per-status follow-up text appended to Microsoft's response. Logs a
 * warn when the status is novel so operators see observability gaps
 * before users do — the verbatim upstream message still propagates in
 * the thrown error, so the user gets *some* info, but a recurring
 * null-return signals a new failure mode worth a follow-up entry here.
 */
function hintForTeamsStatus(status: number): string | null {
  if (status === 400) {
    return "double-check the tenant_id — find it in the Microsoft Entra admin center under Overview → Tenant ID";
  }
  if (status === 401 || status === 403) {
    return "the OIDC discovery endpoint refused this tenant — it may be a guest-restricted tenant, or recently deleted";
  }
  if (status === 429) {
    return "Microsoft rate-limited the discovery endpoint — wait a minute and retry";
  }
  if (status >= 500) {
    return "Microsoft's identity platform is degraded — check https://status.azure.com and retry";
  }
  log.warn(
    { httpStatus: status },
    "Teams discovery status not mapped in hintForTeamsStatus — consider adding a hint branch",
  );
  return null;
}

/**
 * Short, log-safe fingerprint of the tenant_id — last 4 chars only.
 * The tenant_id is a routing identifier, not a secret, but logging the
 * full value in every install line is noisy.
 */
function fingerprintTenantId(tenantId: string): string {
  return tenantId.length <= 4 ? tenantId : `…${tenantId.slice(-4)}`;
}

/**
 * `fetch` with a timeout. Bun's fetch has no built-in timeout in
 * serverless runtimes; without an AbortController-driven cap a hung
 * Microsoft upstream would hold the install POST open indefinitely.
 * Mirrors `discord-static-bot-handler.ts`'s `fetchWithTimeout`.
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
