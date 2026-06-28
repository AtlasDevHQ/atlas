/**
 * Process-local registry for the proactive-chat `ChatAnnouncer` port.
 *
 * Why a singleton: the chat plugin runs in the same node process as the
 * Atlas API; the plugin's bridge holds the adapter instances needed to
 * `postChannelMessage`. The admin route that triggers the activation
 * announcement is on the host side of the plugin boundary and has no
 * direct handle to the bridge. The two ends agree on this module:
 *
 *   - chat plugin → calls `registerChatAnnouncer(impl)` after the bridge
 *     finishes initializing (slice #2300 wires this up).
 *   - admin route → calls `getChatAnnouncer()` and falls back to
 *     `NULL_ANNOUNCER` when no plugin has registered (self-hosted
 *     deployments without the chat plugin still must not 500).
 *
 * Lifecycle:
 *   - Single-process; no SaaS-multi-region cross-instance concerns
 *     because the announcement is best-effort per-instance and the DB
 *     stamp dedupes any double-fire (#announceActivation).
 *   - Plugin teardown calls `clearChatAnnouncer()` so a re-initialize
 *     during dev hot-reload doesn't leak the old bridge reference.
 */

import type { ChatAnnouncer } from "./announcement-coordinator";
import { NULL_ANNOUNCER } from "./announcement-coordinator";

let registered: ChatAnnouncer | null = null;

export function registerChatAnnouncer(announcer: ChatAnnouncer): void {
  registered = announcer;
}

export function clearChatAnnouncer(): void {
  registered = null;
}

/**
 * Returns the registered chat announcer or the NULL_ANNOUNCER fallback.
 *
 * Callers never need to null-check — the fallback returns
 * `{ ok: false, reason: "no_announcer_configured" }` which the
 * coordinator treats as a clean "skip, don't stamp" outcome.
 */
export function getChatAnnouncer(): ChatAnnouncer {
  return registered ?? NULL_ANNOUNCER;
}
