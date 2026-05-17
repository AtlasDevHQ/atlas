import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eeOnError } from "../routes/ee-error-handler";

// ---------------------------------------------------------------------------
// eeOnError tests
// ---------------------------------------------------------------------------

describe("eeOnError", () => {
  function createApp() {
    const app = new Hono();
    app.onError(eeOnError);
    return app;
  }

  test("surfaces HTTPException with res as-is", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new HTTPException(403, {
        res: Response.json({ error: "enterprise_required", message: "License required" }, { status: 403 }),
      });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("enterprise_required");
  });

  test("preserves upstream c.header() values when surfacing HTTPException.res (CORS regression)", async () => {
    // Upstream middleware queues CORS + security headers via c.header(...) before the
    // handler runs. Returning `err.res` directly used to drop them — the response
    // would reach the network but the browser would reject it as "Failed to fetch"
    // for cross-origin requests, breaking the /admin/semantic/raw YAML view.
    // Routing through c.newResponse merges the queued headers in.
    const app = createApp();
    app.use("*", async (c, next) => {
      c.header("Access-Control-Allow-Origin", "https://app.example.com");
      c.header("X-Frame-Options", "DENY");
      await next();
    });
    app.get("/raw", () => {
      throw new HTTPException(200, {
        res: new Response("table: users\n", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      });
    });
    const res = await app.request("/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    // Original Content-Type from err.res must survive the merge.
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("table: users\n");
  });

  test("maps framework 400 to bad_request JSON", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new HTTPException(400);
    });
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("Invalid JSON body.");
  });

  test("re-throws unknown errors", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new Error("unexpected");
    });
    // Hono propagates re-thrown errors from onError
    try {
      await app.request("/test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("unexpected");
    }
  });
});
