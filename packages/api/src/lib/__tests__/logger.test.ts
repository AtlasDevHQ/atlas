import { describe, expect, test } from "bun:test";
import { Writable } from "stream";
import pino from "pino";
import {
  getLogger,
  createLogger,
  withRequestContext,
  getRequestContext,
  redactPaths,
  hashShareToken,
  scrubErrSerializer,
  scrubLogFormatter,
} from "../logger";

describe("logger", () => {
  test("getLogger returns a pino logger with expected methods", () => {
    const log = getLogger();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  test("createLogger returns a child logger with component binding", () => {
    const log = createLogger("test-component");
    expect(typeof log.info).toBe("function");
    const bindings = log.bindings();
    expect(bindings.component).toBe("test-component");
  });

  test("withRequestContext makes requestId available via getRequestContext", () => {
    const requestId = "test-request-123";

    withRequestContext({ requestId }, () => {
      const ctx = getRequestContext();
      expect(ctx).toBeDefined();
      expect(ctx!.requestId).toBe(requestId);
    });
  });

  test("getLogger outside request context returns root logger", () => {
    const log = getLogger();
    const bindings = log.bindings();
    expect(bindings.requestId).toBeUndefined();
  });

  test("getRequestContext returns undefined outside context", () => {
    const ctx = getRequestContext();
    expect(ctx).toBeUndefined();
  });

  test("mixin injects requestId into log output within withRequestContext", () => {
    const requestId = "mixin-test-456";

    // Create a pino logger that mimics the module's mixin, writing to a stream
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const testLogger = pino(
      {
        level: "info",
        mixin() {
          const ctx = getRequestContext();
          return ctx ? { requestId: ctx.requestId } : {};
        },
      },
      stream,
    );

    // Outside context — no requestId
    testLogger.info({ msg: "no-context" });
    const outsideParsed = JSON.parse(Buffer.concat(chunks).toString());
    expect(outsideParsed.requestId).toBeUndefined();

    // Inside context — requestId injected by mixin
    chunks.length = 0;
    withRequestContext({ requestId }, () => {
      testLogger.info({ msg: "with-context" });
    });
    const insideParsed = JSON.parse(Buffer.concat(chunks).toString());
    expect(insideParsed.requestId).toBe(requestId);
  });

  test("withRequestContext propagates user to getRequestContext", () => {
    const user = { id: "test-user-id", mode: "simple-key" as const, label: "api-key-test" };
    withRequestContext({ requestId: "req-123", user }, () => {
      const ctx = getRequestContext();
      expect(ctx).toBeDefined();
      expect(ctx!.user).toEqual(user);
    });
  });

  test("mixin injects userId and authMode when user is present in context", () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const testLogger = pino(
      {
        level: "info",
        mixin() {
          const ctx = getRequestContext();
          if (!ctx) return {};
          const base: Record<string, unknown> = { requestId: ctx.requestId };
          if (ctx.user) {
            base.userId = ctx.user.id;
            base.authMode = ctx.user.mode;
          }
          return base;
        },
      },
      stream,
    );

    const user = { id: "api-key-abc12345", mode: "simple-key" as const, label: "api-key-sk-t" };
    withRequestContext({ requestId: "req-with-user", user }, () => {
      testLogger.info("authenticated request");
    });

    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    expect(parsed.requestId).toBe("req-with-user");
    expect(parsed.userId).toBe("api-key-abc12345");
    expect(parsed.authMode).toBe("simple-key");
  });

  test("redaction replaces sensitive fields with [Redacted]", () => {
    // Create a test logger with equivalent redact paths (object form for explicit censor assertion)
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const testLogger = pino(
      {
        level: "info",
        redact: { paths: redactPaths, censor: "[Redacted]" },
      },
      stream,
    );

    testLogger.info({
      msg: "connection attempt",
      password: "super-secret-pw",
      apiKey: "sk-ant-key-12345",
      connectionString: "postgresql://user:pass@host/db",
      safe: "this-should-remain",
    });

    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output);

    expect(parsed.password).toBe("[Redacted]");
    expect(parsed.apiKey).toBe("[Redacted]");
    expect(parsed.connectionString).toBe("[Redacted]");
    expect(parsed.safe).toBe("this-should-remain");
  });

  // ---------------------------------------------------------------------------
  // setLogLevel validation (#1089 gap 3)
  // ---------------------------------------------------------------------------

  test("setLogLevel accepts valid levels", async () => {
    const { setLogLevel } = await import("../logger");
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      expect(setLogLevel(level)).toBe(true);
    }
  });

  test("setLogLevel rejects invalid levels", async () => {
    const { setLogLevel } = await import("../logger");
    expect(setLogLevel("verbose")).toBe(false);
    expect(setLogLevel("")).toBe(false);
    expect(setLogLevel("INFO")).toBe(false);
    expect(setLogLevel("critical")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // hashShareToken — share-token log redaction (#1743)
  // ---------------------------------------------------------------------------

  test("hashShareToken returns 16 lowercase hex chars", () => {
    const hash = hashShareToken("abc123def456ghi789jk");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toHaveLength(16);
  });

  test("hashShareToken is deterministic for the same input", () => {
    const token = "abc123def456ghi789jk";
    expect(hashShareToken(token)).toBe(hashShareToken(token));
  });

  test("hashShareToken produces different output for different inputs", () => {
    const a = hashShareToken("abc123def456ghi789jk");
    const b = hashShareToken("zzz999def456ghi789jk");
    expect(a).not.toBe(b);
  });

  test("hashShareToken does not return the input token", () => {
    const token = "abc123def456ghi789jk";
    const hash = hashShareToken(token);
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token.slice(0, 8));
  });

  test("hashShareToken throws on non-string input", () => {
    expect(() => hashShareToken(undefined as unknown as string)).toThrow(TypeError);
    expect(() => hashShareToken(null as unknown as string)).toThrow(TypeError);
    expect(() => hashShareToken(123 as unknown as string)).toThrow(TypeError);
  });

  test("redaction works for nested fields", () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const testLogger = pino(
      {
        level: "info",
        redact: { paths: redactPaths, censor: "[Redacted]" },
      },
      stream,
    );

    testLogger.info({
      msg: "nested secret test",
      config: {
        password: "nested-secret",
        apiKey: "nested-key",
        safe: "visible",
      },
    });

    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output);

    expect(parsed.config.password).toBe("[Redacted]");
    expect(parsed.config.apiKey).toBe("[Redacted]");
    expect(parsed.config.safe).toBe("visible");
  });

  // ---------------------------------------------------------------------------
  // F-44 — connection-string userinfo scrub in pino err serializer + formatter.
  //
  // Covers the log-feed credential exposure in SaaS where pg / mysql2 / better-
  // auth error text sometimes echoes the whole DSN (`postgres://user:pass@...`)
  // as `err.message`. Before this phase the pino redact.paths list covered
  // field *names* but nothing inside a string value, so a top-level `err` field
  // (which was NOT redacted) carried the password straight into Grafana Loki,
  // Railway logs, and Datadog.
  //
  // Tests build a pino logger matching the module's real config (redact +
  // serializers + formatters) and assert:
  //   1. `err` field scrubbed whether passed as string / Error / error-shape.
  //   2. Top-level non-`err` string fields carrying a DSN also scrubbed
  //      (second-line defense — the formatter walks every string field).
  //   3. Field-name redaction expanded to cover the F-44 list:
  //      cookie, set-cookie, bearer, refreshToken, botToken, signingSecret,
  //      clientSecret, webhookSecret, appPassword, serverToken — plus their
  //      one-level and array-element variants.
  //   4. Fail-open: scrubber never drops a log line, even on throw.
  // ---------------------------------------------------------------------------

  function captureSink(): { chunks: Buffer[]; stream: Writable } {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });
    return { chunks, stream };
  }

  function makeScrubLogger(stream: Writable, level: pino.Level = "info"): pino.Logger {
    return pino(
      {
        level,
        redact: { paths: redactPaths, censor: "[Redacted]" },
        serializers: { err: scrubErrSerializer },
        formatters: { log: scrubLogFormatter },
      },
      stream,
    );
  }

  describe("scrubErrSerializer (F-44)", () => {
    test("scrubs userinfo from string err value", () => {
      const out = scrubErrSerializer("connect postgres://u:pw@h:5432/db failed");
      expect(out).toBe("connect postgres://***@h:5432/db failed");
    });

    test("scrubs userinfo from Error.message and preserves type + stack shape", () => {
      const err = new Error("bad DSN mysql://u:pw@host:3306/db timed out");
      const out = scrubErrSerializer(err) as { type: string; message: string; stack?: string };
      expect(out.type).toBe("Error");
      expect(out.message).toBe("bad DSN mysql://***@host:3306/db timed out");
      // Stack also scrubbed when it echoes the DSN (bun/Node sometimes copy message into stack).
      expect(out.stack ?? "").not.toContain("u:pw@");
    });

    test("scrubs userinfo from a pre-serialized error-shape object", () => {
      const out = scrubErrSerializer({ type: "DatabaseError", message: "postgres://u:pw@h/db failed" });
      expect((out as { message: string }).message).toBe("postgres://***@h/db failed");
    });

    test("truncates message over 512 chars with ellipsis", () => {
      const long = "a".repeat(600) + " postgres://u:p@h/db";
      const out = scrubErrSerializer(long);
      expect(typeof out).toBe("string");
      expect((out as string).length).toBeLessThanOrEqual(512);
      expect((out as string).endsWith("...")).toBe(true);
    });

    test("preserves non-matching error text byte-for-byte", () => {
      const msg = "timeout after 30000ms waiting for pool";
      expect(scrubErrSerializer(msg)).toBe(msg);
    });

    test("coerces non-error values via errorMessage semantics", () => {
      expect(scrubErrSerializer(42)).toBe("42");
      expect(scrubErrSerializer(null)).toBe("null");
      expect(scrubErrSerializer(undefined)).toBe("undefined");
    });
  });

  describe("scrubLogFormatter (F-44)", () => {
    test("scrubs userinfo in a non-err top-level string field", () => {
      const out = scrubLogFormatter({
        msg: "startup",
        reason: "connect postgres://admin:hunter2@db:5432/atlas failed",
      });
      expect(out.reason).toBe("connect postgres://***@db:5432/atlas failed");
    });

    test("leaves strings without a DSN shape unchanged", () => {
      const input = { msg: "hello", latencyMs: 42, note: "no secrets here" };
      const out = scrubLogFormatter({ ...input });
      expect(out).toEqual(input);
    });

    test("walks only top-level string fields (deep fields covered by redact.paths)", () => {
      // nested unknown fields are NOT walked — we rely on redact.paths for
      // the known-name nested fields, and on the err serializer to cover
      // nested errors.
      const out = scrubLogFormatter({
        msg: "x",
        nested: { raw: "postgres://u:p@h/db" },
      });
      expect((out.nested as { raw: string }).raw).toBe("postgres://u:p@h/db");
    });

    test("does not mutate the caller's object (copy-on-write)", () => {
      // pino passes the caller's merged log object by reference. If the
      // formatter mutated it, a caller that logs a long-lived reference
      // would observe the scrubbed string in their in-memory state.
      const caller = {
        msg: "x",
        reason: "postgres://u:p@h/db failed",
        other: "noop",
      };
      const before = { ...caller };
      const out = scrubLogFormatter(caller);
      expect(caller).toEqual(before);
      expect(caller.reason).toBe("postgres://u:p@h/db failed");
      expect((out as { reason: string }).reason).toBe("postgres://***@h/db failed");
      expect(out).not.toBe(caller);
    });

    test("does not clone when no field matches (allocation-free hot path)", () => {
      const caller = { msg: "x", note: "no secrets here", latencyMs: 42 };
      const out = scrubLogFormatter(caller);
      expect(out).toBe(caller);
    });

    test("fails open — returns original object if scrubbing throws", () => {
      // Simulate a pathological string via a Proxy that throws on read. The
      // formatter must still return an object — never throw, never drop.
      const throwing: Record<string, unknown> = new Proxy(
        { msg: "test" },
        {
          ownKeys() {
            throw new Error("boom");
          },
        },
      ) as Record<string, unknown>;
      let out: unknown;
      expect(() => {
        out = scrubLogFormatter(throwing);
      }).not.toThrow();
      expect(out).toBe(throwing);
    });
  });

  describe("logger integration with scrubbing (F-44)", () => {
    test("F-44 repro — admin-connections probe failure with DSN err string is scrubbed", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);

      // This mirrors the exact call shape from admin-connections.ts
      // after a pg connect() rejects with driver-echoed DSN text.
      log.warn(
        { err: "getaddrinfo ENOTFOUND for postgres://admin:hunter2@db:5432/atlas", requestId: "req-1" },
        "Connection test failed",
      );

      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      // err may be serialized as string or as { message }; assert the DSN
      // password never appears in the emitted line.
      const raw = JSON.stringify(parsed);
      expect(raw).not.toContain("hunter2");
      expect(raw).toContain("postgres://***@db:5432/atlas");
    });

    test("Error instance with DSN in message is scrubbed", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      const err = new Error("ECONNREFUSED mysql://root:secret@db:3306/warehouse");
      log.error({ err, connectionId: "default" }, "Health check failed");

      const raw = Buffer.concat(chunks).toString();
      expect(raw).not.toContain("secret@");
      expect(raw).toContain("mysql://***@db:3306/warehouse");
    });

    test("top-level cookie field is redacted", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ cookie: "sessionid=abc123; other=x" }, "req");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed.cookie).toBe("[Redacted]");
    });

    test("top-level set-cookie field is redacted", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ "set-cookie": "token=xyz789" }, "resp");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed["set-cookie"]).toBe("[Redacted]");
    });

    test.each([
      "bearer",
      "refreshToken",
      "botToken",
      "signingSecret",
      "clientSecret",
      "webhookSecret",
      "appPassword",
      "serverToken",
    ])("top-level %s field is redacted", (field) => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ [field]: "very-secret-value-abc" }, "x");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed[field]).toBe("[Redacted]");
    });

    test("nested botToken via *. wildcard is redacted", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ integration: { botToken: "xoxb-1234-abcd" } }, "slack");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed.integration.botToken).toBe("[Redacted]");
    });

    test("nested refreshToken via *. wildcard is redacted", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ oauth: { refreshToken: "rt-abc" } }, "oauth");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed.oauth.refreshToken).toBe("[Redacted]");
    });

    test("array-element clientSecret via [*]. is redacted", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info({ integrations: [{ clientSecret: "s1" }, { clientSecret: "s2" }] }, "list");
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed.integrations[0].clientSecret).toBe("[Redacted]");
      expect(parsed.integrations[1].clientSecret).toBe("[Redacted]");
    });

    test("non-credential fields pass through untouched alongside redaction", () => {
      const { chunks, stream } = captureSink();
      const log = makeScrubLogger(stream);
      log.info(
        {
          requestId: "req-xyz",
          userId: "user-123",
          latencyMs: 42,
          password: "sekret",
          safe: "visible-value",
        },
        "mixed",
      );
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed.requestId).toBe("req-xyz");
      expect(parsed.userId).toBe("user-123");
      expect(parsed.latencyMs).toBe(42);
      expect(parsed.password).toBe("[Redacted]");
      expect(parsed.safe).toBe("visible-value");
    });
  });
});
