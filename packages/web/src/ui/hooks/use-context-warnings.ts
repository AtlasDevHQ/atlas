"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseContextWarning, type ChatContextWarning } from "@useatlas/types";

export type WarningBucket = {
  warnings: ChatContextWarning[];
};

type Pending = {
  warnings: ChatContextWarning[];
  /**
   * `messages.length` at the moment the first warning of this batch was
   * buffered. The drain effect must wait for an assistant message at an
   * index >= this value — otherwise a warning on turn N would be attached
   * to turn N-1's assistant (which is still the latest assistant id when
   * the frame arrives, because the chat route writes warnings before
   * merging the agent stream).
   */
  anchorMessageCount: number;
};

const EMPTY: Pending = { warnings: [], anchorMessageCount: 0 };

/**
 * Buffer + per-message attachment of `data-context-warning` SSE frames.
 *
 * The chat route writes warning frames AHEAD of merging the agent's
 * text-delta stream (see the "Ordering is load-bearing" block in
 * `chat.ts` immediately before `writer.merge(agentResult.toUIMessageStream(...))`).
 * At the moment a frame fires through `onData`, the AI SDK has not yet
 * appended the new assistant message id to `messages`, so we cannot key
 * the bucket by id on arrival. The hook splits the work:
 *
 * 1. `handleData(part)` — onData entry point. Returns `true` if the part
 *    was a warning frame (so the caller can stop dispatching it). Parses
 *    via the canonical `parseContextWarning` guard. Invalid frames are
 *    dropped to avoid spamming users with a banner over a wire bug, but
 *    a `console.warn` fires so the regression is observable in dev.
 *    The first warning of a batch snapshots the current message count
 *    so the drain step can tell turn N's warnings from turn N-1's.
 * 2. Internal drain `useEffect` — when `messages` next updates, look for
 *    an assistant message at an index >= the snapshotted count and
 *    transfer the buffer onto its id. Subsequent warnings for the same
 *    turn append to the existing bucket.
 * 3. Internal cleanup `useEffect` — drops bucket entries whose message
 *    id is no longer in `messages` (e.g. after `setMessages` replaces a
 *    message on regenerate / edit). Without this the map would leak.
 * 4. `resetPending()` — call before sending the next user message so a
 *    stalled previous turn cannot leak warnings into the new answer.
 * 5. `reset()` — clears the per-message buckets and pending buffer,
 *    used on new chat / conversation switch. The malformed-frame log
 *    gate (`loggedMalformedRef`) is intentionally preserved across
 *    resets so a misbehaving server doesn't get a fresh log allowance
 *    every time the user switches conversations.
 */
export function useContextWarnings(messages: ReadonlyArray<{ id: string; role: string }>) {
  const [byMessage, setByMessage] = useState<Map<string, WarningBucket>>(new Map());
  const [pending, setPending] = useState<Pending>(EMPTY);

  // Read-only snapshot of `messages.length` for `handleData` to capture
  // when a new pending batch starts. A ref keeps `handleData` stable
  // (no dep on the messages array) so `useChat`'s `onData` capture works.
  const messagesLengthRef = useRef(messages.length);
  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages]);

  // Drain: attach pending warnings to the assistant message that appeared
  // for THIS turn (index >= the snapshotted message count).
  useEffect(() => {
    if (pending.warnings.length === 0) return;
    let targetId: string | null = null;
    // Walk backwards from the tail. Bound the search at
    // anchorMessageCount so we never attach to a previous turn's
    // assistant (the bug fix). `for` + index is preferred over
    // `toReversed()` because the latter allocates a fresh array per
    // pending tick — meaningful on long conversations.
    for (let i = messages.length - 1; i >= pending.anchorMessageCount; i--) {
      if (messages[i].role === "assistant") {
        targetId = messages[i].id;
        break;
      }
    }
    if (targetId === null) return;
    const claimedId = targetId;
    setByMessage((prev) => {
      const next = new Map(prev);
      const existing = next.get(claimedId) ?? { warnings: [] };
      next.set(claimedId, {
        warnings: [...existing.warnings, ...pending.warnings],
      });
      return next;
    });
    setPending(EMPTY);
  }, [messages, pending]);

  // Cleanup: drop buckets whose message id is no longer in `messages`.
  // Runs separately from drain so a regenerate that replaces an id
  // releases the orphaned bucket on the same render that introduces the
  // new id.
  useEffect(() => {
    setByMessage((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(messages.map((m) => m.id));
      let changed = false;
      const next = new Map<string, WarningBucket>();
      for (const [id, bucket] of prev) {
        if (live.has(id)) next.set(id, bucket);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages]);

  // First-malformed-frame log gate. Logging every dropped frame is
  // tempting for observability but a server-side wire regression could
  // emit hundreds per session — at which point users tune out the noise
  // and the regression is effectively invisible again. We log once per
  // session with the offending payload so the first user to hit it
  // surfaces the bug; subsequent drops still happen but stay quiet.
  const loggedMalformedRef = useRef(false);

  const handleData = useCallback(
    (dataPart: { type: string; data: unknown }): boolean => {
      if (dataPart.type === "data-context-warning") {
        const parsed = parseContextWarning(dataPart.data);
        if (parsed) {
          const anchor = messagesLengthRef.current;
          setPending((p) =>
            p.warnings.length === 0
              ? { warnings: [parsed], anchorMessageCount: anchor }
              : { ...p, warnings: [...p.warnings, parsed] },
          );
        } else if (!loggedMalformedRef.current) {
          // The legacy `data-plan-warning` channel had a typed mismatch
          // (server wrote an object, client guarded on string) and went
          // undetected for two releases because nothing logged the
          // drop. Logging once here makes any future wire-shape
          // regression observable on the first hit, without spamming
          // a runaway-stream's worth of warnings into the console.
          loggedMalformedRef.current = true;
          console.warn(
            "[atlas-chat] dropped malformed data-context-warning frame (further drops suppressed)",
            dataPart.data,
          );
        }
        return true;
      }
      return false;
    },
    [],
  );

  const resetPending = useCallback(() => setPending(EMPTY), []);
  const reset = useCallback(() => {
    setByMessage(new Map());
    setPending(EMPTY);
  }, []);

  return { byMessage, pending, handleData, reset, resetPending };
}
