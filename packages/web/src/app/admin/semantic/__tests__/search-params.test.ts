/**
 * Tests for the semantic page's URL ↔ selection helpers (#2412).
 *
 * Deep-link safety depends on the three pure helpers in `search-params.ts`
 * round-tripping cleanly through nuqs query state. A regression in any
 * one of them silently breaks group-scoped admin URLs.
 */

import { describe, expect, test } from "bun:test";
import {
  fileParamToSelection,
  selectionToFileParam,
  selectionToGroupParam,
  withGroupOnSelection,
} from "../search-params";

describe("fileParamToSelection", () => {
  test("returns null for empty / null input", () => {
    expect(fileParamToSelection(null)).toBeNull();
    expect(fileParamToSelection("")).toBeNull();
  });

  test("maps file param strings to discriminated-union selections", () => {
    expect(fileParamToSelection("catalog")).toEqual({ type: "catalog" });
    expect(fileParamToSelection("glossary")).toEqual({ type: "glossary" });
    expect(fileParamToSelection("entities/users")).toEqual({
      type: "entity",
      name: "users",
    });
    expect(fileParamToSelection("metrics/revenue")).toEqual({
      type: "metrics",
      file: "revenue",
    });
  });

  test("returns null for unrecognized prefixes", () => {
    expect(fileParamToSelection("unknown/foo")).toBeNull();
  });
});

describe("selectionToFileParam", () => {
  test("inverts fileParamToSelection for round-trip identity", () => {
    const cases = ["catalog", "glossary", "entities/users", "metrics/revenue"];
    for (const param of cases) {
      const sel = fileParamToSelection(param);
      expect(selectionToFileParam(sel)).toBe(param);
    }
  });

  test("returns null for null selection", () => {
    expect(selectionToFileParam(null)).toBeNull();
  });

  test("metrics without a file param returns null (no anchor to encode)", () => {
    expect(selectionToFileParam({ type: "metrics" })).toBeNull();
  });
});

describe("withGroupOnSelection", () => {
  test("attaches a string group to an entity selection", () => {
    const sel = fileParamToSelection("entities/users");
    const scoped = withGroupOnSelection(sel, "g_prod_us");
    expect(scoped).toEqual({
      type: "entity",
      name: "users",
      connectionGroupId: "g_prod_us",
    });
  });

  test("leaves selection unchanged when group is undefined", () => {
    const sel = fileParamToSelection("entities/users");
    expect(withGroupOnSelection(sel, undefined)).toEqual(sel);
  });

  test("leaves selection unchanged when group is null (legacy unscoped)", () => {
    // `null` here means "no group qualifier present on the URL" because
    // nuqs's parseAsString returns null for absent params. The helper
    // intentionally treats this the same as undefined — a `null` choice
    // in selection space is encoded via the empty-string URL value
    // (see selectionToGroupParam contract below).
    const sel = fileParamToSelection("entities/users");
    expect(withGroupOnSelection(sel, null)).toEqual(sel);
  });

  test("is a no-op for non-entity selections", () => {
    expect(withGroupOnSelection({ type: "catalog" }, "g_prod_us")).toEqual({
      type: "catalog",
    });
    expect(withGroupOnSelection({ type: "glossary" }, "g_prod_us")).toEqual({
      type: "glossary",
    });
    expect(withGroupOnSelection({ type: "metrics", file: "rev" }, "g_prod_us")).toEqual({
      type: "metrics",
      file: "rev",
    });
    expect(withGroupOnSelection(null, "g_prod_us")).toBeNull();
  });
});

describe("selectionToGroupParam", () => {
  test("returns the group id for a scoped entity selection", () => {
    expect(
      selectionToGroupParam({
        type: "entity",
        name: "users",
        connectionGroupId: "g_prod_us",
      }),
    ).toBe("g_prod_us");
  });

  test("returns null for entity selections with no group qualifier (undefined OR null)", () => {
    // The serializer collapses undefined and null to null because nuqs's
    // parseAsString uses null for "absent". Callers that need to encode
    // an explicit legacy/null-group choice in the URL use the empty-
    // string sentinel directly (see encodeGroupParam in page.tsx).
    expect(selectionToGroupParam({ type: "entity", name: "users" })).toBeNull();
    expect(
      selectionToGroupParam({
        type: "entity",
        name: "users",
        connectionGroupId: null,
      }),
    ).toBeNull();
  });

  test("returns null for non-entity selections", () => {
    expect(selectionToGroupParam({ type: "catalog" })).toBeNull();
    expect(selectionToGroupParam({ type: "glossary" })).toBeNull();
    expect(selectionToGroupParam({ type: "metrics" })).toBeNull();
    expect(selectionToGroupParam(null)).toBeNull();
  });
});

describe("round-trip URL state", () => {
  test("entity with group: fileParam + group → selection → fileParam + group", () => {
    // The page-level encoding strategy: store `file` and `group` as
    // independent URL params; combine them at read time. This test
    // exercises the round-trip without going through the URL itself.
    const initial = withGroupOnSelection(
      fileParamToSelection("entities/users"),
      "g_prod_us",
    );
    expect(selectionToFileParam(initial)).toBe("entities/users");
    expect(selectionToGroupParam(initial)).toBe("g_prod_us");
  });

  test("entity without group: fileParam only → selection → fileParam, null group", () => {
    const initial = fileParamToSelection("entities/users");
    expect(selectionToFileParam(initial)).toBe("entities/users");
    expect(selectionToGroupParam(initial)).toBeNull();
  });
});
