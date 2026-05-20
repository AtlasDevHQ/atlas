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
  _resetInstallHandlerRegistries,
} from "./dispatch";

export { staticBotInstallHandlerStub } from "./static-bot-stub";
