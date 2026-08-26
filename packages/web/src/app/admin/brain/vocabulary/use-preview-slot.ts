"use client";

import { useRef, useState } from "react";
import type { z } from "zod";
import type { BrainVocabularyBlastRadius } from "@/ui/lib/types";
import {
  BrainVocabularyPreviewRequestSchema,
  BrainVocabularyPreviewResponseSchema,
} from "@/ui/lib/admin-schemas";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";

/**
 * One blast-radius preview — its three states, its staleness guard, and the two
 * questions callers ask of it (#5447).
 *
 * ## Why this is a hook and not three `useState`s per call site
 *
 * `page.tsx` had this machinery twice (authoring and removal), `pending-queue.tsx`
 * has a third, and the cardinality card was about to be a fourth. Each copy
 * carries the same non-obvious guard, and the guard is the entire reason the
 * shape is subtle rather than incidental:
 *
 *   - **The slot is a triple, never a bare radius.** `radius`, `pending` and
 *     `error` must move together, because "the preview failed" and "the preview
 *     came back empty" are opposite facts that a single nullable radius renders
 *     identically. That conflation is what the whole disclosure exists to prevent.
 *   - **Every load bumps a generation counter.** Each reset path is synchronous
 *     and none of them cancels an in-flight request, so a response for an
 *     ABANDONED decision lands afterwards and repopulates the slot it was cleared
 *     from — re-arming a write gate with a number computed for a different pair,
 *     a different verb, or a different position. `preview-gate.test.tsx` pins
 *     this: deleting the bump from the authoring path turns it red.
 *
 * A fourth hand-rolled copy is a fourth place for that bump to be forgotten, and
 * nothing would fail loudly if it were — the slot would simply be wrong,
 * occasionally, in the direction of permitting a write.
 *
 * ## `hasRadius` / `awaitingFirst` are derived here on purpose
 *
 * Call sites asked the same two questions by re-spelling the triple inline, and
 * the two spellings drifted apart by a term: one gate read `radius !== null &&
 * error === null && !pending` while the sentence beside it re-derived the
 * negation over the same three fields. Deriving both once means a write gate and
 * the prompt that explains it cannot disagree about whether a number exists.
 *
 * ⚠️ Not migrated: `pending-queue.tsx`'s copy. It is per-entry rather than
 * per-pane, so it needs a keyed collection of slots rather than one, and folding
 * that in would reshape a working pane this change has no other reason to touch.
 * It is the remaining duplicate, and it is deliberate.
 */

/** The preview body, typed from the SERVER's own schema rather than a mirror. */
export type PreviewRequest = z.input<typeof BrainVocabularyPreviewRequestSchema>;

/**
 * One preview's three states, kept together so they cannot drift apart.
 *
 * A failed preview and an empty one are opposite facts; a bare
 * `BrainVocabularyBlastRadius | null` cannot tell them apart.
 */
export interface PreviewSlot {
  readonly radius: BrainVocabularyBlastRadius | null;
  readonly pending: boolean;
  readonly error: string | null;
}

export const EMPTY_PREVIEW: PreviewSlot = { radius: null, pending: false, error: null };

export interface PreviewSlotHandle {
  /** The three states, for `BlastRadiusPreview`. */
  readonly slot: PreviewSlot;
  /**
   * A radius arrived, nothing failed, nothing is in flight.
   *
   * The only condition that may arm a write. Derived here so a gate and the
   * sentence explaining it cannot disagree.
   */
  readonly hasRadius: boolean;
  /** Settled with no radius and no error — nobody has previewed yet. */
  readonly awaitingFirst: boolean;
  /** Ask for one decision's blast radius, dropping the answer if it goes stale. */
  readonly load: (body: PreviewRequest) => Promise<void>;
  /** Reset, and invalidate any in-flight response for the abandoned decision. */
  readonly clear: () => void;
}

export function usePreviewSlot(): PreviewSlotHandle {
  const [slot, setSlot] = useState<PreviewSlot>(EMPTY_PREVIEW);

  /**
   * ⚠️ Bumped on every write to the slot — on `load`'s entry AND on `clear`.
   *
   * `load` bumping on entry covers any reset followed by a new request. The
   * `clear` bump matters only where a reset is followed by NO new request and the
   * slot is read afterwards — re-picking a norm, changing a direction — which is
   * exactly the authoring path `preview-gate.test.tsx` exercises.
   */
  const generation = useRef(0);

  const previewMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyPreviewResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/preview", method: "POST" });

  async function load(body: PreviewRequest): Promise<void> {
    const mine = ++generation.current;
    setSlot({ radius: null, pending: true, error: null });
    const result = await previewMutation.mutate({ body });
    // The decision moved on while this was in flight. Drop the answer — writing
    // it would re-arm a write gate with a number about a different question.
    if (mine !== generation.current) return;
    if (!result.ok) {
      setSlot({ radius: null, pending: false, error: friendlyError(result.error) });
      return;
    }
    setSlot({ radius: result.data?.radius ?? null, pending: false, error: null });
  }

  function clear(): void {
    generation.current += 1;
    setSlot(EMPTY_PREVIEW);
  }

  return {
    slot,
    hasRadius: slot.radius !== null && slot.error === null && !slot.pending,
    awaitingFirst: slot.radius === null && slot.error === null && !slot.pending,
    load,
    clear,
  };
}
