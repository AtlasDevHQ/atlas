/**
 * OpenAPI 3.1 specification endpoint.
 *
 * GET /api/v1/openapi.json returns the spec for the v1 API, with request/response schemas derived from Zod types.
 * The spec is built once on first request and cached thereafter.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ChatRequestSchema } from "./chat";
import { ConversationWithMessagesSchema } from "./conversations";
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
      { name: "Auth", description: "Authentication routes (managed auth via Better Auth)" },
      { name: "Slack", description: "Slack integration (requires SLACK_SIGNING_SECRET)" },
      { name: "Widget", description: "Embeddable chat widget (host page, loader script, assets)" },
      { name: "Onboarding", description: "Self-serve signup flow (requires managed auth)" },
      { name: "Demo", description: "Email-gated public demo with lead capture (requires ATLAS_DEMO_ENABLED=true)" },
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
