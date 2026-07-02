/**
 * Display-surface descriptors for content-mode drafts — the ONE home for how
 * the pending-changes surfaces (developer-banner chip, top-bar pill, publish
 * modal) name, order, and fold the wire keys of `ModeDraftCounts`.
 *
 * Every key of `ModeDraftCounts` must be claimed by exactly one display
 * surface — enforced at compile time below — so when the API registers a new
 * content-mode surface (which widens `ModeDraftCounts` via the server-side
 * `InferDraftCounts` derivation), the web build fails HERE with one edit to
 * make, instead of three components silently dropping the new surface
 * (milestone #81 arch review: knowledge joined via ~11 hand-edits across 7
 * files, with exactly one of them compiler-enforced).
 *
 * Ordering matches the publish dependency chain, top-down as the admin reads
 * it: connections define data sources, entities expose them, prompts reference
 * them, starter prompts are the empty-state surface, and knowledge documents
 * are descriptive context.
 */

import { BookText, Database, FileText, Layers, Lightbulb, type LucideIcon } from "lucide-react";
import { totalDraftCount } from "@/ui/lib/draft-counts";
import type { ModeDraftCounts, ModeDraftActivity } from "@useatlas/types/mode";

export interface ContentSurfaceDescriptor {
  /** Display key — stable per surface, used as the React list key. */
  readonly key: string;
  /** The `ModeDraftCounts` wire keys folded into this display surface. */
  readonly countKeys: ReadonlyArray<keyof ModeDraftCounts>;
  /** Section title (publish modal), e.g. "Semantic entities". */
  readonly title: string;
  /** Pill row label, singular/plural, e.g. "Knowledge document(s)". */
  readonly singular: string;
  readonly plural: string;
  /** Banner-chip label, lowercase, e.g. "3 knowledge documents". */
  readonly chipSingular: string;
  readonly chipPlural: string;
  readonly icon: LucideIcon;
}

export const CONTENT_SURFACES = [
  {
    key: "connections",
    countKeys: ["connections"],
    title: "Connections",
    singular: "Connection",
    plural: "Connections",
    chipSingular: "connection",
    chipPlural: "connections",
    icon: Database,
  },
  {
    // The three entity slices (new drafts, draft-edits, tombstoned deletes)
    // fold into one display surface — the publish modal shows the per-slice
    // breakdown via row intents.
    key: "entities",
    countKeys: ["entities", "entityEdits", "entityDeletes"],
    title: "Semantic entities",
    singular: "Semantic entity",
    plural: "Semantic entities",
    chipSingular: "entity",
    chipPlural: "entities",
    icon: Layers,
  },
  {
    key: "prompts",
    countKeys: ["prompts"],
    title: "Prompt collections",
    singular: "Prompt collection",
    plural: "Prompt collections",
    chipSingular: "prompt",
    chipPlural: "prompts",
    icon: FileText,
  },
  {
    key: "starterPrompts",
    countKeys: ["starterPrompts"],
    title: "Starter prompts",
    singular: "Starter prompt",
    plural: "Starter prompts",
    chipSingular: "starter prompt",
    chipPlural: "starter prompts",
    icon: Lightbulb,
  },
  {
    key: "knowledgeDocuments",
    countKeys: ["knowledgeDocuments"],
    title: "Knowledge documents",
    singular: "Knowledge document",
    plural: "Knowledge documents",
    chipSingular: "knowledge document",
    chipPlural: "knowledge documents",
    icon: BookText,
  },
] as const satisfies ReadonlyArray<ContentSurfaceDescriptor>;

// ---------------------------------------------------------------------------
// Compile-time claim check: every ModeDraftCounts key is claimed by AT LEAST
// one display surface (a new wire key no descriptor claims fails the
// assertion; a typo'd countKey fails the descriptor's `satisfies` above).
// Uniqueness of the claim is by convention — a double-claimed key would
// double-display its count.
// ---------------------------------------------------------------------------
type ClaimedKey = (typeof CONTENT_SURFACES)[number]["countKeys"][number];
type _AllCountKeysClaimed = [keyof ModeDraftCounts] extends [ClaimedKey] ? true : never;
const _allCountKeysClaimed: _AllCountKeysClaimed = true;
void _allCountKeysClaimed;

/** Display-surface key union — makes lookups total at compile time. */
export type ContentSurfaceKey = (typeof CONTENT_SURFACES)[number]["key"];

/** Look up a display surface by key (publish-modal section metadata). */
export function contentSurface(key: ContentSurfaceKey): ContentSurfaceDescriptor {
  const found = (CONTENT_SURFACES as ReadonlyArray<ContentSurfaceDescriptor>).find(
    (s) => s.key === key,
  );
  if (!found) throw new Error(`Unknown content surface "${key}"`);
  return found;
}

/**
 * Total drafts across every display surface — delegates to the NaN-safe
 * `totalDraftCount` (#4229): during a web-before-API deploy-overlap window an
 * older API omits a newer segment, and an unguarded per-field sum would poison
 * the total to NaN ("NaN pending" badge).
 */
export function totalDrafts(counts: ModeDraftCounts): number {
  return totalDraftCount(counts);
}

/** A single wire segment's count, guarded the same way (absent/garbage → 0). */
function countOf(counts: ModeDraftCounts, key: keyof ModeDraftCounts): number {
  const v = counts[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** One non-zero display surface, with its folded count + freshest activity. */
export interface DraftSurfaceSegment {
  readonly key: string;
  readonly count: number;
  /** Pill row label ("Semantic entities"), pluralized to `count`. */
  readonly label: string;
  /** Banner-chip label ("3 entities"), pluralized to `count`. */
  readonly chipLabel: string;
  /** Freshest `lastEditedAt` across the surface's folded wire keys. */
  readonly lastEditedAt: string | null;
}

/**
 * Fold counts (+ optional activity) into ordered, non-zero display segments —
 * the shared core behind the banner chip and the top-bar pill popover.
 */
export function draftSurfaceSegments(
  counts: ModeDraftCounts,
  activity: ModeDraftActivity | null,
): DraftSurfaceSegment[] {
  const out: DraftSurfaceSegment[] = [];
  for (const surface of CONTENT_SURFACES) {
    const count = surface.countKeys.reduce((a, k) => a + countOf(counts, k), 0);
    if (count === 0) continue;
    out.push({
      key: surface.key,
      count,
      label: count === 1 ? surface.singular : surface.plural,
      chipLabel: `${count} ${count === 1 ? surface.chipSingular : surface.chipPlural}`,
      lastEditedAt: mostRecent(surface.countKeys.map((k) => activity?.[k]?.lastEditedAt ?? null)),
    });
  }
  return out;
}

/** Pick the most recent ISO timestamp from a list, ignoring nulls. */
function mostRecent(values: ReadonlyArray<string | null>): string | null {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) {
      best = t;
      bestIso = v;
    }
  }
  return bestIso;
}
