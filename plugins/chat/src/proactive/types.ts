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

import type { Adapter, Message, Thread } from "chat";
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
 * Returns true when proactive mode is allowed for the given workspace.
 * Takes `workspaceId` as a per-call argument (multi-tenant) — pre-#2620
 * this was zero-arg with `workspaceId` baked at registration; after #2620
 * the listener resolves workspace per event and threads the id through.
 *
 * The host wires this to `isEnterpriseEnabled() && workspaceFlag` so the
 * plugin itself does not import `@atlas/ee`.
 */
export type ProactiveGateFn = (
  workspaceId: string,
) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Per-event workspace resolution (#2620)
// ---------------------------------------------------------------------------
//
// Pre-#2620 the listener carried a single `workspaceId` baked at
// registration. SaaS routes Slack events from N tenants through one Chat
// instance, so a static workspaceId stamps the wrong tenant on every meter
// row / pause check / quota lookup. The fix is per-event resolution.
//
// The host implements `ResolveWorkspaceIdFn` by reading the platform-
// specific tenant identifier (Slack `team_id`, Teams `tenantId`, ...) out
// of the raw message and looking up the corresponding Atlas workspace.
// Returning `null` is a silent skip: unrecognized tenant, no classify, no
// meter row.

/**
 * Narrowed subset of `Message` the resolver is contractually allowed to
 * read (#2623 item 2). The resolver-side contract has always been
 * "only read `adapter.name` + `message.raw`", but pre-#2623 the
 * parameter was the full `Message` and synthesis sites (action /
 * modal / slash, which don't carry a real Message) smuggled a partial
 * shape via a structural `Message` cast. The cast silenced the type
 * error but a resolver author could legally read
 * `event.message.attachments`
 * or `event.message.author` — fields synthetic events don't populate,
 * which would silently misroute the tenant lookup at runtime.
 *
 * Narrowing the parameter type closes that contract hole at compile
 * time: a resolver that reads anything outside this set is a type
 * error, and synthesis sites can return this shape directly without
 * any cast.
 *
 * Adding a field here means every host implementation can now read it;
 * removing means closing a hole. `raw` is the only load-bearing field
 * (Slack `team_id`, Teams `tenantId`, ...); `id` is included because
 * synthesis sites populate it for logging convenience but it carries
 * no semantic value on synthetic events.
 */
export type ResolverEventLite = Pick<Message, "id" | "raw">;

/**
 * Per-event input to {@link ResolveWorkspaceIdFn}.
 *
 * `thread` is `Thread | undefined` because slash-command and home-tab
 * events don't carry a thread context — the bridge passes `undefined`
 * there. Pre-#2623 the bridge cast `undefined as unknown as Thread`
 * to satisfy a stricter contract; the explicit `| undefined` lets the
 * cast go away.
 */
export interface ResolverEvent {
  adapter: Adapter;
  thread: Thread | undefined;
  message: ResolverEventLite;
}

/**
 * Per-event workspace resolution callback.
 *
 * Returns the Atlas workspace id (`org_id` in the internal DB) for the
 * tenant that sent this event, or `null` when the event doesn't belong
 * to any known tenant (unrecognized `team_id`, missing raw payload,
 * etc.). On `null` the listener silently skips — no classification, no
 * meter event, no kill-switch read.
 *
 * Implementations should never throw. Failures should resolve as `null`
 * so the listener fails closed (skip) without crashing the SDK loop.
 *
 * Host wiring (Slack-first): see
 * `packages/api/src/lib/proactive/workspace-id-resolver.ts` for the
 * canonical implementation that maps Slack `team_id` →
 * `slack_installations.org_id`.
 */
export type ResolveWorkspaceIdFn = (event: ResolverEvent) => Promise<string | null>;

/**
 * Per-event workspace config fetcher.
 *
 * Replaces the pre-#2620 static `workspace: WorkspaceProactiveConfig`
 * registration field. Called once per event after `resolveWorkspaceId`
 * succeeds; the listener caches the result for the lifetime of the
 * single event handler call so repeated lookups inside one handler stay
 * cheap.
 *
 * Returns `null` when the workspace has no config row (treat as not
 * opted in; the listener short-circuits without classification).
 * Implementations should never throw — failures resolve as `null`.
 */
export type GetWorkspaceConfigFn = (
  workspaceId: string,
) => Promise<WorkspaceProactiveConfig | null>;

/**
 * Per-event channel-config fetcher.
 *
 * Replaces the pre-#2620 static `channelConfigs:
 * Record<string, ChannelProactiveConfig>` registration field. Returns
 * the workspace's per-channel overrides as a flat array; the listener
 * scans it linearly per event (channel-config arrays are short in
 * practice — a handful of allow/deny overrides per workspace).
 *
 * Implementations should never throw — failures should resolve as an
 * empty array so the listener falls back to workspace-default behaviour.
 */
export type GetChannelConfigsFn = (
  workspaceId: string,
) => Promise<ReadonlyArray<ChannelProactiveConfig>>;

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
