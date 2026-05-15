import { parseAsString, parseAsStringLiteral } from "nuqs"
import type { SemanticSelection } from "@/ui/components/admin/semantic-file-tree"

export const semanticSearchParams = {
  file: parseAsString,
  view: parseAsStringLiteral(["pretty", "yaml", "history"] as const).withDefault("pretty"),
  /**
   * Connection-group scope for entity selection (#2412). Multi-group orgs
   * can host the same entity in two environments — `group=g_prod_us`
   * picks which one the detail/edit/delete handlers operate on. Empty /
   * unset means "no disambiguation" — backend returns 409 with the
   * candidate groups when the name is genuinely ambiguous.
   */
  group: parseAsString,
}

/**
 * Convert a `file` query param string to a SemanticSelection.
 *
 * Examples:
 *   "catalog"           → { type: "catalog" }
 *   "glossary"          → { type: "glossary" }
 *   "entities/accounts" → { type: "entity", name: "accounts" }
 *   "metrics/accounts"  → { type: "metrics", file: "accounts" }
 *   null                → null
 *
 * The `group` query param (when present) is folded onto the entity
 * selection via {@link withGroupOnSelection} so consumers don't have
 * to thread two values everywhere.
 */
export function fileParamToSelection(file: string | null): SemanticSelection {
  if (!file) return null
  if (file === "catalog") return { type: "catalog" }
  if (file === "glossary") return { type: "glossary" }
  if (file.startsWith("entities/")) return { type: "entity", name: file.slice("entities/".length) }
  if (file.startsWith("metrics/")) return { type: "metrics", file: file.slice("metrics/".length) }
  return null
}

/** Attach a group scope to an entity selection (#2412). No-op for other types. */
export function withGroupOnSelection(
  sel: SemanticSelection,
  group: string | null | undefined,
): SemanticSelection {
  if (!sel || sel.type !== "entity") return sel
  if (group === undefined || group === null) return sel
  return { ...sel, connectionGroupId: group }
}

/**
 * Convert a SemanticSelection back to a `file` query param string.
 */
export function selectionToFileParam(sel: SemanticSelection): string | null {
  if (!sel) return null
  switch (sel.type) {
    case "catalog": return "catalog"
    case "glossary": return "glossary"
    case "entity": return `entities/${sel.name}`
    case "metrics": return sel.file ? `metrics/${sel.file}` : null
  }
}

/** Pull the group qualifier off an entity selection for the URL `group` param. */
export function selectionToGroupParam(sel: SemanticSelection): string | null {
  if (!sel || sel.type !== "entity") return null
  return sel.connectionGroupId ?? null
}
