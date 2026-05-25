/**
 * Barrel for the Platform install module — slice 4 of #2649 (issue #2652).
 *
 * Consumers should import from this module, not from individual files,
 * so the surface stays observable in code review and the internal layout
 * (registries, stub placement) can evolve without churn at call sites.
 */

export {
  mintOAuthStateToken,
  verifyOAuthStateToken,
  type MintOptions,
  type VerifiedState,
} from "./oauth-state-token";

export type {
  CatalogId,
  CatalogRowForDispatch,
  CredentialResult,
  FormBasedInstallHandler,
  InstallRecord,
  OAuthPlatformInstallHandler,
  PlatformInstallHandler,
  StaticBotInstallHandler,
} from "./types";

export {
  getInstallHandler,
  registerFormHandler,
  registerOAuthHandler,
  registerStaticBotHandler,
  _resetInstallHandlerRegistries,
} from "./dispatch";

export {
  WorkspaceInstallGate,
  isWorkspaceInstallActive,
  createInstallGateCache,
  type WorkspaceInstallGateFn,
} from "./workspace-install-gate";

// Per-Platform OAuth handler implementations + their module-load
// registration. Importing the barrel does NOT auto-register — boot
// calls `registerBuiltinInstallHandlers()` explicitly so tests can
// opt in selectively without the handler swallowing test env vars.
export { SlackOAuthInstallHandler } from "./slack-oauth-handler";
export type { SlackOAuthHandlerConfig } from "./slack-oauth-handler";
export {
  TelegramStaticBotInstallHandler,
  TELEGRAM_CATALOG_ID,
  TELEGRAM_SLUG,
} from "./telegram-static-bot-handler";
export type {
  TelegramStaticBotHandlerConfig,
  TelegramInstallConfig,
} from "./telegram-static-bot-handler";
export {
  DiscordStaticBotInstallHandler,
  DISCORD_CATALOG_ID,
  DISCORD_SLUG,
} from "./discord-static-bot-handler";
export type {
  DiscordStaticBotHandlerConfig,
  DiscordInstallConfig,
} from "./discord-static-bot-handler";
export {
  EmailFormInstallHandler,
  EmailFormDataSchema,
  EmailFormValidationError,
  FormInstallValidationError,
  type EmailFormData,
  type EmailFormInstallHandlerOptions,
} from "./email-form-handler";
export {
  registerBuiltinInstallHandlers,
  _resetRegistrationLatch,
} from "./register";
