import { describe, expect, test } from "bun:test";
import { Writable } from "stream";
import pino from "pino";
import {
  getLogger,
  createLogger,
  withRequestContext,
  getRequestContext,
  redactPaths,
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
});
