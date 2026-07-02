import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock, EnterpriseError } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────
//
// The combinator composes three guards. We mock the enterprise gate
// (`../index`) and `hasInternalDB` (`@atlas/api/lib/db/internal`) via the
// shared factory. We deliberately do NOT mock `./db-guard`: the REAL
// `requireInternalDBEffect` reads `hasInternalDB` from the (already-mocked)
// `@atlas/api/lib/db/internal`, so letting it run exercises the actual
// collaborator — including its default no-DB message — rather than a shim copy.

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

// Import after mocks
const { eeRead, eeWrite } = await import("./ee-query");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/** Run an Effect and return the failure (Effect.Either left) for assertions. */
const runFail = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect) as Effect.Effect<E, never>);

beforeEach(() => {
  ee.reset();
});

// ── eeRead ──────────────────────────────────────────────────────────

describe("eeRead", () => {
  it("runs the query when enterprise is enabled and a DB is present", async () => {
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return [1, 2, 3];
    });
    const result = await run(eeRead("roles", [], query));
    expect(result).toEqual([1, 2, 3]);
    expect(ran).toBe(true);
  });

  it("short-circuits to whenNoDb without running the query when no DB", async () => {
    ee.setHasInternalDB(false);
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return [1, 2, 3];
    });
    const result = await run(eeRead("roles", [], query));
    expect(result).toEqual([]);
    expect(ran).toBe(false);
  });

  it("preserves the per-function empty value (null, 0, false, {}) verbatim", async () => {
    ee.setHasInternalDB(false);
    expect(await run(eeRead("roles", null, Effect.succeed<string | null>("x")))).toBeNull();
    expect(await run(eeRead("q", 0, Effect.succeed(99)))).toBe(0);
    expect(await run(eeRead("delete", false, Effect.succeed(true)))).toBe(false);
    expect(await run(eeRead("ip", { allowed: true }, Effect.succeed({ allowed: false })))).toEqual({
      allowed: true,
    });
  });

  it("propagates the query's own failure (E channel) unchanged when DB present", async () => {
    const failing: Effect.Effect<number[], Error> = Effect.fail(new Error("boom"));
    const err = await runFail(eeRead("roles", [], failing));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
  });

  it("fails with EnterpriseError and never touches the DB when unlicensed", async () => {
    ee.setEnterpriseEnabled(false);
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return [1];
    });
    const err = await runFail(eeRead("roles", [], query));
    expect(err).toBeInstanceOf(EnterpriseError);
    expect(ran).toBe(false);
  });

  it("gates before the DB check — unlicensed + no DB still fails EnterpriseError", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setHasInternalDB(false);
    const err = await runFail(eeRead("roles", [], Effect.succeed([1])));
    expect(err).toBeInstanceOf(EnterpriseError);
  });
});

// ── eeWrite ─────────────────────────────────────────────────────────

describe("eeWrite", () => {
  it("runs the query when enterprise is enabled and a DB is present", async () => {
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return "written";
    });
    const result = await run(eeWrite("roles", "role assignment", query));
    expect(result).toBe("written");
    expect(ran).toBe(true);
  });

  it("fails loud with the default message when no DB, without running the query", async () => {
    ee.setHasInternalDB(false);
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return "written";
    });
    const err = await runFail(eeWrite("roles", "role assignment", query));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Internal database required for role assignment.");
    expect(ran).toBe(false);
  });

  it("fails with the domain error from errorFactory when supplied and no DB", async () => {
    ee.setHasInternalDB(false);
    class ApprovalError extends Error {
      readonly _tag = "ApprovalError";
    }
    const err = await runFail(
      eeWrite("approval rules", "approval rules", Effect.succeed("x"), () => new ApprovalError("boom")),
    );
    expect(err).toBeInstanceOf(ApprovalError);
    expect((err as Error).message).toBe("boom");
  });

  it("fails with EnterpriseError before the DB requirement when unlicensed", async () => {
    ee.setEnterpriseEnabled(false);
    ee.setHasInternalDB(false);
    let ran = false;
    const query = Effect.sync(() => {
      ran = true;
      return "written";
    });
    const err = await runFail(eeWrite("roles", "role assignment", query));
    expect(err).toBeInstanceOf(EnterpriseError);
    expect(ran).toBe(false);
  });

  it("propagates the query's own failure (E channel) unchanged when licensed + DB present", async () => {
    const failing: Effect.Effect<string, Error> = Effect.fail(new Error("write boom"));
    const err = await runFail(eeWrite("roles", "role assignment", failing));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("write boom");
  });
});
