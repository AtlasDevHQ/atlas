import { parseAsString, parseAsStringLiteral } from "nuqs"
import type { SemanticSelection } from "@/ui/components/admin/semantic-file-tree"

export const semanticSearchParams = {
  file: parseAsString,
  view: parseAsStringLiteral(["pretty", "yaml"] as const).withDefault("pretty"),
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
 */
export function fileParamToSelection(file: string | null): SemanticSelection {
  if (!file) return null
  if (file === "catalog") return { type: "catalog" }
  if (file === "glossary") return { type: "glossary" }
  if (file.startsWith("entities/")) return { type: "entity", name: file.slice("entities/".length) }
  if (file.startsWith("metrics/")) return { type: "metrics", file: file.slice("metrics/".length) }
  return null
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
