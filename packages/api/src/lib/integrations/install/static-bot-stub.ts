/**
 * `StaticBotInstallHandler` stub — pinned in 1.5.2 so the dispatch
 * table covers all three `install_model` branches today, but the real
 * handler doesn't land until 1.5.3 (milestone #51).
 *
 * Calling `confirmInstall` throws an actionable error rather than
 * silently failing or returning a fake record — a half-installed
 * static-bot row would mislead the admin UI and the AdapterRegistry
 * into a broken routing state. The throw is the documentation: don't
 * register this catalog row's `enabled = true` until the 1.5.3 handler
 * lands.
 */

import type { StaticBotInstallHandler } from "./types";

class StaticBotInstallHandlerStub implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

  async confirmInstall(): Promise<never> {
    throw new Error(
      "StaticBotInstallHandler not implemented until 1.5.3 — see milestone #51",
    );
  }
}

export const staticBotInstallHandlerStub: StaticBotInstallHandler =
  new StaticBotInstallHandlerStub();
