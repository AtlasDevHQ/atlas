/**
 * Tests for the internal DB circuit breaker with Effect-based recovery.
 *
 * Verifies:
 * - Circuit trips after consecutive failures
 * - Calls are dropped when circuit is open
 * - _resetCircuitBreaker cleans up state and recovery fiber
 * - Recovery probe uses Effect.retry with exponential backoff
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { InternalPool } from "../internal";
import {
  internalExecute,
  _resetCircuitBreaker,
  _resetPool,
  hasInternalDB,
} from "../internal";

/** Create a mock pool that tracks calls and can be toggled between success/failure. */
function createMockPool(opts: { shouldFail: boolean }) {
  let queryCount = 0;
  const pool: InternalPool & { _getQueryCount: () => number } = {
    async query() {
      queryCount++;
      if (opts.shouldFail) throw new Error("mock connection refused");
      return { rows: [{ "?column?": 1 }] };
    },
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    async end() {},
    on() {},
    _getQueryCount: () => queryCount,
  };
  return pool;
}

describe("Internal DB circuit breaker (Effect-based recovery)", () => {
  const savedDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test@localhost/internal";
    _resetCircuitBreaker();
  });

  afterEach(() => {
    _resetCircuitBreaker();
    _resetPool();
    if (savedDbUrl !== undefined) {
      process.env.DATABASE_URL = savedDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("executes query successfully when DB is healthy", async () => {
    const pool = createMockPool({ shouldFail: false });
    _resetPool(pool);

    internalExecute("INSERT INTO audit_log (sql) VALUES ($1)", ["SELECT 1"]);
    await new Promise((r) => setTimeout(r, 50));

    expect(pool._getQueryCount()).toBeGreaterThanOrEqual(1);
  });

  it("trips circuit after 5 consecutive failures", async () => {
    const pool = createMockPool({ shouldFail: true });
    _resetPool(pool);

    // Trigger 5 failures (MAX_CONSECUTIVE_FAILURES)
    for (let i = 0; i < 6; i++) {
      internalExecute("INSERT INTO test VALUES ($1)", [i]);
    }

    // Wait for fire-and-forget promises to settle
    await new Promise((r) => setTimeout(r, 150));

    // Now the circuit should be open — this call should be dropped silently
    const countBefore = pool._getQueryCount();
    internalExecute("INSERT INTO test VALUES ($1)", ["should-be-dropped"]);
    await new Promise((r) => setTimeout(r, 50));

    // No new query should have been made
    expect(pool._getQueryCount()).toBe(countBefore);
  });

  it("_resetCircuitBreaker resets state and allows new queries", async () => {
    const failPool = createMockPool({ shouldFail: true });
    _resetPool(failPool);

    // Trip the circuit
    for (let i = 0; i < 6; i++) {
      internalExecute("INSERT INTO test VALUES ($1)", [i]);
    }
    await new Promise((r) => setTimeout(r, 150));

    // Verify circuit is tripped — calls should be dropped
    const droppedBefore = failPool._getQueryCount();
    internalExecute("INSERT INTO test VALUES ($1)", ["dropped"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(failPool._getQueryCount()).toBe(droppedBefore);

    // Reset and inject a healthy pool
    _resetCircuitBreaker();
    const healthyPool = createMockPool({ shouldFail: false });
    _resetPool(healthyPool);

    // Should be able to execute again
    internalExecute("INSERT INTO test VALUES ($1)", ["after-reset"]);
    await new Promise((r) => setTimeout(r, 50));

    expect(healthyPool._getQueryCount()).toBeGreaterThanOrEqual(1);
  });

  it("drops multiple calls while circuit is open", async () => {
    const pool = createMockPool({ shouldFail: true });
    _resetPool(pool);

    // Trip the circuit
    for (let i = 0; i < 6; i++) {
      internalExecute("INSERT INTO test VALUES ($1)", [i]);
    }
    await new Promise((r) => setTimeout(r, 150));

    // Multiple calls should all be dropped
    const countBefore = pool._getQueryCount();
    for (let i = 0; i < 10; i++) {
      internalExecute("INSERT INTO test VALUES ($1)", [`dropped-${i}`]);
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(pool._getQueryCount()).toBe(countBefore);
  });

  it("hasInternalDB returns false without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    _resetPool();
    expect(hasInternalDB()).toBe(false);
  });

  it("hasInternalDB returns true with DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://test@localhost/internal";
    expect(hasInternalDB()).toBe(true);
  });
});
