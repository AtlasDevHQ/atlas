/**
 * Tests for {@link isRoutingIdUniqueViolation} (#3167) — the predicate the
 * five static-bot handlers use to recognise a lost concurrent-install race
 * (a Postgres 23505 on the migration-0120 routing-id partial unique index)
 * and re-surface it as the actionable "already connected elsewhere" error.
 *
 * The predicate must be TIGHT: a 23505 on any OTHER index, a non-23505 error,
 * or a non-object value (network/driver failures) must NOT be classified as a
 * routing-id conflict — otherwise an unrelated failure would be silently
 * relabelled with a misleading cross-workspace message.
 */

import { describe, expect, it } from "bun:test";
import {
  CHAT_ROUTING_ID_UNIQUE_INDEX,
  isRoutingIdUniqueViolation,
} from "../routing-id-conflict";

/** Build a pg-DatabaseError-shaped object. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code,
    ...(constraint !== undefined ? { constraint } : {}),
  });
}

describe("isRoutingIdUniqueViolation (#3167)", () => {
  it("matches a 23505 on the routing-id index", () => {
    expect(isRoutingIdUniqueViolation(pgError("23505", CHAT_ROUTING_ID_UNIQUE_INDEX))).toBe(true);
  });

  it("does NOT match a 23505 on a different index (singleton / id index)", () => {
    expect(isRoutingIdUniqueViolation(pgError("23505", "workspace_plugins_singleton"))).toBe(false);
    expect(isRoutingIdUniqueViolation(pgError("23505", "workspace_plugins_id_unique"))).toBe(false);
  });

  it("does NOT match a 23505 with no constraint name", () => {
    expect(isRoutingIdUniqueViolation(pgError("23505"))).toBe(false);
  });

  it("does NOT match a different SQLSTATE on the routing-id index", () => {
    // e.g. 23514 check_violation, 23503 fk_violation — different failure class.
    expect(isRoutingIdUniqueViolation(pgError("23514", CHAT_ROUTING_ID_UNIQUE_INDEX))).toBe(false);
  });

  it("does NOT match non-object / nullish / plain-Error values", () => {
    expect(isRoutingIdUniqueViolation(null)).toBe(false);
    expect(isRoutingIdUniqueViolation(undefined)).toBe(false);
    expect(isRoutingIdUniqueViolation("23505")).toBe(false);
    expect(isRoutingIdUniqueViolation(new Error("network down"))).toBe(false);
  });

  // The no-org install path (`internalQuery`) and the marketplace config
  // UPDATE (`queryEffect`) both run through `@effect/sql`, which wraps the pg
  // DatabaseError in `SqlError.cause` with no top-level `code`. The predicate
  // must follow `.cause` to catch those (Codex review on #3170).
  it("matches when the pg error is wrapped in an @effect/sql SqlError.cause", () => {
    const sqlError = Object.assign(new Error("statement failed"), {
      _tag: "SqlError",
      cause: pgError("23505", CHAT_ROUTING_ID_UNIQUE_INDEX),
    });
    expect(isRoutingIdUniqueViolation(sqlError)).toBe(true);
  });

  it("matches a pg error nested several .cause links deep", () => {
    const deep = { cause: { cause: pgError("23505", CHAT_ROUTING_ID_UNIQUE_INDEX) } };
    expect(isRoutingIdUniqueViolation(deep)).toBe(true);
  });

  it("does NOT match a wrapped 23505 on a DIFFERENT index", () => {
    const sqlError = Object.assign(new Error("statement failed"), {
      _tag: "SqlError",
      cause: pgError("23505", "workspace_plugins_singleton"),
    });
    expect(isRoutingIdUniqueViolation(sqlError)).toBe(false);
  });

  it("terminates on a self-referential / cyclic cause chain (no infinite loop)", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "08006" };
    cyclic.cause = cyclic;
    expect(isRoutingIdUniqueViolation(cyclic)).toBe(false);
  });

  it("pins the index name the migration + schema mirror create", () => {
    // A rename in migration 0120 / schema.ts without updating this constant
    // would silently regress every handler's conflict mapping back to a 500.
    expect(CHAT_ROUTING_ID_UNIQUE_INDEX).toBe("workspace_plugins_chat_routing_id_unique");
  });
});
