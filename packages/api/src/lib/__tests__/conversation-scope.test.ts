/**
 * Unit tests for the pure conversation-scope module (#4351).
 *
 * Pure + total by construction — no DB, no mocks. The writer that consumes
 * these values (`updateConversationScope`) is exercised table-driven in
 * `conversations.test.ts`.
 */
import { describe, it, expect } from "bun:test";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";
import {
  CONVERSATION_ROUTING_MODE_DEFAULT,
  CONVERSATION_SCOPE_COLUMNS,
  CONVERSATION_SCOPE_KEYS,
  ROUTING_MODE_WITHOUT_CONVERSATION,
  conversationScopeColumnValues,
  conversationScopeFrom,
  conversationScopePatchFrom,
  diffConversationScope,
  routingModeFromColumn,
  type ConversationScope,
} from "../conversation-scope";

describe("routingModeFromColumn()", () => {
  // Exhaustive over the column's inhabitable values: the three legal modes,
  // both absent shapes, and the garbage a manual edit / future release could
  // leave behind. Total — every input yields a mode, none throw.
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly input: unknown;
    readonly expected: ConversationRoutingMode;
  }> = [
    { label: "null (the column default / pre-#2518 row)", input: null, expected: "pin" },
    { label: "undefined (column omitted from the SELECT)", input: undefined, expected: "pin" },
    { label: "explicit auto", input: "auto", expected: "auto" },
    { label: "explicit pin", input: "pin", expected: "pin" },
    { label: "explicit all", input: "all", expected: "all" },
    { label: "unknown string (manual edit / retired mode)", input: "sideways", expected: "pin" },
    { label: "empty string", input: "", expected: "pin" },
    { label: "wrong type (number)", input: 3, expected: "pin" },
    { label: "wrong type (object)", input: { mode: "all" }, expected: "pin" },
  ];

  for (const { label, input, expected } of cases) {
    it(`decodes ${label} → "${expected}"`, () => {
      expect(routingModeFromColumn(input)).toBe(expected);
    });
  }

  it("uses the documented NULL default constant", () => {
    expect(CONVERSATION_ROUTING_MODE_DEFAULT).toBe("pin");
    expect(routingModeFromColumn(null)).toBe(CONVERSATION_ROUTING_MODE_DEFAULT);
  });

  // The two defaults answer different questions and must NOT be collapsed:
  // "the row says nothing" (pin, back-compat for pre-#2518 chats) vs. "there
  // is no row at all" (auto, agent-decides for MCP / scheduler / direct tool
  // callers). Pinning the divergence here keeps a well-meaning future
  // simplification from silently regressing one of the two.
  it("keeps the no-conversation default distinct from the NULL-column default", () => {
    expect(ROUTING_MODE_WITHOUT_CONVERSATION).toBe("auto");
    expect(ROUTING_MODE_WITHOUT_CONVERSATION).not.toBe(CONVERSATION_ROUTING_MODE_DEFAULT);
  });
});

describe("scope value + column mapping", () => {
  it("maps every axis to a column, with no gaps", () => {
    for (const key of CONVERSATION_SCOPE_KEYS) {
      expect(CONVERSATION_SCOPE_COLUMNS[key]).toBeTruthy();
    }
    expect(Object.keys(CONVERSATION_SCOPE_COLUMNS).sort()).toEqual(
      [...CONVERSATION_SCOPE_KEYS].sort(),
    );
  });

  it("normalises a partial source to the persisted defaults", () => {
    expect(conversationScopeFrom({})).toEqual({
      routingMode: null,
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
      answerStyle: null,
    });
    expect(conversationScopeFrom(null)).toEqual(conversationScopeFrom({}));
  });

  it("carries every axis through unchanged when the source is total", () => {
    const scope: ConversationScope = {
      routingMode: "all",
      restExcludedDatasourceIds: ["ds-1"],
      restFocusDatasourceId: "ds-stripe",
      groupReach: "g_prod",
      answerStyle: "executive",
    };
    expect(conversationScopeFrom(scope)).toEqual(scope);
  });

  // AC — fork/convert style derivation inherits scope via ONE spread. The
  // scope keys are the `createConversation` option keys by construction, so a
  // derived conversation picks up a new axis without touching the call site.
  it("inherits a parent conversation's scope through a single spread", () => {
    const parent = {
      id: "conv-parent",
      title: "Parent",
      routingMode: "pin" as const,
      restExcludedDatasourceIds: ["ds-9"],
      restFocusDatasourceId: null,
      groupReach: "g_eu",
      answerStyle: "analyst" as const,
    };
    const derived = { ...conversationScopeFrom(parent), userId: "u1", title: "Fork" };
    for (const key of CONVERSATION_SCOPE_KEYS) {
      expect(derived[key]).toEqual(parent[key]);
    }
    // …and nothing non-scope rides along on the spread.
    expect("id" in derived).toBe(false);
  });

  it("emits column/value pairs in persisted order, omitting absent axes", () => {
    expect(conversationScopeColumnValues({ groupReach: "g_prod", routingMode: "all" })).toEqual([
      ["routing_mode", "all"],
      ["group_reach", "g_prod"],
    ]);
    expect(conversationScopeColumnValues({})).toEqual([]);
    // A `null` axis is a real change (clear), not an absent one.
    expect(conversationScopeColumnValues({ restFocusDatasourceId: null })).toEqual([
      ["rest_focus_datasource_id", null],
    ]);
  });
});

describe("conversationScopePatchFrom()", () => {
  it("keeps explicitly-null axes and drops undefined ones (#3073)", () => {
    expect(
      conversationScopePatchFrom({
        groupReach: null,
        restFocusDatasourceId: undefined,
        answerStyle: "executive",
      }),
    ).toEqual({ groupReach: null, answerStyle: "executive" });
  });

  it("ignores non-scope keys on the source", () => {
    // A parsed request body carries far more than scope; only the axes are
    // picked (the chat route hands the whole body straight in).
    const body = { routingMode: "auto" as const, conversationId: "c1", messages: [] };
    expect(conversationScopePatchFrom(body)).toEqual({ routingMode: "auto" });
  });
});

describe("diffConversationScope()", () => {
  const stored: ConversationScope = {
    routingMode: "pin",
    restExcludedDatasourceIds: ["ds-1", "ds-2"],
    restFocusDatasourceId: "ds-stripe",
    groupReach: "g_prod",
    answerStyle: "executive",
  };

  it("returns an empty patch when the request matches the row", () => {
    expect(diffConversationScope(stored, { ...stored })).toEqual({});
  });

  it("returns an empty patch when the request carries nothing", () => {
    expect(diffConversationScope(stored, {})).toEqual({});
  });

  it("treats a reordered exclude-set as unchanged (set equality)", () => {
    expect(
      diffConversationScope(stored, { restExcludedDatasourceIds: ["ds-2", "ds-1"] }),
    ).toEqual({});
  });

  it("treats duplicates in the exclude-set as unchanged (a set, not a list)", () => {
    expect(
      diffConversationScope(stored, { restExcludedDatasourceIds: ["ds-1", "ds-1", "ds-2"] }),
    ).toEqual({});
  });

  it("detects an explicit [] that re-includes everything", () => {
    expect(diffConversationScope(stored, { restExcludedDatasourceIds: [] })).toEqual({
      restExcludedDatasourceIds: [],
    });
  });

  it("detects clears (null) on the nullable axes", () => {
    expect(
      diffConversationScope(stored, { restFocusDatasourceId: null, groupReach: null }),
    ).toEqual({ restFocusDatasourceId: null, groupReach: null });
  });

  it("detects the first explicit pick on a never-touched row", () => {
    const fresh = conversationScopeFrom({});
    expect(diffConversationScope(fresh, { answerStyle: "plain-english" })).toEqual({
      answerStyle: "plain-english",
    });
    // A NULL routing_mode row reads as "pin", but the ROW is null — an
    // explicit "pin" from the body is still a change worth persisting, so the
    // decoded default never freezes into the row behind the user's back.
    expect(diffConversationScope(fresh, { routingMode: "pin" })).toEqual({ routingMode: "pin" });
  });

  it("collects a multi-axis change into ONE patch", () => {
    expect(
      diffConversationScope(stored, {
        routingMode: "all",
        groupReach: null,
        answerStyle: "executive", // unchanged — must not ride along
      }),
    ).toEqual({ routingMode: "all", groupReach: null });
  });
});
