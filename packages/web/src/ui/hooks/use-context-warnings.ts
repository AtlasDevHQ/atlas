"use client";

import { useCallback, useEffect, useState } from "react";
import { parseContextWarning, type ChatContextWarning } from "@useatlas/types";

export type WarningBucket = {
  warnings: ChatContextWarning[];
};

/**
 * Buffer + per-message attachment of `data-context-warning` SSE frames
 * (#1988 B5 + #2005). The chat route writes warning frames AHEAD of the
 * agent's text-delta merge (chat.ts:864 — load-bearing ordering comment).
 * At the moment a frame fires through `onData`, the AI SDK has not yet
 * appended an assistant message to `messages`, so we cannot key the
 * bucket by id on arrival. The hook splits the work:
 *
 * 1. `handleData(part)` — onData entry point. Returns `true` if the part
 *    was a warning frame (so the caller can stop dispatching it). Parses
 *    via the canonical `parseContextWarning` guard; invalid frames are
 *    silently dropped because a degraded answer is not worth surfacing
 *    if the wire shape is broken.
 * 2. Internal `useEffect` — when `messages` next updates, drain the
 *    `pending` bucket onto the most recent assistant message id.
 *    Subsequent warnings for the same id append to the existing bucket.
 * 3. `resetPending()` — call before sending the next user message so a
 *    stalled previous turn cannot leak warnings into the new answer.
 * 4. `reset()` — full clear, used on new chat / conversation switch.
 */
export function useContextWarnings(messages: ReadonlyArray<{ id: string; role: string }>) {
  const [byMessage, setByMessage] = useState<Map<string, WarningBucket>>(new Map());
  const [pending, setPending] = useState<WarningBucket>({ warnings: [] });

  useEffect(() => {
    if (pending.warnings.length === 0) return;
    // Walk from the tail rather than mutating with toReversed() — the
    // input is typed ReadonlyArray, and react state references should not
    // motivate cloning a potentially long messages array per pending tick.
    let lastAssistantId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantId = messages[i].id;
        break;
      }
    }
    if (lastAssistantId === null) return;
    const targetId = lastAssistantId;
    setByMessage((prev) => {
      const next = new Map(prev);
      const existing = next.get(targetId) ?? { warnings: [] };
      next.set(targetId, {
        warnings: [...existing.warnings, ...pending.warnings],
      });
      return next;
    });
    setPending({ warnings: [] });
  }, [messages, pending]);

  const handleData = useCallback(
    (dataPart: { type: string; data: unknown }): boolean => {
      if (dataPart.type === "data-context-warning") {
        const parsed = parseContextWarning(dataPart.data);
        if (parsed) {
          setPending((p) => ({ warnings: [...p.warnings, parsed] }));
        }
        return true;
      }
      return false;
    },
    [],
  );

  const resetPending = useCallback(() => setPending({ warnings: [] }), []);
  const reset = useCallback(() => {
    setByMessage(new Map());
    setPending({ warnings: [] });
  }, []);

  return { byMessage, pending, handleData, reset, resetPending };
}
