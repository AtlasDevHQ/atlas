import type {
  SemanticSelection,
  SemanticTreeDrift,
} from "@/ui/components/admin/semantic-file-tree";

/**
 * Minimal lookup row — name + group qualifier + drift state. Kept narrower
 * than `EntitySummary` so a future schema growth on the page can't drift
 * this predicate's input shape without an explicit edit.
 */
export interface DriftRoutingEntity {
  readonly name: string;
  readonly connectionGroupId: string | null;
  readonly drift?: SemanticTreeDrift | null;
}

/**
 * Returns the entity name to open the drift drawer for, or `null` if the
 * click should fall through to the regular entity-detail view.
 *
 * The drawer opens for `changed`, `removed`, or `new` rows (#2461). `new`
 * doesn't currently appear in the YAML-side file tree but is included so
 * a future caller surfacing DB-only rows won't silently no-op.
 *
 * Match keys on both `name` and `connectionGroupId` to keep multi-
 * environment orgs (#2412) coherent — the same `name` under two groups
 * is two rows, and a stale group qualifier shouldn't open a drawer for
 * the other env's drift.
 */
export function driftDrawerTargetFor(
  selection: SemanticSelection,
  entities: ReadonlyArray<DriftRoutingEntity>,
): string | null {
  if (selection?.type !== "entity") return null;
  const match = entities.find(
    (e) =>
      e.name === selection.name &&
      e.connectionGroupId === (selection.connectionGroupId ?? null),
  );
  const state = match?.drift?.state;
  if (state === "changed" || state === "removed" || state === "new") {
    return selection.name;
  }
  return null;
}
