/**
 * Chat plugin configuration schema.
 *
 * Validates adapter credentials via Zod; runtime callbacks are validated
 * with refinements (TypeScript provides compile-time safety via
 * ChatPluginConfig).
 */

import { z } from "zod";
import type { StreamChunk } from "chat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in a conversation thread. */
export type ChatMessage = { role: "user" | "assistant"; content: string };

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
  botToken: string;
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
  };

  /** State backend configuration. Default: { backend: "memory" } */
  state?: StateConfig;

  /** Slash command name registered with the Chat SDK. Default: "/atlas".
   * Must start with "/" followed by a lowercase letter, then lowercase alphanumeric or hyphens. */
  slashCommandName?: string;

  /** Run the Atlas agent on a question and return structured results. Required. */
  executeQuery: (
    question: string,
    options?: {
      threadId?: string;
      priorMessages?: ChatMessage[];
    },
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
   * `executeQuery`. */
  executeQueryStream?: (
    question: string,
    options?: {
      threadId?: string;
      priorMessages?: ChatMessage[];
    },
  ) => StreamingQueryResult;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const SlackAdapterSchema = z.object({
  botToken: z.string().min(1, "slack botToken must not be empty"),
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
  executeQuery: z
    .any()
    .refine(
      (v) => typeof v === "function",
      "executeQuery must be a function",
    ),
  checkRateLimit: z
    .any()
    .refine(
      (v) => v === undefined || typeof v === "function",
      "checkRateLimit must be a function",
    )
    .optional(),
  scrubError: z
    .any()
    .refine(
      (v) => v === undefined || typeof v === "function",
      "scrubError must be a function",
    )
    .optional(),
  actions: z
    .any()
    .refine(
      (v) =>
        v === undefined ||
        (typeof v === "object" &&
          v !== null &&
          typeof v.approve === "function" &&
          typeof v.deny === "function" &&
          typeof v.get === "function"),
      "actions must implement { approve, deny, get }",
    )
    .optional(),
  conversations: z
    .any()
    .refine(
      (v) =>
        v === undefined ||
        (typeof v === "object" &&
          v !== null &&
          typeof v.create === "function" &&
          typeof v.addMessage === "function" &&
          typeof v.get === "function" &&
          typeof v.generateTitle === "function"),
      "conversations must implement { create, addMessage, get, generateTitle }",
    )
    .optional(),
  streaming: StreamingConfigSchema,
  executeQueryStream: z
    .any()
    .refine(
      (v) => v === undefined || typeof v === "function",
      "executeQueryStream must be a function",
    )
    .optional(),
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
