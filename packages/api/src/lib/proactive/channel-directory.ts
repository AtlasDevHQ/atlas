/**
 * Channel-directory port for proactive-chat admin surfaces (#3463).
 *
 * The admin route that backs the channel picker
 * (`GET /api/v1/admin/proactive/channels/available`) needs "which
 * channels exist in this workspace's chat platform?" — a question the
 * proactive subsystem itself is agnostic about (it runs over
 * `@chat-adapter/*` and already supports non-Slack platforms). This
 * module is the seam that keeps the route platform-neutral: the host
 * resolves the workspace's installed chat platform through a registered
 * {@link ChannelDirectoryProvider} instead of importing `lib/slack`
 * directly.
 *
 * Registry shape mirrors `announcer-registry.ts` (process-local
 * singleton, register/clear/get): a chat plugin or platform module
 * registers a provider; the host reads it. Unlike the announcer's NULL
 * fallback, the default provider here is the host's built-in Slack
 * implementation (`lib/slack/channel-directory-provider.ts`) — Slack is
 * the platform the host ships first-party, and the provider itself
 * degrades to `no_chat_installation` when the workspace has no Slack
 * install, so the fallback is safe on every deploy shape.
 *
 * Caching (#3461): `conversations.list` is Tier-2 rate-limited
 * (~20/min/token) and one uncached page load can cost up to 5 paginated
 * calls, so {@link listWorkspaceChannels} wraps the provider in a
 * short-TTL in-memory cache keyed on workspace id. Successful listings
 * only — a failure (rate limit, missing scope) is never cached, so the
 * picker recovers as soon as the platform does. Per-workspace keying
 * means no cross-tenant leakage; in-memory is fine because the listing
 * is best-effort UX data (a cold replica just pays one extra listing).
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("proactive-channel-directory");

/**
 * One channel row, platform-neutral. Field semantics match the wire
 * schema on `GET /admin/proactive/channels/available`: `isMember` is
 * whether the bot can actually act in the channel (an override on a
 * non-member channel never fires, so pickers warn on it).
 */
export interface ChannelDirectoryChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/**
 * Platform-neutral failure classes, mirrored 1:1 onto the wire `reason`
 * enum (the route serialises these verbatim — keep them OAuth-generic):
 *
 * - `no_chat_installation` — the workspace has no chat-platform install
 *   (or its credential is unreadable); nothing to list.
 * - `missing_scope` — the platform credential lacks the read scope the
 *   listing needs even for its most-degraded retry (#3462/#3466). The
 *   fix is a re-consent on the platform's OAuth flow, so admin UIs
 *   surface a reconnect CTA for this reason specifically.
 * - `platform_error` — any other platform-side failure (rate limit,
 *   revoked token, network). Transient; UIs soft-degrade to manual
 *   channel-id entry.
 */
export type ChannelDirectoryFailureReason =
  | "no_chat_installation"
  | "missing_scope"
  | "platform_error";

export type ChannelDirectoryResult =
  | { ok: true; channels: ChannelDirectoryChannel[] }
  | {
      ok: false;
      reason: ChannelDirectoryFailureReason;
      /** Raw platform error for logs. Never serialised onto the wire. */
      detail?: string;
    };

export interface ChannelDirectoryProvider {
  listWorkspaceChannels(workspaceId: string): Promise<ChannelDirectoryResult>;
}

/**
 * Single provider slot for now: Slack is the only platform with a
 * proactive admin surface, so "the workspace's chat platform" and "the
 * registered provider" coincide. When a second platform's proactive
 * support lands, this becomes a per-platform map keyed off the
 * workspace's installed chat plugin (`workspace_plugins`, pillar
 * `chat`) — the route stays unchanged either way because it only calls
 * {@link listWorkspaceChannels}.
 */
let registered: ChannelDirectoryProvider | null = null;

export function registerChannelDirectoryProvider(provider: ChannelDirectoryProvider): void {
  registered = provider;
}

export function clearChannelDirectoryProvider(): void {
  registered = null;
}

let slackProviderImport: Promise<ChannelDirectoryProvider> | null = null;

/**
 * Returns the registered provider, falling back to the built-in Slack
 * implementation. The import is lazy (inside the function) so loading
 * this module never drags `lib/slack` in for consumers that register
 * their own provider — and so the module pair (`channel-directory` ↔
 * `slack/channel-directory-provider`) avoids a value-level import
 * cycle. The import promise is memoized; the runtime caches the module
 * anyway, but this skips re-walking the import machinery per request.
 */
async function resolveProvider(): Promise<ChannelDirectoryProvider> {
  if (registered) return registered;
  slackProviderImport ??= import(
    "@atlas/api/lib/slack/channel-directory-provider"
  ).then((m) => m.slackChannelDirectoryProvider);
  return slackProviderImport;
}

// ---------------------------------------------------------------------------
// Short-TTL cache (#3461)
// ---------------------------------------------------------------------------

/**
 * 45s sits inside the issue's 30–60s window: long enough that several
 * admins tuning overrides concurrently cost one listing per workspace,
 * short enough that a freshly created channel shows up on the next
 * natural refresh.
 */
export const CHANNEL_DIRECTORY_CACHE_TTL_MS = 45_000;

/**
 * Insertion-ordered bound. Entries expire by TTL anyway; the cap only
 * matters if a burst of distinct workspaces lists channels inside one
 * TTL window, and evicting the oldest insertion is the right call there.
 */
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  expiresAt: number;
  channels: ChannelDirectoryChannel[];
}

const cache = new Map<string, CacheEntry>();

/**
 * In-flight dedup: N concurrent cold-cache requests for one workspace
 * (several admins opening the page at once — the motivating scenario
 * for the cache) share one provider call instead of fanning out N
 * platform listings before any of them populates the cache.
 */
const inFlight = new Map<string, Promise<ChannelDirectoryResult>>();

/** Test hook — route/unit tests reset between cases. */
export function clearChannelDirectoryCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * List the workspace's chat-platform channels through the registered
 * provider, with the short-TTL success cache described above.
 *
 * `now` is injectable for the cache-expiry unit tests only.
 */
export async function listWorkspaceChannels(
  workspaceId: string,
  opts?: { now?: () => number },
): Promise<ChannelDirectoryResult> {
  const now = opts?.now ?? Date.now;

  const hit = cache.get(workspaceId);
  if (hit) {
    if (hit.expiresAt > now()) {
      // Fresh copy per caller — a returned array that aliased the cache
      // entry would let one consumer's in-place mutation corrupt every
      // later hit (channel objects stay shared; they're plain data).
      return { ok: true, channels: [...hit.channels] };
    }
    cache.delete(workspaceId);
  }

  const pending = inFlight.get(workspaceId);
  if (pending) return pending;

  const fetchPromise = (async (): Promise<ChannelDirectoryResult> => {
    const provider = await resolveProvider();
    const result = await provider.listWorkspaceChannels(workspaceId);

    if (result.ok) {
      if (cache.size >= CACHE_MAX_ENTRIES) {
        // Map iterates in insertion order — drop the oldest entry.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(workspaceId, {
        expiresAt: now() + CHANNEL_DIRECTORY_CACHE_TTL_MS,
        // Copy on store too, so the cache owns its array even if a
        // provider hands back a reused buffer.
        channels: [...result.channels],
      });
    } else {
      // Failures are intentionally not cached — see module doc. Log here
      // (not just at the route) so scheduler/CLI consumers added later
      // don't silently lose the platform detail.
      log.warn(
        { workspaceId, reason: result.reason, detail: result.detail },
        "Channel-directory listing failed",
      );
    }

    return result;
  })();

  inFlight.set(workspaceId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlight.delete(workspaceId);
  }
}
