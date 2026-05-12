/**
 * Tests for the `withGroupScope` helper that consolidates the
 * `COALESCE(connection_id, '__default__')` sentinel pattern duplicated across
 * the developer-mode publish flow (`semantic/entities.ts`,
 * `admin-publish-preview.ts`, `mode.ts`, `content-mode/tables.ts`).
 *
 * The helper is pure — no DB, no I/O. These tests pin the produced SQL
 * fragments byte-for-byte so the call-site refactor is provably no-op against
 * the existing migration 0028 partial-index expressions and against the
 * `admin-publish.test.ts` mock SQL that mirrors `applyTombstones` /
 * `promoteDraftEntities`.
 */

import { describe, it, expect } from "bun:test";
import {
  GROUP_SCOPE_SENTINEL,
  coalescedScopeColumn,
  matchScopeAcrossAliases,
  withGroupScope,
} from "../with-group-scope";

describe("GROUP_SCOPE_SENTINEL", () => {
  it("matches the literal baked into migration 0028's partial indexes", () => {
    expect(GROUP_SCOPE_SENTINEL).toBe("__default__");
  });
});

describe("coalescedScopeColumn", () => {
  it("defaults to the `connection_id` column with no alias", () => {
    expect(coalescedScopeColumn()).toBe("COALESCE(connection_id, '__default__')");
  });

  it("accepts a custom column name (forward-compat with `connection_group_id`)", () => {
    expect(coalescedScopeColumn({ column: "connection_group_id" })).toBe(
      "COALESCE(connection_group_id, '__default__')",
    );
  });

  it("qualifies the column with the supplied alias", () => {
    expect(coalescedScopeColumn({ alias: "d" })).toBe(
      "COALESCE(d.connection_id, '__default__')",
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
      "COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')",
    );
  });

  it("emits the same shape with `pub` as the published alias", () => {
    // Matches `admin-publish-preview.ts`, `mode.ts`, `content-mode/tables.ts`.
    expect(matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub" })).toBe(
      "COALESCE(d.connection_id, '__default__') = COALESCE(pub.connection_id, '__default__')",
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
      const scope = withGroupScope("org_1", null);
      expect(scope.orgId).toBe("org_1");
      expect(scope.scopeId).toBeNull();
      expect(scope.param).toBeNull();
    });

    it("normalises `undefined` to `null` so callers can pass optional ids through", () => {
      const scope = withGroupScope("org_1", undefined);
      expect(scope.scopeId).toBeNull();
      expect(scope.param).toBeNull();
    });

    it("emits a sentinel-coalesced equality clause when scope is null", () => {
      const scope = withGroupScope("org_1", null);
      expect(scope.match(4)).toBe(
        "COALESCE(connection_id, '__default__') = COALESCE($4, '__default__')",
      );
    });
  });

  describe("single-member resolution (one connection per scope)", () => {
    it("passes the scope id through unchanged as the bind value", () => {
      const scope = withGroupScope("org_1", "conn_us");
      expect(scope.scopeId).toBe("conn_us");
      expect(scope.param).toBe("conn_us");
    });

    it("produces the same SQL shape regardless of whether scope is set", () => {
      // `withGroupScope` should not branch its SQL on whether the scope id is
      // null or not — the COALESCE-with-sentinel form makes both cases match
      // the partial index on `(org_id, name, COALESCE(connection_id, '__default__'))`.
      const withId = withGroupScope("org_1", "conn_us").match(4);
      const withoutId = withGroupScope("org_1", null).match(4);
      expect(withId).toBe(withoutId);
    });
  });

  describe("missing scope (undefined ≡ legacy default)", () => {
    it("treats undefined and null as the same logical scope", () => {
      const a = withGroupScope("org_1", undefined);
      const b = withGroupScope("org_1", null);
      expect(a.param).toBe(b.param);
      expect(a.match(4)).toBe(b.match(4));
    });
  });

  describe("sentinel-coalesce semantics", () => {
    it("threads custom column names through `.match()` for forward-compat", () => {
      const scope = withGroupScope("org_1", "conn_us");
      expect(scope.match(2, { column: "connection_group_id" })).toBe(
        "COALESCE(connection_group_id, '__default__') = COALESCE($2, '__default__')",
      );
    });

    it("qualifies the column with an alias in `.match()`", () => {
      const scope = withGroupScope("org_1", "conn_us");
      expect(scope.match(2, { alias: "d" })).toBe(
        "COALESCE(d.connection_id, '__default__') = COALESCE($2, '__default__')",
      );
    });

    it("supports any positive `$N` placeholder", () => {
      const scope = withGroupScope("org_1", "conn_us");
      expect(scope.match(1)).toBe(
        "COALESCE(connection_id, '__default__') = COALESCE($1, '__default__')",
      );
      expect(scope.match(10)).toBe(
        "COALESCE(connection_id, '__default__') = COALESCE($10, '__default__')",
      );
    });
  });
});
