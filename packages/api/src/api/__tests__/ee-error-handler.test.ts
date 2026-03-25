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
