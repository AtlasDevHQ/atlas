/**
 * #5266 — `lib/db/pg-errors.ts`, the shared SQLSTATE classification.
 *
 * The module's header makes a contract claim that decides whether every
 * consumer's recovery works: *"Reads a TOP-LEVEL `code` only. An
 * `@effect/sql`-backed client wraps the driver error under `.cause`, so every
 * collision would arrive here unclassified."* That is the whole reason
 * `routing-id-conflict.ts` keeps a separate `.cause` walk instead of adopting
 * this helper.
 *
 * Prose is not a checked condition. This file makes it one — in particular the
 * wrapped case, which is the arm the header uses to justify NOT unifying the
 * two classifiers, and which #5272 is open against for the four call sites
 * (two routes, two stores) that read the flat shape on a wrapped path.
 */

import { describe, expect, it } from "bun:test";
import {
  asUniqueViolation,
  PG_UNIQUE_VIOLATION,
  PG_PLUGIN_CATALOG_SLUG_CONSTRAINT,
} from "@atlas/api/lib/db/pg-errors";

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
    // This is why `routing-id-conflict.ts` walks the chain instead of calling
    // this helper, and why #5272 exists. If this ever starts returning a
    // value, the two classifiers have converged and that module's "do not
    // simplify the two into one helper" argument needs re-reading.
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
