import { isToolUIPart, getToolName, type UIMessage } from "ai";

/**
 * Surgical board-invalidation for the bound chat drawer (#4567, PRD #4553 L5).
 *
 * The bound editor runs both READ tools (`getDashboardState`, `getCardDetail`,
 * plus the base `explore` / `executeSQL`) and MUTATION tools that change what
 * the canvas shows. Refetching the whole board on EVERY tool completion means a
 * plain question ("what is card 1 counting?") flash-reloads twelve tiles, and a
 * mutation that FAILED refetches even though nothing changed.
 *
 * The rule: refetch only when a mutation tool completes SUCCESSFULLY. That
 * includes the staged ops (`removeCard` / `updateCardSql`) whose success is a
 * `stage_required` envelope — staging doesn't alter the published board but it
 * does update the pending/ghost view the canvas renders, so it warrants a
 * refetch just like a direct draft edit. This module is the single pure
 * statement of that rule so the drawer effect stays a one-liner and the
 * decision is unit-testable without mounting a chat.
 */

/**
 * Bound-editor tools that change dashboard state — they either commit to the
 * caller's draft (`addCard` / `updateCard` / `updateLayout` /
 * `updateDashboardMeta`) or stage a destructive change (`removeCard` /
 * `updateCardSql`). These are the MUTATING SAFE-ops plus the two staged ops from
 * `packages/api/src/lib/tools/bound-dashboard.ts`; the read SAFE-ops
 * (`getDashboardState`, `getCardDetail`) and the base `explore` / `executeSQL`
 * are intentionally excluded — a read never warrants a board refetch.
 */
export const BOUND_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "addCard",
  "updateCard",
  "updateLayout",
  "updateDashboardMeta",
  "removeCard",
  "updateCardSql",
]);

/**
 * A stable signature of the SUCCESSFUL mutation-tool completions in a message.
 * A tool part contributes only when ALL of:
 *   - it is a mutation tool (in {@link BOUND_MUTATION_TOOLS}) — excludes reads;
 *   - its state is `output-available` — excludes in-flight and thrown
 *     (`output-error`) calls;
 *   - its result envelope's `kind` is not `"err"` — excludes mutations that ran
 *     but returned a handled failure (e.g. `addCard` → `{ kind: "err" }`), which
 *     changed nothing.
 *
 * The signature changes exactly when a NEW successful mutation lands (tool call
 * ids are unique), so a caller can fire a surgical refetch off a change to it —
 * and never off a pure read or a failed mutation. Empty string = nothing to do.
 */
export function boundMutationSignature(message: UIMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  let signature = "";
  for (const part of message.parts ?? []) {
    // Narrows `part` to the SDK's `ToolUIPart` discriminated union — `state` is
    // the discriminant and `toolCallId: string` is always present.
    if (!isToolUIPart(part)) continue;
    // Terminal SUCCESS only. The `output-available` arm carries `output`;
    // `output-error` (the tool threw) and in-flight states are excluded here.
    if (part.state !== "output-available") continue;
    let name = "";
    try {
      name = getToolName(part);
    } catch {
      // intentionally ignored: an unrecognizable tool part can't be a known mutation
      continue;
    }
    if (!BOUND_MUTATION_TOOLS.has(name)) continue;
    // A handled-failure envelope ran the tool but mutated nothing — skip it.
    const kind = (part.output as { kind?: unknown } | null | undefined)?.kind;
    if (kind === "err") continue;
    signature += `${part.toolCallId}:${typeof kind === "string" ? kind : ""};`;
  }
  return signature;
}
