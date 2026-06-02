import { parseAsString } from "nuqs";

/**
 * URL state for the chat surface (`AtlasChat`). The active conversation id is
 * reflected in `?id=` so a reload / deep-link reopens it (#3068). `?prompt=`
 * prefills the composer — the hosted `WorkspaceShell` delivers a query through
 * it (`deliverPrompt`) from the prompt library / schema explorer, and /wizard +
 * /signup/success starters use it too. (Was `app/(workspace)/search-params.ts`,
 * retired now that `AtlasChat` is the single web chat.)
 */
export const chatSearchParams = {
  id: parseAsString.withDefault(""),
  prompt: parseAsString.withDefault(""),
};

/**
 * What the URL-driven open effect should do for the current `?id=` value.
 *
 *  - `open`  — load the named conversation (messages + scope restore, #3065).
 *              `id` is always a non-empty id (emitted only past the `!urlId` guard).
 *  - `clear` — the URL has no id but one is loaded (e.g. back-nav to the empty
 *              chat) → reset to a fresh chat.
 *  - `noop`  — nothing to do: inputs not ready, already bound, or still waiting
 *              for the connection groups a scope restore must validate against.
 */
export type ConversationUrlAction =
  | { readonly kind: "open"; readonly id: string }
  | { readonly kind: "clear" }
  | { readonly kind: "noop" };

export interface ConversationUrlInput {
  /** The conversation id in the URL (`?id=`), or "" when absent. */
  readonly urlId: string;
  /** The conversation the UI is currently bound to / loading, or null for a fresh chat. */
  readonly loadedId: string | null;
  /**
   * Auth is fully settled: the mode is detected AND, for managed auth, the
   * session has resolved. `isSignedIn` is only final once this is true — gating
   * on a mere "mode detected" would, during the managed-session-pending window,
   * read `isSignedIn` as false and wrongly take the self-hosted carve-out below.
   */
  readonly authSettled: boolean;
  /** Mirrors the connection-groups query `enabled` predicate (managed auth + a signed-in user). */
  readonly isSignedIn: boolean;
  /** The connection-groups fetch has settled. Only meaningful when `isSignedIn`. */
  readonly envGroupsHasLoaded: boolean;
}

/**
 * Pure decision behind `AtlasChat`'s URL-driven conversation-open effect.
 * Extracted (and unit-tested) like the env-picker resolvers so the gating
 * logic — especially the self-hosted carve-out below — can't silently rot.
 */
export function resolveConversationUrlAction(
  input: ConversationUrlInput,
): ConversationUrlAction {
  const { urlId, loadedId, authSettled, isSignedIn, envGroupsHasLoaded } = input;

  // Until auth is fully settled, `isSignedIn` isn't final — wait, so a managed
  // user mid-session-load isn't misread as self-hosted (which would skip the
  // wait-for-groups gate and restore scope against an empty group set).
  if (!authSettled) return { kind: "noop" };

  // No conversation in the URL: reset to a fresh chat if one was loaded
  // (e.g. back-nav to the empty state); otherwise there's nothing to do.
  if (!urlId) return loadedId !== null ? { kind: "clear" } : { kind: "noop" };

  // Already bound to this conversation (or a load for it is in flight).
  if (urlId === loadedId) return { kind: "noop" };

  // Opening restores the conversation's scope (#3065), which must validate
  // against the real connection groups. Wait for the groups fetch to settle —
  // but only when we'd actually fetch them. Self-hosted / simple-key never
  // fetches groups (the query is disabled when not signed in), so its
  // `envGroupsHasLoaded` never flips; gating on it there would strand the deep
  // link forever.
  if (isSignedIn && !envGroupsHasLoaded) return { kind: "noop" };

  return { kind: "open", id: urlId };
}
