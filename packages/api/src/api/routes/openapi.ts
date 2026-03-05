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
} from "./conversations";
import { HealthResponseSchema } from "./health";

const openapi = new Hono();

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

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

  return {
    openapi: "3.1.0",
    info: {
      title: "Atlas API",
      version: "1.0.0",
      description:
        "Text-to-SQL data analyst agent. Ask natural-language questions about your data and receive structured answers.",
    },
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
            {
              name: "limit",
              in: "query",
              description:
                "Maximum number of conversations to return (1-100, default 20).",
              required: false,
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
            {
              name: "offset",
              in: "query",
              description:
                "Number of conversations to skip (default 0).",
              required: false,
              schema: {
                type: "integer",
                minimum: 0,
                default: 0,
              },
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
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Forbidden — insufficient permissions"),
            "404": errorResponse(
              "Not available (no internal database configured)",
            ),
            "429": errorResponse(
              "Rate limit exceeded",
              RateLimitErrorSchema,
            ),
            "500": errorResponse("Internal server error"),
          },
        },
      },

      // -----------------------------------------------------------------
      // GET /api/v1/conversations/{id} — Get conversation with messages
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
            {
              name: "id",
              in: "path",
              description: "Conversation UUID.",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
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
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Forbidden — insufficient permissions"),
            "404": errorResponse(
              "Conversation not found or not available",
            ),
            "429": errorResponse(
              "Rate limit exceeded",
              RateLimitErrorSchema,
            ),
            "500": errorResponse("Internal server error"),
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
            {
              name: "id",
              in: "path",
              description: "Conversation UUID.",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "204": {
              description: "Conversation deleted successfully",
            },
            "400": errorResponse("Invalid conversation ID format"),
            "401": errorResponse("Authentication required"),
            "403": errorResponse("Forbidden — insufficient permissions"),
            "404": errorResponse(
              "Conversation not found or not available",
            ),
            "429": errorResponse(
              "Rate limit exceeded",
              RateLimitErrorSchema,
            ),
            "500": errorResponse("Internal server error"),
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
      {
        name: "Query",
        description: "Synchronous JSON query endpoint",
      },
      {
        name: "Conversations",
        description: "Conversation history CRUD operations",
      },
      { name: "Health", description: "Service health checks" },
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
