/**
 * These tests pin the helper's output to migration 0063's
 * `COALESCE(connection_group_id, '__default__')` expression so any drift between
 * the helper and the partial-unique-index expression baked into the schema
 * surfaces here instead of as silent natural-key duplication at runtime.
 *
 * Pure unit tests — no DB, no I/O. The four boundary cases the issue called
 * out (null sentinel, single-member resolution, missing scope, sentinel-
 * coalesce semantics) live in named `describe` blocks; the input-validation
 * and forward-compat checks live alongside them.
 */

import { describe, it, expect } from "bun:test";
import {
  GROUP_SCOPE_SENTINEL,
  coalescedScopeColumn,
  matchScopeAcrossAliases,
  withGroupScope,
} from "../with-group-scope";

describe("GROUP_SCOPE_SENTINEL", () => {
  it("matches the literal baked into migration 0063's partial indexes", () => {
    expect(GROUP_SCOPE_SENTINEL).toBe("__default__");
  });
});

describe("coalescedScopeColumn", () => {
  it("defaults to the `connection_group_id` column with no alias", () => {
    expect(coalescedScopeColumn()).toBe("COALESCE(connection_group_id, '__default__')");
  });

  it("accepts a custom column name for legacy transitional reads", () => {
    expect(coalescedScopeColumn({ column: "connection_id" })).toBe(
      "COALESCE(connection_id, '__default__')",
    );
  });

  it("qualifies the column with the supplied alias", () => {
    expect(coalescedScopeColumn({ alias: "d" })).toBe(
      "COALESCE(d.connection_group_id, '__default__')",
    );
  });

  it("composes alias + custom column", () => {
    expect(coalescedScopeColumn({ alias: "pub", column: "connection_group_id" })).toBe(
      "COALESCE(pub.connection_group_id, '__default__')",
    );
  });
});

describe("matchScopeAcrossAliases", () => {
  it("emits the cross-alias equality used by the draft/published join", () => {
    expect(matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "p" })).toBe(
      "COALESCE(d.connection_group_id, '__default__') = COALESCE(p.connection_group_id, '__default__')",
    );
  });

  it("emits the same shape with `pub` as the published alias", () => {
    // Matches `admin-publish-preview.ts`, `mode.ts`, `content-mode/tables.ts`.
    expect(matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub" })).toBe(
      "COALESCE(d.connection_group_id, '__default__') = COALESCE(pub.connection_group_id, '__default__')",
    );
  });

  it("propagates a custom column to both sides", () => {
    expect(
      matchScopeAcrossAliases({
        leftAlias: "d",
        rightAlias: "p",
        column: "connection_group_id",
      }),
    ).toBe(
      "COALESCE(d.connection_group_id, '__default__') = COALESCE(p.connection_group_id, '__default__')",
    );
  });
});

describe("withGroupScope", () => {
  describe("null sentinel (legacy single-default-scope rows)", () => {
    it("resolves a `null` scope id to a `null` bind value", () => {
      const scope = withGroupScope(null);
      expect(scope.param).toBeNull();
    });

    it("normalises `undefined` to `null` so callers can pass optional ids through", () => {
      const scope = withGroupScope(undefined);
      expect(scope.param).toBeNull();
    });

    it("normalises `\"\"` to `null` so a partial client payload can't split rows", () => {
      // Without this, a row inserted with `connection_group_id = ""` would land in a
      // distinct partial-index bucket from rows with no scope at all — a silent
      // failure where deletion by undefined scope no longer matches.
      const scope = withGroupScope("");
      expect(scope.param).toBeNull();
    });

    it("emits a sentinel-coalesced equality clause when scope is null", () => {
      const scope = withGroupScope(null);
      expect(scope.match(4)).toBe(
        "COALESCE(connection_group_id, '__default__') = COALESCE($4, '__default__')",
      );
    });
  });

  describe("single-member resolution (one connection per scope)", () => {
    it("passes the scope id through unchanged as the bind value", () => {
      const scope = withGroupScope("conn_us");
      expect(scope.param).toBe("conn_us");
    });

    it("produces the same SQL shape regardless of whether scope is set", () => {
      // `withGroupScope` should not branch its SQL on whether the scope id is
      // null or not — the COALESCE-with-sentinel form makes both cases match
      // the partial index on `(org_id, name, COALESCE(connection_group_id, '__default__'))`.
      const withId = withGroupScope("conn_us").match(4);
      const withoutId = withGroupScope(null).match(4);
      expect(withId).toBe(withoutId);
    });
  });

  describe("missing scope (undefined ≡ legacy default)", () => {
    it("treats undefined and null as the same logical scope", () => {
      const a = withGroupScope(undefined);
      const b = withGroupScope(null);
      expect(a.param).toBe(b.param);
      expect(a.match(4)).toBe(b.match(4));
    });
  });

  describe("sentinel-coalesce semantics", () => {
    it("threads custom column names through `.match()` for forward-compat", () => {
      const scope = withGroupScope("conn_us");
      expect(scope.match(2, { column: "connection_group_id" })).toBe(
        "COALESCE(connection_group_id, '__default__') = COALESCE($2, '__default__')",
      );
    });

    it("qualifies the column with an alias in `.match()`", () => {
      const scope = withGroupScope("conn_us");
      expect(scope.match(2, { alias: "d" })).toBe(
        "COALESCE(d.connection_group_id, '__default__') = COALESCE($2, '__default__')",
      );
    });

    it("supports any positive `$N` placeholder", () => {
      const scope = withGroupScope("conn_us");
      expect(scope.match(1)).toBe(
        "COALESCE(connection_group_id, '__default__') = COALESCE($1, '__default__')",
      );
      expect(scope.match(10)).toBe(
        "COALESCE(connection_group_id, '__default__') = COALESCE($10, '__default__')",
      );
    });
  });

  describe("paramIndex validation", () => {
    it("throws on zero (placeholders are 1-indexed in pg)", () => {
      const scope = withGroupScope("conn_us");
      expect(() => scope.match(0)).toThrow(/positive integer/);
    });

    it("throws on negatives", () => {
      const scope = withGroupScope("conn_us");
      expect(() => scope.match(-1)).toThrow(/positive integer/);
    });

    it("throws on non-integers", () => {
      const scope = withGroupScope("conn_us");
      expect(() => scope.match(1.5)).toThrow(/positive integer/);
    });

    it("throws on NaN", () => {
      const scope = withGroupScope("conn_us");
      expect(() => scope.match(Number.NaN)).toThrow(/positive integer/);
    });
  });
});
