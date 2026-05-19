/**
 * Chat plugin configuration schema.
 *
 * Validates adapter credentials via Zod; runtime callbacks are validated
 * with refinements (TypeScript provides compile-time safety via
 * ChatPluginConfig).
 */

import { z } from "zod";
import type { StreamChunk } from "chat";
import type { ReactionConfig } from "./features/reactions";
import type {
  GetChannelConfigsFn,
  GetPublicDatasetFn,
  GetQuotaStatusFn,
  GetWorkspaceConfigFn,
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

/** Canonical chat platform names supported by the bridge.
 *
 * The chat SDK's `Adapter` interface types `name` as a bare `string`
 * because adapters are pluggable, but this plugin only loads the
 * adapters enumerated under `ChatPluginConfig["adapters"]` — narrowing
 * to the literal union here lets host `executeQuery` callbacks
 * type-narrow via `if (adapter.name !== "slack")` and forces every
 * `switch (adapter.name)` to be exhaustive at compile time. */
export type ChatAdapterName =
  | "slack"
  | "teams"
  | "discord"
  | "gchat"
  | "telegram"
  | "github"
  | "linear"
  | "whatsapp";

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

/** Adapter-specific credential configuration. */
export interface SlackAdapterConfig {
  /**
   * Single-workspace bot token. Omit in multi-workspace deploys so
   * `@chat-adapter/slack` resolves per-event tokens from its installation
   * store. Required when `clientId`+`clientSecret` are not set.
   */
  botToken?: string;
  signingSecret: string;
  /** Client ID for multi-workspace OAuth. */
  clientId?: string;
  /** Client secret for multi-workspace OAuth. */
  clientSecret?: string;
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
  /** Adapter credentials keyed by platform name. */
  adapters: {
    slack?: SlackAdapterConfig;
    teams?: TeamsAdapterConfig;
    discord?: DiscordAdapterConfig;
    gchat?: GoogleChatAdapterConfig;
    telegram?: TelegramAdapterConfig;
    github?: GitHubAdapterConfig;
    linear?: LinearAdapterConfig;
    whatsapp?: WhatsAppAdapterConfig;
  };

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

  // ---- Slice #2293 additions: reaction-to-answer flow ----

  /**
   * Resolves a chat-platform user to an Atlas user. Linked askers run
   * `executeQueryProactive` with their identity (RLS applies). Unlinked
   * askers receive the link-Atlas stub.
   */
  userResolver?: ProactiveUserResolver;
  /**
   * Runs the Atlas agent on behalf of a linked asker. Wired by the host
   * to `runAgent` / `runAgentEffect` with the asker's `AuthContext`.
   */
  executeQueryProactive?: ProactiveExecuteQuery;
  /** Deep link surfaced in the unlinked-asker prompt. */
  linkUrl?: string;
  /** Platform name (`"slack"` etc.) recorded in `ProactiveAsker`. */
  platform?: string;

  // ---- Slice #2298: feedback collection ----

  /**
   * Persists feedback from button clicks, the wrong-data modal, and
   * the `/atlas feedback <text>` slash subcommand. Host typically
   * writes to the meter / evals dataset.
   */
  feedbackCollector?: FeedbackCollectorFn;

  // ---- Slice #2297 additions: public dataset for unlinked askers ----

  /**
   * Host-injected fetch for the workspace's curated allowlist of
   * semantic entities a public-channel asker (not OAuth'd into Atlas)
   * is allowed to ask questions about. When omitted, the listener
   * keeps the unlinked-asker stub from #2293 — every unlinked-asker
   * answer attempt routes to the "link your Atlas account" prompt.
   */
  getPublicDataset?: GetPublicDatasetFn;
  /**
   * Override the default refusal copy posted when an unlinked asker
   * hits a question whose referenced entities aren't on the public
   * dataset. Defaults to `DEFAULT_PROACTIVE_REFUSAL_COPY` in
   * `proactive/types.ts`. Content-blind by design — never names the
   * entity the asker probed for.
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
  // (onMeterEvent declared below alongside the #2296 AnswerMeter wiring —
  //  shared callback covers the public_refused events from #2297.)

  // ---- Slice #2295 additions: kill switch + per-user opt-out ----
  //
  // Post-#2620 multi-tenant: workspaceId is resolved per event via
  // `resolveWorkspaceId` (above) and threaded into these callbacks at
  // the call site. The static `workspaceId?` field was removed.

  /**
   * Pause-registry read API. Host backs this with the API package's
   * `PauseRegistry` so the listener consults it BEFORE classification.
   */
  isPaused?: IsPausedFn;
  /**
   * Pause-registry write API. Called for in-channel `@atlas pause`
   * (24h channel scope) and DM `unsubscribe` (workspace-wide
   * user opt-out).
   */
  onPauseRequest?: OnPauseRequestFn;

  // ---- Slice #2296 additions: AnswerMeter ----

  /**
   * Per-event meter callback. Receives one event per classify (always)
   * and one per react / offer / accept / feedback when those stages
   * fire. Host wires this to `recordMeterEvent` from
   * `@atlas/api/lib/proactive/answer-meter` so rows land in
   * `proactive_meter_events`.
   */
  onMeterEvent?: ProactiveMeterEventFn;

  // ---- Slice #2301 additions: monthly quota cap ----

  /**
   * Quota-status reader. Consulted BEFORE the classifier on every
   * channel message — when the workspace has hit its monthly cap the
   * listener short-circuits and emits a `capReached` meter row instead
   * of running the LLM. Host wires this to
   * `getWorkspaceQuotaStatus` from
   * `@atlas/api/lib/proactive/quota`.
   */
  getQuotaStatus?: GetQuotaStatusFn;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const SlackAdapterSchema = z.object({
  // Optional: required for single-workspace mode (the adapter uses this
  // bare token for every outbound call). MULTI-WORKSPACE deploys OMIT
  // this field so `@chat-adapter/slack` resolves per-event tokens from
  // its installation store (state-adapter `slack:installation:<teamId>`).
  // A non-empty placeholder here puts the adapter in single-workspace
  // mode and the placeholder ends up as the bearer token → Slack rejects.
  botToken: z.string().min(1, "slack botToken must not be empty").optional(),
  signingSecret: z.string().min(1, "slack signingSecret must not be empty"),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
}).refine(
  (s) => (s.clientId == null) === (s.clientSecret == null),
  "clientId and clientSecret must both be provided for OAuth",
);

const TeamsAdapterSchema = z.object({
  appId: z.string().min(1, "teams appId must not be empty"),
  appPassword: z.string().min(1, "teams appPassword must not be empty"),
  tenantId: z.string().min(1).optional(),
});

const DiscordAdapterSchema = z.object({
  botToken: z.string().min(1, "discord botToken must not be empty"),
  applicationId: z.string().min(1, "discord applicationId must not be empty"),
  publicKey: z.string().regex(/^[0-9a-f]{64}$/i, "discord publicKey must be a 64-character hex string (Ed25519 public key from Discord Developer Portal)"),
  mentionRoleIds: z.array(z.string().min(1)).optional(),
});

const TelegramAdapterSchema = z.object({
  botToken: z.string().min(1, "telegram botToken must not be empty").regex(
    /^\d+:[A-Za-z0-9_-]{20,}$/,
    "telegram botToken must be in format '<bot-id>:<secret>' from BotFather",
  ),
  secretToken: z.string().min(1).optional(),
});

const GitHubAdapterSchema = z.object({
  token: z.string().min(1, "github token must not be empty").optional(),
  appId: z.string().min(1, "github appId must not be empty").optional(),
  privateKey: z.string().min(1, "github privateKey must not be empty").optional(),
  installationId: z.number().int().positive("github installationId must be a positive integer").optional(),
  webhookSecret: z.string().min(1, "github webhookSecret must not be empty").optional(),
  userName: z.string().min(1, "github userName must not be empty").optional(),
}).superRefine((c, ctx) => {
  if (c.token && c.appId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Cannot provide both token (PAT) and appId (GitHub App) — choose one auth mode",
    });
  }
  if (c.appId && !c.privateKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "appId requires privateKey for GitHub App auth",
      path: ["privateKey"],
    });
  }
  if (!c.appId && c.privateKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "privateKey requires appId for GitHub App auth",
      path: ["appId"],
    });
  }
  if (c.installationId && !c.appId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "installationId requires appId — it is only used with GitHub App auth",
      path: ["installationId"],
    });
  }
  if (!c.token && !c.appId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either token (PAT) or appId + privateKey (GitHub App) — at least one credential path is required",
    });
  }
});

const LinearAdapterSchema = z.object({
  apiKey: z.string().min(1, "linear apiKey must not be empty").optional(),
  accessToken: z.string().min(1, "linear accessToken must not be empty").optional(),
  clientId: z.string().min(1, "linear clientId must not be empty").optional(),
  clientSecret: z.string().min(1, "linear clientSecret must not be empty").optional(),
  webhookSecret: z.string().min(1, "linear webhookSecret must not be empty").optional(),
  userName: z.string().min(1, "linear userName must not be empty").optional(),
}).superRefine((c, ctx) => {
  const modes = [c.apiKey, c.accessToken, c.clientId].filter(Boolean).length;
  if (modes > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one auth mode: apiKey, accessToken, or clientId + clientSecret",
    });
  }
  if (c.clientId && !c.clientSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "clientId requires clientSecret for OAuth App auth",
      path: ["clientSecret"],
    });
  }
  if (!c.clientId && c.clientSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "clientSecret requires clientId for OAuth App auth",
      path: ["clientId"],
    });
  }
  if (!c.apiKey && !c.accessToken && !c.clientId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide apiKey, accessToken, or clientId + clientSecret — at least one credential path is required",
    });
  }
});

const WhatsAppAdapterSchema = z.object({
  phoneNumberId: z.string().min(1, "whatsapp phoneNumberId must not be empty"),
  accessToken: z.string().min(1, "whatsapp accessToken must not be empty"),
  verifyToken: z.string().min(1, "whatsapp verifyToken must not be empty"),
  appSecret: z.string().min(1, "whatsapp appSecret must not be empty"),
  userName: z.string().min(1).optional(),
  apiVersion: z.string().regex(
    /^v\d+\.\d+$/,
    "whatsapp apiVersion must be in format 'vN.N' (e.g. 'v21.0')",
  ).optional(),
});

const GoogleChatAdapterSchema = z.object({
  credentials: z.object({
    client_email: z.string().email("gchat credentials.client_email must be a valid email"),
    private_key: z.string().min(1, "gchat credentials.private_key must not be empty"),
    project_id: z.string().min(1).optional(),
  }).optional(),
  useApplicationDefaultCredentials: z.literal(true).optional(),
  endpointUrl: z.string().url("gchat endpointUrl must be a valid URL").optional(),
  pubsubTopic: z.string().regex(
    /^projects\/[^/]+\/topics\/[^/]+$/,
    "gchat pubsubTopic must be in format 'projects/{project}/topics/{topic}'",
  ).optional(),
  impersonateUser: z.string().email("gchat impersonateUser must be a valid email").optional(),
}).refine(
  (c) => !(c.credentials != null && c.useApplicationDefaultCredentials === true),
  "Provide either credentials or useApplicationDefaultCredentials, not both (or omit both for env-var auto-detection)",
);

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
    userResolver: zCallback<ProactiveUserResolver>(
      "proactive.userResolver must be a function",
    ).optional(),
    executeQueryProactive: zCallback<ProactiveExecuteQuery>(
      "proactive.executeQueryProactive must be a function",
    ).optional(),
    linkUrl: z.string().url("proactive.linkUrl must be a valid URL").optional(),
    platform: z.string().min(1).optional(),
    feedbackCollector: zCallback<FeedbackCollectorFn>(
      "proactive.feedbackCollector must be a function",
    ).optional(),
    // Public dataset wiring (#2297). All three optional — when
    // `getPublicDataset` is omitted, the listener keeps the
    // unlinked-asker stub from #2293 (link-Atlas prompt only).
    getPublicDataset: zCallback<GetPublicDatasetFn>(
      "proactive.getPublicDataset must be a function returning Promise<PublicDatasetEntry[]>",
    ).optional(),
    refusalCopy: z.string().min(1).max(1024).optional(),
    allowAnswerWhenEntitiesUnknown: z.boolean().optional(),
    // Kill-switch wiring (#2295). Both optional so the legacy env-var
    // allowlist mode (used by tests + dev) keeps working.
    isPaused: zCallback<IsPausedFn>(
      "proactive.isPaused must be a function returning Promise<PauseDecision>",
    ).optional(),
    onPauseRequest: zCallback<OnPauseRequestFn>(
      "proactive.onPauseRequest must be a function returning Promise<void>",
    ).optional(),
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
  })
  // Fail loud on stale config keys. Removed in #2629 — surface the rename
  // at boot rather than silently no-op'ing in production.
  .strict()
  .optional();

export const ChatConfigSchema = z.object({
  adapters: z
    .object({
      slack: SlackAdapterSchema.optional(),
      teams: TeamsAdapterSchema.optional(),
      discord: DiscordAdapterSchema.optional(),
      gchat: GoogleChatAdapterSchema.optional(),
      telegram: TelegramAdapterSchema.optional(),
      github: GitHubAdapterSchema.optional(),
      linear: LinearAdapterSchema.optional(),
      whatsapp: WhatsAppAdapterSchema.optional(),
    })
    .strict()
    .refine(
      (a) => Object.values(a).some((v) => v !== undefined),
      "At least one adapter must be configured",
    ),
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
}).refine(
  (c) => {
    // Warn if streaming.enabled is explicitly true but executeQueryStream is missing
    if (c.streaming?.enabled === true && typeof c.executeQueryStream !== "function") {
      return false;
    }
    return true;
  },
  "streaming.enabled is true but executeQueryStream is not provided — streaming will not activate without executeQueryStream",
);
