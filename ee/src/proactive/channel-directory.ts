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
import type {
  ChannelDirectoryChannel,
  ChannelDirectoryResult,
  ChannelDirectoryProvider,
} from "@atlas/api/lib/proactive/types";

// The port + result types are CORE-resident
// (`@atlas/api/lib/proactive/types`) so the Slack adapter
// (`lib/slack/channel-directory-provider.ts`) and the admin route can
// reference them without importing `@atlas/ee` (#3999). Re-exported here
// so co-located tests + the EE service keep importing them from the
// module that owns the runtime.
export type {
  ChannelDirectoryChannel,
  ChannelDirectoryFailureReason,
  ChannelDirectoryResult,
  ChannelDirectoryProvider,
} from "@atlas/api/lib/proactive/types";

const log = createLogger("proactive-channel-directory");

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
