/**
 * Shared wire types for the proactive chat layer (PRD #2291, 1.5.0).
 *
 * Before this module, `plugins/chat/src/proactive/types.ts` and
 * `packages/api/src/lib/proactive/*` declared structurally-identical
 * mirror types ("shape-by-shape — declared here so the plugin doesn't
 * import `@atlas/api`"). Those mirrors are the exact drift CLAUDE.md
 * "shared types live in `@useatlas/types`" was written to prevent —
 * any change to one side that misses the other silently breaks the
 * wire.
 *
 * This module hosts the canonical shapes both sides import. Type-only:
 * no runtime exports (per the @useatlas/types scaffold gotcha — adding
 * VALUE exports breaks scaffold CI until the package is republished).
 * Branded identifiers + constructor functions live in the API package
 * because they need a runtime mint helper; the plugin can still cast
 * at its boundaries when those land in a follow-up.
 *
 * What landed here in the 1.5.0 polish:
 *   - `AnnouncementOutcome.reason` is a tagged union — the metrics
 *     rollup no longer has to string-parse `reason: string` into
 *     `announcer_threw:${message}` shaped values.
 *   - `AllowDecision` (public-dataset gate) is a tagged union over
 *     refusal reasons — replaces the `metric-denied:${metric}` packed
 *     string with a structured `{ kind: "metric-denied"; metric }`
 *     so audit consumers can pluck `metric` without re-parsing.
 *
 * Kept flat (deferred to a follow-up architecture-wins PR — each
 * cascades through 50+ callsites + test assertions and is best done
 * as a standalone narrowing-migration PR):
 *   - `PauseDecision` (boolean-blind `layer?: PauseLayer`)
 *   - `ClassificationResult.isQuestion` (boolean blindness)
 *   - `ProactiveMeterEvent` (eventType-conditional field shape)
 *   - Branded `ChannelId` / `MessageId` / `Confidence` / `MicroUSD` /
 *     `Millis` / `EpochMs` (primitive obsession — see #2641 for the
 *     identity-bearing brand types that have landed)
 *
 * Brand types added in #2641 (type-only — runtime promotion chokepoints
 * live in `@useatlas/chat` because adding value exports here would
 * break the scaffold-CI gotcha until the package is republished):
 *   - `WorkspaceId` — Atlas org id (`organization.id` / `slack_installations.org_id`)
 *   - `AtlasUserId` — Atlas user id (`user.id`)
 *   - `ExternalUserId` — Slack/Teams/etc platform user id (Slack `U…`)
 */

// ---------------------------------------------------------------------------
// Identity brands (#2641) — type-level companion to #2624
// ---------------------------------------------------------------------------

/**
 * Atlas workspace id (`organization.id`).
 *
 * Distinct nominal type from `AtlasUserId` and `ExternalUserId` even
 * though all three are strings at runtime, so a transposed-arg call
 * (`verifyWorkspace(asker.externalUserId)`) is a compile error. The
 * single runtime chokepoint that promotes a bare string into a
 * `WorkspaceId` is `assertWorkspaceId` from `@useatlas/chat` — every
 * boundary (host adapter, SaaS config, default verifier) flows through
 * it so an empty/malformed id fails fast instead of silently routing
 * the asker to a "global" tenant.
 */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

/**
 * Atlas user id (`user.id`). Carried by the linked branch of
 * `ResolvedAsker`. Promoted via `assertAtlasUserId` from `@useatlas/chat`.
 */
export type AtlasUserId = string & { readonly __brand: "AtlasUserId" };

/**
 * Platform-side user id from the chat adapter (Slack `U…`, Teams aad
 * object id, etc.). Always paired with `platform` to disambiguate
 * "U999 in Slack tenant A" vs "U999 in Slack tenant B"; tenant scoping
 * itself is the `WorkspaceId` brand on the per-event resolver context.
 * Promoted via `assertExternalUserId` from `@useatlas/chat`.
 */
export type ExternalUserId = string & { readonly __brand: "ExternalUserId" };

// ---------------------------------------------------------------------------
// Pause registry (#2295) — three-layer kill switch + per-user opt-out
// ---------------------------------------------------------------------------

/**
 * Channel-scoped pause layers (`channel_id IS NOT NULL`).
 *
 * Split from `PauseLayer` so the type system makes a row that says
 * it's `channel-24h` carry a non-null channel id at the type level.
 */
export type ChannelPauseLayer = "channel-24h" | "admin-channel";

/**
 * The four pause shapes recognised by the registry.
 *
 * - `channel-24h`     — in-channel `@atlas pause` (channel-scoped, 24h)
 * - `admin-channel`   — per-channel admin deny (channel-scoped, indefinite)
 * - `workspace-kill`  — admin "pause all proactive" (workspace-wide, indefinite)
 * - `user-optout`     — DM `unsubscribe` (per-user, workspace-wide, indefinite)
 */
export type PauseLayer =
  | ChannelPauseLayer
  | "workspace-kill"
  | "user-optout";

/**
 * Outcome of a pause-registry lookup.
 *
 * Kept flat (`{ paused: boolean; layer?; until? }`) rather than
 * discriminated by `paused` because every existing test assertion
 * (`expect(decision.layer).toBe("workspace-kill")`) and the admin
 * pauses route's `decision.layer === "workspace-kill"` check expect
 * `layer` to be accessible regardless of TS narrowing. Discriminating
 * this type is a future architecture-wins refactor — see this module
 * header for rationale.
 *
 * `until` is epoch ms; absent on indefinite pauses (workspace-kill,
 * admin-channel, user-optout). `channel-24h` always has `until`.
 * `layer` is absent only when `paused: false`.
 */
export interface PauseDecision {
  paused: boolean;
  layer?: PauseLayer;
  /** Epoch ms when the pause expires; absent on indefinite pauses. */
  until?: number;
}

// ---------------------------------------------------------------------------
// Classifier (#2292) — kept flat; eventType discrimination deferred
// ---------------------------------------------------------------------------

/** Three-tier sensitivity preset. Maps to a confidence threshold in policy. */
export type SensitivityPreset = "cautious" | "balanced" | "eager";

/** Result of running a message through the question classifier. */
export interface ClassificationResult {
  /** Whether the message looks like an answerable data question. */
  isQuestion: boolean;
  /** Confidence in [0, 1] — 1.0 = certain, 0.0 = certainly not. */
  confidence: number;
  /** Optional short reason from the LLM, useful for audit + tuning. */
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Meter (#2296, #2297) — kept flat; eventType-conditional discrimination deferred
// ---------------------------------------------------------------------------

/** Lifecycle stages tracked by the proactive answer meter. */
export type ProactiveMeterEventType =
  | "classify"
  | "react"
  | "offer"
  | "accept"
  | "feedback"
  | "public_refused";

/** Outcome values captured on `feedback` events. */
export type ProactiveMeterOutcome =
  | "helpful"
  | "not-helpful"
  | "wrong-data"
  | "no-feedback";

/**
 * One row of the proactive meter. Plugin emits these via the host's
 * `onMeterEvent` callback; API writes them to `proactive_meter_events`.
 *
 * Field shape is deliberately flat — discriminating per `eventType`
 * would force every emitter to switch on the type before constructing
 * the payload. Deferred to a follow-up; see module header.
 *
 * `workspaceId` is branded {@link WorkspaceId} (#2641) — the plugin
 * always emits a branded value (the listener promotes via
 * `assertWorkspaceId` at the boundary), so consumers on the API side
 * statically know the id came through the chokepoint.
 */
export interface ProactiveMeterEvent {
  workspaceId: WorkspaceId;
  channelId: string;
  messageId?: string | null;
  eventType: ProactiveMeterEventType;
  outcome?: ProactiveMeterOutcome | null;
  tokens?: number;
  costMicroUsd?: number;
  confidence?: number | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public dataset (#2297) — discriminated allowlist verdict
// ---------------------------------------------------------------------------

/** One entry on a workspace's curated public-dataset allowlist. */
export interface PublicDatasetEntry {
  /** Fully-qualified entity name (e.g. `marketing.users`). */
  entityName: string;
  /** Column / measure names denied within this entity. May be empty. */
  denyMetrics: string[];
}

/**
 * Allowlist verdict for one entity touch.
 *
 * Tagged union: refusal reason is a structured `kind` rather than the
 * pre-polish `deniedReason: \`metric-denied:${metric}\`` packed string.
 * Audit consumers pluck `kind` / `metric` directly instead of parsing
 * a packed string.
 */
export type AllowDecision =
  | { allowed: true }
  | {
      allowed: false;
      kind: "entity-not-in-allowlist";
    }
  | {
      allowed: false;
      kind: "metric-denied";
      /** The denied metric the query touched. */
      metric: string;
    };

// ---------------------------------------------------------------------------
// Monthly quota (#2301)
// ---------------------------------------------------------------------------

/** Quota snapshot returned by the host quota-status reader. */
export interface ProactiveQuotaStatus {
  /** Cap value persisted on the workspace config. Null = unlimited. */
  monthlyClassifierCap: number | null;
  /** Distinct classify rows since the start of the current UTC month. */
  classifyCountThisMonth: number;
  /** True when `classifyCountThisMonth >= monthlyClassifierCap`. */
  capReached: boolean;
  /**
   * True when the underlying DB read failed and the snapshot is the
   * fail-open default. Listener emits a `classify` meter row tagged
   * `skipped: "quota-read-failed"` so the bypass surfaces in the
   * analytics rollup.
   */
  readFailed?: boolean;
}

// ---------------------------------------------------------------------------
// Activation announcement (#2300) — discriminated outcome
// ---------------------------------------------------------------------------

/**
 * Outcome of a `announceActivation` call. Tagged union on `reason` so
 * metrics consumers can pivot on the rejection class without parsing
 * the message — replaces the pre-polish `reason: string` shape.
 */
export type AnnouncementOutcome =
  | { posted: true; messageId?: string }
  | { posted: false; reason: "no_internal_db" }
  | { posted: false; reason: "no_config_row" }
  | { posted: false; reason: "already_posted" }
  | { posted: false; reason: "no_announcer_configured" }
  | { posted: false; reason: "claim_update_failed"; message: string }
  | { posted: false; reason: "announcer_threw"; message: string }
  | { posted: false; reason: "announcer_rejected"; message: string };
