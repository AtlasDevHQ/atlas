/**
 * #5266 — `lib/db/pg-errors.ts`, the shared SQLSTATE classification.
 *
 * The module's header makes a contract claim that decides whether every
 * consumer's recovery works: *"Reads a TOP-LEVEL `code` only. An
 * `@effect/sql`-backed client wraps the driver error under `.cause`, so every
 * collision would arrive here unclassified."* That is the whole reason
 * `asWrappedUniqueViolation` exists as a separate classifier rather than this
 * one growing a chain walk.
 *
 * Prose is not a checked condition. This file makes it one — in particular the
 * wrapped case, which is the arm the header uses to justify NOT unifying the
 * two classifiers, and which #5272 settled for the four call sites (two routes,
 * two stores) that read the flat shape on a wrapped path.
 *
 * ⚠️ The fixtures here build their rejections BY HAND, which is exactly the
 * limitation #5272 was filed about: a hand-built error agrees with whatever
 * shape its author assumed. The wrapped cases below therefore build a REAL
 * `FiberFailure` through `Effect.runPromise` rather than imitating one — that
 * is the wrapper whose missing `cause` own-property broke the naive walk, and
 * it cannot be faked with an object literal. The innermost pg error is still
 * hand-shaped; `pg-errors-wrapped-pg.test.ts` is what pins it against a real
 * database.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  asUniqueViolation,
  asWrappedUniqueViolation,
  pgErrorLinks,
  PG_UNIQUE_VIOLATION,
  PG_PLUGIN_CATALOG_SLUG_CONSTRAINT,
} from "@atlas/api/lib/db/pg-errors";

/**
 * A genuine `FiberFailure` wrapping `inner` — the shape `Effect.runPromise`
 * rejects with, produced rather than imitated.
 */
async function realFiberFailure(inner: unknown): Promise<unknown> {
  try {
    await Effect.runPromise(Effect.fail(inner));
    throw new Error("expected the effect to fail");
  } catch (err) {
    return err;
  }
}

describe("PG constants", () => {
  it("pins the SQLSTATE and the constraint name", () => {
    // ⚠️ Literals, not a re-derivation. `plugin_catalog_slug_key` is Postgres's
    // auto-generated name for `slug TEXT NOT NULL UNIQUE` in migration 0014 —
    // a migration that renamed it to `uq_plugin_catalog_slug` would silently
    // route every collision down both seeders' rethrow arm.
    expect(PG_UNIQUE_VIOLATION).toBe("23505");
    expect(PG_PLUGIN_CATALOG_SLUG_CONSTRAINT).toBe("plugin_catalog_slug_key");
  });
});

describe("asUniqueViolation", () => {
  const violation = (extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      ...extra,
    });

  it("classifies a flat 23505 and returns its diagnostics", () => {
    const got = asUniqueViolation(
      violation({ constraint: "plugin_catalog_slug_key", detail: "Key (slug)=(x) already exists." }),
    );
    expect(got).toEqual({
      constraint: "plugin_catalog_slug_key",
      detail: "Key (slug)=(x) already exists.",
    });
  });

  it("classifies a 23505 carrying no diagnostics — both fields undefined, not absent", () => {
    // Both seeders read `.constraint` immediately after the guard; an
    // unguarded read on a driver that omits them would throw INSIDE the catch,
    // turning a reported collision into an aborted pass.
    const got = asUniqueViolation(violation());
    expect(got).toEqual({ constraint: undefined, detail: undefined });
  });

  it("⭐ returns undefined for a `.cause`-WRAPPED 23505 — the header's load-bearing claim", () => {
    // This is why `asWrappedUniqueViolation` exists, and it stays asserted
    // because the flat classifier must KEEP failing here: the two seeders hold
    // a raw `Pool` and rely on it not classifying a wrapped violation from an
    // unrelated layer as a benign slug collision. If this ever starts returning
    // a value, the two classifiers have converged and the module header's "do
    // not simplify the two into one helper" argument needs re-reading.
    const wrapped = Object.assign(new Error("SqlError"), { cause: violation() });
    expect(asUniqueViolation(wrapped)).toBeUndefined();
  });

  it("returns undefined for a different SQLSTATE, however similar the message", () => {
    // Message-keyed classification is the failure this reads the CODE to
    // avoid: demoting a real outage to a benign collision.
    const impostor = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      { code: "XX000" },
    );
    expect(asUniqueViolation(impostor)).toBeUndefined();
  });

  it("returns undefined for an error with no code at all", () => {
    expect(asUniqueViolation(new Error("connection terminated"))).toBeUndefined();
  });

  it("returns undefined for non-objects — the type-narrowing rule, not a cast", () => {
    // `err.code` on a thrown string is `undefined`; reading it unguarded is
    // what CLAUDE.md's narrowing rule forbids.
    for (const notAnObject of ["23505", 23505, null, undefined, true]) {
      expect(asUniqueViolation(notAnObject)).toBeUndefined();
    }
  });

  it("ignores a non-string constraint rather than passing it through", () => {
    // A driver returning a numeric oid would otherwise reach a consumer that
    // compares it against a constraint NAME and silently never match.
    const got = asUniqueViolation(violation({ constraint: 1234, detail: 5678 }));
    expect(got).toEqual({ constraint: undefined, detail: undefined });
  });
});

describe("asWrappedUniqueViolation", () => {
  const pgError = (extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "prompt_collections_org_name_uniq",
      detail: "Key (lower(name))=(x) already exists.",
      ...extra,
    });

  /** `SqlError`-shaped: no `code` of its own, driver error under `.cause`. */
  const sqlErrorLike = (cause: unknown) =>
    Object.assign(new Error("Failed to execute statement"), { _tag: "SqlError", cause });

  it("classifies the flat shape too — one classifier covers both", () => {
    expect(asWrappedUniqueViolation(pgError())).toEqual({
      constraint: "prompt_collections_org_name_uniq",
      detail: "Key (lower(name))=(x) already exists.",
    });
  });

  it("⭐ classifies a REAL FiberFailure → SqlError → pg error", async () => {
    // The production shape. `asUniqueViolation` returning undefined here is the
    // defect #5272 fixed, asserted alongside so the two cannot drift apart.
    const wrapped = await realFiberFailure(sqlErrorLike(pgError()));
    expect(asUniqueViolation(wrapped)).toBeUndefined();
    expect(asWrappedUniqueViolation(wrapped)).toEqual({
      constraint: "prompt_collections_org_name_uniq",
      detail: "Key (lower(name))=(x) already exists.",
    });
  });

  it("⭐ a real FiberFailure exposes no `cause` — why the unwrap exists", async () => {
    const wrapped = (await realFiberFailure(sqlErrorLike(pgError()))) as object;
    expect(Object.getOwnPropertyNames(wrapped)).not.toContain("cause");
    expect((wrapped as { cause?: unknown }).cause).toBeUndefined();
  });

  it("does not classify a wrapped NON-violation", async () => {
    const wrapped = await realFiberFailure(
      sqlErrorLike(Object.assign(new Error("deadlock detected"), { code: "40P01" })),
    );
    expect(asWrappedUniqueViolation(wrapped)).toBeUndefined();
  });

  it("returns undefined for non-objects, matching the flat classifier", () => {
    for (const notAnObject of ["23505", 23505, null, undefined, true]) {
      expect(asWrappedUniqueViolation(notAnObject)).toBeUndefined();
    }
  });

  it("terminates on a self-referential cause chain", () => {
    // The cap is a backstop, but a self-link is the cheap case to get wrong and
    // it hangs the process rather than failing a test.
    const cyclic: Record<string, unknown> = { code: "XX000" };
    cyclic.cause = cyclic;
    expect(asWrappedUniqueViolation(cyclic)).toBeUndefined();
  });

  it("stops at the depth cap rather than walking forever", () => {
    // 20 links, cap is 8 — the 23505 at the bottom must NOT be found, which is
    // what proves the cap is enforced rather than merely declared.
    let deep: unknown = pgError();
    for (let i = 0; i < 20; i++) deep = { cause: deep };
    expect(asWrappedUniqueViolation(deep)).toBeUndefined();
    expect(pgErrorLinks(deep).length).toBe(8);
  });
});
