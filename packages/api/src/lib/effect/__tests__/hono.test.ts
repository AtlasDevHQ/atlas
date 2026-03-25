import { describe, it, expect, mock } from "bun:test";
import { Effect } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

// Mock logger — must export ALL named exports per CLAUDE.md mock rules
const mockLogger = () => ({
  info: mock(),
  warn: mock(),
  error: mock(),
  debug: mock(),
  fatal: mock(),
  child: mock(),
});
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: mockLogger,
  getLogger: mockLogger,
  withRequestContext: mock((_ctx: unknown, fn: () => unknown) => fn()),
  getRequestContext: mock(() => undefined),
  redactPaths: [],
}));

const { runEffect, mapTaggedError } = await import("../hono");
const {
  EmptyQueryError,
  ForbiddenPatternError,
  ParseError,
  WhitelistError,
  ConnectionNotFoundError,
  PoolExhaustedError,
  NoDatasourceError,
  QueryTimeoutError,
  QueryExecutionError,
  RateLimitExceededError,
  ConcurrencyLimitError,
  RLSError,
  EnterpriseGateError,
  ApprovalRequiredError,
  PluginRejectedError,
  CustomValidatorError,
  ActionTimeoutError,
} = await import("../errors");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestEnv = { Variables: { requestId: string } };

interface ErrorBody {
  error: string;
  message: string;
  requestId: string;
}

/** Create a minimal Hono app with requestId middleware. */
function createApp() {
  const app = new Hono<TestEnv>();
  app.use(async (c, next) => {
    c.set("requestId", "test-req-123");
    await next();
  });
  // Return HTTPException .res body (same pattern as eeOnError in production)
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
    }
    return c.json({ error: "unhandled" }, 500);
  });
  return app;
}

// ---------------------------------------------------------------------------
// mapTaggedError unit tests (exhaustive — uses real error instances)
// ---------------------------------------------------------------------------

describe("mapTaggedError", () => {
  it("maps EmptyQueryError to 400", () => {
    const result = mapTaggedError(new EmptyQueryError({ message: "Empty query" }));
    expect(result).toEqual({ status: 400, code: "bad_request", message: "Empty query" });
  });

  it("maps ParseError to 400", () => {
    const result = mapTaggedError(new ParseError({ message: "Parse failed", sql: "bad" }));
    expect(result.status).toBe(400);
    expect(result.code).toBe("bad_request");
  });

  it("maps ForbiddenPatternError to 403", () => {
    const result = mapTaggedError(new ForbiddenPatternError({ message: "Forbidden", pattern: "DROP", sql: "DROP TABLE" }));
    expect(result.status).toBe(403);
    expect(result.code).toBe("forbidden");
  });

  it("maps WhitelistError to 403", () => {
    const result = mapTaggedError(new WhitelistError({ message: "Not allowed", table: "t", allowed: [] }));
    expect(result.status).toBe(403);
  });

  it("maps EnterpriseGateError to 403", () => {
    const result = mapTaggedError(new EnterpriseGateError({ message: "Feature gated", feature: "sso" }));
    expect(result.status).toBe(403);
  });

  it("maps ApprovalRequiredError to 403", () => {
    const result = mapTaggedError(new ApprovalRequiredError({ message: "Needs approval", rules: [] }));
    expect(result.status).toBe(403);
  });

  it("maps RLSError to 403", () => {
    const result = mapTaggedError(new RLSError({ message: "RLS failed", phase: "filter" }));
    expect(result.status).toBe(403);
  });

  it("maps ConnectionNotFoundError to 404", () => {
    const result = mapTaggedError(new ConnectionNotFoundError({ message: "Not found", connectionId: "x", available: [] }));
    expect(result.status).toBe(404);
    expect(result.code).toBe("not_found");
  });

  it("maps PluginRejectedError to 422", () => {
    const result = mapTaggedError(new PluginRejectedError({ message: "Rejected", connectionId: "c" }));
    expect(result.status).toBe(422);
    expect(result.code).toBe("unprocessable_entity");
  });

  it("maps CustomValidatorError to 422", () => {
    const result = mapTaggedError(new CustomValidatorError({ message: "Invalid", connectionId: "c" }));
    expect(result.status).toBe(422);
  });

  it("maps RateLimitExceededError to 429 with Retry-After header", () => {
    const result = mapTaggedError(new RateLimitExceededError({ message: "Rate limited", sourceId: "s", limit: 60, retryAfterMs: 5000 }));
    expect(result.status).toBe(429);
    expect(result.code).toBe("rate_limited");
    expect(result.headers).toEqual({ "Retry-After": "5" });
  });

  it("maps RateLimitExceededError without retryAfterMs to default Retry-After", () => {
    const result = mapTaggedError(new RateLimitExceededError({ message: "Rate limited", sourceId: "s", limit: 60 }));
    expect(result.headers).toEqual({ "Retry-After": "60" });
  });

  it("maps ConcurrencyLimitError to 429", () => {
    const result = mapTaggedError(new ConcurrencyLimitError({ message: "Concurrent", sourceId: "s", limit: 5 }));
    expect(result.status).toBe(429);
  });

  it("maps PoolExhaustedError to 429", () => {
    const result = mapTaggedError(new PoolExhaustedError({ message: "Pool full", current: 50, max: 50 }));
    expect(result.status).toBe(429);
    expect(result.code).toBe("rate_limited");
  });

  it("maps QueryExecutionError to 502", () => {
    const result = mapTaggedError(new QueryExecutionError({ message: "DB error" }));
    expect(result.status).toBe(502);
    expect(result.code).toBe("upstream_error");
  });

  it("maps NoDatasourceError to 503", () => {
    const result = mapTaggedError(new NoDatasourceError({ message: "No datasource" }));
    expect(result.status).toBe(503);
    expect(result.code).toBe("service_unavailable");
  });

  it("maps QueryTimeoutError to 504", () => {
    const result = mapTaggedError(new QueryTimeoutError({ message: "Timeout", sql: "SELECT 1", timeoutMs: 30000 }));
    expect(result.status).toBe(504);
    expect(result.code).toBe("timeout");
  });

  it("maps ActionTimeoutError to 504", () => {
    const result = mapTaggedError(new ActionTimeoutError({ message: "Timeout", timeoutMs: 10000 }));
    expect(result.status).toBe(504);
  });
});

// ---------------------------------------------------------------------------
// runEffect integration tests (Hono request lifecycle)
// ---------------------------------------------------------------------------

describe("runEffect", () => {
  it("returns the success value", async () => {
    const app = createApp();
    app.get("/test", async (c) => {
      const value = await runEffect(c, Effect.succeed({ answer: 42 }));
      return c.json(value, 200);
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: number };
    expect(body).toEqual({ answer: 42 });
  });

  it("maps tagged EmptyQueryError to 400", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(new EmptyQueryError({ message: "Empty query" })),
        { label: "execute query" },
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe("Empty query");
    expect(body.requestId).toBe("test-req-123");
  });

  it("maps tagged ConnectionNotFoundError to 404", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(
          new ConnectionNotFoundError({
            message: 'Connection "foo" is not registered',
            connectionId: "foo",
            available: ["default"],
          }),
        ),
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBe("test-req-123");
  });

  it("maps tagged RateLimitExceededError to 429 with Retry-After header", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(
          new RateLimitExceededError({
            message: "QPM limit reached",
            sourceId: "default",
            limit: 60,
            retryAfterMs: 5000,
          }),
        ),
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("maps tagged PoolExhaustedError to 429", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(
          new PoolExhaustedError({ message: "Pool full", current: 50, max: 50 }),
        ),
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("rate_limited");
  });

  it("maps tagged QueryTimeoutError to 504", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(
          new QueryTimeoutError({
            message: "Query timed out",
            sql: "SELECT 1",
            timeoutMs: 30000,
          }),
        ),
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(504);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("timeout");
  });

  it("returns 500 for unmapped typed errors", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.fail(new Error("something unexpected")),
        { label: "process thing" },
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to process thing.");
    expect(body.requestId).toBe("test-req-123");
  });

  it("returns 500 for tagged errors with unknown _tag", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        // Simulate a tagged error not in the AtlasError union
        Effect.fail({ _tag: "FutureError", message: "not yet mapped" } as never),
        { label: "future thing" },
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to future thing.");
  });

  it("returns 500 for fiber interruptions", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.interrupt,
        { label: "long operation" },
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("interrupted");
    expect(body.message).toBe("Request to long operation was interrupted.");
  });

  it("returns 500 for defects (unexpected throws)", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.die(new Error("segfault")),
        { label: "run pipeline" },
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to run pipeline.");
    expect(body.requestId).toBe("test-req-123");
  });

  it("returns 500 for non-Error defects", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(c, Effect.die("string defect")),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("internal_error");
  });

  it("uses default label when none provided", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(c, Effect.fail(new Error("oops"))),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.message).toBe("Failed to process request.");
  });

  it("uses 'unknown' requestId when not set", async () => {
    const app = new Hono();
    // No requestId middleware
    app.get("/test", async (c) =>
      runEffect(c, Effect.fail(new EmptyQueryError({ message: "Empty" }))),
    );
    app.onError((err) => {
      if (err instanceof HTTPException && err.res) return err.res;
      return new Response("unhandled", { status: 500 });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.requestId).toBe("unknown");
  });

  it("works with Effect.gen programs", async () => {
    const app = createApp();
    app.get("/test", async (c) => {
      const result = await runEffect(
        c,
        Effect.gen(function* () {
          const a = yield* Effect.succeed(10);
          const b = yield* Effect.succeed(20);
          return { sum: a + b };
        }),
      );
      return c.json(result, 200);
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sum: number };
    expect(body).toEqual({ sum: 30 });
  });

  it("works with Effect.gen failures", async () => {
    const app = createApp();
    app.get("/test", async (c) =>
      runEffect(
        c,
        Effect.gen(function* () {
          yield* Effect.succeed(1);
          return yield* Effect.fail(
            new WhitelistError({
              message: 'Table "secret" is not allowed',
              table: "secret",
              allowed: ["users"],
            }),
          );
        }),
      ),
    );

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("forbidden");
    expect(body.message).toBe('Table "secret" is not allowed');
  });
});
