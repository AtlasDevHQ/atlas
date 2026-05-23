/**
 * AdapterRegistry — slice 2 of #2649 (issue #2650).
 *
 * Replaces the pre-1.5.2 `if (config.adapters.slack) { ... }` conditional
 * chain inside `buildChatPlugin`. Reads the chat-type subset of the
 * operator-declared `plugin_catalog`, looks up per-Platform credentials
 * from `process.env`, and returns the set of adapter instances the chat
 * plugin should activate at boot.
 *
 * In milestone 1.5.2, only `install_model === "oauth"` adapters
 * instantiate. The non-Slack chat Platforms (Teams, Discord, gchat,
 * Telegram, WhatsApp) ship as catalog placeholders with
 * `install_model === "static-bot"` and `enabled === false` — visible to
 * ops, not customer-installable, and never instantiated here. Their
 * install handlers land in 1.5.3.
 *
 * Pure-ish: takes the catalog entry list + an env reader as input,
 * returns the adapter set. Side effects are limited to (a) constructing
 * the platform adapter and (b) writing one log line per registered /
 * skipped slug. The construction side effect is unavoidable — the
 * upstream `@chat-adapter/<platform>` factories return live objects, not
 * builders.
 */

import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackAdapter } from "./adapters/slack";
import type { ChatAdapterName, SlackAdapterConfig } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Catalog entry shape the registry consumes. Mirrors the chat-relevant
 * subset of `CatalogEntry` from `@atlas/api/lib/config`, but the chat
 * plugin can't import `@atlas/api` (frontend-side rule from CLAUDE.md
 * + `@useatlas/chat` is the plugin namespace, separate from `@atlas/api`).
 * So we redeclare the structural shape here.
 *
 * The shape is `Readonly` everywhere so the catalog list — typically
 * passed straight from `ResolvedConfig.catalog` — can't be mutated by
 * accident from within the plugin.
 */
export interface ChatCatalogEntry {
  readonly slug: string;
  readonly type: "chat" | "integration";
  readonly install_model: "oauth" | "form" | "static-bot";
  readonly enabled: boolean;
  readonly saas_eligible: boolean;
}

/**
 * Map of platform slug → instantiated adapter. Slug-keyed `Partial`
 * `Record` so future adapters (1.5.3 static-bot platforms) extend by
 * adding map entries — no shape change to the type, no consumer
 * rewrites. Today only `slack` is populated; the other keys are
 * structurally allowed but never set.
 */
export type ChatAdapterSet = Partial<{
  readonly [K in ChatAdapterName]: ChatAdapterInstance<K>;
}>;

/**
 * Per-slug adapter instance type. Only Slack has a concrete type in
 * 1.5.2 — the other slugs map to a structural placeholder so the
 * `Partial<Record>` shape compiles without forcing every adapter class
 * to exist today. 1.5.3 narrows each placeholder to its real class.
 */
type ChatAdapterInstance<K extends ChatAdapterName> = K extends "slack"
  ? SlackAdapter
  : { readonly name: K };

/**
 * Returned alongside `ChatAdapterSet` so `healthCheck` and admin
 * banners can distinguish "no adapters wired (operator misconfig)" from
 * "no chat-type entries in catalog" — both produce an empty
 * `ChatAdapterSet` today, but the cause + fix differ.
 */
export interface ChatAdapterDiagnostics {
  /** Slugs the catalog declared as oauth+enabled but for which Atlas ships no builder (operator typo). */
  readonly unrecognizedSlugs: ReadonlyArray<string>;
  /** Slugs the catalog declared as oauth+enabled whose required env vars are missing. */
  readonly missingCredSlugs: ReadonlyArray<string>;
}

export interface ChatAdapterRegistration {
  readonly adapters: ChatAdapterSet;
  readonly diagnostics: ChatAdapterDiagnostics;
}

/**
 * Per-slug env-var presence check + adapter factory. One shape so the
 * dispatch loop is uniform. Each factory returns `null` when its
 * required env vars are missing (the registry logs the omission and
 * continues to the next slug).
 */
interface ChatAdapterBuilder<Adapter> {
  readonly slug: string;
  readonly platform: string;
  /** Required env-var names — used in the missing-creds log line. */
  readonly requiredEnv: ReadonlyArray<string>;
  /** Construct the adapter, or return `null` if any required env var is unset. */
  readonly build: (env: NodeJS.ProcessEnv) => Adapter | null;
}

// ---------------------------------------------------------------------------
// Per-platform builders
// ---------------------------------------------------------------------------

/**
 * Slack — the only OAuth chat Platform that instantiates in 1.5.2.
 *
 * Required env vars (all four must be present):
 *   - SLACK_CLIENT_ID, SLACK_CLIENT_SECRET — App Registration OAuth credentials
 *   - SLACK_SIGNING_SECRET — webhook signature verification
 *   - SLACK_ENCRYPTION_KEY — AES-256-GCM key for bot-token storage in
 *     `chat_cache` (post-#2634 consolidation)
 *
 * Multi-workspace deploys (SaaS) MUST omit `botToken` — when present it
 * pins the adapter to a single workspace. SLACK_BOT_TOKEN being set is
 * NOT a registry requirement.
 */
const SLACK_BUILDER: ChatAdapterBuilder<SlackAdapter> = {
  slug: "slack",
  platform: "slack",
  requiredEnv: [
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_ENCRYPTION_KEY",
  ],
  build(env) {
    const clientId = env.SLACK_CLIENT_ID;
    const clientSecret = env.SLACK_CLIENT_SECRET;
    const signingSecret = env.SLACK_SIGNING_SECRET;
    const encryptionKey = env.SLACK_ENCRYPTION_KEY;
    if (!clientId || !clientSecret || !signingSecret || !encryptionKey) {
      return null;
    }
    const config: SlackAdapterConfig = {
      clientId,
      clientSecret,
      signingSecret,
      encryptionKey,
      ...(env.SLACK_BOT_TOKEN ? { botToken: env.SLACK_BOT_TOKEN } : {}),
    };
    return createSlackAdapter(config) as SlackAdapter;
  },
};

const BUILDERS_BY_SLUG: Readonly<Record<string, ChatAdapterBuilder<unknown>>> = {
  slack: SLACK_BUILDER,
};

/**
 * Look up the per-slug `requiredEnv` list. Core (`@atlas/api`) calls
 * this from `ChatAdapterEnvGuardLive` (#2672) so the SaaS boot guard
 * can assert that every env var the builder needs is present without
 * redeclaring the list (single source of truth — the builder map above
 * is the only place `requiredEnv` is authored).
 *
 * Returns `null` for unknown slugs. The guard treats that the same as
 * the registry's `unrecognizedSlugs` diagnostic: a catalog row for a
 * Platform Atlas doesn't ship code for is an operator typo, not a
 * missing-env failure.
 */
export function getChatAdapterRequiredEnv(slug: string): ReadonlyArray<string> | null {
  const builder = BUILDERS_BY_SLUG[slug];
  return builder ? builder.requiredEnv : null;
}

// ---------------------------------------------------------------------------
// Logger contract
// ---------------------------------------------------------------------------

/**
 * Structural log interface — matches the `PluginLogger` shape exported
 * by `@useatlas/plugin-sdk` without taking a hard import dependency.
 * Keeps the registry callable from tests without spinning up the SDK.
 */
export interface RegistryLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
  debug?(payload: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Build the registry
// ---------------------------------------------------------------------------

export interface BuildAdapterRegistryArgs {
  /** Catalog entries the host has declared. The registry filters by `type === "chat"`. */
  readonly catalog: ReadonlyArray<ChatCatalogEntry>;
  /** Env source — typically `process.env`; injectable for tests. */
  readonly env: NodeJS.ProcessEnv;
  /** Logger; falls back to `console`-shaped no-op when omitted. */
  readonly logger?: RegistryLogger;
}

/**
 * Build the chat adapter set from a catalog declaration + env. Slack is
 * the only adapter that can be activated in 1.5.2 — other slugs are
 * skipped with a `debug` log so ops can confirm the entry was seen but
 * intentionally not wired.
 *
 * Filter chain per slug:
 *
 *   1. `type === "chat"` — integration slugs (Salesforce, Email, …)
 *      are handled by the LazyPluginLoader path in slice 3, not here.
 *   2. `install_model === "oauth"` — form / static-bot install models
 *      don't instantiate an event-loop adapter at boot. Static-bot
 *      adapters land in 1.5.3.
 *   3. `enabled === true` — operator (or DB-side ops disable) can flip
 *      a row off without removing it from the catalog.
 *   4. Builder exists for the slug — a catalog entry for a chat Platform
 *      Atlas doesn't ship code for is a `warn` (operator typo or
 *      cross-version catalog row).
 *   5. All required env vars present — missing creds is a `warn` so the
 *      operator can fix env wiring without reading source.
 */
export function buildChatAdapterRegistry(
  args: BuildAdapterRegistryArgs,
): ChatAdapterRegistration {
  const logger: RegistryLogger = args.logger ?? createNoopLogger();
  const adapters: { -readonly [K in ChatAdapterName]?: ChatAdapterInstance<K> } = {};
  const unrecognizedSlugs: string[] = [];
  const missingCredSlugs: string[] = [];

  for (const entry of args.catalog) {
    if (entry.type !== "chat") continue;

    if (entry.install_model !== "oauth") {
      logger.debug?.(
        { slug: entry.slug, installModel: entry.install_model },
        "AdapterRegistry: catalog entry skipped — non-OAuth install model has no event-loop adapter to instantiate",
      );
      continue;
    }

    if (!entry.enabled) {
      logger.debug?.(
        { slug: entry.slug },
        "AdapterRegistry: catalog entry skipped — enabled=false",
      );
      continue;
    }

    const builder = BUILDERS_BY_SLUG[entry.slug];
    if (!builder) {
      unrecognizedSlugs.push(entry.slug);
      logger.warn(
        { slug: entry.slug },
        "AdapterRegistry: catalog entry for unknown chat Platform slug — no builder registered (operator typo or cross-version drift)",
      );
      continue;
    }

    const adapter = builder.build(args.env);
    if (!adapter) {
      missingCredSlugs.push(entry.slug);
      // `error`, not `warn` — the entry-disabled branch above already
      // short-circuits, so reaching here means the operator opted the
      // Platform in and the env vars are missing. On a SaaS deploy this
      // is always a critical misconfig; on self-hosted it surfaces the
      // same way (operator declared enabled=true and meant it). See
      // #2673 for the 2026-05-20 silent-degradation incident.
      logger.error(
        {
          slug: entry.slug,
          platform: builder.platform,
          requiredEnv: builder.requiredEnv,
        },
        "AdapterRegistry: required env vars missing — adapter not instantiated",
      );
      continue;
    }

    if (entry.slug === "slack") {
      adapters.slack = adapter as SlackAdapter;
      logger.info(
        { slug: entry.slug, platform: builder.platform },
        "AdapterRegistry: chat adapter registered",
      );
    }
    // No other adapters wire today — the builder map has only `slack`.
    // 1.5.3 work adds map entries for the static-bot platforms; the
    // `Partial<Record>` shape of `ChatAdapterSet` admits them without
    // a type change here.
  }

  return {
    adapters,
    diagnostics: { unrecognizedSlugs, missingCredSlugs },
  };
}

function createNoopLogger(): RegistryLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/**
 * True when the catalog declared an instantiable adapter we couldn't
 * wire — missing env vars or unknown slug. Both are SaaS-deploy bugs:
 * the operator opted the Platform in, but the adapter isn't there.
 *
 * Empty adapters with empty diagnostics is fine (intentionally-empty
 * catalog, or only non-OAuth / disabled entries declared); that path
 * stays at `info`. This predicate gates the post-init log severity so
 * a silently-degraded SaaS deploy surfaces as an error in operator
 * log streams instead of blending into routine boot info noise.
 *
 * See #2673 — 2026-05-20 incident where a dropped `SLACK_ENCRYPTION_KEY`
 * left `adapters=[]` for ~22h and the warn/info lines were missed.
 */
export function hasInstantiationFailure(d: ChatAdapterDiagnostics): boolean {
  return d.missingCredSlugs.length > 0 || d.unrecognizedSlugs.length > 0;
}
