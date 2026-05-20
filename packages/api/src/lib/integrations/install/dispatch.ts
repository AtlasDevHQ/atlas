/**
 * Install-handler dispatch — slice 4 of #2649 (issue #2652).
 *
 * `getInstallHandler(catalogRow)` switches on `catalog.install_model`
 * and returns the matching handler. Three branches today (`oauth` /
 * `form` / `static-bot`); the exhaustive `never` check at the default
 * branch turns a future fourth `install_model` value (e.g. `"manifest"`)
 * into a compile error here, before any runtime drift.
 *
 * Handler registration (per-Platform):
 *
 *   `oauth` and `form` handlers are looked up by the catalog row's
 *   slug in two small in-module registries. Each Platform's handler
 *   file calls {@link registerOAuthHandler} / {@link registerFormHandler}
 *   at module-load time (slice 5 registers Slack; #2660 registers
 *   form-based Email/Webhook/Obsidian; etc.). The registries are
 *   intentionally **empty** in 1.5.2 — calling `getInstallHandler` on
 *   a `slack` catalog row today throws "no handler registered" because
 *   slice 5 hasn't landed yet. That's the correct failure mode: the
 *   dispatch shape is pinned, the implementations slot in cleanly.
 *
 *   For `static-bot`, the dispatch always returns the stub from
 *   {@link staticBotInstallHandlerStub} — there is no per-slug registry
 *   because the bot is operator-shared (one handler per Platform suffices,
 *   not per Workspace install). Slice 5/6 may replace the single stub
 *   with the real handler; until then, calling its methods throws.
 */

import type {
  CatalogRowForDispatch,
  FormBasedInstallHandler,
  OAuthPlatformInstallHandler,
  PlatformInstallHandler,
  StaticBotInstallHandler,
} from "./types";
import { staticBotInstallHandlerStub } from "./static-bot-stub";

// ---------------------------------------------------------------------------
// Per-slug registries
// ---------------------------------------------------------------------------

const oauthHandlers = new Map<string, OAuthPlatformInstallHandler>();
const formHandlers = new Map<string, FormBasedInstallHandler>();

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

/** @internal Test-only — clears both registries between tests. */
export function _resetInstallHandlerRegistries(): void {
  oauthHandlers.clear();
  formHandlers.clear();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve the install handler for a catalog row. Throws when no handler
 * is registered for an `oauth` / `form` slug — that's a config drift:
 * the catalog declares an install model that no implementation supports
 * yet, and silently returning a no-op handler would let install start
 * pages render without a working backend.
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
    case "static-bot":
      return staticBotInstallHandlerStub;
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
