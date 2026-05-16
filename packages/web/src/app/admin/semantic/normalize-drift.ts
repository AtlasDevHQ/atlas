/**
 * Defensive parser for the per-entity `drift` field on the admin
 * entities-list response (#2459). Unknown shapes / states drop silently
 * to `null` so a server-side regression in the drift field can't crash
 * the file tree — same posture the surrounding entity-shape parser takes.
 *
 * Extracted to its own module so it's testable as a pure function.
 */

import type {
  SemanticTreeDrift,
  SemanticTreeDriftState,
} from "@/ui/components/admin/semantic-file-tree";

const DRIFT_STATES: ReadonlySet<SemanticTreeDriftState> = new Set([
  "new",
  "removed",
  "changed",
  "in-sync",
]);

export function normalizeDrift(raw: unknown): SemanticTreeDrift | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    // A non-null object that fails shape validation is the regression signal
    // (the null/undefined branch is the normal no-drift path and stays quiet).
    console.debug("normalizeDrift: dropped non-object drift payload", { raw });
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || !DRIFT_STATES.has(r.state as SemanticTreeDriftState)) {
    console.debug("normalizeDrift: dropped unknown drift state", { state: r.state });
    return null;
  }
  const state = r.state as SemanticTreeDriftState;
  if (state === "changed") {
    if (typeof r.changeCount !== "number" || !Number.isFinite(r.changeCount)) {
      console.debug("normalizeDrift: dropped changed-drift with non-numeric changeCount", {
        changeCount: r.changeCount,
      });
      return null;
    }
    return { state, changeCount: r.changeCount };
  }
  return { state };
}
