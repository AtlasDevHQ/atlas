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
} from "./conversations";
import { HealthResponseSchema } from "./health";

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
      version: "1.0.0",
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
      // POST /api/chat — Streaming chat (SSE)
      // -----------------------------------------------------------------
      "/api/chat": {
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
          description: "Toggles the starred status of a conversation.",
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
      // GET /api/health — Health check
      // -----------------------------------------------------------------
      "/api/health": {
        get: {
          operationId: "healthCheck",
          summary: "Health check",
          description:
            "Returns the health status of the Atlas API including checks for datasource connectivity, LLM provider, semantic layer, internal database, explore backend, auth mode, and Slack integration. " +
            "Returns HTTP 200 for 'ok' or 'degraded' status, and 503 for 'error' status.",
          tags: ["Health"],
          security: [],
          responses: {
            "200": {
              description:
                "Service is healthy or degraded (some optional components unavailable)",
              content: {
                "application/json": {
                  schema: toJsonSchema(HealthResponseSchema),
                },
              },
            },
            "503": {
              description: "Service is unhealthy (critical component failure)",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      toJsonSchema(HealthResponseSchema),
                      toJsonSchema(
                        z.object({
                          status: z.literal("error"),
                          error: z.string(),
                        }),
                      ),
                    ],
                  },
                },
              },
            },
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
                enum: ["pending", "approved", "denied", "executed", "failed"],
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
                            status: { type: "string", enum: ["pending", "approved", "denied", "executed", "failed"] },
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
      "/api/slack/commands": {
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

      "/api/slack/events": {
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

      "/api/slack/install": {
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

      "/api/slack/callback": {
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
      // Admin — admin console routes
      // -----------------------------------------------------------------
      "/api/v1/admin/overview": {
        get: {
          operationId: "adminOverview",
          summary: "Dashboard overview",
          description:
            "Returns counts of connections, entities, metrics, glossary terms, and plugins. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Dashboard summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      connections: { type: "integer" },
                      entities: { type: "integer" },
                      metrics: { type: "integer" },
                      glossaryTerms: { type: "integer" },
                      plugins: { type: "integer" },
                      pluginHealth: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            type: { type: "string" },
                            status: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/semantic/entities": {
        get: {
          operationId: "adminListEntities",
          summary: "List semantic entities",
          description: "Lists all entity YAML files with summary info. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of entities",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/semantic/entities/{name}": {
        get: {
          operationId: "adminGetEntity",
          summary: "Get entity details",
          description: "Returns the full parsed YAML for a specific entity. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "name", in: "path", required: true, schema: { type: "string" }, description: "Entity name (e.g. 'orders')." },
          ],
          responses: {
            "200": {
              description: "Entity YAML content",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": errorResponse("Invalid entity name"),
            ...authErrors,
            "404": errorResponse("Entity not found"),
          },
        },
      },

      "/api/v1/admin/semantic/metrics": {
        get: {
          operationId: "adminListMetrics",
          summary: "List metrics",
          description: "Lists all metric YAML files grouped by source. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of metrics",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/semantic/glossary": {
        get: {
          operationId: "adminGetGlossary",
          summary: "Get glossary",
          description: "Returns all glossary files (default and per-source). Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Glossary content",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/semantic/catalog": {
        get: {
          operationId: "adminGetCatalog",
          summary: "Get catalog",
          description: "Returns the parsed catalog.yml. Returns { catalog: null } if no catalog exists. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Catalog content",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/semantic/stats": {
        get: {
          operationId: "adminSemanticStats",
          summary: "Semantic layer statistics",
          description: "Aggregate statistics across the semantic layer. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Semantic layer stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      totalEntities: { type: "integer" },
                      totalColumns: { type: "integer" },
                      totalJoins: { type: "integer" },
                      totalMeasures: { type: "integer" },
                      coverageGaps: {
                        type: "object",
                        properties: {
                          noDescription: { type: "integer" },
                          noColumns: { type: "integer" },
                          noJoins: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/connections": {
        get: {
          operationId: "adminListConnections",
          summary: "List connections",
          description: "Lists all registered database connections with type and cached health status. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of connections",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/connections/{id}/test": {
        post: {
          operationId: "adminTestConnection",
          summary: "Test a connection",
          description: "Triggers a live health check for a specific connection. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Connection ID (e.g. 'default')." },
          ],
          responses: {
            "200": {
              description: "Connection health check result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["healthy", "unhealthy"] },
                      latencyMs: { type: "integer" },
                      checkedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            ...authErrors,
            "404": errorResponse("Connection not found"),
          },
        },
      },

      "/api/v1/admin/users": {
        get: {
          operationId: "adminListUsers",
          summary: "List users",
          description: "Lists users with pagination, search, and role filtering. Requires admin role and managed auth.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            ...paginationParams({ limit: 50, maxLimit: 200 }),
            { name: "search", in: "query", required: false, schema: { type: "string" }, description: "Search by email (contains match)." },
            { name: "role", in: "query", required: false, schema: { type: "string", enum: ["viewer", "analyst", "admin"] }, description: "Filter by role." },
          ],
          responses: {
            "200": {
              description: "Paginated list of users",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/stats": {
        get: {
          operationId: "adminUserStats",
          summary: "User statistics",
          description: "Aggregate user statistics: total count, banned count, and breakdown by role. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "User stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      total: { type: "integer" },
                      banned: { type: "integer" },
                      byRole: {
                        type: "object",
                        properties: {
                          admin: { type: "integer" },
                          analyst: { type: "integer" },
                          viewer: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/{id}/role": {
        patch: {
          operationId: "adminChangeUserRole",
          summary: "Change user role",
          description: "Updates a user's role. Cannot change your own role or demote the last admin. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User ID." }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["role"],
                  properties: {
                    role: { type: "string", enum: ["viewer", "analyst", "admin"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Role updated", content: { "application/json": { schema: { type: "object" } } } },
            "400": errorResponse("Invalid role or cannot change own role"),
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/{id}/ban": {
        post: {
          operationId: "adminBanUser",
          summary: "Ban a user",
          description: "Bans a user with optional reason and expiration. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User ID." }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    reason: { type: "string" },
                    expiresIn: { type: "integer", description: "Ban duration in seconds." },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "User banned", content: { "application/json": { schema: { type: "object" } } } },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/{id}/unban": {
        post: {
          operationId: "adminUnbanUser",
          summary: "Unban a user",
          description: "Removes a ban from a user. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User ID." }],
          responses: {
            "200": { description: "User unbanned", content: { "application/json": { schema: { type: "object" } } } },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/{id}": {
        delete: {
          operationId: "adminDeleteUser",
          summary: "Delete a user",
          description: "Permanently deletes a user. Cannot delete yourself or the last admin. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User ID." }],
          responses: {
            "204": { description: "User deleted" },
            "400": errorResponse("Cannot delete yourself or last admin"),
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/users/{id}/revoke": {
        post: {
          operationId: "adminRevokeUserSessions",
          summary: "Revoke user sessions",
          description: "Revokes all sessions for a user (force logout). Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User ID." }],
          responses: {
            "200": { description: "Sessions revoked", content: { "application/json": { schema: { type: "object" } } } },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/audit": {
        get: {
          operationId: "adminListAuditLog",
          summary: "Query audit log",
          description: "Returns paginated audit log entries with optional filters. Requires admin role and internal database.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            ...paginationParams({ limit: 50, maxLimit: 200 }),
            { name: "user", in: "query", required: false, schema: { type: "string" }, description: "Filter by user ID." },
            { name: "success", in: "query", required: false, schema: { type: "boolean" }, description: "Filter by success/failure." },
            { name: "from", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "ISO 8601 start date." },
            { name: "to", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "ISO 8601 end date." },
          ],
          responses: {
            "200": {
              description: "Paginated audit log",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/audit/stats": {
        get: {
          operationId: "adminAuditStats",
          summary: "Audit statistics",
          description: "Aggregate audit statistics: total queries, error count, error rate, and queries per day. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Audit stats",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/plugins": {
        get: {
          operationId: "adminListPlugins",
          summary: "List plugins",
          description: "Lists all installed plugins with type, version, and status. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of plugins",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/plugins/{id}/health": {
        post: {
          operationId: "adminPluginHealth",
          summary: "Check plugin health",
          description: "Triggers a health check for a specific plugin. Requires admin role.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Plugin ID." },
          ],
          responses: {
            "200": {
              description: "Plugin health check result",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...authErrors,
            "404": errorResponse("Plugin not found"),
          },
        },
      },

      "/api/v1/admin/me/password-status": {
        get: {
          operationId: "adminPasswordStatus",
          summary: "Check password change requirement",
          description: "Checks if the current user must change their password. Available to any authenticated managed-auth user.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Password status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      mustChange: { type: "boolean" },
                    },
                  },
                },
              },
            },
            ...authErrors,
          },
        },
      },

      "/api/v1/admin/me/password": {
        post: {
          operationId: "adminChangePassword",
          summary: "Change password",
          description: "Changes the current user's password. Available to any authenticated managed-auth user.",
          tags: ["Admin"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["currentPassword", "newPassword"],
                  properties: {
                    currentPassword: { type: "string" },
                    newPassword: { type: "string", minLength: 8 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Password changed", content: { "application/json": { schema: { type: "object" } } } },
            "400": errorResponse("Invalid current password or weak new password"),
            ...authErrors,
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
    },
    tags: [
      { name: "Chat", description: "Streaming chat with the Atlas agent" },
      { name: "Query", description: "Synchronous JSON query endpoint" },
      { name: "Conversations", description: "Conversation history CRUD operations" },
      { name: "Health", description: "Service health checks" },
      { name: "Actions", description: "Approval-gated write operations (requires ATLAS_ACTIONS_ENABLED=true)" },
      { name: "Scheduled Tasks", description: "Recurring query tasks with cron scheduling (requires ATLAS_SCHEDULER_ENABLED=true)" },
      { name: "Auth", description: "Authentication routes (managed auth via Better Auth)" },
      { name: "Slack", description: "Slack integration (requires SLACK_SIGNING_SECRET)" },
      { name: "Admin", description: "Admin console API (requires admin role)" },
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
