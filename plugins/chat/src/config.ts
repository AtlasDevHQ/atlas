/**
 * Chat plugin configuration schema.
 *
 * Validates adapter credentials via Zod; runtime callbacks are validated
 * with refinements (TypeScript provides compile-time safety via
 * ChatPluginConfig).
 */

import { z } from "zod";

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
  }): void;
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
  };

  /** State backend configuration. Default: { backend: "memory" } */
  state?: StateConfig;

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

export const ChatConfigSchema = z.object({
  adapters: z
    .object({
      slack: SlackAdapterSchema.optional(),
      teams: TeamsAdapterSchema.optional(),
      discord: DiscordAdapterSchema.optional(),
    })
    .strict()
    .refine(
      (a) => Object.values(a).some((v) => v !== undefined),
      "At least one adapter must be configured",
    ),
  state: StateConfigSchema,
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
});
