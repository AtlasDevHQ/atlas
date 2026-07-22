/**
 * Conversation **scope** — the per-conversation policy value that decides
 * where a turn may read from and how it answers (ADR-0011, ADR-0022).
 *
 * Scope is a first-class domain concept with, until #4351, no code home: it
 * lived as a loose bag of columns written by five byte-identical-bar-the-column
 * writers, hand-copied into every `INSERT INTO conversations`, and re-derived
 * field-by-field in the chat route. Every new axis had to touch all of them
 * (`#2518 → #3066 → #3067 → #3895 → #4302`). This module is the seam: one
 * value, one patch type, one column mapping, one diff, one total `routing_mode`
 * decoder. The writer itself lives next to the table it writes
 * (`lib/conversations.ts` — it needs that module's private auth `scopeClause`
 * and its `CrudResult` contract); everything here is **pure**.
 *
 * The axes, in persisted order:
 *
 * | key                         | column                        | issue | null means                        |
 * |-----------------------------|-------------------------------|-------|-----------------------------------|
 * | `routingMode`               | `routing_mode`                | #2518 | back-compat `"pin"` (see below)   |
 * | `restExcludedDatasourceIds` | `rest_excluded_datasource_ids`| #3066 | (never null — `[]` = nothing out) |
 * | `restFocusDatasourceId`     | `rest_focus_datasource_id`    | #3067 | not focused                       |
 * | `groupReach`                | `group_reach`                 | #3895 | All sources (ADR-0022)            |
 * | `answerStyle`               | `answer_style`                | #4302 | no explicit choice → live default |
 *
 * Modelled on `lib/group-reach/index.ts` (`reachStateFromColumn`): a pure,
 * total column decoder consumed uniformly, so the column's meaning can never
 * depend on which caller reads it.
 */

import type { AnswerStyle } from "@atlas/api/lib/answer-styles";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";

// ---------------------------------------------------------------------------
// routing_mode — the one decoder
// ---------------------------------------------------------------------------

/**
 * The `routing_mode` a conversation has when its column is NULL.
 *
 * `"pin"` — a NULL column is a row that predates the #2518 picker (or a
 * caller that never offered one). Reading it as `"pin"` preserves pre-#2518
 * single-execution semantics: the agent's `scope` hints don't suddenly start
 * fanning out queries across every member of the conversation's group.
 */
export const CONVERSATION_ROUTING_MODE_DEFAULT: ConversationRoutingMode = "pin";

/**
 * The routing mode a caller runs under when there is **no conversation at
 * all** — the direct-tool surfaces (MCP, scheduler, unit tests) that never go
 * through the chat route and therefore never carry a `routing_mode` column.
 *
 * `"auto"` — "the agent decides": the tool honours the agent's own `scope`
 * argument, which is the whole point of those surfaces. This is deliberately
 * **not** {@link CONVERSATION_ROUTING_MODE_DEFAULT}: the two constants answer
 * different questions ("the row says nothing" vs. "there is no row"), and
 * collapsing them would either freeze MCP/scheduler callers into `pin` (losing
 * agent-decided fanout) or fan legacy chats out (the regression #2518 guarded).
 * Naming both here, side by side, is what keeps the divergence a documented
 * decision instead of the accident it was — pre-#4351 the `"pin"` default lived
 * in `lib/conversations.ts` and the `"auto"` default was an inline `?? "auto"`
 * literal in `lib/tools/`, and nothing said they were different questions.
 */
export const ROUTING_MODE_WITHOUT_CONVERSATION: ConversationRoutingMode = "auto";

/**
 * Decode a persisted `conversations.routing_mode` value into the runtime
 * three-state union. **Pure and total** — every input shape produces a mode,
 * never throws.
 *
 * NULL / undefined / an unrecognised string (a manual edit, a value from a
 * future release) all decode to {@link CONVERSATION_ROUTING_MODE_DEFAULT}.
 * This is the *only* decoder of that column; callers must not re-derive a
 * default of their own.
 *
 * Web's `effectiveMode` helper in `chat/env-picker.tsx` mirrors this default
 * for the picker's trigger label. Drift between them is a UX bug, not a
 * correctness bug, so the duplication is acceptable until web can import
 * api-internal helpers (which it deliberately cannot per CLAUDE.md "frontend
 * is a pure HTTP client").
 */
export function routingModeFromColumn(value: unknown): ConversationRoutingMode {
  return isConversationRoutingMode(value)
    ? value
    : CONVERSATION_ROUTING_MODE_DEFAULT;
}

/**
 * Type guard for the three legal routing modes — the single statement of
 * which values the column may hold. Keeps an unknown DB string (a manual
 * edit, a mode from a future release) from leaking into the typed union.
 *
 * Distinct from {@link routingModeFromColumn} on purpose: the guard preserves
 * "this row says nothing" as a *representable* state, which the read mapper
 * (`rowToConversation`) needs so the chat route can tell "user picked Auto"
 * from "row predates the column". The default lands at the routing edge, not
 * at the read.
 */
export function isConversationRoutingMode(
  value: unknown,
): value is ConversationRoutingMode {
  return value === "auto" || value === "pin" || value === "all";
}

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

/**
 * A conversation's scope, in its **persisted** representation — the exact
 * shape of the row's scope columns, nulls and all. Total: every axis is
 * present, so a new axis is a compile error at every producer rather than a
 * silently dropped field.
 *
 * Deliberately NOT the resolved runtime shape: `routingMode` stays nullable
 * here so "the row predates the picker" survives to the edge that decodes it
 * ({@link routingModeFromColumn}). Baking the default into the value would
 * make a NULL row indistinguishable from an explicit `"pin"` and quietly
 * freeze the default into the next write.
 */
export interface ConversationScope {
  /** #2518 — intra-group member routing. NULL ⇒ {@link routingModeFromColumn}. */
  readonly routingMode: ConversationRoutingMode | null;
  /** #3066 — excluded REST datasource `install_id`s. `[]` ⇒ nothing excluded. */
  readonly restExcludedDatasourceIds: string[];
  /** #3067 — REST-only focus (`install_id`); null ⇒ not focused. */
  readonly restFocusDatasourceId: string | null;
  /** #3895 — cross-group reach (ADR-0022); null ⇒ All sources. */
  readonly groupReach: string | null;
  /** #4302 — editorial voice; null ⇒ no explicit choice (track the default). */
  readonly answerStyle: AnswerStyle | null;
}

/**
 * A partial scope change. **Key presence is the signal**: a key that is absent
 * (or `undefined`) is untouched; a key present with `null` *clears* that axis.
 * That distinction is the transport-omits-null bug class (#3073) — an explicit
 * `null` groupReach widens to All sources, an omitted one inherits the row.
 */
export type ConversationScopePatch = {
  -readonly [K in keyof ConversationScope]?: ConversationScope[K];
};

/** The scope axes, in persisted column order. Drives the INSERT and the UPDATE. */
export const CONVERSATION_SCOPE_KEYS = [
  "routingMode",
  "restExcludedDatasourceIds",
  "restFocusDatasourceId",
  "groupReach",
  "answerStyle",
] as const satisfies readonly (keyof ConversationScope)[];

/** Scope axis → its `conversations` column. The single statement of the mapping. */
export const CONVERSATION_SCOPE_COLUMNS: {
  readonly [K in keyof ConversationScope]: string;
} = {
  routingMode: "routing_mode",
  restExcludedDatasourceIds: "rest_excluded_datasource_ids",
  restFocusDatasourceId: "rest_focus_datasource_id",
  groupReach: "group_reach",
  answerStyle: "answer_style",
};

/**
 * Loosely-typed source for {@link conversationScopeFrom} — a row read back
 * from the DB, a wire type, a create-options bag. Every axis is optional and
 * nullable, because each of those shapes spells "absent" differently.
 */
export type ConversationScopeSource = {
  readonly [K in keyof ConversationScope]?: ConversationScope[K] | null | undefined;
};

/**
 * Normalise any scope-bearing source (a `Conversation` read back from the DB,
 * a create-options bag, a request body) into a total {@link ConversationScope}
 * with the persisted defaults applied.
 *
 * This is the **one spread** a derived conversation inherits scope through:
 * `createConversation({ ...conversationScopeFrom(parent), userId, title })`.
 * The scope keys are the create-options keys by construction, so a new axis
 * is inherited without touching the derivation site.
 */
export function conversationScopeFrom(
  source: ConversationScopeSource | null | undefined,
): ConversationScope {
  return {
    routingMode: source?.routingMode ?? null,
    restExcludedDatasourceIds: Array.isArray(source?.restExcludedDatasourceIds)
      ? source.restExcludedDatasourceIds
      : [],
    restFocusDatasourceId: source?.restFocusDatasourceId ?? null,
    groupReach: source?.groupReach ?? null,
    answerStyle: source?.answerStyle ?? null,
  };
}

/**
 * Pick the scope axes a source **explicitly carries** into a patch — the
 * request-body → patch adapter. `undefined` values are dropped (absent =
 * inherit); `null` values are kept (present = clear).
 */
export function conversationScopePatchFrom(
  source: ConversationScopePatch,
): ConversationScopePatch {
  // Per-axis assignment rather than a keyed loop: a generic
  // `patch[key] = source[key]` widens every axis to the union of all axis
  // types and needs a cast to land. Five explicit lines type-check exactly,
  // and the compiler flags a new axis here the moment it joins the value.
  const patch: ConversationScopePatch = {};
  if (source.routingMode !== undefined) patch.routingMode = source.routingMode;
  if (source.restExcludedDatasourceIds !== undefined) {
    patch.restExcludedDatasourceIds = source.restExcludedDatasourceIds;
  }
  if (source.restFocusDatasourceId !== undefined) {
    patch.restFocusDatasourceId = source.restFocusDatasourceId;
  }
  if (source.groupReach !== undefined) patch.groupReach = source.groupReach;
  if (source.answerStyle !== undefined) patch.answerStyle = source.answerStyle;
  return patch;
}

/**
 * #3066 — order-independent equality for two id sets, used to decide whether
 * the requested REST exclude-set differs from the stored one before burning
 * an UPDATE. Duplicates collapse (a set, not a list), so `["a","a"]` and
 * `["a"]` compare equal — correct for an exclude-set keyed on `install_id`.
 */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/**
 * Narrow a requested patch to the axes that would actually change `current`.
 *
 * Returns an empty patch when nothing differs, so the caller can skip the
 * UPDATE entirely — every chat turn re-sends the picker state, and burning a
 * write per turn is what the five per-field `!==` guards existed to avoid.
 * The exclude-set compares as a set (a reorder is not a change); an explicit
 * `[]` that clears a non-empty set IS a change (the re-include path).
 */
export function diffConversationScope(
  current: ConversationScope,
  requested: ConversationScopePatch,
): ConversationScopePatch {
  const changed: ConversationScopePatch = {};
  if (
    requested.routingMode !== undefined &&
    requested.routingMode !== current.routingMode
  ) {
    changed.routingMode = requested.routingMode;
  }
  if (
    requested.restExcludedDatasourceIds !== undefined &&
    !sameIdSet(requested.restExcludedDatasourceIds, current.restExcludedDatasourceIds)
  ) {
    changed.restExcludedDatasourceIds = requested.restExcludedDatasourceIds;
  }
  if (
    requested.restFocusDatasourceId !== undefined &&
    requested.restFocusDatasourceId !== current.restFocusDatasourceId
  ) {
    changed.restFocusDatasourceId = requested.restFocusDatasourceId;
  }
  if (
    requested.groupReach !== undefined &&
    requested.groupReach !== current.groupReach
  ) {
    changed.groupReach = requested.groupReach;
  }
  if (
    requested.answerStyle !== undefined &&
    requested.answerStyle !== current.answerStyle
  ) {
    changed.answerStyle = requested.answerStyle;
  }
  return changed;
}

/**
 * The `(column, value)` pairs a patch writes, in persisted column order.
 * Absent / `undefined` axes are omitted — the shared basis for both the
 * `UPDATE … SET` list and the `INSERT` column list.
 */
export function conversationScopeColumnValues(
  patch: ConversationScopePatch,
): readonly (readonly [column: string, value: unknown])[] {
  return CONVERSATION_SCOPE_KEYS.filter((key) => patch[key] !== undefined).map(
    (key) => [CONVERSATION_SCOPE_COLUMNS[key], patch[key]] as const,
  );
}
