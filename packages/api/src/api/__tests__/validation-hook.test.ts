/**
 * Tests for the shared validation hook.
 *
 * Verifies that @hono/zod-openapi validation failures produce accurate
 * error messages based on the validation target (body, query, param).
 */

import { describe, it, expect } from "bun:test";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "../routes/validation-hook";

// ---------------------------------------------------------------------------
// Mini app with strict schemas for query, param, and body validation
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  // Route with required query params
  const queryRoute = createRoute({
    method: "get",
    path: "/test-query",
    request: {
      query: z.object({
        page: z.string().regex(/^\d+$/, "page must be numeric").openapi({
          param: { name: "page", in: "query" },
        }),
      }),
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  });

  app.openapi(queryRoute, (c) => {
    return c.json({ ok: true }, 200);
  });

  // Route with path params
  const paramRoute = createRoute({
    method: "get",
    path: "/test-param/{id}",
    request: {
      params: z.object({
        id: z.string().uuid("id must be a valid UUID").openapi({
          param: { name: "id", in: "path" },
        }),
      }),
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  });

  app.openapi(paramRoute, (c) => {
    return c.json({ ok: true }, 200);
  });

  // Route with body validation
  const bodyRoute = createRoute({
    method: "post",
    path: "/test-body",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1, "name is required"),
              age: z.number().int().positive("age must be positive"),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  });

  app.openapi(bodyRoute, (c) => {
    return c.json({ ok: true }, 200);
  });

  return app;
}

describe("validationHook", () => {
  const app = createTestApp();

  describe("query param validation", () => {
    it("returns 'Invalid query parameters' for bad query params", async () => {
      const response = await app.request("/test-query?page=abc");
      expect(response.status).toBe(422);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation_error");
      expect(body.message).toBe("Invalid query parameters");
      expect(body.details).toBeDefined();
      expect(Array.isArray(body.details)).toBe(true);
    });

    it("returns 'Invalid query parameters' when required param is missing", async () => {
      const response = await app.request("/test-query");
      expect(response.status).toBe(422);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation_error");
      expect(body.message).toBe("Invalid query parameters");
    });

    it("does NOT say 'Invalid JSON body' for query param errors", async () => {
      const response = await app.request("/test-query?page=abc");
      expect(response.status).toBe(422);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.message).not.toContain("Invalid JSON body");
      expect(body.message).not.toContain("Invalid request body");
    });
  });

  describe("path param validation", () => {
    it("returns 'Invalid path parameters' for bad path params", async () => {
      const response = await app.request("/test-param/not-a-uuid");
      expect(response.status).toBe(422);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation_error");
      expect(body.message).toBe("Invalid path parameters");
      expect(body.details).toBeDefined();
    });
  });

  describe("body validation", () => {
    it("returns 'Invalid request body' for bad body", async () => {
      const response = await app.request("/test-body", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", age: -5 }),
      });
      expect(response.status).toBe(422);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation_error");
      expect(body.message).toBe("Invalid request body");
      expect(body.details).toBeDefined();
    });
  });

  describe("successful requests", () => {
    it("passes through valid query params", async () => {
      const response = await app.request("/test-query?page=1");
      expect(response.status).toBe(200);
    });

    it("passes through valid path params", async () => {
      const response = await app.request(
        "/test-param/550e8400-e29b-41d4-a716-446655440000",
      );
      expect(response.status).toBe(200);
    });

    it("passes through valid body", async () => {
      const response = await app.request("/test-body", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice", age: 30 }),
      });
      expect(response.status).toBe(200);
    });
  });
});
