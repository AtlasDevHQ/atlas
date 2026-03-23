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
    })
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
          typeof v.get === "function"),
      "conversations must implement { create, addMessage, get, generateTitle }",
    )
    .optional(),
});
