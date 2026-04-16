"use client";

import { useMode } from "@/ui/hooks/use-mode";
import { useModeStatus } from "@/ui/hooks/use-mode-status";
import type { ModeDraftCounts } from "@useatlas/types/mode";

/**
 * Keys on `ModeDraftCounts` that a caller can select when computing whether
 * the admin has any relevant drafts for a given admin surface.
 */
export type DraftCounter = keyof ModeDraftCounts;

/**
 * True iff the admin is in developer mode, `/api/v1/mode` has resolved, and
 * the sum of the requested draft counters is zero.
 *
 * Used by admin surfaces (and the chat) that switch to a focused empty
 * state when the admin has toggled into developer mode but hasn't drafted
 * anything yet.
 *
 * The `modeStatus !== null` gate matters: `useModeStatus` returns `null`
 * while the query is in flight AND on failure (its retry is disabled).
 * Without the gate, admins with drafts would briefly see the dev-mode
 * empty state flash while the fetch is pending — or indefinitely if the
 * fetch fails.
 *
 * @param counters Which draft counters contribute to the "has drafts" sum.
 *   - `["connections"]` for the connections page and chat
 *   - `["prompts"]` for the prompts page
 *   - `["entities", "entityEdits", "entityDeletes"]` for the semantic editor
 */
export function useDevModeNoDrafts(counters: readonly DraftCounter[]): boolean {
  const { mode } = useMode();
  const { data: modeStatus } = useModeStatus();

  if (mode !== "developer") return false;
  if (modeStatus === null) return false;

  let total = 0;
  for (const key of counters) {
    total += modeStatus.draftCounts?.[key] ?? 0;
  }
  return total === 0;
}
