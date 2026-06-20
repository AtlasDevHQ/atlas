/**
 * Chat plugin configuration schema.
 *
 * Validates adapter credentials via Zod; runtime callbacks are validated
 * with refinements (TypeScript provides compile-time safety via
 * ChatPluginConfig).
 */

import { z } from "zod";
import type { StreamChunk } from "chat";
// #2665 — catalog vocabulary lives in @useatlas/types so the chat plugin
// and @atlas/api share one source of truth for the literal unions.
// Re-exported below as `ChatAdapterName` for back-compat with downstream
// hosts that imported it from `@useatlas/chat`.
import {
  CATALOG_ENTRY_TYPES,
  CATALOG_INSTALL_MODELS,
  CHAT_ADAPTER_NAMES,
} from "@useatlas/types";
import type {
  CatalogEntryType,
  CatalogInstallModel,
  ChatAdapterName as SharedChatAdapterName,
} from "@useatlas/types";
import type { ReactionConfig } from "./features/reactions";
import type {
  AnswerFlowConfig,
  FeedbackConfig,
  GetChannelConfigsFn,
  GetPublicDatasetFn,
  GetQuotaStatusFn,
  GetWorkspaceConfigFn,
  KillSwitchConfig,
  LLMClassifierFn,
  OnPauseRequestFn,
  ProactiveGateFn,
  ProactiveMeterEventFn,
  ResolveWorkspaceIdFn,
} from "./proactive/types";
import type { IsPausedFn } from "./proactive/pause";
import type {
  ProactiveExecuteQuery,
  ProactiveUserResolver,
} from "./proactive/answerer";
import type { FeedbackCollectorFn } from "./proactive/feedback";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in a conversation thread. */
export type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * Presentation mode for the Atlas agent's response (#2705).
 *
 * - `"developer"` (default for the web chat surface): analyst-grade
 *   output — full markdown, SQL code blocks, tables, glossary
 *   disambiguation, entity links.
 * - `"conversational"`: 1-2 sentence prose answers for Slack
 *   @mentions and proactive replies, where the audience is a
 *   non-analyst team member skimming a thread. Suppresses SQL,
 *   markdown tables, and glossary lectures by default; the chat
 *   plugin pairs this with progressive-disclosure buttons that
 *   surface the developer-mode view on demand.
 *
 * Threaded through `executeQuery` / `executeQueryStream` and
 * `executeQueryProactive` so the host can adjust the system prompt
 * accordingly. Backward-compatible: when the host's callback ignores
 * the field, behavior matches pre-#2705 ("developer" mode).
 */
export type PresentationMode = "developer" | "conversational";

/**
 * Catalog entry shape the chat plugin's `AdapterRegistry` consumes
 * (slice 2 of #2649). Mirrors the chat-relevant subset of `CatalogEntry`
 * from `@atlas/api/lib/config` — kept local because the chat plugin
 * can't import `@atlas/api` directly (separate package namespace).
 *
 * Hosts pass this through `chatPlugin({ catalog })`; the registry
 * filters by `type === "chat"` so integration entries pass through
 * harmlessly (they're owned by the LazyPluginLoader in slice 3).
 */
export interface ChatCatalogEntryInput {
  /** Stable slug — `"slack"`, `"telegram"`, etc. */
  readonly slug: string;
  /** Admin-UI grouping. The registry skips non-chat entries. */
  readonly type: CatalogEntryType;
  /** Install-handler dispatch key. Only `"oauth"` activates in 1.5.2. */
  readonly install_model: CatalogInstallModel;
  /** Customer can install? Ops can flip false without removing the row. */
  readonly enabled: boolean;
  /** Visible to SaaS admin UI? (Used in slice 3; unused by AdapterRegistry.) */
  readonly saas_eligible: boolean;
}

/**
 * Canonical chat platform names — re-exported from `@useatlas/types`
 * (#2665) so the literal union is shared with `@atlas/api`'s catalog
 * dispatch. Adding a platform happens in one place
 * (`packages/types/src/catalog.ts:CHAT_ADAPTER_NAMES`) and propagates
 * to both packages via TypeScript exhaustiveness.
 */
export type ChatAdapterName = SharedChatAdapterName;
export { CHAT_ADAPTER_NAMES };

/** Minimal adapter shape passed through to host `executeQuery` callbacks.
 *
 * The chat SDK's full `Adapter` type carries platform-specific generics
 * (`Adapter<SlackThreadId, SlackEvent>` etc.) that the host shouldn't have
 * to thread through. The host only reads `name` to dispatch to the right
 * tenant resolver — keep this surface intentionally narrow. */
export interface ChatExecuteQueryAdapter {
  /** Platform identifier. The host uses this to dispatch to the
   * platform-specific tenant resolver — typed as a literal union
   * (see {@link ChatAdapterName}) so dispatch branches narrow at
   * compile time and unknown platforms cannot reach here. */
  name: ChatAdapterName;
}

/** Context passed to `executeQuery` / `executeQueryStream`.
 *
 * Carries the platform identity bits the host needs to resolve tenancy
 * before calling the agent. See `executeQuery` JSDoc on `ChatPluginConfig`
 * for the contract.
 *
 * Mirrors the shape `ResolveWorkspaceIdFn` already established in #2620 —
 * `adapter` + `message.raw` is the canonical "which tenant is this event
 * from?" channel. Surfacing the same bits to `executeQuery` lets the host
 * build a `botActorUser` for the agent loop's approval / RLS gates. */
export interface ChatExecuteQueryContext {
  /** Stable thread id, formatted by the bridge as
   * `${adapter.name}:${thread.id}` (e.g. `"slack:C123-1234.5678"`). */
  threadId: string;
  /** Prior conversation messages for multi-turn context. Empty on first
   * mention; populated by the bridge's history retrieval on follow-ups. */
  priorMessages?: ChatMessage[];
  /** Minimal adapter handle — see {@link ChatExecuteQueryAdapter}. */
  adapter: ChatExecuteQueryAdapter;
  /** Raw platform event payload (Slack: `SlackEvent` with `team_id`, `user`,
   * etc.; Teams: `Activity`; …). Typed as `unknown` so the contract stays
   * platform-agnostic — host code narrows by `adapter.name`. */
  rawMessage: unknown;
  /**
   * Presentation mode for the agent's response (#2705). Set by the
   * bridge to `"conversational"` for @mention and proactive paths —
   * the Slack audience is non-analyst team members skimming a
   * thread. Hosts whose `executeQuery` callback predates #2705
   * ignore the field and serve the developer-mode body, which is the
   * backward-compatible default.
   */
  presentationMode?: PresentationMode;
}

/** A pending action that requires user approval. */
export interface PendingAction {
  id: string;
  type: string;
  target: string;
  summary: string;
}

/** Structured query result returned by the Atlas agent. */
export interface ChatQueryResult {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  /** Actions awaiting user approval (e.g., write operations). */
  pendingActions?: PendingAction[];
}

/**
 * Narrow bridge capability exposed to the host's `onBridgeReady` callback
 * (#3750) — just enough to post a continued answer back into a thread when a
 * parked turn's approval is resolved. Kept minimal (a structural subset of
 * `ChatBridge`) so the host wires resume delivery without depending on the
 * full bridge surface.
 */
export interface ChatResumeBridge {
  /** Platform slug the bridge knows (`"slack"`, `"telegram"`, …). */
  postToThread(
    platform: string,
    threadId: string,
    message: string,
  ): Promise<{ messageId: string } | null>;
}

/**
 * Host callback invoked when the bridge finishes initializing (with the
 * bridge) and on shutdown (with `null`) — #3750. Lets the host register a
 * resume-deliverer that closes over the bridge so an approval-review handler
 * (on the host side of the plugin boundary) can continue a parked chat thread.
 * Additive + host-optional: the plugin works unchanged when it's absent.
 */
export type OnBridgeReady = (bridge: ChatResumeBridge | null) => void;

/** Adapter-specific credential configuration. */
export interface SlackAdapterConfig {
  /** Single-workspace bot token (`xoxb-…`). Omit in multi-workspace deploys. */
  botToken?: string;
  signingSecret: string;
  /** Client ID for multi-workspace OAuth. */
  clientId?: string;
  /** Client secret for multi-workspace OAuth. */
  clientSecret?: string;
  /**
   * AES-256-GCM key for at-rest encryption of bot tokens persisted in
   * `chat_cache` (post-#2634 consolidation). Passed through to
   * `@chat-adapter/slack`. 32 raw bytes as hex64 or base64. When set,
   * Atlas's `lib/slack/installation-encryption.ts` and the chat-adapter
   * both encrypt/decrypt against the same key so OAuth-write /
   * per-event-read stay symmetric. Optional; omitting it persists
   * tokens as plaintext (self-hosted single-user posture).
   */
  encryptionKey?: string;
}

/** Teams adapter credential configuration. */
export interface TeamsAdapterConfig {
  /** Microsoft App ID from Azure Bot registration. */
  appId: string;
  /** Microsoft App Password from Azure Bot registration. */
  appPassword: string;
  /** Optional: restrict to a specific Microsoft Entra ID tenant.
   * When set, the adapter operates in single-tenant mode and rejects
   * tokens from other tenants. */
  tenantId?: string;
}

/** Discord adapter credential configuration. */
export interface DiscordAdapterConfig {
  /** Discord bot token. */
  botToken: string;
  /** Discord application ID. */
  applicationId: string;
  /** Discord application public key for webhook signature verification. */
  publicKey: string;
  /** Role IDs that trigger mention handlers (in addition to direct @mentions). */
  mentionRoleIds?: string[];
}

/** Telegram adapter credential configuration. */
export interface TelegramAdapterConfig {
  /** Telegram bot token from BotFather. */
  botToken: string;
  /** Webhook secret token for verifying incoming requests.
   * When omitted, the webhook endpoint accepts unauthenticated POST requests.
   * Strongly recommended for production deployments. */
  secretToken?: string;
}

/** Shared GitHub adapter fields (auth-mode-independent). */
interface GitHubAdapterBaseConfig {
  /** Webhook secret for HMAC-SHA256 signature verification.
   * Must match the secret configured in your GitHub webhook settings. */
  webhookSecret?: string;
  /** Bot username (e.g., "my-bot" or "my-bot[bot]" for GitHub Apps).
   * Used for @-mention detection. */
  userName?: string;
}

/** GitHub adapter using a Personal Access Token. */
interface GitHubPATConfig extends GitHubAdapterBaseConfig {
  /** Personal Access Token — simplest auth, for personal bots or testing. */
  token: string;
  appId?: never;
  privateKey?: never;
  installationId?: never;
}

/** GitHub adapter using a GitHub App with a fixed installation. */
interface GitHubAppSingleTenantConfig extends GitHubAdapterBaseConfig {
  token?: never;
  /** GitHub App ID. */
  appId: string;
  /** GitHub App private key (PEM format). */
  privateKey: string;
  /** Installation ID — locks the adapter to a single org/repo. */
  installationId: number;
}

/** GitHub adapter using a GitHub App in multi-tenant mode.
 * Installation ID is auto-detected from each webhook payload. */
interface GitHubAppMultiTenantConfig extends GitHubAdapterBaseConfig {
  token?: never;
  /** GitHub App ID. */
  appId: string;
  /** GitHub App private key (PEM format). */
  privateKey: string;
  installationId?: never;
}

/** GitHub adapter credential configuration.
 * Discriminated union — exactly one auth mode must be provided:
 * - PAT: `{ token }` — simplest, for personal bots
 * - App single-tenant: `{ appId, privateKey, installationId }` — fixed org
 * - App multi-tenant: `{ appId, privateKey }` — public app, auto-detects installation */
export type GitHubAdapterConfig =
  | GitHubPATConfig
  | GitHubAppSingleTenantConfig
  | GitHubAppMultiTenantConfig;

/** Shared Linear adapter fields (auth-mode-independent). */
interface LinearAdapterBaseConfig {
  /** Webhook signing secret for HMAC-SHA256 verification.
   * Found on the webhook detail page in Linear settings.
   * Required by the upstream @chat-adapter/linear — initialization
   * will fail if omitted and LINEAR_WEBHOOK_SECRET env var is unset. */
  webhookSecret?: string;
  /** Bot display name used for @-mention detection.
   * Defaults to LINEAR_BOT_USERNAME env var or "linear-bot". */
  userName?: string;
}

/** Linear adapter using a personal API key. */
interface LinearAPIKeyConfig extends LinearAdapterBaseConfig {
  /** Personal API key from Linear Settings > Security & Access. */
  apiKey: string;
  accessToken?: never;
  clientId?: never;
  clientSecret?: never;
}

/** Linear adapter using a pre-obtained OAuth access token. */
interface LinearOAuthConfig extends LinearAdapterBaseConfig {
  apiKey?: never;
  /** OAuth access token obtained through the OAuth flow. */
  accessToken: string;
  clientId?: never;
  clientSecret?: never;
}

/** Linear adapter using OAuth client credentials (recommended for apps).
 * The adapter handles token management internally. */
interface LinearAppConfig extends LinearAdapterBaseConfig {
  apiKey?: never;
  accessToken?: never;
  /** OAuth application client ID. */
  clientId: string;
  /** OAuth application client secret. */
  clientSecret: string;
}

/** Linear adapter credential configuration.
 * Discriminated union — exactly one auth mode must be provided:
 * - API Key: `{ apiKey }` — simplest, for personal bots
 * - OAuth token: `{ accessToken }` — pre-obtained OAuth token
 * - OAuth App: `{ clientId, clientSecret }` — recommended for apps */
export type LinearAdapterConfig =
  | LinearAPIKeyConfig
  | LinearOAuthConfig
  | LinearAppConfig;

/** WhatsApp adapter credential configuration. */
export interface WhatsAppAdapterConfig {
  /** WhatsApp Business phone number ID (not the phone number itself). */
  phoneNumberId: string;
  /** System User access token for WhatsApp Cloud API calls. */
  accessToken: string;
  /** Verify token for webhook challenge-response verification. */
  verifyToken: string;
  /** Meta App Secret for webhook HMAC-SHA256 signature verification. */
  appSecret: string;
  /** Bot display name used for identification. */
  userName?: string;
  /** Meta Graph API version (default: "v21.0"). */
  apiVersion?: string;
}

/** Google Chat adapter credential configuration. */
export interface GoogleChatAdapterConfig {
  /** Service account credentials JSON (client_email + private_key). */
  credentials?: {
    client_email: string;
    private_key: string;
    project_id?: string;
  };
  /** Use Application Default Credentials instead of explicit credentials. */
  useApplicationDefaultCredentials?: true;
  /** HTTP endpoint URL for button click actions (card interactions). */
  endpointUrl?: string;
  /** Pub/Sub topic for receiving all messages via Workspace Events.
   * Format: "projects/my-project/topics/my-topic".
   * When set, the adapter receives all messages, not just @mentions. */
  pubsubTopic?: string;
  /** User email to impersonate for Workspace Events API (domain-wide delegation). */
  impersonateUser?: string;
  /**
   * Google Cloud project number — used by the adapter to verify
   * direct-webhook JWTs Google signs with the project's identity. When
   * unset, direct-webhook verification is disabled and the adapter
   * logs a warning per inbound request. Required for SaaS deploys
   * that accept Google Chat webhooks over the HTTP endpoint.
   */
  googleChatProjectNumber?: string;
  /**
   * Expected `aud` claim for Pub/Sub push-message JWTs the adapter
   * receives via the Workspace Events subscription. When unset,
   * Pub/Sub push verification is disabled and the adapter logs a
   * warning per inbound message. Required for SaaS deploys that
   * accept Pub/Sub push messages.
   */
  pubsubAudience?: string;
}

/** Streaming response configuration. */
export interface StreamingConfig {
  /** Enable streaming responses to chat platforms. Default: true.
   * When enabled and `executeQueryStream` is provided, the bridge streams
   * agent responses incrementally via Chat SDK's native streaming (Slack)
   * or edit-based fallback (Teams, Discord, Google Chat). */
  enabled?: boolean;
  /** Minimum interval (ms) between message edits for edit-based streaming
   * on platforms that support progressive edits (Teams, Discord, Google Chat,
   * Telegram). GitHub is unaffected — it buffers and posts once.
   * Must be between 200 and 10,000. Lower values provide smoother updates
   * but risk hitting platform rate limits.
   * Default: 500 (Chat SDK default) */
  chunkIntervalMs?: number;
}

/** Streaming query result returned by `executeQueryStream`. */
export interface StreamingQueryResult {
  /** Async iterable of text chunks and structured status updates.
   * Yield plain strings for text or `StreamChunk` objects for rich status
   * indicators (e.g. `{ type: "task_update", title: "Running SQL...", status: "in_progress", id: "sql" }`). */
  stream: AsyncIterable<string | StreamChunk>;
  /** Resolves with the final structured result after the stream completes.
   * Must not resolve before the stream is fully consumed. If the stream
   * errors, this promise should reject with the same error.
   * Used for history persistence, approval prompts, and conversation tracking. */
  result: Promise<ChatQueryResult>;
}

/** State backend configuration. */
export interface StateConfig {
  /** Which state backend to use. Default: "memory" */
  backend: "memory" | "pg" | "redis";
  /** Table name prefix for PG backend. Default: "chat_" */
  tablePrefix?: string;
  /** Redis connection URL (future — not yet implemented). */
  redisUrl?: string;
}

/** Action framework callbacks for approve/deny flows. */
export interface ActionCallbacks {
  approve(
    actionId: string,
    approverId: string,
  ): Promise<{ status: string; error?: string | null } | null>;
  deny(
    actionId: string,
    denierId: string,
  ): Promise<Record<string, unknown> | null>;
  get(
    actionId: string,
  ): Promise<{
    id: string;
    action_type: string;
    target: string;
    summary: string;
  } | null>;
}

/** Conversation persistence callbacks for host integration. */
export interface ConversationCallbacks {
  create(opts: {
    id?: string;
    title?: string | null;
    surface?: string;
  }): Promise<{ id: string } | null>;
  addMessage(opts: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<void> | void;
  get(
    id: string,
  ): Promise<{
    messages: Array<{ role: string; content: unknown }>;
  } | null>;
  generateTitle(question: string): string;
}

/** Ephemeral message configuration. */
export interface EphemeralConfig {
  /** Post error messages as ephemeral (visible only to the requesting user).
   * On Slack and Google Chat, uses native ephemeral messages. On other
   * platforms, falls back to a DM to the user.
   * Default: true */
  errorsAsEphemeral?: boolean;
}

/** File upload (CSV export) configuration. */
export interface FileUploadConfig {
  /** Row count threshold for auto-attaching CSV files. When a query result
   * contains more rows than this value, a CSV file is automatically attached
   * alongside the card response. Set to 0 to disable auto-attach.
   * Default: 20 */
  autoAttachThreshold?: number;
  /** Base URL for the Atlas web UI. Used as a fallback link on platforms
   * that do not support file uploads (GitHub, Linear).
   * Example: "https://app.useatlas.dev" */
  webBaseUrl?: string;
}

export interface ChatPluginConfig {
  /**
   * Catalog entries — the chat-type subset of `atlas.config.ts:catalog`
   * (slice 2 of #2649). The host passes the chat-relevant entries here so
   * `AdapterRegistry` can decide which adapters to instantiate at boot.
   *
   * In 1.5.2, only `install_model === "oauth"` chat entries instantiate
   * — and the only OAuth chat platform Atlas ships today is Slack.
   * Static-bot entries (Teams, Discord, gchat, Telegram, WhatsApp) ride
   * along as `enabled: false` placeholders; their install handlers
   * land in 1.5.3.
   *
   * Per-Platform OPERATOR credentials come from `process.env` by default
   * (per CONTEXT.md "Operator vs Customer") — the plugin reads them inside
   * `buildChatAdapterRegistry`. When `resolveAdapterEnv` is provided (#3704),
   * its overlay takes precedence over env so operator credentials set via the
   * Admin console are picked up at (re)build time. This config object still
   * intentionally carries NO raw credential values — only the optional
   * resolver callback.
   */
  catalog?: ReadonlyArray<ChatCatalogEntryInput>;

  /**
   * Optional async resolver for operator-tier adapter credentials (#3704).
   *
   * Returns an env-shaped overlay (`{ <ENV_VAR_NAME>: value | undefined }`)
   * that the plugin merges ON TOP OF `process.env` before building the
   * adapter registry, so the existing env-reading adapter builders pick up
   * Admin-set, DB-backed operator credentials with no per-builder change.
   * `undefined` values are dropped before merging, so an unresolved key
   * never clobbers its env fallback (env stays the fallback for self-host).
   *
   * Resolution + precedence (DB row → env → unset) lives entirely in the
   * host (`@atlas/api`'s operator-credentials resolver) — the chat plugin
   * stays free of `@atlas/api` imports and of any DB/secret dependency.
   *
   * Called on every `initialize()`, so re-initializing the plugin (the
   * runtime "rebuild" seam — `PluginRegistry.refresh`) re-reads credentials
   * with no process restart. Omitted on self-host → pure env behavior,
   * unchanged.
   */
  resolveAdapterEnv?: () => Promise<Record<string, string | undefined>>;

  /** State backend configuration. Default: { backend: "memory" } */
  state?: StateConfig;

  /** Slash command name registered with the Chat SDK. Default: "/atlas".
   * Must start with "/" followed by a lowercase letter, then lowercase alphanumeric or hyphens. */
  slashCommandName?: string;

  /** Run the Atlas agent on a question and return structured results. Required.
   *
   * The `context` argument carries platform-specific identity bits the host
   * needs to resolve tenancy on multi-tenant deploys:
   *
   *   - `adapter.name` — `"slack"`, `"teams"`, etc. The host MUST refuse
   *     unsupported platforms cleanly (throw an error the bridge will scrub).
   *   - `rawMessage` — the platform-specific raw event payload. For Slack
   *     this carries `team_id`, `user`, and friends. Mirrors the
   *     `resolveWorkspaceId({ adapter, thread, message })` shape #2620
   *     introduced for the proactive listener.
   *
   * Both fields are REQUIRED — pre-customer codebase, no migration shim.
   * Callers that have no raw event (e.g. internal/test invocations)
   * supply a synthetic object with the platform's `name` set and an empty
   * raw payload. The host's refuse path will reject unknown tenants and
   * the listener gates already block synthetic events from reaching here.
   */
  executeQuery: (
    question: string,
    context: ChatExecuteQueryContext,
  ) => Promise<ChatQueryResult>;

  /** Optional rate limiting callback. */
  checkRateLimit?: (key: string) => { allowed: boolean };

  /** Optional error scrubbing callback. */
  scrubError?: (message: string) => string;

  /** Optional action framework callbacks for approve/deny flows. */
  actions?: ActionCallbacks;

  /** Optional conversation persistence callbacks for host integration. */
  conversations?: ConversationCallbacks;

  /** Streaming configuration. Controls how the bridge delivers incremental
   * responses to chat platforms. */
  streaming?: StreamingConfig;

  /** Streaming query callback. When provided and `streaming.enabled !== false`,
   * the bridge streams responses incrementally instead of waiting for the full
   * result. If not provided, the bridge falls back to the non-streaming
   * `executeQuery`. Carries the same `context` shape as `executeQuery` —
   * see its docs for `adapter` / `rawMessage` semantics. */
  executeQueryStream?: (
    question: string,
    context: ChatExecuteQueryContext,
  ) => StreamingQueryResult;

  /** File upload (CSV export) configuration. Controls when query results are
   * attached as CSV files in chat responses. */
  fileUpload?: FileUploadConfig;

  /** Status reaction configuration. Controls emoji reactions on user messages
   * during the query lifecycle (received → processing → complete/error).
   * Default: enabled with standard emoji. */
  reactions?: ReactionConfig;

  /** Ephemeral message configuration. Controls whether errors and debug info
   * are posted as ephemeral messages (visible only to the requesting user). */
  ephemeral?: EphemeralConfig;

  /**
   * Proactive chat configuration (slice #2292: reaction-first tracer).
   *
   * When present and `isEnabled()` returns truthy, the bridge subscribes
   * to channel-message events and reacts to high-confidence data
   * questions with 🤖. The host wires `isEnabled` to
   * `isEnterpriseEnabled() && workspaceFlag` and `classify` to the
   * configured Atlas model — the plugin itself never imports from
   * `@atlas/ee` or `@atlas/api`.
   *
   * Slice #2292 stops at the reaction. Later slices add the reply,
   * kill switches, admin UI, meter, and feedback.
   */
  proactive?: ProactiveConfig;

  /**
   * Bridge-ready callback (#3750) — invoked at the end of `initialize()` with
   * the (narrow) bridge handle, and on `teardown()` with `null`. The host uses
   * it to (de)register a chat resume-deliverer that posts a parked turn's
   * continued answer back in-thread once its approval is resolved. Additive +
   * host-optional: the plugin works unchanged when omitted (self-host without
   * durable approval-park resume). Top-level (not under `proactive` — resume
   * delivery is independent of the proactive listener). Host wiring:
   * `deploy/api/atlas.config.ts` → `registerChatResumeDeliverer`.
   */
  onBridgeReady?: OnBridgeReady;
}

/** Proactive chat configuration. */
export interface ProactiveConfig {
  /**
   * Per-event workspace resolution (#2620). The bridge passes this to
   * the listener so every event handler resolves which tenant the
   * event belongs to before any classification / meter / quota work
   * happens. Returning `null` is a silent skip.
   *
   * Host wiring (Slack-first): see
   * `packages/api/src/lib/proactive/workspace-id-resolver.ts:createSlackWorkspaceIdResolver`.
   */
  resolveWorkspaceId: ResolveWorkspaceIdFn;
  /**
   * Gate: returns true when proactive mode is allowed for the given
   * workspace. Per-call workspaceId (post-#2620 multi-tenant refactor).
   */
  isEnabled: ProactiveGateFn;
  /** LLM classifier injected from the host. */
  classify: LLMClassifierFn;
  /**
   * Per-event fetcher for workspace-level proactive settings (master
   * toggle, sensitivity, classifier mode). Replaces the pre-#2620
   * static `workspace` field — the listener calls this once per event
   * after `resolveWorkspaceId` succeeds.
   */
  getWorkspaceConfig: GetWorkspaceConfigFn;
  /**
   * Per-event fetcher for per-channel overrides. Replaces the pre-#2620
   * static `channelConfigs` map — the listener calls this once per
   * event and scans the returned array linearly.
   */
  getChannelConfigs: GetChannelConfigsFn;

  // ---- Coupled feature groups (#2623 item 1) ------------------------------
  //
  // Three discriminated unions replace the 7 previously-optional
  // callback fields whose legal combinations were documented only.
  // See `proactive/types.ts` for the JSDoc on each variant.

  /**
   * Answer-flow wiring. Replaces the pre-1.5.2
   * `userResolver?` + `executeQueryProactive?` + `getPublicDataset?`
   * triple — the discriminated union absorbs all three (slice #2293
   * linked-asker path, slice #2297 public-dataset path, and the
   * shared `executeQueryProactive` they both invoke).
   *
   * `{ mode: "off" }` keeps the reaction-first tracer working but
   * never runs the agent. Multi-tenant SaaS deploys typically wire
   * `mode: "both"` so linked askers run under RLS while unlinked
   * askers get the curated public dataset.
   */
  answerFlow: AnswerFlowConfig;

  /**
   * Kill-switch + per-user opt-out wiring (slice #2295). Pre-1.5.2
   * shape was `{ isPaused?, onPauseRequest? }`; the union ensures
   * the pair stays in lockstep.
   */
  killSwitch: KillSwitchConfig;

  /**
   * Feedback collection wiring (slice #2298). `{ enabled: false }`
   * silently drops button / modal / slash feedback events.
   */
  feedback: FeedbackConfig;

  // ---- Independent / informational optionals -----------------------------

  /** Deep link surfaced in the unlinked-asker prompt. */
  linkUrl?: string;
  /** Platform name (`"slack"` etc.) recorded in `ProactiveAsker`. */
  platform?: string;
  /**
   * Override the default refusal copy posted when an unlinked asker's
   * question hits an entity outside the public-dataset allowlist
   * (only consulted when `answerFlow.mode` includes the public path).
   * Defaults to `DEFAULT_PROACTIVE_REFUSAL_COPY` in
   * `proactive/types.ts`. Content-blind by design.
   */
  refusalCopy?: string;
  /**
   * Opt-out for hosts whose `executeQueryProactive` cannot report
   * `entitiesReferenced` on the result. Default `false` (fail-closed
   * — results without entity introspection are refused). Setting
   * `true` lets such results through; only enable when the host has
   * another compensating control (RLS, allowlist enforcement at SQL
   * time). Logs at warn on startup so the bypass is visible.
   */
  allowAnswerWhenEntitiesUnknown?: boolean;

  // ---- Slice #2296: AnswerMeter ------------------------------------------

  /**
   * Per-event meter callback. Receives one event per classify (always)
   * and one per react / offer / accept / feedback when those stages
   * fire. Host wires this to `recordMeterEvent` from
   * `@atlas/api/lib/proactive/answer-meter` so rows land in
   * `proactive_meter_events`.
   */
  onMeterEvent?: ProactiveMeterEventFn;

  // ---- Slice #2301: monthly quota cap ------------------------------------

  /**
   * Quota-status reader. Consulted BEFORE the classifier on every
   * channel message — when the workspace has hit its monthly cap the
   * listener short-circuits and emits a `capReached` meter row instead
   * of running the LLM. Host wires this to
   * `getWorkspaceQuotaStatus` from
   * `@atlas/api/lib/proactive/quota`.
   */
  getQuotaStatus?: GetQuotaStatusFn;

  // ---- Slice #2655: WorkspaceInstallGate ---------------------------------

  /**
   * Per-event catalog-install predicate wiring (#2655). Discriminated
   * union — `{ enabled: false }` keeps the listener at pre-#2655
   * behaviour (hosts that haven't adopted the catalog install model);
   * `{ enabled: true, gate, catalogId }` enables the OUTERMOST
   * workspace-scoped check on every channel-message event.
   *
   * Host wiring: see
   * `packages/api/src/lib/integrations/install/workspace-install-gate.ts`
   * (`WorkspaceInstallGate.isWorkspaceInstallActive`).
   */
  installGate: import("./proactive/types").InstallGateConfig;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

// Per-Platform Zod adapter-credential schemas were removed in #2650
// slice 2 of 1.5.2 — chat-adapter activation moved to the catalog +
// env-var seam (`AdapterRegistry`), so the per-Platform schemas no
// longer ran anywhere. The TypeScript types (`SlackAdapterConfig`,
// `TeamsAdapterConfig`, etc.) above stay because the per-Platform
// adapter factories under `./adapters/<platform>.ts` still take them.
// 1.5.3 will reintroduce per-Platform Zod schemas as the static-bot
// install-handler form-input validators when those handlers land.

const StateConfigSchema = z
  .object({
    backend: z.enum(["memory", "pg", "redis"]).default("memory"),
    tablePrefix: z.string().min(1).regex(
      /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      "tablePrefix must be a valid SQL identifier (letters, numbers, underscores)",
    ).optional(),
    redisUrl: z.string().url().optional(),
  })
  .optional();

const StreamingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    chunkIntervalMs: z
      .number()
      .int()
      .min(200, "chunkIntervalMs must be at least 200ms to avoid rate limits")
      .max(10_000, "chunkIntervalMs must be at most 10000ms")
      .optional(),
  })
  .optional();

const EphemeralConfigSchema = z
  .object({
    errorsAsEphemeral: z.boolean().optional(),
  })
  .optional();

const FileUploadConfigSchema = z
  .object({
    autoAttachThreshold: z
      .number()
      .int()
      .min(0, "autoAttachThreshold must be >= 0")
      .optional(),
    webBaseUrl: z.string().url("webBaseUrl must be a valid URL").optional(),
  })
  .optional();

/**
 * Type-preserving helper for callback fields. `z.any().refine(typeof
 * === "function")` flattens the inferred type to `any`; `z.custom<Fn>`
 * keeps the strong TS signature so `ChatConfig["proactive"]["classify"]`
 * stays typed as `LLMClassifierFn` rather than `any`.
 *
 * Runtime behaviour is unchanged: same `typeof === "function"` check,
 * same error message. The difference is purely at the type level.
 */
function zCallback<Fn extends (...args: never[]) => unknown>(
  message: string,
): z.ZodType<Fn> {
  return z.custom<Fn>((v) => typeof v === "function", { message });
}

/** Same shape as `zCallback` but for objects validated by a custom predicate. */
function zCustomObject<T>(
  predicate: (v: unknown) => boolean,
  message: string,
): z.ZodType<T> {
  return z.custom<T>(predicate, { message });
}

const EmojiValueSchema = zCustomObject<{ name: string }>(
  (v: unknown) =>
    v === undefined ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Record<string, unknown>).name === "string"),
  "customEmoji values must be EmojiValue objects from Chat SDK's emoji helper (e.g., emoji.eyes, emoji.custom('my_emoji'))",
).optional();

const ReactionConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    customEmoji: z
      .object({
        received: EmojiValueSchema,
        processing: EmojiValueSchema,
        complete: EmojiValueSchema,
        error: EmojiValueSchema,
      })
      .optional(),
  })
  .optional();

// Pre-#2620 these wrapped the static `workspace` / `channelConfigs`
// fields on `ProactiveConfig`. They were dropped when those fields
// migrated to per-event fetchers — the wire shapes still live in
// `proactive/types.ts` (`WorkspaceProactiveConfig`,
// `ChannelProactiveConfig`) and the host now validates them at the
// /admin/proactive-chat route + DB-constraint layer rather than here.
//   const SensitivityPresetSchema = z.enum(["cautious", "balanced", "eager"]);

// ---- Discriminated-union sub-schemas (#2623 item 1) ----------------------
//
// Three z.discriminatedUnion()s mirror the three runtime unions in
// `proactive/types.ts`. The runtime check is shape-equivalent to the
// pre-#2623 individual `.optional()` callbacks (zCallback enforces
// `typeof === "function"`), but the discriminator forces the host to
// declare its intent at the schema layer — a stray `executeQueryProactive`
// without a matching `mode` is rejected at boot rather than silently
// no-op'ing inside the listener.

// Shared field schemas for AnswerFlow variants. Defined once so the
// error messages stay consistent across the three non-off modes and
// the per-variant shapes below stay declarative — each variant lists
// only its discriminator plus the callbacks it carries.
const zExecuteQueryProactive = zCallback<ProactiveExecuteQuery>(
  "proactive.answerFlow.executeQueryProactive must be a function",
);
const zGetPublicDataset = zCallback<GetPublicDatasetFn>(
  "proactive.answerFlow.getPublicDataset must be a function returning Promise<PublicDatasetEntry[]>",
);
const zUserResolver = zCallback<ProactiveUserResolver>(
  "proactive.answerFlow.userResolver must be a function",
);

const AnswerFlowSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({
      mode: z.literal("public-only"),
      getPublicDataset: zGetPublicDataset,
      executeQueryProactive: zExecuteQueryProactive,
    })
    .strict(),
  z
    .object({
      mode: z.literal("linked-only"),
      userResolver: zUserResolver,
      executeQueryProactive: zExecuteQueryProactive,
    })
    .strict(),
  z
    .object({
      mode: z.literal("both"),
      getPublicDataset: zGetPublicDataset,
      userResolver: zUserResolver,
      executeQueryProactive: zExecuteQueryProactive,
    })
    .strict(),
]);

const KillSwitchSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      isPaused: zCallback<IsPausedFn>(
        "proactive.killSwitch.isPaused must be a function returning Promise<PauseDecision>",
      ),
      onPauseRequest: zCallback<OnPauseRequestFn>(
        "proactive.killSwitch.onPauseRequest must be a function returning Promise<void>",
      ),
    })
    .strict(),
]);

const FeedbackSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      collector: zCallback<FeedbackCollectorFn>(
        "proactive.feedback.collector must be a function",
      ),
    })
    .strict(),
]);

// #2655 — WorkspaceInstallGate wiring. Half-wired states (gate set but
// catalogId missing, or vice versa) are compile-impossible via the
// discriminated union. The `enabled: false` branch keeps the listener
// at pre-#2655 behaviour for hosts that haven't adopted the catalog
// install model.
const InstallGateSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      gate: zCallback<import("./proactive/types").InstallGateFn>(
        "proactive.installGate.gate must be a function returning Promise<boolean>",
      ),
      catalogId: z.string().min(1, "proactive.installGate.catalogId must be a non-empty string"),
      // #2703 — optional diagnostic that returns the structured
      // verdict for the gate-deny log. Strict schema requires every
      // field be declared; the per-(workspaceId, channelId) throttle
      // in the listener caps the call rate even when wired.
      describeState: zCallback<import("./proactive/types").InstallGateDescribeFn>(
        "proactive.installGate.describeState must be a function returning Promise<InstallGateVerdict>",
      ).optional(),
    })
    .strict(),
]);

const ProactiveConfigSchema = z
  .object({
    // Per-event workspace resolution (#2620). Required.
    resolveWorkspaceId: zCallback<ResolveWorkspaceIdFn>(
      "proactive.resolveWorkspaceId must be a function returning Promise<string | null>",
    ),
    isEnabled: zCallback<ProactiveGateFn>(
      "proactive.isEnabled must be a function (workspaceId) => boolean | Promise<boolean>",
    ),
    classify: zCallback<LLMClassifierFn>(
      "proactive.classify must be a function returning Promise<ClassificationResult>",
    ),
    // Per-event workspace + channel config fetchers (#2620). Required.
    getWorkspaceConfig: zCallback<GetWorkspaceConfigFn>(
      "proactive.getWorkspaceConfig must be a function returning Promise<WorkspaceProactiveConfig | null>",
    ),
    getChannelConfigs: zCallback<GetChannelConfigsFn>(
      "proactive.getChannelConfigs must be a function returning Promise<ChannelProactiveConfig[]>",
    ),
    // Coupled feature groups (#2623 item 1). All three required.
    answerFlow: AnswerFlowSchema,
    killSwitch: KillSwitchSchema,
    feedback: FeedbackSchema,
    // Independent / informational optionals.
    linkUrl: z.string().url("proactive.linkUrl must be a valid URL").optional(),
    platform: z.string().min(1).optional(),
    refusalCopy: z.string().min(1).max(1024).optional(),
    allowAnswerWhenEntitiesUnknown: z.boolean().optional(),
    // AnswerMeter wiring (#2296). Optional — when omitted the listener
    // simply doesn't emit meter rows.
    onMeterEvent: zCallback<ProactiveMeterEventFn>(
      "proactive.onMeterEvent must be a function returning Promise<void> | void",
    ).optional(),
    // Monthly quota wiring (#2301). Optional — when omitted no cap is
    // enforced and every message goes through the classifier.
    getQuotaStatus: zCallback<GetQuotaStatusFn>(
      "proactive.getQuotaStatus must be a function returning Promise<ProactiveQuotaStatus>",
    ).optional(),
    // WorkspaceInstallGate wiring (#2655). Discriminated union matching
    // the `answerFlow` / `killSwitch` / `feedback` pattern (#2623 item 1)
    // — half-wired states are compile-impossible. `{ enabled: false }`
    // is the safe default for hosts that haven't adopted the catalog
    // install model.
    installGate: InstallGateSchema,
  })
  // Fail loud on stale config keys. Removed in #2629 — surface the rename
  // at boot rather than silently no-op'ing in production.
  .strict()
  .optional();

const ChatCatalogEntrySchema = z
  .object({
    slug: z.string().regex(
      /^[a-z][a-z0-9-]*$/,
      "catalog entry slug must be lowercase alphanumeric with dashes",
    ),
    // #2665 — shared with @atlas/api via @useatlas/types so the
    // accepted literal set propagates from one source of truth.
    type: z.enum(CATALOG_ENTRY_TYPES),
    install_model: z.enum(CATALOG_INSTALL_MODELS),
    enabled: z.boolean(),
    saas_eligible: z.boolean(),
  })
  .strict();

export const ChatConfigSchema = z.object({
  // Catalog declaration (1.5.2 slice 2 — #2650). Optional at the schema
  // boundary so the chat plugin can boot in self-host without a catalog
  // (no chat adapters will activate; the plugin reports unhealthy via
  // healthCheck). The host typically passes `config.catalog` straight
  // through from `atlas.config.ts:catalog`.
  catalog: z.array(ChatCatalogEntrySchema).optional(),
  state: StateConfigSchema,
  slashCommandName: z
    .string()
    .regex(
      /^\/[a-z][a-z0-9-]*$/,
      "slashCommandName must start with '/' followed by lowercase alphanumeric characters or hyphens (e.g. '/atlas', '/data-query')",
    )
    .optional(),
  executeQuery: zCallback<ChatPluginConfig["executeQuery"]>(
    "executeQuery must be a function",
  ),
  checkRateLimit: zCallback<NonNullable<ChatPluginConfig["checkRateLimit"]>>(
    "checkRateLimit must be a function",
  ).optional(),
  scrubError: zCallback<NonNullable<ChatPluginConfig["scrubError"]>>(
    "scrubError must be a function",
  ).optional(),
  actions: zCustomObject<ActionCallbacks>(
    (v) =>
      v === undefined ||
      (typeof v === "object" &&
        v !== null &&
        typeof (v as Record<string, unknown>).approve === "function" &&
        typeof (v as Record<string, unknown>).deny === "function" &&
        typeof (v as Record<string, unknown>).get === "function"),
    "actions must implement { approve, deny, get }",
  ).optional(),
  conversations: zCustomObject<ConversationCallbacks>(
    (v) =>
      v === undefined ||
      (typeof v === "object" &&
        v !== null &&
        typeof (v as Record<string, unknown>).create === "function" &&
        typeof (v as Record<string, unknown>).addMessage === "function" &&
        typeof (v as Record<string, unknown>).get === "function" &&
        typeof (v as Record<string, unknown>).generateTitle === "function"),
    "conversations must implement { create, addMessage, get, generateTitle }",
  ).optional(),
  streaming: StreamingConfigSchema,
  fileUpload: FileUploadConfigSchema,
  reactions: ReactionConfigSchema,
  ephemeral: EphemeralConfigSchema,
  proactive: ProactiveConfigSchema,
  executeQueryStream: zCallback<NonNullable<ChatPluginConfig["executeQueryStream"]>>(
    "executeQueryStream must be a function",
  ).optional(),
  // #3704 — operator-tier credential resolver overlay. Optional async
  // callback; the host (`@atlas/api`) wires it to the operator-credentials
  // resolver. Must be in this `.strict()` schema or config load rejects the
  // key and boot crashes before HTTP binds (caught by Boot Smoke).
  resolveAdapterEnv: zCallback<NonNullable<ChatPluginConfig["resolveAdapterEnv"]>>(
    "resolveAdapterEnv must be a function returning Promise<Record<string, string | undefined>>",
  ).optional(),
  // #3750 — bridge-ready callback for chat resume-on-approval delivery.
  // Optional callback; the host (`@atlas/api`) wires it to (de)register the
  // chat resume-deliverer. Must be in this `.strict()` schema or config load
  // rejects the key and boot crashes before HTTP binds (caught by Boot Smoke).
  onBridgeReady: zCallback<NonNullable<ChatPluginConfig["onBridgeReady"]>>(
    "onBridgeReady must be a function",
  ).optional(),
}).strict().refine(
  (c) => {
    // Warn if streaming.enabled is explicitly true but executeQueryStream is missing
    if (c.streaming?.enabled === true && typeof c.executeQueryStream !== "function") {
      return false;
    }
    return true;
  },
  "streaming.enabled is true but executeQueryStream is not provided — streaming will not activate without executeQueryStream",
);
