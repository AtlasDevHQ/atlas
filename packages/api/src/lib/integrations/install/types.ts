/**
 * `PlatformInstallHandler` interface family — slice 4 of #2649 (issue #2652).
 *
 * Three concrete handler shapes, one per `install_model` value in the
 * plugin catalog (`oauth` / `form` / `static-bot`). The {@link
 * getInstallHandler} dispatch in `./dispatch.ts` switches on the catalog
 * row's `install_model` and returns the matching handler.
 *
 * Per ADR-0004, Platform OAuth is a separate subsystem from Better
 * Auth's user OAuth. These interfaces never touch the `account` table —
 * they write to `workspace_plugins` (install record, per ADR-0003) and
 * to the per-Platform credential store (`chat_cache` for chat Platforms,
 * per-plugin store for lazy integrations).
 *
 * Per-handler return-shape note: each handler intentionally returns its
 * *own* result shape rather than a shared envelope, because the three
 * install models have genuinely different success semantics (a static-
 * bot install carries no credential, an OAuth callback carries both an
 * install record and a credential write outcome, etc.). The dispatch
 * union ({@link PlatformInstallHandler}) is tagged via the `kind` field
 * so consumers can narrow safely.
 */

import type { WorkspaceId } from "@useatlas/types";
import type { CatalogInstallModel } from "@atlas/api/lib/config";

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

/**
 * Catalog id — the slug column of `plugin_catalog` (e.g. `"slack"`,
 * `"jira"`). Kept as a plain string for now; if catalog ids grow more
 * structure (e.g. namespaced community plugins) we'd promote this to a
 * branded type alongside the existing brands in `@useatlas/types`.
 */
export type CatalogId = string;

/**
 * Outcome of writing a Platform install record — the row in
 * `workspace_plugins`. Returned by every handler so callers can render
 * "installed" UI without a follow-up read.
 *
 * Persisted-row id and the catalog binding land here; per-Platform
 * metadata (Slack `team_id`, Jira `cloud_id`, etc.) lives in the
 * adapter's own state store and is not part of this envelope.
 */
export interface InstallRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly catalogId: CatalogId;
}

/**
 * Outcome of writing the per-Platform credential blob. Tracked as a
 * distinct field from {@link InstallRecord} because a partial failure
 * — install row written, credential write failed — needs to surface as
 * "Reconnect needed" rather than "Installed" (admin must re-run the
 * OAuth dance). The dual-store semantics are documented in ADR-0003.
 */
export interface CredentialResult {
  readonly written: boolean;
  /**
   * Operator-facing reason when `written: false`. Surfaced in the
   * `/admin/integrations` card. Never include secret material.
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// OAuth install handler
// ---------------------------------------------------------------------------

/**
 * Handler for `install_model: "oauth"` catalog entries — Slack, Jira,
 * Salesforce, etc. Atlas's per-deploy app registration drives the
 * OAuth dance; the Workspace gets its own bot token / per-tenant
 * credential at callback time.
 *
 * Credential rotation semantics: each implementation documents how it
 * refreshes — Slack's bot token does not expire, Salesforce / Jira use
 * refresh tokens. See the per-Platform JSDoc in 1.5.3+ handler files.
 */
export interface OAuthPlatformInstallHandler {
  readonly kind: "oauth";

  /**
   * Begin the OAuth dance. Mints a CSRF state token via
   * {@link OAuthStateToken} bound to `(workspaceId, catalogId)` and
   * returns the Platform's authorize URL with that state baked in.
   *
   * `redirectUrl` is what the admin's browser is redirected to;
   * `stateToken` is the same token, surfaced separately so the API
   * route can persist it client-side (cookie / hidden form input) when
   * the Platform's authorize URL doesn't echo the state back through
   * the query string verbatim.
   */
  startInstall(workspaceId: WorkspaceId): Promise<{
    readonly redirectUrl: string;
    readonly stateToken: string;
  }>;

  /**
   * Handle the OAuth callback. Verifies the state token, exchanges the
   * authorization code with the Platform, then writes both stores:
   * the install record (`workspace_plugins`) and the per-Platform
   * credential.
   *
   * Returns `null` on state-token failure (forged, expired, replayed).
   * Bubbles a tagged error on Platform-side failures (`oauth.v2.access`
   * non-OK responses for Slack, etc.) so the route can surface an
   * actionable user error.
   *
   * `extras` carries Platform-specific callback query params that
   * aren't the OAuth `code` itself. GitHub multi-tenant App installs
   * use this to receive `installationId` alongside the user OAuth
   * `code` — verifying the installation_id is owned by the
   * authenticating user is what prevents the cross-tenant binding
   * attack documented on `GitHubOAuthInstallHandler`. Other handlers
   * ignore the field. Adding a new Platform-specific extra is one
   * field here; if the extras shape ever grows beyond a handful, fold
   * it into a per-Platform discriminated union.
   */
  handleCallback(
    code: string,
    stateToken: string,
    extras?: OAuthCallbackExtras,
  ): Promise<{
    readonly workspaceId: WorkspaceId;
    readonly catalogId: CatalogId;
    readonly installRecord: InstallRecord;
    readonly credentialResult: CredentialResult;
  } | null>;
}

/**
 * Platform-specific extras delivered on the OAuth callback query string
 * but distinct from the OAuth 2.0 `code` field. Today only GitHub Apps
 * use this slot (installation_id). The interface is open-ended on
 * purpose so adding a future field (e.g. PKCE `code_verifier`) doesn't
 * ripple across every handler implementation.
 */
export interface OAuthCallbackExtras {
  /**
   * GitHub App `installation_id` query param delivered alongside the
   * user OAuth `code` when the App has "Request user authorization
   * (OAuth) during installation" enabled. The handler verifies this
   * value is owned by the user the `code` resolves to before persisting.
   */
  readonly installationId?: string;
}

// ---------------------------------------------------------------------------
// Form-based install handler
// ---------------------------------------------------------------------------

/**
 * Handler for `install_model: "form"` catalog entries — Email, Webhook,
 * Obsidian, etc. Admin submits a form (SMTP host + creds, webhook URL +
 * shared secret, etc.); handler validates the config and writes both
 * stores in one shot.
 *
 * `formData` is `unknown` at this level — each implementation is
 * responsible for validating with its own Zod schema before touching
 * persistence. The catalog row's `config_schema` JSONB column is the
 * source of truth for what fields a Platform expects.
 *
 * Credential rotation semantics: form-based credentials don't refresh
 * automatically — when an SMTP password expires, the admin re-submits
 * the form. Some implementations may surface "test connection" actions
 * that re-validate without rewriting.
 */
export interface FormBasedInstallHandler {
  readonly kind: "form";

  validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Static-bot install handler
// ---------------------------------------------------------------------------

/**
 * Handler for `install_model: "static-bot"` catalog entries — Telegram,
 * Discord, Teams, gchat, WhatsApp. The bot itself is operator-shared
 * (single app registration per Platform); the customer admin supplies a
 * routing identifier (Discord `guild_id`, Telegram `chat_id`, Teams
 * `tenant_id`, etc.) that the shared bot uses to scope messages.
 *
 * `verificationProof` is optional — a Platform-specific proof that the
 * routing identifier really belongs to the requesting Workspace.
 * Required for Platforms where impersonation would let Workspace B
 * claim Workspace A's routing identifier. The semantics are
 * Platform-defined: some Platforms verify server-side via an upstream
 * round-trip (no caller proof needed), others require a signed
 * handshake the caller supplies here.
 *
 * `extras` carries the optional config fields beyond the routing
 * identifier — e.g. Telegram's `display_name` from the catalog
 * `config_schema`. The customer admin submits these in the install
 * modal; the WorkspaceInstaller forwards them as a plain object the
 * handler interprets per its catalog schema. Keys missing from the
 * handler's schema are silently dropped at persist time — this slot is
 * a forward-compat extension point, not a free-form metadata store.
 *
 * Credential rotation semantics: there is no per-Workspace credential —
 * the bot's auth lives with the operator. Rotation is operator-side.
 *
 * **KEYSTONE pattern for Phase D implementers.** Telegram (1.5.3 #2748)
 * is the first real implementation; Discord (#2749), gchat (#2754), and
 * WhatsApp (#2753) inherit the shape. The contract each handler MUST
 * honor:
 *
 *   1. Validate `routingIdentifier` format at entry — reject obvious
 *      malformed input (wrong type, public-handle / username,
 *      out-of-range length) BEFORE any upstream round-trip. Use a
 *      Platform-specific tagged error (see `TelegramChatIdInvalidError`).
 *   2. Verify reachability against the Platform BEFORE persisting the
 *      install row — a failed verification must never leave a half-
 *      installed row behind.
 *   3. Persist via UPSERT keyed on `(workspace_id, catalog_id)` with
 *      `RETURNING id`; use the returned id (not the candidate) so
 *      re-install lookups land on the existing row.
 *   4. Extract known fields from `extras` per the catalog
 *      `config_schema`; drop unknown keys silently. Log at `warn` if a
 *      known field arrives at the wrong type (admin UI form validation
 *      should never let this through; warn = operator signal).
 *   5. Use `Data.TaggedError` for failure surface (one tag per failure
 *      class), wire them into `mapTaggedError` so the HTTP layer
 *      produces actionable 400 / 502 envelopes instead of generic 500s.
 *   6. Sanitize any operator-scoped credential (bot token) from error
 *      messages and log payloads; never attach `cause: err` on a
 *      `fetch`-error wrapper.
 *
 * See {@link TelegramStaticBotInstallHandler} for the reference shape.
 */
export interface StaticBotInstallHandler {
  readonly kind: "static-bot";

  /**
   * Operator-side application id, when the Platform's bot-install flow
   * is OAuth-shaped (Discord) and the route needs to build the
   * authorize URL. `undefined` for Platforms whose install captures the
   * routing identifier directly without an OAuth redirect (Telegram —
   * the admin pastes the `chat_id` into a form).
   *
   * Typed on the interface so the route's narrow (`if (!handler.applicationId)`)
   * is a type-checked contract rather than a `"applicationId" in handler`
   * runtime duck-type. A future static-bot Platform that uses an OAuth
   * shape must populate this; one that doesn't can omit it.
   */
  readonly applicationId?: string;

  confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{
    readonly installRecord: InstallRecord;
  }>;
}

// ---------------------------------------------------------------------------
// Dispatch union
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by {@link getInstallHandler}. The `kind`
 * tag mirrors the catalog row's {@link CatalogInstallModel} value so
 * callers can narrow with a single switch.
 *
 * Adding a new `install_model` value (e.g. `"manifest"`) in a future
 * milestone is a compile error at the dispatch switch — the exhaustive
 * `never` branch surfaces the missing case before any runtime drift.
 */
export type PlatformInstallHandler =
  | OAuthPlatformInstallHandler
  | FormBasedInstallHandler
  | StaticBotInstallHandler;

/**
 * Subset of the catalog row that the dispatch needs — kept narrow so
 * the install module doesn't depend on Drizzle row shapes. The seeder
 * already validates `install_model` against {@link CatalogInstallModel}
 * at read time (see `catalog-seeder.ts::readExistingCatalog`).
 */
export interface CatalogRowForDispatch {
  readonly slug: CatalogId;
  readonly install_model: CatalogInstallModel;
}
