/**
 * Static OpenAPI path entries for routes that are NOT on OpenAPIHono.
 *
 * Auth routes are proxied to Better Auth (dynamic, not schema-driven).
 * Widget routes serve static assets (HTML/JS/CSS/TS declarations).
 *
 * These entries are merged into the auto-generated spec in index.ts.
 */

import { z } from "zod";

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

const errorResponse = (
  description: string,
  schema: z.ZodType = ErrorSchema,
) => ({
  description,
  content: { "application/json": { schema: toJsonSchema(schema) } },
});

/** Static path entries for auth and widget routes. */
export const staticPaths: Record<string, unknown> = {
  // -------------------------------------------------------------------
  // Auth — Better Auth routes (key endpoints)
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // Widget — embeddable chat widget (static assets)
  // -------------------------------------------------------------------
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
        "200": { description: "Widget HTML page", content: { "text/html": { schema: { type: "string" } } } },
        "503": { description: "Widget bundle not built", content: { "text/html": { schema: { type: "string" } } } },
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
        "200": { description: "Widget JS bundle", content: { "application/javascript": { schema: { type: "string" } } } },
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
        "200": { description: "Widget CSS", content: { "text/css": { schema: { type: "string" } } } },
        "404": { description: "Widget CSS not built", content: { "text/plain": { schema: { type: "string" } } } },
      },
    },
  },

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
        "200": { description: "Widget loader script (IIFE)", content: { "application/javascript": { schema: { type: "string" } } } },
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
        "200": { description: "TypeScript ambient declarations", content: { "text/plain": { schema: { type: "string" } } } },
      },
    },
  },

  // -------------------------------------------------------------------
  // Well-Known — OAuth 2.1 + OIDC + RFC 9728 discovery
  // -------------------------------------------------------------------
  // These endpoints are read by MCP clients (Claude Desktop, ChatGPT,
  // Cursor) and any RFC-conformant OAuth client. They publish issuer
  // metadata, OIDC configuration, and the protected-resource document
  // that ties the MCP audience to its authorization server. Only
  // available when auth mode is `managed` (Better Auth).
  "/.well-known/oauth-authorization-server/api/auth": {
    get: {
      operationId: "wellKnownOAuthAuthorizationServer",
      summary: "OAuth 2.1 authorization-server metadata",
      description:
        "RFC 8414 OAuth authorization-server metadata document. Path-insertion form — " +
        "the issuer's path (`/api/auth`) is appended after the well-known segment. " +
        "Consumed by MCP clients during OAuth onboarding to discover token, authorize, " +
        "registration, and introspection endpoints. " +
        "Only available when auth mode is `managed`.",
      tags: ["Well-Known"],
      security: [],
      responses: {
        "200": {
          description: "Authorization-server metadata (JSON)",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "404": errorResponse("Auth mode is not `managed` — metadata unavailable"),
        "503": errorResponse("Metadata generation failed (transient — includes requestId)"),
      },
    },
  },

  "/.well-known/openid-configuration/api/auth": {
    get: {
      operationId: "wellKnownOpenIdConfiguration",
      summary: "OpenID Connect discovery document",
      description:
        "OIDC discovery document (path-appending form). Same content as the OAuth " +
        "authorization-server metadata plus OIDC-specific fields (userinfo endpoint, " +
        "supported scopes, claim types). " +
        "Only available when auth mode is `managed`.",
      tags: ["Well-Known"],
      security: [],
      responses: {
        "200": {
          description: "OIDC configuration (JSON)",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "404": errorResponse("Auth mode is not `managed` — metadata unavailable"),
        "503": errorResponse("Metadata generation failed (transient — includes requestId)"),
      },
    },
  },

  "/.well-known/oauth-protected-resource/mcp/{workspace_id}": {
    get: {
      operationId: "wellKnownOAuthProtectedResource",
      summary: "RFC 9728 protected-resource metadata for hosted MCP",
      description:
        "RFC 9728 OAuth protected-resource metadata. Per the MCP authorization spec, " +
        "the resource server (us) publishes one document per protected resource so the " +
        "client can discover the auth server before making an authenticated request. " +
        "`workspace_id` segments the path so a future per-workspace metadata extension " +
        "(policy URLs, contact info) has somewhere to land without breaking clients hitting " +
        "the canonical region resource. The returned `resource` URI must match the JWT `aud` " +
        "exactly; workspace isolation is enforced via the `ATLAS_OAUTH_WORKSPACE_CLAIM` " +
        "custom claim at the verifier. " +
        "Only available when auth mode is `managed`.",
      tags: ["Well-Known"],
      security: [],
      parameters: [
        {
          name: "workspace_id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Workspace identifier (segments the path; resource URI is region-scoped, not workspace-scoped).",
        },
      ],
      responses: {
        "200": {
          description: "Protected-resource metadata (JSON)",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "400": errorResponse("Missing workspace_id"),
        "404": errorResponse("Auth mode is not `managed` — metadata unavailable"),
        "503": errorResponse("Metadata generation failed (transient — includes requestId)"),
      },
    },
  },

  // -------------------------------------------------------------------
  // Hosted MCP — Streamable HTTP transport for MCP clients
  //
  // The same path serves three verbs (packages/mcp/src/hosted.ts:HANDLED_METHODS)
  // on both the canonical path and its /sse alias (hosted.ts:HOSTED_PATHS):
  //   POST   — JSON-RPC frames (client → server)
  //   GET    — opens the notification stream (server → client)
  //   DELETE — explicit session termination
  //
  // This is the Streamable HTTP transport; the `text/event-stream` framing on
  // GET/POST is its streaming wire format, NOT the deprecated HTTP+SSE
  // transport. The canonical path dropped its misleading `/sse` suffix in
  // #4169; the legacy `/mcp/{workspace_id}/sse` alias still resolves.
  //
  // Auth, workspace claim binding, and session-cap behavior are shared
  // across all three. See the MCP authorization spec for the full
  // request/response contract on the JSON-RPC payloads.
  // -------------------------------------------------------------------
  "/mcp/{workspace_id}": {
    get: {
      operationId: "hostedMcpStream",
      summary: "Hosted MCP — notification stream",
      description:
        "Opens the MCP server → client notification stream (text/event-stream). " +
        "Companion to `POST /mcp/{workspace_id}` (JSON-RPC frames) and " +
        "`DELETE /mcp/{workspace_id}` (session termination). " +
        "Authentication is OAuth 2.1 + RFC 9728: clients first hit " +
        "`/.well-known/oauth-protected-resource/mcp/{workspace_id}` to discover the " +
        "authorization server, complete the OAuth flow, then connect with " +
        "`Authorization: Bearer <token>`. The token's `aud` claim must match the " +
        "advertised resource URI and `ATLAS_OAUTH_WORKSPACE_CLAIM` must match " +
        "`workspace_id`. " +
        "Concurrent session count is bounded by `ATLAS_MCP_MAX_SESSIONS` (default 100); " +
        "exceeding it returns `503 too_many_sessions`. " +
        "See the [MCP guide](/guides/mcp) for the full agent-onboarding flow.",
      tags: ["MCP"],
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "workspace_id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Workspace identifier — must match the `ATLAS_OAUTH_WORKSPACE_CLAIM` value in the bearer token.",
        },
      ],
      responses: {
        "200": {
          description: "SSE stream (text/event-stream) carrying JSON-RPC notifications",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "401": errorResponse("Missing or invalid bearer token"),
        "403": errorResponse("Token workspace claim does not match path workspace_id"),
        "503": errorResponse("Session cap reached (too_many_sessions)"),
      },
    },
    post: {
      operationId: "hostedMcpRequest",
      summary: "Hosted MCP — submit a JSON-RPC frame",
      description:
        "Client → server JSON-RPC frames over the MCP transport. Same auth + workspace-claim contract as `GET /mcp/{workspace_id}`. Payload shape is defined by the MCP protocol spec; Atlas accepts any conformant JSON-RPC request (initialize, tools/list, tools/call, prompts/list, prompts/get, …).",
      tags: ["MCP"],
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "workspace_id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Workspace identifier — must match the `ATLAS_OAUTH_WORKSPACE_CLAIM` value in the bearer token.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
      responses: {
        "200": {
          description: "JSON-RPC response (or 202 acknowledgment for notifications)",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "401": errorResponse("Missing or invalid bearer token"),
        "403": errorResponse("Token workspace claim does not match path workspace_id"),
        "503": errorResponse("Session cap reached (too_many_sessions)"),
      },
    },
    delete: {
      operationId: "hostedMcpTerminate",
      summary: "Hosted MCP — terminate the session",
      description:
        "Explicit session termination. Drops the server-side session state and any in-flight notification stream for the caller's workspace. Same auth + workspace-claim contract as the other verbs.",
      tags: ["MCP"],
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "workspace_id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Workspace identifier — must match the `ATLAS_OAUTH_WORKSPACE_CLAIM` value in the bearer token.",
        },
      ],
      responses: {
        "204": { description: "Session terminated" },
        "401": errorResponse("Missing or invalid bearer token"),
        "403": errorResponse("Token workspace claim does not match path workspace_id"),
      },
    },
  },
};

/** Static tag definitions for auth, widget, well-known, and hosted MCP. */
export const staticTags = [
  { name: "Auth", description: "Authentication routes (managed auth via Better Auth)" },
  { name: "Widget", description: "Embeddable chat widget (host page, loader script, assets)" },
  {
    name: "Well-Known",
    description:
      "OAuth 2.1 / OIDC / RFC 9728 discovery documents. Consumed by MCP clients (Claude Desktop, ChatGPT, Cursor) and any RFC-conformant OAuth client. Only available when auth mode is `managed`.",
  },
  {
    name: "MCP",
    description:
      "Hosted Model Context Protocol endpoints. See the [MCP guide](/guides/mcp) for the agent-onboarding flow and tool surface.",
  },
];

/** Security scheme used across the API. */
export const securitySchemes = {
  bearerAuth: {
    type: "http" as const,
    scheme: "bearer",
    description: "API key or JWT token. Pass via Authorization: Bearer <token>.",
  },
};
