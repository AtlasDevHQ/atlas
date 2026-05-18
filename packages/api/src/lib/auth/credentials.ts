/**
 * Workspace credential types — promoted to core in #2565 so the
 * `ModelRouter` Tag in `lib/effect/services.ts`, the AI Layer in
 * `lib/effect/ai.ts`, and the provider factory in `lib/providers.ts`
 * can type the `credentials` field without importing the type from
 * `@atlas/ee/platform/model-routing`.
 *
 * EE's `ee/src/platform/model-routing.ts` re-exports both types for
 * back-compat. The shapes are wire-compatible; no consumer needs to
 * change anything other than the import path.
 */

import type { BedrockCredentialBundle, ModelConfigProvider } from "@useatlas/types";

/**
 * Discriminated union over the typed credential material a workspace
 * row carries after `api_key_encrypted` is decrypted. Internal to the
 * BYOT boundary — never appears on the wire.
 *
 * The bedrock arm's `bundle` is nullable so the post-decrypt JSON
 * shape failure travels as data rather than as a thrown error —
 * distinct from a true crypto failure (`ModelConfigDecryptError`),
 * which the row mapper raises before this union is ever constructed.
 */
export type WorkspaceCredentials =
  | { provider: "bedrock"; bundle: BedrockCredentialBundle | null }
  | {
      provider: Exclude<ModelConfigProvider, "bedrock" | "gateway">;
      apiKey: string;
    }
  | { provider: "gateway"; apiKey: string | null };

/**
 * Decrypted workspace model configuration. Returned by the
 * `ModelRouter.getWorkspaceModelConfigRaw` accessor for the AI Layer
 * + admin route layer.
 *
 * Consumers switch on `credentials.provider` and read the matching
 * field; the wire shape of `WorkspaceModelConfig` is unchanged (it
 * carries a masked `apiKeyMasked` + `apiKeyStatus`).
 */
export interface RawWorkspaceModelConfig {
  readonly provider: ModelConfigProvider;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly bedrockRegion: string | null;
  readonly credentials: WorkspaceCredentials;
}
