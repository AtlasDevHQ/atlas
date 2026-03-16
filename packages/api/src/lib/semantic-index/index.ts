/**
 * Pre-computed semantic index.
 *
 * Builds a Markdown summary of the semantic layer at server startup
 * (or on first access) and caches it. The summary is injected into
 * the agent system prompt so the LLM can identify relevant tables
 * without issuing explore tool calls for every question.
 *
 * @module
 */

import * as path from "path";
import { buildIndex } from "./build";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-index");

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let _cachedIndex: string | null = null;
let _cachedEntityCount = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the semantic index from disk and cache it.
 *
 * @param semanticRoot - Path to the semantic layer root directory.
 * @returns The Markdown index string (empty string if no entities found).
 */
export function buildSemanticIndex(semanticRoot: string): string {
  const { markdown, entityCount } = buildIndex(semanticRoot);
  _cachedIndex = markdown || null;
  _cachedEntityCount = entityCount;

  if (entityCount > 0) {
    log.info({ entityCount, mode: entityCount < 20 ? "full" : "summary" }, "Semantic index built");
  }

  return markdown;
}

/**
 * Get the cached semantic index, building it if not yet cached.
 *
 * @param semanticRoot - Path to the semantic layer root. Defaults to
 *   `./semantic` relative to cwd.
 * @returns The cached Markdown string, or null if no entities found.
 */
export function getSemanticIndex(semanticRoot?: string): string | null {
  if (_cachedIndex !== null) return _cachedIndex;

  const root = semanticRoot ?? path.resolve(process.cwd(), "semantic");
  const result = buildSemanticIndex(root);
  return result || null;
}

/** Clear the cached index. Called when semantic layer files change. */
export function invalidateSemanticIndex(): void {
  _cachedIndex = null;
  _cachedEntityCount = 0;
}

/** Return the number of entities in the current cached index. */
export function getIndexedEntityCount(): number {
  return _cachedEntityCount;
}

// Re-export types
export type { BuildResult } from "./build";
export type {
  ParsedEntity,
  ParsedDimension,
  ParsedMeasure,
  ParsedJoin,
  ParsedQueryPattern,
  ParsedMetric,
  ParsedGlossaryTerm,
  CatalogEntry,
} from "./types";
