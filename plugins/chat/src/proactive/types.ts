/**
 * Plugin-side proactive chat types.
 *
 * Wire types (shapes shared between plugin and API host) live in
 * `@useatlas/types/proactive` and are re-exported here so plugin-
 * internal consumers keep their existing import paths. Plugin-only
 * callback signatures (`LLMClassifierFn`, `OnPauseRequestFn`, etc.)
 * stay declared in this module because they carry plugin-specific
 * Promise/void variance the host doesn't import.
 *
 * Slice #2292 ships the reaction-first tracer; slice #2295 the kill
 * switch + per-user opt-out. The post-1.5.0 polish moved the shared
 * shapes into `@useatlas/types` so the previous "shape-by-shape
 * mirror" footgun can't reintroduce wire drift between plugin↔API.
 */

export type {
  ClassificationResult,
  SensitivityPreset,
  ChannelPauseLayer,
  PauseLayer,
  PauseDecision,
  ProactiveMeterEventType,
  ProactiveMeterOutcome,
  ProactiveMeterEvent,
  ProactiveQuotaStatus,
  PublicDatasetEntry as ProactivePublicDatasetEntry,
  AllowDecision,
  AnnouncementOutcome,
} from "@useatlas/types";

import type {
  ClassificationResult,
  ProactiveMeterEvent,
  PublicDatasetEntry as ProactivePublicDatasetEntry,
  SensitivityPreset,
  PauseLayer,
  ProactiveQuotaStatus,
} from "@useatlas/types";

/** Workspace-level proactive settings. */
export interface WorkspaceProactiveConfig {
  /** Master toggle. When false, the listener never reacts. */
  enabled: boolean;
  /** Confidence-threshold preset. */
  sensitivity: SensitivityPreset;
  /** Classifier mode. */
  classifierMode: "regex-prefilter" | "classify-all";
}

/** Per-channel override. Absent fields fall back to workspace defaults. */
export interface ChannelProactiveConfig {
  channelId: string;
  /** When false, the channel is denied (Atlas never interjects). */
  allow: boolean;
  /** Optional sensitivity override. */
  sensitivity?: SensitivityPreset;
}

/** Recent interjection activity used for rate limiting. */
export interface RecentActivity {
  /** Epoch ms of the most recent interjection in this channel, if any. */
  lastInterjectionAt?: number;
}

/** Action returned by `decideInterjection`. */
export type InterjectionAction = "react" | "skip";

/** Decision returned by `decideInterjection`. */
export interface InterjectionDecision {
  action: InterjectionAction;
  /** Short tag explaining why — used in audit + tests. */
  reason: string;
}

/**
 * LLM classifier function injected from the host.
 *
 * Keeps the plugin decoupled from the API package and from any specific
 * model wiring. The host passes a function that runs the workspace's
 * configured Atlas model against a question-detection prompt.
 *
 * Implementations should never throw — failures should resolve as
 * `{ isQuestion: false, confidence: 0 }` so the listener fails closed.
 */
export type LLMClassifierFn = (text: string) => Promise<ClassificationResult>;

/**
 * Gate callback injected from the host.
 *
 * Returns true when proactive mode is allowed for this workspace. The
 * host wires this to `isEnterpriseEnabled() && workspaceFlag` so the
 * plugin itself does not import `@atlas/ee`.
 */
export type ProactiveGateFn = () => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Kill switch (#2295) — three-layer pause + per-user opt-out
// ---------------------------------------------------------------------------
//
// `ChannelPauseLayer`, `PauseLayer`, `PauseDecision` live in
// `@useatlas/types/proactive` and are re-exported at the top of this
// module. Only callback signatures stay below.

/**
 * Host-supplied callback that records a pause row.
 *
 * The listener never writes to the database directly — it builds the
 * request shape (`@atlas pause` → 24h channel-scoped, DM `unsubscribe`
 * → indefinite user-scoped) and hands it off to the host.
 *
 * Implementations may throw; the listener catches and logs at warn —
 * a failed pause write must never crash the SDK event loop.
 *
 * `durationMs: null` ⇒ indefinite (no `expires_at`).
 */
export type OnPauseRequestFn = (request: {
  workspaceId: string;
  /** Channel id for channel-scoped pauses; null for workspace/user pauses. */
  channelId: string | null;
  userId: string;
  layer: PauseLayer;
  /** ms from `requestedAt`; null means indefinite. */
  durationMs: number | null;
  /** Epoch ms when the request was generated — passed through so the host
   *  can compute `expires_at` deterministically in tests. */
  requestedAt: number;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Meter event (#2296)
// ---------------------------------------------------------------------------
//
// `ProactiveMeterEventType`, `ProactiveMeterOutcome`, `ProactiveMeterEvent`
// live in `@useatlas/types/proactive`. Only the plugin-side callback
// signature stays below.

/**
 * Host-injected meter callback. The plugin never persists meter rows
 * itself — it emits an event and the host wires it to the API's
 * `AnswerMeter` service (which writes to `proactive_meter_events`).
 *
 * Implementations should never throw. Failures are swallowed inside
 * the listener so the Chat SDK event loop never crashes.
 */
export type ProactiveMeterEventFn = (
  event: ProactiveMeterEvent,
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Monthly quota cap (#2301)
// ---------------------------------------------------------------------------
//
// `ProactiveQuotaStatus` lives in `@useatlas/types/proactive`. Only the
// host-injected fetcher signature stays below.

/**
 * Host-injected quota reader. Consulted BEFORE the classifier on every
 * channel message — pays a single DB read (well-indexed) and short-
 * circuits the LLM call when the workspace has hit its monthly cap.
 *
 * Implementations should never throw. Failures are caught by the
 * listener and treated as "no quota info" (Atlas keeps answering)
 * so a quota outage never crashes the SDK event loop.
 */
export type GetQuotaStatusFn = (input: {
  workspaceId: string;
}) => Promise<ProactiveQuotaStatus>;

// ---------------------------------------------------------------------------
// Public dataset for non-linked askers (#2297)
// ---------------------------------------------------------------------------
//
// `PublicDatasetEntry` (re-exported here as `ProactivePublicDatasetEntry`)
// and `AllowDecision` live in `@useatlas/types/proactive`. Only the
// host-injected fetcher signature stays below.

/**
 * Host-injected fetch for the workspace's public-dataset allowlist.
 * Consulted by the listener when an unlinked asker reaches the answer
 * flow — every referenced entity must appear in the returned list, or
 * the listener emits a `public_refused` meter event and returns the
 * refusal copy. Failures are caught and treated as "empty allowlist"
 * so a registry hiccup doesn't accidentally widen the refusal surface.
 *
 * The plugin never queries Postgres itself; the host implementation
 * lives in `packages/api/src/lib/proactive/public-dataset.ts`.
 */
export type GetPublicDatasetFn = (input: {
  workspaceId: string;
}) => Promise<ReadonlyArray<ProactivePublicDatasetEntry>>;

/**
 * Default refusal copy used when an unlinked asker hits a question
 * whose referenced entities aren't on the workspace's public dataset.
 * Single string, content-blind by design (never names the entity the
 * asker probed for) — admins can override via `proactive.refusalCopy`
 * to match house style.
 */
export const DEFAULT_PROACTIVE_REFUSAL_COPY =
  "I can only answer a curated set of questions in public channels. Link your Atlas account in DM to see this answer — or ask your admin to make this kind of question public.";
