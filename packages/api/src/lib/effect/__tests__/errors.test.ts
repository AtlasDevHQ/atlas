import { describe, it, expect } from "bun:test";
import {
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
  SchedulerTaskTimeoutError,
  SchedulerExecutionError,
  DeliveryError,
} from "../errors";

describe("tagged errors", () => {
  it("EmptyQueryError has correct _tag and message", () => {
    const err = new EmptyQueryError({ message: "Empty query" });
    expect(err._tag).toBe("EmptyQueryError");
    expect(err.message).toBe("Empty query");
    expect(err).toBeInstanceOf(Error);
  });

  it("ForbiddenPatternError carries pattern and sql context", () => {
    const err = new ForbiddenPatternError({
      message: "Forbidden SQL operation detected",
      pattern: "INSERT",
      sql: "INSERT INTO foo VALUES (1)",
    });
    expect(err._tag).toBe("ForbiddenPatternError");
    expect(err.pattern).toBe("INSERT");
    expect(err.sql).toBe("INSERT INTO foo VALUES (1)");
  });

  it("ParseError carries sql and optional detail", () => {
    const err = new ParseError({
      message: "Query could not be parsed",
      sql: "SELCT * FROM foo",
      detail: "Unexpected token SELCT",
    });
    expect(err._tag).toBe("ParseError");
    expect(err.sql).toBe("SELCT * FROM foo");
    expect(err.detail).toBe("Unexpected token SELCT");

    // detail is optional
    const err2 = new ParseError({ message: "Parse failed", sql: "???" });
    expect(err2.detail).toBeUndefined();
  });

  it("WhitelistError carries table and allowed list", () => {
    const err = new WhitelistError({
      message: 'Table "secret" is not in the allowed list',
      table: "secret",
      allowed: ["users", "orders"],
    });
    expect(err._tag).toBe("WhitelistError");
    expect(err.table).toBe("secret");
    expect(err.allowed).toEqual(["users", "orders"]);
  });

  it("ConnectionNotFoundError carries connectionId and available list", () => {
    const err = new ConnectionNotFoundError({
      message: 'Connection "foo" is not registered',
      connectionId: "foo",
      available: ["default", "analytics"],
    });
    expect(err._tag).toBe("ConnectionNotFoundError");
    expect(err.connectionId).toBe("foo");
    expect(err.available).toEqual(["default", "analytics"]);
  });

  it("PoolExhaustedError carries current and max counts", () => {
    const err = new PoolExhaustedError({
      message: "Connection pool capacity reached",
      current: 48,
      max: 50,
    });
    expect(err._tag).toBe("PoolExhaustedError");
    expect(err.current).toBe(48);
    expect(err.max).toBe(50);
  });

  it("NoDatasourceError", () => {
    const err = new NoDatasourceError({ message: "No datasource URL" });
    expect(err._tag).toBe("NoDatasourceError");
  });

  it("QueryTimeoutError carries sql and timeoutMs", () => {
    const err = new QueryTimeoutError({
      message: "Query timed out",
      sql: "SELECT * FROM large_table",
      timeoutMs: 30000,
    });
    expect(err._tag).toBe("QueryTimeoutError");
    expect(err.timeoutMs).toBe(30000);
  });

  it("QueryExecutionError carries optional hint and position", () => {
    const err = new QueryExecutionError({
      message: 'column "foo" does not exist',
      hint: 'Perhaps you meant "bar"',
      position: "42",
    });
    expect(err._tag).toBe("QueryExecutionError");
    expect(err.hint).toBe('Perhaps you meant "bar"');
    expect(err.position).toBe("42");

    // hint and position are optional
    const err2 = new QueryExecutionError({ message: "DB error" });
    expect(err2.hint).toBeUndefined();
    expect(err2.position).toBeUndefined();
  });

  it("RateLimitExceededError carries sourceId, limit, and optional retryAfterMs", () => {
    const err = new RateLimitExceededError({
      message: "QPM limit reached",
      sourceId: "default",
      limit: 60,
      retryAfterMs: 5000,
    });
    expect(err._tag).toBe("RateLimitExceededError");
    expect(err.sourceId).toBe("default");
    expect(err.limit).toBe(60);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("ConcurrencyLimitError carries sourceId and limit", () => {
    const err = new ConcurrencyLimitError({
      message: "Concurrency limit reached",
      sourceId: "analytics",
      limit: 5,
    });
    expect(err._tag).toBe("ConcurrencyLimitError");
    expect(err.limit).toBe(5);
  });

  it("RLSError carries phase discriminant", () => {
    for (const phase of ["extraction", "filter", "injection"] as const) {
      const err = new RLSError({ message: `RLS ${phase} failed`, phase });
      expect(err._tag).toBe("RLSError");
      expect(err.phase).toBe(phase);
    }
  });

  it("EnterpriseGateError carries feature name", () => {
    const err = new EnterpriseGateError({
      message: "Enterprise feature not available",
      feature: "sso",
    });
    expect(err._tag).toBe("EnterpriseGateError");
    expect(err.feature).toBe("sso");
  });

  it("ApprovalRequiredError carries matched rules", () => {
    const err = new ApprovalRequiredError({
      message: "Approval required",
      rules: ["sensitive-data", "pii-access"],
    });
    expect(err._tag).toBe("ApprovalRequiredError");
    expect(err.rules).toEqual(["sensitive-data", "pii-access"]);
  });

  it("PluginRejectedError carries connectionId", () => {
    const err = new PluginRejectedError({
      message: "Query rejected by plugin",
      connectionId: "snowflake-1",
    });
    expect(err._tag).toBe("PluginRejectedError");
    expect(err.connectionId).toBe("snowflake-1");
  });

  it("CustomValidatorError carries connectionId", () => {
    const err = new CustomValidatorError({
      message: "Custom validator error",
      connectionId: "salesforce-1",
    });
    expect(err._tag).toBe("CustomValidatorError");
    expect(err.connectionId).toBe("salesforce-1");
  });

  it("ActionTimeoutError carries timeoutMs", () => {
    const err = new ActionTimeoutError({
      message: "Action timed out after 10000ms",
      timeoutMs: 10000,
    });
    expect(err._tag).toBe("ActionTimeoutError");
    expect(err.timeoutMs).toBe(10000);
  });

  it("SchedulerTaskTimeoutError carries taskId and timeoutMs", () => {
    const err = new SchedulerTaskTimeoutError({
      message: "Timed out",
      taskId: "task-1",
      timeoutMs: 60000,
    });
    expect(err._tag).toBe("SchedulerTaskTimeoutError");
    expect(err.taskId).toBe("task-1");
    expect(err.timeoutMs).toBe(60000);
    expect(err).toBeInstanceOf(Error);
  });

  it("SchedulerExecutionError carries taskId and optional runId", () => {
    const err = new SchedulerExecutionError({
      message: "Agent crashed",
      taskId: "task-1",
      runId: "run-1",
    });
    expect(err._tag).toBe("SchedulerExecutionError");
    expect(err.taskId).toBe("task-1");
    expect(err.runId).toBe("run-1");

    // runId is optional
    const err2 = new SchedulerExecutionError({ message: "fail", taskId: "task-2" });
    expect(err2.runId).toBeUndefined();
  });

  it("DeliveryError carries channel, recipient, and permanent flag", () => {
    const transient = new DeliveryError({
      message: "HTTP 500",
      channel: "webhook",
      recipient: "https://example.com",
      permanent: false,
    });
    expect(transient._tag).toBe("DeliveryError");
    expect(transient.channel).toBe("webhook");
    expect(transient.recipient).toBe("https://example.com");
    expect(transient.permanent).toBe(false);

    const permanent = new DeliveryError({
      message: "Blocked URL",
      channel: "webhook",
      recipient: "http://localhost",
      permanent: true,
    });
    expect(permanent.permanent).toBe(true);
  });

  it("all tagged errors are instances of Error", () => {
    const errors = [
      new EmptyQueryError({ message: "empty" }),
      new ForbiddenPatternError({ message: "forbidden", pattern: "DROP", sql: "DROP TABLE" }),
      new ParseError({ message: "parse", sql: "bad" }),
      new WhitelistError({ message: "whitelist", table: "t", allowed: [] }),
      new ConnectionNotFoundError({ message: "not found", connectionId: "x", available: [] }),
      new PoolExhaustedError({ message: "pool", current: 0, max: 0 }),
      new NoDatasourceError({ message: "no ds" }),
      new QueryTimeoutError({ message: "timeout", sql: "SELECT 1", timeoutMs: 1000 }),
      new QueryExecutionError({ message: "exec" }),
      new RateLimitExceededError({ message: "rate", sourceId: "s", limit: 1 }),
      new ConcurrencyLimitError({ message: "conc", sourceId: "s", limit: 1 }),
      new RLSError({ message: "rls", phase: "filter" }),
      new EnterpriseGateError({ message: "ee", feature: "f" }),
      new ApprovalRequiredError({ message: "approval", rules: [] }),
      new PluginRejectedError({ message: "plugin", connectionId: "c" }),
      new CustomValidatorError({ message: "validator", connectionId: "c" }),
      new ActionTimeoutError({ message: "timeout", timeoutMs: 1000 }),
      new SchedulerTaskTimeoutError({ message: "timeout", taskId: "t", timeoutMs: 1000 }),
      new SchedulerExecutionError({ message: "exec", taskId: "t" }),
      new DeliveryError({ message: "fail", channel: "webhook", recipient: "url", permanent: false }),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(typeof err._tag).toBe("string");
      expect(typeof err.message).toBe("string");
    }
  });
});
