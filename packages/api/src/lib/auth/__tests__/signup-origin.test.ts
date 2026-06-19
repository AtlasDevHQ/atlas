/**
 * Unit coverage for the signup-origin AsyncLocalStorage (#3653).
 *
 * The MCP_SIGNUP suppression contract rests entirely on the ALS value surviving
 * the await chain between `runWithSignupOrigin("mcp", …)` (in
 * `provisionTrialWorkspace`) and the point `getSignupOrigin()` is read inside
 * Better Auth's `user.create.after` hook. These tests pin that propagation
 * guarantee directly — independent of Better Auth — so the cross-module wiring
 * test (`signup-origin-wiring.test.ts`) and the helper suppression test rest on
 * a proven primitive rather than an assumed one.
 */

import { describe, it, expect } from "bun:test";
import { runWithSignupOrigin, getSignupOrigin } from "../signup-origin";

describe("signup-origin AsyncLocalStorage", () => {
  it("reads back the bound origin synchronously inside the scope", () => {
    let seen: string | undefined;
    runWithSignupOrigin("mcp", () => {
      seen = getSignupOrigin();
    });
    expect(seen).toBe("mcp");
  });

  it("returns undefined outside any scope (the ordinary web-signup case)", () => {
    expect(getSignupOrigin()).toBeUndefined();
  });

  it("survives a single await boundary", async () => {
    const seen = await runWithSignupOrigin("mcp", async () => {
      await Promise.resolve();
      return getSignupOrigin();
    });
    expect(seen).toBe("mcp");
  });

  it("survives nested / chained microtask boundaries", async () => {
    const seen = await runWithSignupOrigin("mcp", async () => {
      await Promise.resolve();
      await Promise.resolve().then(() => Promise.resolve());
      await Promise.all([Promise.resolve(), Promise.resolve()]);
      return getSignupOrigin();
    });
    expect(seen).toBe("mcp");
  });

  it("survives a macrotask (setTimeout) boundary", async () => {
    const seen = await runWithSignupOrigin("mcp", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return getSignupOrigin();
    });
    expect(seen).toBe("mcp");
  });

  it("propagates into a nested async helper that never threads the value", async () => {
    // The hook reads the origin without the provisioner passing it as an arg —
    // this is the exact shape the suppression relies on.
    async function deepRead(): Promise<string | undefined> {
      await Promise.resolve();
      return getSignupOrigin();
    }
    const seen = await runWithSignupOrigin("mcp", () => deepRead());
    expect(seen).toBe("mcp");
  });

  it("returns whatever fn resolves to", async () => {
    const result = await runWithSignupOrigin("mcp", async () => 42);
    expect(result).toBe(42);
  });

  it("does not leak the value past the scope after it resolves", async () => {
    await runWithSignupOrigin("mcp", async () => {
      await Promise.resolve();
    });
    expect(getSignupOrigin()).toBeUndefined();
  });

  it("isolates concurrent scopes (no cross-talk between interleaved runs)", async () => {
    // An MCP-bound scope and an unbound (web) flow running concurrently must not
    // see each other's value. "mcp" is the only origin today, so prove
    // isolation via the bound-vs-unbound pair overlapping in time.
    const results = await Promise.all([
      runWithSignupOrigin("mcp", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getSignupOrigin();
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getSignupOrigin();
      })(),
    ]);
    expect(results[0]).toBe("mcp");
    expect(results[1]).toBeUndefined();
  });
});
