/**
 * Per-event workspace + channel config loaders for the proactive
 * listener (#2620).
 *
 * The chat plugin's `registerProactiveListener` calls these once per
 * event (after `resolveWorkspaceId` succeeds) so the master toggle /
 * sensitivity / classifier mode / per-channel allow-list reflect the
 * current admin state without a process restart.
 *
 * Pre-#2620 the plugin baked a static `workspace` + `channelConfigs`
 * object at registration time; SaaS routes Slack events from N tenants
 * through one Chat instance, so a baked-in config silently served the
 * wrong tenant. The fix lifts both into per-event fetchers; this module
 * is the host-side implementation backed by `workspace_proactive_config`
 * + `channel_proactive_config` (migration `0075_proactive_chat_config.sql`).
 *
 * Contract (from `plugins/chat/src/proactive/types.ts`):
 *
 *   - `getWorkspaceProactiveConfig(workspaceId)` returns the workspace's
 *     row as `{ enabled, sensitivity, classifierMode }` or `null` when
 *     no row exists (treat as "not opted in" — the listener short-
 *     circuits silently).
 *   - `getChannelProactiveConfigs(workspaceId)` returns the workspace's
 *     per-channel overrides as a flat array. Empty array means "no
 *     overrides"; the listener falls back to workspace defaults.
 *
 * Both functions never throw — failures resolve as `null` / `[]` so a
 * registry hiccup degrades to "not opted in" / "no overrides" instead
 * of crashing the Chat SDK event loop. The plugin's safe-wrapper
 * (`listener.ts:safeGetWorkspaceConfig` / `safeGetChannelConfigs`)
 * provides defence in depth, but we still fail closed here so the
 * structured `log.warn` rows line up cleanly with rejected events.
 *
 * @module
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { SensitivityPreset } from "@useatlas/types";

const log = createLogger("proactive:workspace-config-loader");

/**
 * Workspace-level proactive settings.
 *
 * Mirrors the plugin-side `WorkspaceProactiveConfig` from
 * `plugins/chat/src/proactive/types.ts`. Kept structural (rather than
 * importing from `@useatlas/chat`) so consumers that wire this loader
 * into the listener don't pull the plugin's full dependency tree into
 * `lib/`. The shape stays in lockstep with the plugin via the schema
 * smoke test in `workspace-config-loader.test.ts`.
 */
export interface WorkspaceProactiveConfig {
  /** Master toggle — when false, the listener never reacts. */
  enabled: boolean;
  /** Confidence-threshold preset. */
  sensitivity: SensitivityPreset;
  /** Classifier mode. */
  classifierMode: "regex-prefilter" | "classify-all";
}

/**
 * Per-channel override row.
 *
 * Mirrors the plugin-side `ChannelProactiveConfig`. `sensitivity` is
 * optional — when absent, the listener uses the workspace default.
 */
export interface ChannelProactiveConfig {
  channelId: string;
  /** When false, the channel is denied (Atlas never interjects). */
  allow: boolean;
  /** Optional sensitivity override. */
  sensitivity?: SensitivityPreset;
}

/**
 * Raw shape returned by the workspace SELECT.
 *
 * The index signature satisfies `internalQuery`'s
 * `T extends Record<string, unknown>` constraint without widening the
 * declared columns.
 */
interface RawWorkspaceRow {
  enabled: boolean;
  sensitivity: string;
  classifier_mode: string;
  [key: string]: unknown;
}

/** Raw shape returned by the channels SELECT. */
interface RawChannelRow {
  channel_id: string;
  allow: boolean;
  sensitivity: string | null;
  [key: string]: unknown;
}

/**
 * Narrow the raw `sensitivity` column to the plugin's `SensitivityPreset`
 * union. The DB check constraint (`chk_workspace_proactive_sensitivity`
 * / `chk_channel_proactive_sensitivity`) enforces the same values, so
 * a non-matching value here would be a schema-drift bug worth surfacing.
 * Falls back to `"balanced"` defensively so a drift doesn't crash the
 * listener.
 */
function toSensitivity(raw: string | null): SensitivityPreset {
  if (raw === "cautious" || raw === "balanced" || raw === "eager") {
    return raw;
  }
  return "balanced";
}

/**
 * Narrow `classifier_mode` to the plugin's enum. DB check constraint
 * enforces the same values; falls back to `"regex-prefilter"`
 * defensively so a drift doesn't crash the listener.
 */
function toClassifierMode(
  raw: string,
): "regex-prefilter" | "classify-all" {
  return raw === "classify-all" ? "classify-all" : "regex-prefilter";
}

/**
 * Fetch the per-workspace proactive config row.
 *
 * Returns `null` when no row exists for the workspace (the workspace
 * hasn't opted in to proactive mode — listener short-circuits). Returns
 * `null` (with `log.warn`) on DB failure — fail-closed by default so a
 * blip silently disables the listener rather than crashing the SDK
 * event loop with an unhandled rejection.
 */
export async function getWorkspaceProactiveConfig(
  workspaceId: string,
): Promise<WorkspaceProactiveConfig | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<RawWorkspaceRow>(
      `SELECT enabled, sensitivity, classifier_mode
         FROM workspace_proactive_config
        WHERE workspace_id = $1
        LIMIT 1`,
      [workspaceId],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      enabled: row.enabled === true,
      sensitivity: toSensitivity(row.sensitivity),
      classifierMode: toClassifierMode(row.classifier_mode),
    };
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? { code: (err as { code: unknown }).code }
        : {};
    log.warn(
      {
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
        ...code,
      },
      "Proactive workspace-config loader: workspace_proactive_config read failed — treating as not opted in",
    );
    return null;
  }
}

/**
 * Fetch the per-channel proactive override rows for the workspace.
 *
 * Returns an empty array when no overrides are configured (the listener
 * falls back to workspace defaults). Returns `[]` (with `log.warn`) on
 * DB failure — fail-closed so the listener treats a hiccup as "no
 * overrides" rather than crashing.
 *
 * The rows are returned in `channel_id ASC` order so the listener's
 * `Array.prototype.find` walk is stable for testing/log analysis (the
 * actual lookup is O(N) but channel-config arrays are short in
 * practice — a handful of overrides per workspace).
 */
export async function getChannelProactiveConfigs(
  workspaceId: string,
): Promise<ChannelProactiveConfig[]> {
  if (!hasInternalDB()) return [];
  try {
    const rows = await internalQuery<RawChannelRow>(
      `SELECT channel_id, allow, sensitivity
         FROM channel_proactive_config
        WHERE workspace_id = $1
        ORDER BY channel_id ASC`,
      [workspaceId],
    );
    return rows.map((row) => {
      const out: ChannelProactiveConfig = {
        channelId: row.channel_id,
        allow: row.allow === true,
      };
      if (row.sensitivity !== null && row.sensitivity !== undefined) {
        out.sensitivity = toSensitivity(row.sensitivity);
      }
      return out;
    });
  } catch (err) {
    const code =
      err instanceof Error && "code" in err
        ? { code: (err as { code: unknown }).code }
        : {};
    log.warn(
      {
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
        ...code,
      },
      "Proactive workspace-config loader: channel_proactive_config read failed — treating as no overrides",
    );
    return [];
  }
}
