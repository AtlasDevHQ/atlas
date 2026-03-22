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
};

/** Static tag definitions for auth and widget. */
export const staticTags = [
  { name: "Auth", description: "Authentication routes (managed auth via Better Auth)" },
  { name: "Widget", description: "Embeddable chat widget (host page, loader script, assets)" },
];

/** Security scheme used across the API. */
export const securitySchemes = {
  bearerAuth: {
    type: "http" as const,
    scheme: "bearer",
    description: "API key or JWT token. Pass via Authorization: Bearer <token>.",
  },
};
