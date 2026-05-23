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
import type {
  ProactiveExecuteQuery,
  ProactiveUserResolver,
} from "./answerer";
import type { IsPausedFn } from "./pause";
import type { FeedbackCollectorFn } from "./feedback";

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
 * shape via an `as unknown as Message` double cast that bypassed
 * structural checking entirely. The cast silenced the type error but
 * a resolver author could legally read `event.message.attachments`
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
 * the channel-message and action-feedback paths can populate a real
 * adapter message id (`listener.ts:1016`), while the modal-submit and
 * bridge-slash synthesis paths pass `""` because there is no original
 * message (`listener.ts:1102`, `bridge.ts:1089`). Resolvers must NOT
 * branch on `id` — only use it for opportunistic logging — because
 * the `""` sentinel cannot be distinguished from an unknown adapter
 * that happens to produce empty ids.
 *
 * Pinned by the `@ts-expect-error` block in
 * `plugins/chat/src/proactive/__tests__/listener.test.ts` (describe
 * tagged `ResolveWorkspaceIdFn type narrowing (#2623 item 2)`) —
 * widening this back to `Message` will make those directives unused
 * and fail the type gate.
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
 * registration field. Called at most once per event handler invocation
 * — the listener holds the result in a local `const` so repeated
 * lookups inside one handler are not needed (there is no cache; the
 * cost ceiling is "one DB read per channel-message event"). The
 * per-event "called exactly once" contract is pinned by the sentinel
 * describe block tagged `#2623 item 6` in
 * `plugins/chat/src/proactive/__tests__/listener.test.ts`.
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

/**
 * Per-event "is the workspace's install of this catalog entry active?"
 * predicate (#2655).
 *
 * The proactive listener calls this as the outermost check on every
 * channel-message event — BEFORE classification, meter, kill-switch,
 * quota, or any other DB read. A `false` verdict is a silent skip:
 * no LLM call, no meter row, no rate-limit hit, no DB write further
 * down the pipeline.
 *
 * Returns `true` ONLY when all four facts hold:
 *
 *   1. A `workspace_plugins` row exists for `(workspaceId, catalogId)`,
 *   2. that row's `enabled = true`,
 *   3. the joined `plugin_catalog` row's `enabled = true`,
 *   4. the workspace's plan ranks ≥ the catalog row's `min_plan`.
 *
 * Implementations must never throw — failures should resolve as
 * `false` so the listener fails closed (silent skip) rather than
 * crashing the SDK event loop.
 *
 * Host wiring: see
 * `packages/api/src/lib/integrations/install/workspace-install-gate.ts`
 * (`WorkspaceInstallGate.isWorkspaceInstallActive`).
 *
 * Per-event caching: the listener wraps the host callback with a
 * `Map`-based memo at the top of each event so a second call within
 * one handler invocation returns the same verdict from ONE underlying
 * roundtrip. Mirrors the per-event-fetch contract on
 * {@link GetWorkspaceConfigFn}.
 */
export type InstallGateFn = (
  workspaceId: string,
  catalogId: string,
) => Promise<boolean>;

/**
 * Structured verdict the listener logs on the gate-deny path
 * (#2703). The host's optional {@link InstallGateConfig.describeState}
 * returns one of these so an operator investigating "why doesn't
 * proactive work for workspace X?" sees the answer in the structured
 * log instead of running the rank table by hand.
 *
 * The shape is host-facing (this types.ts file is shared with the
 * chat plugin SDK). Fields are nullable to support hosts that can't
 * surface every fact — the listener treats missing fields as "no
 * data" rather than "false".
 */
export interface InstallGateVerdict {
  readonly active: boolean;
  readonly installFound: boolean;
  readonly installEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly planTier: string | null;
  readonly minPlan: string | null;
  readonly operatorBypass: boolean;
  readonly reason: string;
}

/**
 * Optional diagnostic variant of {@link InstallGateFn}. Wired by the
 * host alongside the boolean gate; the listener calls it only when a
 * gate-deny log fires AND the per-(workspaceId, channelId) throttle
 * window is open. Operators get the four-fact verdict without paying
 * the extra DB read on every event.
 */
export type InstallGateDescribeFn = (
  workspaceId: string,
  catalogId: string,
) => Promise<InstallGateVerdict>;

/**
 * WorkspaceInstallGate wiring (#2655).
 *
 * Discriminated union matching the {@link AnswerFlowConfig} /
 * {@link KillSwitchConfig} / {@link FeedbackConfig} pattern (#2623 item 1):
 * the union makes half-wired states compile-impossible. Pre-union the
 * shape was two independent optionals (`installGate?` + `installCatalogId?`),
 * and a host that wired only one silently disabled the gate — exactly
 * the "documented-but-not-type-enforced legal combinations" failure
 * mode #2623 was meant to eliminate.
 *
 * `{ enabled: false }` is the safe default: hosts that haven't adopted
 * the catalog install model use this branch and the listener does no
 * install gating (behaves exactly as pre-#2655).
 */
export type InstallGateConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /**
       * Host-supplied gate predicate. See {@link InstallGateFn}.
       */
      readonly gate: InstallGateFn;
      /**
       * Catalog id passed to {@link gate} per event. The host gate
       * accepts either the catalog row's `slug` (e.g. `"slack"`) or
       * the catalog row's `id` (e.g. `"catalog:slack"`) for
       * flexibility.
       */
      readonly catalogId: string;
      /**
       * Optional structured-verdict diagnostic. When wired, the
       * listener uses it on the gate-deny path (rate-limited per
       * `${workspaceId}:${channelId}` pair, default 10 minutes) to
       * log WHICH fact failed (`reason: "plan_below_min"`,
       * `"install_disabled"`, ...) along with the underlying booleans
       * + plan info (#2703). When omitted, the listener logs the
       * deny event with only the workspace / catalog / channel IDs.
       */
      readonly describeState?: InstallGateDescribeFn;
    };

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

// ---------------------------------------------------------------------------
// Discriminated unions for coupled listener config (#2623 item 1)
// ---------------------------------------------------------------------------
//
// `ProactiveListenerConfig` used to expose 25+ optional fields with
// documented-only couplings — a host wiring half a feature group
// silently fell back to a stub. The three unions below encode the
// couplings at the type level so illegal combinations are compile-
// time impossible:
//
//   1. {@link AnswerFlowConfig}  — public-dataset + linked-asker
//                                  answer paths (share `executeQueryProactive`)
//   2. {@link KillSwitchConfig}  — `isPaused` + `onPauseRequest` pair
//   3. {@link FeedbackConfig}    — `feedbackCollector` wire
//
// Pre-customer posture: required fields, no migration shim. Hosts that
// don't want a feature group set the discriminator to the "off" branch
// explicitly (`{ mode: "off" }` / `{ enabled: false }`).
//
// `slashCommandName` was dropped from `ProactiveListenerConfig` in the
// same change: it was declared but unread by the listener (bridge owns
// slash-command registration via the top-level `ChatPluginConfig`).

/**
 * Answer-flow wiring for question events that reach the answer stage
 * (reaction-back or "Yes, answer" button).
 *
 * Four legal modes encode the {@link ProactiveExecuteQuery} sharing
 * between the two answer paths:
 *
 *   - `off`: no `executeQueryProactive` wired. Reaction-backs and
 *     "Yes, answer" clicks post the link-Atlas stub. Self-hosted free
 *     deployments typically pick this branch — the answer paths are
 *     enterprise-gated at the route layer, so `mode: "off"` is the
 *     legal shape when the gate is closed.
 *   - `public-only`: unlinked askers get the workspace's curated
 *     public-dataset allowlist; linked-asker resolution doesn't run.
 *   - `linked-only`: OAuth-linked askers run the agent under their
 *     identity (RLS applies); unlinked askers see the link-Atlas stub.
 *   - `both`: linked askers get their RLS path AND unlinked askers
 *     get the public-dataset path.
 *
 * Encoding (a) from #2623 — single union, no cross-block invariant
 * to maintain. The shared {@link ProactiveExecuteQuery} reads as a
 * field on each non-`off` mode rather than a separate dependency.
 */
export type AnswerFlowConfig =
  | { readonly mode: "off" }
  | {
      readonly mode: "public-only";
      readonly getPublicDataset: GetPublicDatasetFn;
      readonly executeQueryProactive: ProactiveExecuteQuery;
    }
  | {
      readonly mode: "linked-only";
      readonly userResolver: ProactiveUserResolver;
      readonly executeQueryProactive: ProactiveExecuteQuery;
    }
  | {
      readonly mode: "both";
      readonly getPublicDataset: GetPublicDatasetFn;
      readonly userResolver: ProactiveUserResolver;
      readonly executeQueryProactive: ProactiveExecuteQuery;
    };

/**
 * Kill-switch + per-user opt-out wiring (#2295).
 *
 *   - `enabled: false`: no pause check before classification, no DM
 *     `unsubscribe` write, no in-channel `@atlas pause` write. Useful
 *     for tests and dev deploys that don't have the pause registry
 *     wired.
 *   - `enabled: true`: both halves wired — `isPaused` consulted
 *     BEFORE the classifier on every channel message; `onPauseRequest`
 *     called on `@atlas pause` / DM `unsubscribe`. Paired in practice
 *     because one queries the registry and the other writes to it.
 */
export type KillSwitchConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly isPaused: IsPausedFn;
      readonly onPauseRequest: OnPauseRequestFn;
    };

/**
 * Feedback collection wiring for the `Helpful` / `Not helpful` /
 * `Wrong data` buttons, the wrong-data modal, and the bridge-routed
 * `/atlas feedback <text>` slash subcommand (#2298).
 *
 *   - `enabled: false`: feedback events are silently dropped. The
 *     buttons and modal still render (they're part of the answer
 *     card) but no row is written.
 *   - `enabled: true`: events routed to `collector`.
 *
 * `slashCommandName` lives on the top-level {@link ChatPluginConfig}
 * (bridge-level) because the bridge owns slash-command registration —
 * the listener's `handleProactiveFeedbackSlash` is a free function the
 * bridge calls, not a chat.onSlashCommand handler the listener
 * registers itself.
 */
export type FeedbackConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly collector: FeedbackCollectorFn };
