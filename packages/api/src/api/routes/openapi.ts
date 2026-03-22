/**
 * OpenAPI 3.1 specification endpoint.
 *
 * GET /api/v1/openapi.json returns the spec for the v1 API, with request/response schemas derived from Zod types.
 * The spec is built once on first request and cached thereafter.
 */

import { Hono } from "hono";
import { z } from "zod";
import { QueryRequestSchema, QueryResponseSchema } from "./query";
import { ChatRequestSchema } from "./chat";
import {
  ConversationWithMessagesSchema,
  ListConversationsResponseSchema,
  StarConversationBodySchema,
  ForkConversationBodySchema,
  NotebookStateBodySchema,
} from "./conversations";
import { DemoStartSchema, DemoChatRequestSchema } from "./demo";

const openapi = new Hono();

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reusable parameter definitions
// ---------------------------------------------------------------------------

const uuidPathParam = (name: string, description: string) => ({
  name,
  in: "path" as const,
  description,
  required: true,
  schema: { type: "string", format: "uuid" },
});

const paginationParams = (defaults?: { limit?: number; maxLimit?: number }) => [
  {
    name: "limit",
    in: "query" as const,
    description: `Maximum number of items to return (1-${defaults?.maxLimit ?? 100}, default ${defaults?.limit ?? 20}).`,
    required: false,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: defaults?.maxLimit ?? 100,
      default: defaults?.limit ?? 20,
    },
  },
  {
    name: "offset",
    in: "query" as const,
    description: "Number of items to skip (default 0).",
    required: false,
    schema: { type: "integer", minimum: 0, default: 0 },
  },
];

function buildSpec(): Record<string, unknown> {
  const ErrorSchema = z.object({
    error: z.string(),
    message: z.string(),
  });

  const ValidationErrorSchema = z.object({
    error: z.literal("validation_error"),
    message: z.string(),
    details: z.array(z.unknown()),
  });

  const RateLimitErrorSchema = ErrorSchema.extend({
    retryAfterSeconds: z.number().int(),
  });

  const errorResponse = (
    description: string,
    schema: z.ZodType = ErrorSchema,
  ) => ({
    description,
    content: { "application/json": { schema: toJsonSchema(schema) } },
  });

  // Common error responses shared across most routes
  const authErrors = {
    "401": errorResponse("Authentication required"),
    "403": errorResponse("Forbidden — insufficient permissions"),
    "429": errorResponse("Rate limit exceeded", RateLimitErrorSchema),
    "500": errorResponse("Internal server error"),
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Atlas API",
      version: "0.1.0",
      description:
        "Text-to-SQL data analyst agent. Ask natural-language questions about your data and receive structured answers.",
    },
    servers: [
      {
        url: "http://localhost:3001",
        description: "Standalone API (development)",
      },
      {
        url: "http://localhost:3000",
        description: "Same-origin via Next.js rewrites",
      },
    ],
    paths: {
      // -----------------------------------------------------------------
      // POST /api/v1/chat — Streaming chat (SSE)
      // -----------------------------------------------------------------
      "/api/v1/chat": {
        post: {
          operationId: "chatStream",
          summary: "Chat with the agent (streaming)",
          description:
            "Sends a conversation to the Atlas agent and streams the response as Server-Sent Events using the Vercel AI SDK UI message stream protocol. " +
            "Each SSE event is a JSON object with a 'type' field: 'text-delta' for incremental text, 'tool-call' for tool invocations, " +
            "'tool-result' for tool outputs, 'step-start' for new agent steps, and 'finish' for completion. " +
            "The response includes an `x-conversation-id` header when conversation persistence is enabled.",
          tags: ["Chat"],
          security: [{ bearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(ChatRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description:
                "Streaming response. The body is a text/event-stream following the Vercel AI SDK data stream protocol.",
              headers: {
                "x-conversation-id": {
                  description:
                    "Present when conversation persistence is active and the conversation was successfully created or located.",
                  schema: { type: "string", format: "uuid" },
                  required: false,
                },
              },
              content: {
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description:
                      "SSE stream using the Vercel AI SDK UI message stream protocol. Each event is a JSON object with a 'type' field (text-delta, tool-call, tool-result, step-start, finish).",
                  },
                },
              },
            },
            "400": errorResponse(
              "Bad request (malformed JSON, missing datasource, or invalid conversationId)",
            ),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Forbidden — insufficient permissions"),
            "404": errorResponse(
              "Conversation not found (invalid conversationId)",
            ),
            "422": errorResponse(
              "Validation error (invalid request body)",
              ValidationErrorSchema,
            ),
            "429": errorResponse(
              "Rate limit exceeded",
              RateLimitErrorSchema,
            ),
            "500": errorResponse("Internal server error"),
            "502": errorResponse("LLM provider error"),
            "503": errorResponse(
              "Provider unreachable, auth error, or rate limited",
            ),
            "504": errorResponse("Request timed out"),
          },
        },
      },

      // -----------------------------------------------------------------
      // POST /api/v1/query — Synchronous JSON query
      // -----------------------------------------------------------------
      "/api/v1/query": {
        post: {
          operationId: "query",
          summary: "Ask a question",
          description:
            "Runs the Atlas agent to completion and returns a structured JSON response with the answer, SQL queries executed, result data, step count, and token usage.",
          tags: ["Query"],
          security: [{ bearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(QueryRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Successful query response",
              content: {
                "application/json": {
                  schema: toJsonSchema(QueryResponseSchema),
                },
              },
            },
            "400": errorResponse(
              "Bad request (malformed JSON or missing datasource)",
            ),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Forbidden — insufficient permissions"),
            "422": errorResponse(
              "Validation error (invalid request body)",
              ValidationErrorSchema,
            ),
            "429": errorResponse(
              "Rate limit exceeded",
              RateLimitErrorSchema,
            ),
            "500": errorResponse("Internal server error"),
            "502": errorResponse("LLM provider error"),
            "503": errorResponse(
              "Provider unreachable, auth error, or rate limited",
            ),
            "504": errorResponse("Request timed out"),
          },
        },
      },

      // -----------------------------------------------------------------
      // GET /api/v1/conversations — List conversations
      // -----------------------------------------------------------------
      "/api/v1/conversations": {
        get: {
          operationId: "listConversations",
          summary: "List conversations",
          description:
            "Returns a paginated list of conversations for the authenticated user. Requires an internal database (DATABASE_URL).",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            ...paginationParams(),
            {
              name: "starred",
              in: "query",
              description: "Filter by starred status.",
              required: false,
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": {
              description: "Paginated list of conversations",
              content: {
                "application/json": {
                  schema: toJsonSchema(ListConversationsResponseSchema),
                },
              },
            },
            ...authErrors,
            "404": errorResponse(
              "Not available (no internal database configured)",
            ),
          },
        },
      },

      // -----------------------------------------------------------------
      // GET/DELETE /api/v1/conversations/{id}
      // -----------------------------------------------------------------
      "/api/v1/conversations/{id}": {
        get: {
          operationId: "getConversation",
          summary: "Get conversation with messages",
          description:
            "Returns a single conversation with all its messages. Enforces ownership when auth is enabled.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          responses: {
            "200": {
              description: "Conversation with messages",
              content: {
                "application/json": {
                  schema: toJsonSchema(ConversationWithMessagesSchema),
                },
              },
            },
            "400": errorResponse("Invalid conversation ID format"),
            ...authErrors,
            "404": errorResponse(
              "Conversation not found or not available",
            ),
          },
        },
        delete: {
          operationId: "deleteConversation",
          summary: "Delete a conversation",
          description:
            "Deletes a conversation and all its messages. Enforces ownership when auth is enabled.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          responses: {
            "204": {
              description: "Conversation deleted successfully",
            },
            "400": errorResponse("Invalid conversation ID format"),
            ...authErrors,
            "404": errorResponse(
              "Conversation not found or not available",
            ),
          },
        },
      },

      // -----------------------------------------------------------------
      // PATCH /api/v1/conversations/{id}/star
      // -----------------------------------------------------------------
      "/api/v1/conversations/{id}/star": {
        patch: {
          operationId: "starConversation",
          summary: "Star or unstar a conversation",
          description: "Sets the starred status of a conversation.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(StarConversationBodySchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Star status updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      starred: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid conversation ID or request body"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
      },

      // -----------------------------------------------------------------
      // POST /api/v1/conversations/{id}/fork
      // -----------------------------------------------------------------
      "/api/v1/conversations/{id}/fork": {
        post: {
          operationId: "forkConversation",
          summary: "Fork a conversation at a specific message",
          description:
            "Creates a new conversation by forking an existing one at the specified message. " +
            "Messages up to and including the fork point are copied to the new conversation. " +
            "Branch metadata is saved to both the source and forked conversation's notebook state.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Source conversation UUID."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(ForkConversationBodySchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Fork created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid", description: "New conversation UUID." },
                      messageCount: { type: "integer", description: "Number of messages copied." },
                      branches: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            conversationId: { type: "string", format: "uuid" },
                            forkPointCellId: { type: "string" },
                            label: { type: "string" },
                            createdAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                      warning: { type: "string", description: "Present if branch metadata could not be fully saved." },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid conversation ID or request body"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
      },

      // -----------------------------------------------------------------
      // PATCH /api/v1/conversations/{id}/notebook-state
      // -----------------------------------------------------------------
      "/api/v1/conversations/{id}/notebook-state": {
        patch: {
          operationId: "updateNotebookState",
          summary: "Update notebook state",
          description:
            "Updates the notebook state of a conversation, including cell order, cell properties, and branch metadata.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(NotebookStateBodySchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Notebook state updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      notebookState: { type: "object" },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid conversation ID or notebook state body"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Actions — approval-gated write operations
      // -----------------------------------------------------------------
      "/api/v1/actions": {
        get: {
          operationId: "listActions",
          summary: "List actions",
          description:
            "Returns actions filtered by status. Requires ATLAS_ACTIONS_ENABLED=true and an internal database.",
          tags: ["Actions"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: "status",
              in: "query",
              description: "Filter by action status (default: pending).",
              required: false,
              schema: {
                type: "string",
                enum: ["pending", "approved", "denied", "executed", "failed", "timed_out", "auto_approved"],
                default: "pending",
              },
            },
            {
              name: "limit",
              in: "query",
              description: "Maximum number of actions to return (1-100, default 50).",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            "200": {
              description: "List of actions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      actions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            action_type: { type: "string" },
                            target: { type: "string" },
                            summary: { type: "string" },
                            status: { type: "string", enum: ["pending", "approved", "denied", "executed", "failed", "timed_out", "auto_approved"] },
                            requested_by: { type: "string" },
                            created_at: { type: "string", format: "date-time" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...authErrors,
            "404": errorResponse("Actions not available (no internal database or feature disabled)"),
          },
        },
      },

      "/api/v1/actions/{id}": {
        get: {
          operationId: "getAction",
          summary: "Get action by ID",
          description: "Returns a single action. Only returns actions requested by the authenticated user.",
          tags: ["Actions"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [uuidPathParam("id", "Action UUID.")],
          responses: {
            "200": {
              description: "Action details",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid action ID format"),
            ...authErrors,
            "404": errorResponse("Action not found"),
          },
        },
      },

      "/api/v1/actions/{id}/approve": {
        post: {
          operationId: "approveAction",
          summary: "Approve a pending action",
          description:
            "Approves a pending action and triggers execution. Returns the updated action with results. " +
            "For admin-only approval mode, the requester cannot approve their own action (separation of duties).",
          tags: ["Actions"],
          security: [{ bearerAuth: [] }],
          parameters: [uuidPathParam("id", "Action UUID.")],
          responses: {
            "200": {
              description: "Action approved and execution result",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid action ID format"),
            ...authErrors,
            "404": errorResponse("Action not found"),
            "409": errorResponse("Action has already been resolved"),
          },
        },
      },

      "/api/v1/actions/{id}/deny": {
        post: {
          operationId: "denyAction",
          summary: "Deny a pending action",
          description:
            "Denies a pending action. Optionally provide a reason in the request body. " +
            "For admin-only approval mode, the requester cannot deny their own action.",
          tags: ["Actions"],
          security: [{ bearerAuth: [] }],
          parameters: [uuidPathParam("id", "Action UUID.")],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    reason: { type: "string", description: "Optional denial reason." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Action denied",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid action ID or request body"),
            ...authErrors,
            "404": errorResponse("Action not found"),
            "409": errorResponse("Action has already been resolved"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Scheduled Tasks
      // -----------------------------------------------------------------
      "/api/v1/scheduled-tasks": {
        get: {
          operationId: "listScheduledTasks",
          summary: "List scheduled tasks",
          description:
            "Returns scheduled tasks owned by the authenticated user. Requires ATLAS_SCHEDULER_ENABLED=true and an internal database.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            ...paginationParams(),
            {
              name: "enabled",
              in: "query",
              description: "Filter by enabled status.",
              required: false,
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": {
              description: "Paginated list of scheduled tasks",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
            "404": errorResponse("Scheduled tasks not available (no internal database or feature disabled)"),
          },
        },
        post: {
          operationId: "createScheduledTask",
          summary: "Create a scheduled task",
          description:
            "Creates a recurring query task with a cron schedule and delivery channel.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "question", "cronExpression"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 200, description: "Task name." },
                    question: { type: "string", minLength: 1, maxLength: 2000, description: "Natural language question." },
                    cronExpression: { type: "string", description: "Cron schedule (e.g. '0 9 * * *')." },
                    deliveryChannel: { type: "string", enum: ["email", "slack", "webhook"], default: "webhook", description: "Delivery channel." },
                    recipients: {
                      type: "array",
                      description: "Delivery targets.",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string", enum: ["email", "slack", "webhook"] },
                          address: { type: "string", description: "Email address (for email type)." },
                          channel: { type: "string", description: "Slack channel (for slack type)." },
                          teamId: { type: "string", description: "Slack team ID (for slack type)." },
                          url: { type: "string", description: "Webhook URL (for webhook type)." },
                          headers: { type: "object", additionalProperties: { type: "string" }, description: "Custom headers (for webhook type)." },
                        },
                      },
                    },
                    connectionId: { type: "string", nullable: true, description: "Target datasource connection." },
                    approvalMode: { type: "string", enum: ["auto", "manual", "admin-only"], default: "auto", description: "Action approval mode." },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Scheduled task created",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid request body or cron expression"),
            ...authErrors,
            "404": errorResponse("Feature not available"),
          },
        },
      },

      "/api/v1/scheduled-tasks/tick": {
        post: {
          operationId: "schedulerTick",
          summary: "Trigger scheduler tick",
          description:
            "Serverless scheduler tick endpoint for Vercel Cron or external cron services. " +
            "Checks for due tasks and executes them. Requires CRON_SECRET or ATLAS_SCHEDULER_SECRET.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Tick completed",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "401": errorResponse("Invalid or missing cron secret"),
            "500": errorResponse("Tick execution failed"),
          },
        },
      },

      "/api/v1/scheduled-tasks/{id}": {
        get: {
          operationId: "getScheduledTask",
          summary: "Get scheduled task",
          description: "Returns a scheduled task with its 10 most recent runs.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [uuidPathParam("id", "Task UUID.")],
          responses: {
            "200": {
              description: "Scheduled task with recent runs",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid task ID format"),
            ...authErrors,
            "404": errorResponse("Task not found"),
          },
        },
        put: {
          operationId: "updateScheduledTask",
          summary: "Update a scheduled task",
          description: "Updates a scheduled task. All fields are optional.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }],
          parameters: [uuidPathParam("id", "Task UUID.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 200 },
                    question: { type: "string", minLength: 1, maxLength: 2000 },
                    cronExpression: { type: "string" },
                    deliveryChannel: { type: "string", enum: ["email", "slack", "webhook"] },
                    recipients: { type: "array", items: { type: "object" } },
                    connectionId: { type: "string", nullable: true },
                    approvalMode: { type: "string", enum: ["auto", "manual", "admin-only"] },
                    enabled: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated scheduled task",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid request body or cron expression"),
            ...authErrors,
            "404": errorResponse("Task not found"),
          },
        },
        delete: {
          operationId: "deleteScheduledTask",
          summary: "Delete a scheduled task",
          description: "Soft-deletes (disables) a scheduled task.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }],
          parameters: [uuidPathParam("id", "Task UUID.")],
          responses: {
            "204": { description: "Task deleted successfully" },
            "400": errorResponse("Invalid task ID format"),
            ...authErrors,
            "404": errorResponse("Task not found"),
          },
        },
      },

      "/api/v1/scheduled-tasks/{id}/run": {
        post: {
          operationId: "triggerScheduledTask",
          summary: "Trigger immediate execution",
          description: "Triggers an immediate execution of a scheduled task.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }],
          parameters: [uuidPathParam("id", "Task UUID.")],
          responses: {
            "200": {
              description: "Task triggered",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      taskId: { type: "string", format: "uuid" },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid task ID format"),
            ...authErrors,
            "404": errorResponse("Task not found"),
          },
        },
      },

      "/api/v1/scheduled-tasks/{id}/runs": {
        get: {
          operationId: "listTaskRuns",
          summary: "List task runs",
          description: "Returns past execution runs for a scheduled task.",
          tags: ["Scheduled Tasks"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Task UUID."),
            {
              name: "limit",
              in: "query",
              description: "Maximum number of runs to return (1-100, default 20).",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            "200": {
              description: "List of task runs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      runs: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid task ID format"),
            ...authErrors,
            "404": errorResponse("Task not found"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Auth — Better Auth routes (key endpoints)
      // -----------------------------------------------------------------
      "/api/auth/sign-up/email": {
        post: {
          operationId: "signUpEmail",
          summary: "Sign up with email",
          description:
            "Creates a new user account with email and password. Only available when auth mode is 'managed' (Better Auth).",
          tags: ["Auth"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "name"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "User created successfully",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid request"),
            "404": errorResponse("Auth routes not enabled (not in managed mode)"),
          },
        },
      },

      "/api/auth/sign-in/email": {
        post: {
          operationId: "signInEmail",
          summary: "Sign in with email",
          description:
            "Authenticates a user with email and password. Returns a session token. Only available when auth mode is 'managed'.",
          tags: ["Auth"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Session created",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "401": errorResponse("Invalid credentials"),
            "404": errorResponse("Auth routes not enabled"),
          },
        },
      },

      "/api/auth/get-session": {
        get: {
          operationId: "getSession",
          summary: "Get current session",
          description:
            "Returns the current session and user info. Requires a valid session cookie or Authorization header.",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Current session",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "401": errorResponse("Not authenticated"),
            "404": errorResponse("Auth routes not enabled"),
          },
        },
      },

      "/api/auth/sign-out": {
        post: {
          operationId: "signOut",
          summary: "Sign out",
          description: "Destroys the current session.",
          tags: ["Auth"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Session destroyed" },
            "404": errorResponse("Auth routes not enabled"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Slack integration
      // -----------------------------------------------------------------
      "/api/v1/slack/commands": {
        post: {
          operationId: "slackCommand",
          summary: "Slack slash command",
          description:
            "Handles Slack slash commands (/atlas). Acks within 3 seconds and processes the query asynchronously. " +
            "Requires SLACK_SIGNING_SECRET. Request signature is verified.",
          tags: ["Slack"],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "The question text." },
                    channel_id: { type: "string" },
                    user_id: { type: "string" },
                    team_id: { type: "string" },
                    response_url: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Immediate acknowledgment (processing continues asynchronously)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      response_type: { type: "string" },
                      text: { type: "string" },
                    },
                  },
                },
              },
            },
            "401": errorResponse("Invalid Slack signature"),
          },
        },
      },

      "/api/v1/slack/events": {
        post: {
          operationId: "slackEvents",
          summary: "Slack Events API",
          description:
            "Handles Slack Events API callbacks including url_verification challenges and thread follow-up messages. " +
            "Bot messages are ignored to prevent loops.",
          tags: ["Slack"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["url_verification", "event_callback"] },
                    challenge: { type: "string", description: "Verification challenge (url_verification only)." },
                    event: { type: "object", description: "The Slack event payload." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Event acknowledged",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      challenge: { type: "string", description: "Echoed challenge (url_verification only)." },
                    },
                  },
                },
              },
            },
            "401": errorResponse("Invalid Slack signature"),
          },
        },
      },

      "/api/v1/slack/install": {
        get: {
          operationId: "slackInstall",
          summary: "Slack OAuth install",
          description:
            "Redirects to the Slack OAuth authorization page. Requires SLACK_CLIENT_ID to be configured.",
          tags: ["Slack"],
          responses: {
            "302": { description: "Redirect to Slack OAuth authorization page" },
            "501": errorResponse("OAuth not configured"),
          },
        },
      },

      "/api/v1/slack/callback": {
        get: {
          operationId: "slackCallback",
          summary: "Slack OAuth callback",
          description:
            "Handles the OAuth callback from Slack, exchanges the code for a bot token, and saves the installation.",
          tags: ["Slack"],
          parameters: [
            { name: "code", in: "query", required: true, schema: { type: "string" }, description: "OAuth authorization code." },
            { name: "state", in: "query", required: true, schema: { type: "string" }, description: "CSRF state parameter." },
          ],
          responses: {
            "200": {
              description: "Installation successful (HTML response)",
              content: { "text/html": { schema: { type: "string" } } },
            },
            "400": errorResponse("Invalid or expired state, or missing code"),
            "500": { description: "Installation failed (HTML response)", content: { "text/html": { schema: { type: "string" } } } },
            "501": errorResponse("OAuth not configured"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Suggestions — user-facing query suggestions
      // -----------------------------------------------------------------
      "/api/v1/suggestions": {
        get: {
          operationId: "listSuggestions",
          summary: "Get contextual suggestions",
          description:
            "Returns query suggestions for one or more tables, ordered by score. Requires at least one 'table' query parameter.",
          tags: ["Suggestions"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: "table",
              in: "query",
              description: "Table name to get suggestions for. Can be repeated for multiple tables.",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              description: "Maximum number of suggestions to return (1-50, default 10).",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
          ],
          responses: {
            "200": {
              description: "List of suggestions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      suggestions: { type: "array", items: { type: "object" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Missing table parameter",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
            "401": {
              description: "Authentication required",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },

      "/api/v1/suggestions/popular": {
        get: {
          operationId: "listPopularSuggestions",
          summary: "Get popular suggestions",
          description:
            "Returns the top query suggestions across all tables, ordered by score.",
          tags: ["Suggestions"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Maximum number of suggestions to return (1-50, default 10).",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
          ],
          responses: {
            "200": {
              description: "List of popular suggestions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      suggestions: { type: "array", items: { type: "object" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Authentication required",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },

      "/api/v1/suggestions/{id}/click": {
        post: {
          operationId: "trackSuggestionClick",
          summary: "Track suggestion click",
          description:
            "Tracks user engagement with a suggestion. Fire-and-forget — always returns 204 on success.",
          tags: ["Suggestions"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Suggestion ID." },
          ],
          responses: {
            "204": { description: "Click tracked (fire-and-forget)" },
            "401": {
              description: "Authentication required",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { error: { type: "string" } },
                  },
                },
              },
            },
            "429": { description: "Rate limit exceeded (empty body)" },
          },
        },
      },

      // -----------------------------------------------------------------
      // Prompts — user-facing prompt library
      // -----------------------------------------------------------------
      "/api/v1/prompts": {
        get: {
          operationId: "listPromptCollections",
          summary: "List prompt collections",
          description:
            "Returns prompt collections available to the current user: built-in collections plus any belonging to the user's organization.",
          tags: ["Prompts"],
          security: [{ bearerAuth: [] }, {}],
          responses: {
            "200": {
              description: "List of prompt collections",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collections: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/prompts/{id}": {
        get: {
          operationId: "getPromptCollection",
          summary: "Get prompt collection with items",
          description:
            "Returns a single prompt collection with all its items, ordered by sort_order.",
          tags: ["Prompts"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Collection ID." },
          ],
          responses: {
            "200": {
              description: "Collection with items",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collection: { type: "object" },
                      items: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            ...authErrors,
            "404": errorResponse("Prompt collection not found"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Sessions — user self-service session management
      // -----------------------------------------------------------------
      "/api/v1/sessions": {
        get: {
          operationId: "listSessions",
          summary: "List current user's sessions",
          description:
            "Returns all sessions for the authenticated user. Requires managed auth mode and an internal database.",
          tags: ["Sessions"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of user sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" },
                            expiresAt: { type: "string", format: "date-time" },
                            ipAddress: { type: "string", nullable: true },
                            userAgent: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...authErrors,
            "404": errorResponse("Session management requires managed auth mode"),
          },
        },
      },

      "/api/v1/sessions/{id}": {
        delete: {
          operationId: "revokeSession",
          summary: "Revoke a session",
          description:
            "Revokes one of the current user's sessions. Cannot revoke another user's session.",
          tags: ["Sessions"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session ID." },
          ],
          responses: {
            "200": {
              description: "Session revoked",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { success: { type: "boolean" } },
                  },
                },
              },
            },
            ...authErrors,
            "403": errorResponse("Cannot revoke another user's session"),
            "404": errorResponse("Session not found or not in managed auth mode"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Conversation sharing endpoints
      // -----------------------------------------------------------------
      "/api/v1/conversations/{id}/share": {
        get: {
          operationId: "getShareStatus",
          summary: "Get conversation share status",
          description:
            "Returns whether a conversation is currently shared and its share link details.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          responses: {
            "200": {
              description: "Share status",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        type: "object",
                        properties: { shared: { type: "boolean", enum: [false] } },
                      },
                      {
                        type: "object",
                        properties: {
                          shared: { type: "boolean", enum: [true] },
                          token: { type: "string" },
                          url: { type: "string", format: "uri" },
                          expiresAt: { type: "string", format: "date-time", nullable: true },
                          shareMode: { type: "string", enum: ["public", "org"] },
                        },
                      },
                    ],
                  },
                },
              },
            },
            "400": errorResponse("Invalid conversation ID format"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
        post: {
          operationId: "shareConversation",
          summary: "Generate share link",
          description:
            "Creates a shareable link for a conversation. Optionally specify expiry duration and share mode (public or org-only).",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    expiresIn: { type: "string", enum: ["1h", "24h", "7d", "30d", "never"], description: "Share link expiry duration." },
                    shareMode: { type: "string", enum: ["public", "org"], description: "Share visibility mode." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Share link created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string" },
                      url: { type: "string", format: "uri" },
                      expiresAt: { type: "string", format: "date-time", nullable: true },
                      shareMode: { type: "string", enum: ["public", "org"] },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid conversation ID or share options"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
        delete: {
          operationId: "unshareConversation",
          summary: "Revoke share link",
          description: "Revokes the share link for a conversation, making it private again.",
          tags: ["Conversations"],
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          responses: {
            "204": { description: "Share link revoked" },
            "400": errorResponse("Invalid conversation ID format"),
            ...authErrors,
            "404": errorResponse("Conversation not found or not available"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Public shared conversation (no auth required)
      // -----------------------------------------------------------------
      "/api/public/conversations/{token}": {
        get: {
          operationId: "getSharedConversation",
          summary: "View a shared conversation",
          description:
            "Returns the content of a shared conversation. No authentication required for public shares. Org-scoped shares require authentication. Rate limited per IP.",
          tags: ["Conversations"],
          security: [],
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{20,64}$" }, description: "Share token." },
          ],
          responses: {
            "200": {
              description: "Shared conversation content",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string", nullable: true },
                      surface: { type: "string" },
                      createdAt: { type: "string", format: "date-time" },
                      shareMode: { type: "string", enum: ["public", "org"] },
                      messages: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            role: { type: "string" },
                            content: {},
                            createdAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": errorResponse("Org-scoped share requires authentication"),
            "404": errorResponse("Conversation not found"),
            "410": errorResponse("Share link has expired"),
            "429": errorResponse("Rate limit exceeded"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Onboarding — self-serve signup flow
      // -----------------------------------------------------------------
      "/api/v1/onboarding/social-providers": {
        get: {
          operationId: "getOnboardingSocialProviders",
          summary: "List enabled social login providers",
          description:
            "Returns which OAuth providers (Google, GitHub, Microsoft) are configured so the signup page can render the correct buttons. Public endpoint — no authentication required.",
          tags: ["Onboarding"],
          security: [],
          responses: {
            "200": {
              description: "List of enabled social providers",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      providers: {
                        type: "array",
                        items: { type: "string", enum: ["google", "github", "microsoft"] },
                        description: "Provider names with both CLIENT_ID and CLIENT_SECRET configured.",
                      },
                    },
                    required: ["providers"],
                  },
                },
              },
            },
          },
        },
      },

      "/api/v1/onboarding/test-connection": {
        post: {
          operationId: "testOnboardingConnection",
          summary: "Test a database connection",
          description:
            "Validates the URL scheme, creates a temporary connection, runs a health check, and returns the result. " +
            "The connection is not persisted. Requires managed auth mode and an authenticated session.",
          tags: ["Onboarding"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", description: "Database connection URL (postgresql:// or mysql://)" },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Connection test result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", description: "Connection health status" },
                      latencyMs: { type: "number", description: "Connection latency in milliseconds" },
                      dbType: { type: "string", description: "Detected database type (postgresql or mysql)" },
                      maskedUrl: { type: "string", description: "Connection URL with credentials redacted" },
                    },
                    required: ["status", "latencyMs", "dbType", "maskedUrl"],
                  },
                },
              },
            },
            "400": errorResponse("Invalid URL scheme or connection test failed"),
            "401": errorResponse("Authentication required"),
            "404": errorResponse("Onboarding requires managed auth mode"),
          },
        },
      },

      "/api/v1/onboarding/complete": {
        post: {
          operationId: "completeOnboarding",
          summary: "Complete workspace setup",
          description:
            "Finalizes onboarding by testing the connection, encrypting the URL, and persisting it to the internal database " +
            "scoped to the user's active organization. Resets the semantic layer whitelist cache so new tables become queryable immediately.",
          tags: ["Onboarding"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", description: "Database connection URL (postgresql:// or mysql://)" },
                    connectionId: {
                      type: "string",
                      description: "Optional connection ID (defaults to \"default\"). Lowercase alphanumeric, hyphens, underscores, 2-64 chars.",
                    },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Connection saved and workspace setup complete",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      connectionId: { type: "string", description: "The connection ID (\"default\" or custom)" },
                      dbType: { type: "string", description: "Detected database type" },
                      maskedUrl: { type: "string", description: "Connection URL with credentials redacted" },
                    },
                    required: ["connectionId", "dbType", "maskedUrl"],
                  },
                },
              },
            },
            "400": errorResponse("Invalid URL, connection test failed, or no active organization"),
            "401": errorResponse("Authentication required"),
            "404": errorResponse("Onboarding requires managed auth mode and DATABASE_URL"),
            "409": errorResponse("Connection ID already in use by another organization"),
            "500": errorResponse("Failed to encrypt or save connection"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Demo — email-gated public demo
      // -----------------------------------------------------------------
      "/api/v1/demo/start": {
        post: {
          operationId: "demoStart",
          summary: "Start a demo session",
          description:
            "Email-gated demo entry point. Validates the email, signs a short-lived demo JWT, and captures the lead. " +
            "IP-based rate limiting prevents abuse. Returns a token for subsequent demo API calls.",
          tags: ["Demo"],
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(DemoStartSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Demo session started",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string", description: "Demo JWT token for subsequent requests" },
                      expiresAt: { type: "string", format: "date-time", description: "Token expiry timestamp" },
                      returning: { type: "boolean", description: "Whether this email has been seen before" },
                      conversationCount: { type: "integer", description: "Number of existing demo conversations for this email" },
                    },
                    required: ["token", "expiresAt", "returning", "conversationCount"],
                  },
                },
              },
            },
            "400": errorResponse("Invalid JSON body"),
            "422": errorResponse("Validation error (invalid email)", ValidationErrorSchema),
            "429": errorResponse("Rate limit exceeded (IP-based)", RateLimitErrorSchema),
            "500": errorResponse("Demo mode not properly configured"),
          },
        },
      },

      "/api/v1/demo/chat": {
        post: {
          operationId: "demoChat",
          summary: "Chat in demo mode",
          description:
            "Mirrors the main chat endpoint with demo-specific limits. Requires a valid demo token from /demo/start. " +
            "Streams the response as Server-Sent Events using the Vercel AI SDK UI message stream protocol. " +
            "Demo conversations are persisted when an internal database is available.",
          tags: ["Demo"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(DemoChatRequestSchema),
              },
            },
          },
          responses: {
            "200": {
              description: "Streaming response (SSE)",
              headers: {
                "x-conversation-id": {
                  description: "Conversation UUID when persistence is active.",
                  schema: { type: "string", format: "uuid" },
                  required: false,
                },
              },
              content: {
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description: "SSE stream using the Vercel AI SDK UI message stream protocol.",
                  },
                },
              },
            },
            "400": errorResponse("Bad request (malformed JSON, missing datasource, configuration error, or model not found)"),
            "401": errorResponse("Valid demo token required"),
            "404": errorResponse("Conversation not found (invalid conversationId)"),
            "422": errorResponse("Validation error (invalid request body)", ValidationErrorSchema),
            "429": errorResponse("Demo rate limit exceeded", RateLimitErrorSchema),
            "500": errorResponse("Internal server error"),
            "502": errorResponse("LLM provider error"),
            "503": errorResponse("Provider unreachable, auth error, or rate limited"),
            "504": errorResponse("Request timed out"),
          },
        },
      },

      "/api/v1/demo/conversations": {
        get: {
          operationId: "listDemoConversations",
          summary: "List demo conversations",
          description:
            "Returns a paginated list of conversations for the demo user identified by their demo token. " +
            "Returns an empty list when no internal database is configured.",
          tags: ["Demo"],
          security: [{ bearerAuth: [] }],
          parameters: [
            ...paginationParams({ limit: 50, maxLimit: 100 }),
          ],
          responses: {
            "200": {
              description: "Paginated list of demo conversations",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      conversations: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            userId: { type: "string" },
                            title: { type: "string", nullable: true },
                            surface: { type: "string" },
                            starred: { type: "boolean" },
                            connectionId: { type: "string", nullable: true },
                            notebookState: { type: "object", nullable: true },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": errorResponse("Valid demo token required"),
            "500": errorResponse("Failed to load conversations"),
          },
        },
      },

      "/api/v1/demo/conversations/{id}": {
        get: {
          operationId: "getDemoConversation",
          summary: "Get a demo conversation",
          description:
            "Returns a single demo conversation with all its messages. Requires a valid demo token and enforces ownership.",
          tags: ["Demo"],
          security: [{ bearerAuth: [] }],
          parameters: [
            uuidPathParam("id", "Conversation UUID."),
          ],
          responses: {
            "200": {
              description: "Conversation with messages",
              content: {
                "application/json": {
                  schema: toJsonSchema(ConversationWithMessagesSchema),
                },
              },
            },
            "401": errorResponse("Valid demo token required"),
            "404": errorResponse("Conversation not found"),
            "500": errorResponse("Failed to load conversation"),
          },
        },
      },

      // -----------------------------------------------------------------
      // Widget — embeddable chat widget
      // -----------------------------------------------------------------
      "/widget": {
        get: {
          operationId: "widgetHost",
          summary: "Widget HTML host page",
          description:
            "Serves a self-contained HTML page for iframe embedding. Renders the AtlasChat component with configurable theme, API URL, position, branding, and initial query.",
          tags: ["Widget"],
          security: [],
          parameters: [
            { name: "theme", in: "query", required: false, schema: { type: "string", enum: ["light", "dark", "system"], default: "system" }, description: "Color theme." },
            { name: "apiUrl", in: "query", required: false, schema: { type: "string" }, description: "Atlas API base URL (http/https only)." },
            { name: "position", in: "query", required: false, schema: { type: "string", enum: ["bottomRight", "bottomLeft", "inline"], default: "inline" }, description: "Widget position." },
            { name: "logo", in: "query", required: false, schema: { type: "string" }, description: "HTTPS URL to a custom logo image." },
            { name: "accent", in: "query", required: false, schema: { type: "string" }, description: "Hex color without # (e.g. '4f46e5')." },
            { name: "welcome", in: "query", required: false, schema: { type: "string" }, description: "Welcome message (max 500 chars)." },
            { name: "initialQuery", in: "query", required: false, schema: { type: "string" }, description: "Auto-send query on first open (max 500 chars)." },
          ],
          responses: {
            "200": {
              description: "Widget HTML page",
              content: { "text/html": { schema: { type: "string" } } },
            },
            "503": {
              description: "Widget bundle not built",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },

      "/widget/atlas-widget.js": {
        get: {
          operationId: "widgetJS",
          summary: "Widget JavaScript bundle",
          description: "Self-contained ESM bundle (React + AtlasChat). Cached for 24 hours.",
          tags: ["Widget"],
          security: [],
          responses: {
            "200": {
              description: "Widget JS bundle",
              content: { "application/javascript": { schema: { type: "string" } } },
            },
            "404": { description: "Widget JS not built", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },

      "/widget/atlas-widget.css": {
        get: {
          operationId: "widgetCSS",
          summary: "Widget CSS stylesheet",
          description: "Pre-compiled Tailwind CSS for widget components. Cached for 24 hours.",
          tags: ["Widget"],
          security: [],
          responses: {
            "200": {
              description: "Widget CSS",
              content: { "text/css": { schema: { type: "string" } } },
            },
            "404": { description: "Widget CSS not built", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },

      // -----------------------------------------------------------------
      // Widget loader — script tag for embedding
      // -----------------------------------------------------------------
      "/widget.js": {
        get: {
          operationId: "widgetLoader",
          summary: "Widget script tag loader",
          description:
            "Returns a self-contained IIFE script that injects a floating chat bubble and iframe overlay into any host page. " +
            "Reads data-* attributes from its own `<script>` tag for configuration. Exposes window.Atlas programmatic API.",
          tags: ["Widget"],
          security: [],
          responses: {
            "200": {
              description: "Widget loader script (IIFE)",
              content: { "application/javascript": { schema: { type: "string" } } },
            },
          },
        },
      },

      "/widget.d.ts": {
        get: {
          operationId: "widgetTypeDeclarations",
          summary: "Widget TypeScript declarations",
          description:
            "Returns ambient TypeScript declarations for window.Atlas. Fallback for embedders who load only the script tag without installing @useatlas/react.",
          tags: ["Widget"],
          security: [],
          responses: {
            "200": {
              description: "TypeScript ambient declarations",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      // -----------------------------------------------------------------
      // Wizard — Guided semantic layer setup
      // -----------------------------------------------------------------
      "/api/v1/wizard/profile": {
        post: {
          operationId: "wizardProfile",
          summary: "List tables from a connected datasource",
          description:
            "Discovers tables, views, and materialized views in a connected database for the wizard table selection step. " +
            "Supports PostgreSQL and MySQL datasources. Requires admin role.",
          tags: ["Wizard"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["connectionId"],
                  properties: {
                    connectionId: { type: "string", description: "Connection ID to profile (e.g. 'default')." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Table list from the connected datasource",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      connectionId: { type: "string" },
                      dbType: { type: "string", enum: ["postgres", "mysql"] },
                      schema: { type: "string" },
                      tables: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            type: { type: "string", enum: ["table", "view", "materialized_view"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid request (missing connectionId or unsupported database type)"),
            ...authErrors,
            "404": errorResponse("Connection not found"),
            "500": errorResponse("Connection resolution or profiling failed"),
          },
        },
      },
      "/api/v1/wizard/generate": {
        post: {
          operationId: "wizardGenerate",
          summary: "Profile tables and generate entity YAML",
          description:
            "Profiles selected tables from a connected datasource and generates entity YAML definitions " +
            "with dimensions, measures, joins, query patterns, and heuristic flags. Requires admin role.",
          tags: ["Wizard"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["connectionId", "tables"],
                  properties: {
                    connectionId: { type: "string", description: "Connection ID to profile." },
                    tables: {
                      type: "array",
                      items: { type: "string" },
                      description: "Table names to profile and generate entities for.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Generated entity YAML definitions with profiling metadata",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      connectionId: { type: "string" },
                      dbType: { type: "string", enum: ["postgres", "mysql"] },
                      schema: { type: "string" },
                      entities: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            tableName: { type: "string" },
                            objectType: { type: "string" },
                            rowCount: { type: "integer" },
                            columnCount: { type: "integer" },
                            yaml: { type: "string", description: "Generated entity YAML content." },
                            profile: {
                              type: "object",
                              description: "Detailed profiling metadata for the table.",
                            },
                          },
                        },
                      },
                      errors: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            table: { type: "string" },
                            error: { type: "string" },
                          },
                        },
                        description: "Errors encountered during profiling (non-fatal).",
                      },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid request (missing connectionId, empty tables, or unsupported database type)"),
            ...authErrors,
            "404": errorResponse("Connection not found"),
            "500": errorResponse("Profiling or generation failed"),
          },
        },
      },
      "/api/v1/wizard/preview": {
        post: {
          operationId: "wizardPreview",
          summary: "Preview agent behavior with entities",
          description:
            "Shows how the agent would interpret the semantic layer when answering a question, " +
            "given a set of candidate entity YAML definitions. Requires admin role.",
          tags: ["Wizard"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["question", "entities"],
                  properties: {
                    question: { type: "string", description: "Natural language question to preview." },
                    entities: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["tableName", "yaml"],
                        properties: {
                          tableName: { type: "string" },
                          yaml: { type: "string" },
                        },
                      },
                      description: "Entity definitions to preview against.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Preview of how the agent would see the semantic layer",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      question: { type: "string" },
                      semanticContext: { type: "string" },
                      availableTables: { type: "array", items: { type: "string" } },
                      entityCount: { type: "integer" },
                      sampleEntityYaml: { type: "string", description: "Truncated sample of entity YAML (max 2000 chars)." },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid request (missing question or entities)"),
            ...authErrors,
          },
        },
      },
      "/api/v1/wizard/save": {
        post: {
          operationId: "wizardSave",
          summary: "Save entities to org-scoped semantic layer",
          description:
            "Persists generated entity YAML files to the organization's semantic layer directory on disk. " +
            "Validates table names for path traversal, syncs to the internal database if available, " +
            "and resets the semantic whitelist cache. Requires admin role and an active organization.",
          tags: ["Wizard"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["connectionId", "entities"],
                  properties: {
                    connectionId: { type: "string", description: "Connection ID to associate with saved entities." },
                    entities: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["tableName", "yaml"],
                        properties: {
                          tableName: { type: "string" },
                          yaml: { type: "string" },
                        },
                      },
                    },
                    schema: { type: "string", description: "Database schema name (defaults to 'public')." },
                    profiles: {
                      type: "array",
                      description: "Optional profile data for generating catalog, glossary, and metric files.",
                      items: { type: "object" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Entities saved to disk",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      saved: { type: "boolean" },
                      orgId: { type: "string" },
                      connectionId: { type: "string" },
                      entityCount: { type: "integer" },
                      files: { type: "array", items: { type: "string" }, description: "Relative paths of saved files." },
                    },
                  },
                },
              },
            },
            "400": errorResponse("Invalid request (missing connectionId, empty entities, invalid table name, or no active organization)"),
            ...authErrors,
            "500": errorResponse("Failed to save entities"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API key or JWT token. Pass via Authorization: Bearer <token>.",
        },
      },
      schemas: {
        SSOProvider: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            orgId: { type: "string" },
            type: { type: "string", enum: ["saml", "oidc"] },
            issuer: { type: "string", description: "IdP issuer identifier" },
            domain: { type: "string", description: "Email domain for auto-provisioning" },
            enabled: { type: "boolean" },
            config: {
              type: "object",
              description: "Provider-specific configuration (SAML or OIDC)",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          required: ["id", "orgId", "type", "issuer", "domain", "enabled", "config", "createdAt", "updatedAt"],
        },
        CreateSSOProviderRequest: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["saml", "oidc"] },
            issuer: { type: "string" },
            domain: { type: "string", description: "Email domain (e.g. acme.com)" },
            enabled: { type: "boolean", default: false },
            config: {
              type: "object",
              description: "SAML: { idpEntityId, idpSsoUrl, idpCertificate }. OIDC: { clientId, clientSecret, discoveryUrl }.",
            },
          },
          required: ["type", "issuer", "domain", "config"],
        },
        UpdateSSOProviderRequest: {
          type: "object",
          properties: {
            issuer: { type: "string" },
            domain: { type: "string" },
            enabled: { type: "boolean" },
            config: { type: "object", description: "Partial provider-specific config to merge" },
          },
        },
      },
    },
    tags: [
      { name: "Chat", description: "Streaming chat with the Atlas agent" },
      { name: "Query", description: "Synchronous JSON query endpoint" },
      { name: "Conversations", description: "Conversation history CRUD and sharing" },
      { name: "Suggestions", description: "User-facing query suggestions" },
      { name: "Prompts", description: "Prompt library collections and items" },
      { name: "Sessions", description: "User self-service session management (requires managed auth)" },
      { name: "Actions", description: "Approval-gated write operations (requires ATLAS_ACTIONS_ENABLED=true)" },
      { name: "Scheduled Tasks", description: "Recurring query tasks with cron scheduling (requires ATLAS_SCHEDULER_ENABLED=true)" },
      { name: "Auth", description: "Authentication routes (managed auth via Better Auth)" },
      { name: "Slack", description: "Slack integration (requires SLACK_SIGNING_SECRET)" },
      { name: "Widget", description: "Embeddable chat widget (host page, loader script, assets)" },
      { name: "Billing", description: "Stripe billing, subscription status, and plan management (requires STRIPE_SECRET_KEY)" },
      { name: "Onboarding", description: "Self-serve signup flow (requires managed auth)" },
      { name: "Demo", description: "Email-gated public demo with lead capture (requires ATLAS_DEMO_ENABLED=true)" },
      { name: "Wizard", description: "Guided semantic layer setup wizard (requires admin role)" },
    ],
  };
}

let cachedSpec: Record<string, unknown> | null = null;

openapi.get("/", (c) => {
  if (!cachedSpec) {
    cachedSpec = buildSpec();
  }
  return c.json(cachedSpec);
});

export { openapi };
