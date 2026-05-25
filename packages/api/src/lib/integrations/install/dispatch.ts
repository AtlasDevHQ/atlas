/**
 * Install-handler dispatch — slice 4 of #2649 (issue #2652).
 *
 * `getInstallHandler(catalogRow)` switches on `catalog.install_model`
 * and returns the matching handler. Three branches today (`oauth` /
 * `form` / `static-bot`); the exhaustive `never` check at the default
 * branch turns a future fourth `install_model` value (e.g. `"manifest"`)
 * into a compile error here, before any runtime drift.
 *
 * Handler registration is per-Platform across all three branches:
 *
 *   `oauth`, `form`, and `static-bot` handlers are looked up by the
 *   catalog row's slug in three small in-module registries. Each
 *   Platform's handler file calls {@link registerOAuthHandler} /
 *   {@link registerFormHandler} / {@link registerStaticBotHandler} at
 *   module-load time. The registries are intentionally **empty** until
 *   something imports the handler module — calling `getInstallHandler`
 *   on a slug with no registered handler throws "no handler registered",
 *   which is the correct fail-loud signal for an operator who enabled a
 *   catalog row whose handler env wiring is missing.
 *
 *   Pre-1.5.3 (#2748), `static-bot` returned a single operator-shared
 *   stub that threw on every call. The stub was the pin that kept the
 *   dispatch table covering all three branches before any real handler
 *   shipped. Now Telegram (the 1.5.3 keystone) registers a real handler
 *   via {@link registerStaticBotHandler}, and the dispatch matches the
 *   oauth/form pattern — per-slug lookup, throw on missing.
 */

import type {
  CatalogRowForDispatch,
  FormBasedInstallHandler,
  OAuthPlatformInstallHandler,
  PlatformInstallHandler,
  StaticBotInstallHandler,
} from "./types";

// ---------------------------------------------------------------------------
// Per-slug registries
// ---------------------------------------------------------------------------

const oauthHandlers = new Map<string, OAuthPlatformInstallHandler>();
const formHandlers = new Map<string, FormBasedInstallHandler>();
const staticBotHandlers = new Map<string, StaticBotInstallHandler>();

/**
 * Register an OAuth install handler for a given catalog slug. Idempotent
 * — re-registering the same slug overwrites the previous entry (helpful
 * in tests that swap a real handler for a mock). Production code calls
 * this once at module load.
 */
export function registerOAuthHandler(
  slug: string,
  handler: OAuthPlatformInstallHandler,
): void {
  oauthHandlers.set(slug, handler);
}

/**
 * Register a form-based install handler for a given catalog slug.
 * See {@link registerOAuthHandler} for the idempotency contract.
 */
export function registerFormHandler(
  slug: string,
  handler: FormBasedInstallHandler,
): void {
  formHandlers.set(slug, handler);
}

/**
 * Register a static-bot install handler for a given catalog slug.
 * Telegram is the first consumer (#2748); Discord (#2749), gchat
 * (#2754), and WhatsApp (#2753) reuse the same registry.
 *
 * Distinct from oauth/form: the bot itself is operator-shared (one app
 * registration per Platform), but each Workspace's routing identifier
 * (Telegram `chat_id`, Discord `guild_id`, etc.) still needs per-
 * Workspace persistence. The handler owns that write.
 */
export function registerStaticBotHandler(
  slug: string,
  handler: StaticBotInstallHandler,
): void {
  staticBotHandlers.set(slug, handler);
}

/** @internal Test-only — clears all three registries between tests. */
export function _resetInstallHandlerRegistries(): void {
  oauthHandlers.clear();
  formHandlers.clear();
  staticBotHandlers.clear();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve the install handler for a catalog row. Throws when no handler
 * is registered for the slug — that's a config drift: the catalog
 * declares an install model that no implementation supports yet, and
 * silently returning a no-op handler would let install start pages
 * render without a working backend.
 *
 * The default branch is a compile-time exhaustiveness gate via the
 * unused `_exhaustive: never` binding — adding a new `install_model`
 * value to {@link CatalogInstallModel} surfaces here as a TS error
 * before any runtime drift.
 */
export function getInstallHandler(
  catalogRow: CatalogRowForDispatch,
): PlatformInstallHandler {
  switch (catalogRow.install_model) {
    case "oauth": {
      const handler = oauthHandlers.get(catalogRow.slug);
      if (!handler) {
        throw new Error(
          `No OAuth install handler registered for catalog slug "${catalogRow.slug}". Register via registerOAuthHandler() at module load.`,
        );
      }
      return handler;
    }
    case "form": {
      const handler = formHandlers.get(catalogRow.slug);
      if (!handler) {
        throw new Error(
          `No form-based install handler registered for catalog slug "${catalogRow.slug}". Register via registerFormHandler() at module load.`,
        );
      }
      return handler;
    }
    case "static-bot": {
      const handler = staticBotHandlers.get(catalogRow.slug);
      if (!handler) {
        throw new Error(
          `No static-bot install handler registered for catalog slug "${catalogRow.slug}". Register via registerStaticBotHandler() at module load (set the operator env vars the handler needs — TELEGRAM_BOT_TOKEN for telegram; DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID for discord; TEAMS_APP_ID + TEAMS_APP_PASSWORD for teams; META_BUSINESS_ACCESS_TOKEN + META_BUSINESS_APP_ID for whatsapp).`,
        );
      }
      return handler;
    }
    default: {
      const _exhaustive: never = catalogRow.install_model;
      throw new Error(
        `Unknown install_model "${String(_exhaustive)}" — add a case to getInstallHandler when introducing a new install model`,
      );
    }
  }
}

// Re-export the handler shape for callers that want to narrow the
// dispatch result without going through `./types` directly.
export type {
  OAuthPlatformInstallHandler,
  FormBasedInstallHandler,
  StaticBotInstallHandler,
  PlatformInstallHandler,
};
