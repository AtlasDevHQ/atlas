import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

// Mock logger to avoid pino init in tests
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
    fatal: mock(),
    child: mock(),
  }),
}));

const { withErrorHandler } = await import(
  "@atlas/api/lib/routes/error-handler"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestEnv = { Variables: { requestId: string } };

/** Create a minimal Hono app with requestId middleware for testing. */
function createApp() {
  const app = new Hono<TestEnv>();
  app.use(async (c, next) => {
    c.set("requestId", "test-req-123");
    await next();
  });
  // Re-throw HTTPExceptions with .res (same as eeOnError)
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
    }
    return c.json({ error: "unhandled" }, 500);
  });
  return app;
}

/** Domain error class for testing throwIfEEError integration. */
class TestApprovalError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TEST_ERROR_STATUS = { validation: 400, not_found: 404, conflict: 409 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withErrorHandler", () => {
  // ── Success passthrough ────────────────────────────────────────────

  it("passes through successful handler responses", async () => {
    const app = createApp();
    app.get(
      "/ok",
      withErrorHandler("test action", async (c) => {
        return c.json({ result: "success" }, 200);
      }),
    );

    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "success" });
  });

  // ── Error catch with requestId ─────────────────────────────────────

  it("catches errors and returns 500 with requestId and label", async () => {
    const app = createApp();
    app.get(
      "/fail",
      withErrorHandler("list organizations", async () => {
        throw new Error("db connection lost");
      }),
    );

    const res = await app.request("/fail");
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "internal_error",
      message: "Failed to list organizations.",
      requestId: "test-req-123",
    });
  });

  // ── Non-Error thrown → type-narrowed ───────────────────────────────

  it("type-narrows non-Error thrown values", async () => {
    const app = createApp();
    app.get(
      "/throw-string",
      withErrorHandler("process data", async () => {
        throw "raw string error";
      }),
    );

    const res = await app.request("/throw-string");
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to process data.");
    expect(body.requestId).toBe("test-req-123");
  });

  // ── HTTPException passthrough ──────────────────────────────────────

  it("re-throws HTTPExceptions (framework validation, auth errors)", async () => {
    const app = createApp();
    app.get(
      "/http-exc",
      withErrorHandler("validate input", async () => {
        throw new HTTPException(403, {
          res: Response.json(
            { error: "forbidden", message: "Admin required." },
            { status: 403 },
          ),
        });
      }),
    );

    const res = await app.request("/http-exc");
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden");
  });

  // ── Domain error mapping via throwIfEEError ────────────────────────

  it("maps domain errors to HTTPExceptions via throwIfEEError", async () => {
    const app = createApp();
    app.get(
      "/domain-err",
      withErrorHandler(
        "create rule",
        async () => {
          throw new TestApprovalError("conflict", "Rule already exists.");
        },
        [TestApprovalError, TEST_ERROR_STATUS],
      ),
    );

    const res = await app.request("/domain-err");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("conflict");
    expect(body.message).toBe("Rule already exists.");
  });

  it("maps unknown domain error codes to 400 (throwIfEEError default)", async () => {
    const app = createApp();
    app.get(
      "/unmapped-code",
      withErrorHandler(
        "update rule",
        async () => {
          throw new TestApprovalError("unknown_code", "Something unexpected.");
        },
        [TestApprovalError, TEST_ERROR_STATUS],
      ),
    );

    const res = await app.request("/unmapped-code");
    expect(res.status).toBe(400);
  });

  // ── No domain error fallthrough → 500 ─────────────────────────────

  it("returns 500 when error does not match any domain mapping", async () => {
    const app = createApp();
    app.get(
      "/unmatched",
      withErrorHandler(
        "update resource",
        async () => {
          // Regular Error, not a TestApprovalError
          throw new Error("unexpected failure");
        },
        [TestApprovalError, TEST_ERROR_STATUS],
      ),
    );

    const res = await app.request("/unmatched");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to update resource.");
  });

  // ── Without domain mappings → no throwIfEEError call ───────────────

  it("returns 500 without attempting domain mapping when no mappings provided", async () => {
    const app = createApp();
    app.get(
      "/no-mappings",
      withErrorHandler("simple action", async () => {
        // Domain error that would match if mappings were provided
        throw new TestApprovalError("conflict", "Would match if mapped.");
      }),
    );

    // Without mappings, domain error is NOT converted — falls to 500
    const res = await app.request("/no-mappings");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });

  // ── Preserves handler return type ──────────────────────────────────

  it("returns the same function type as the original handler", () => {
    const original = async (c: { json: (data: unknown) => Response }) =>
      c.json({ ok: true });

    const wrapped = withErrorHandler("test", original);

    // Type check: wrapped should be assignable to the same type as original
    const _check: typeof original = wrapped;
    expect(typeof wrapped).toBe("function");
    expect(_check).toBe(wrapped);
  });
});
