/**
 * Semantic-layer YAML parsing helper.
 *
 * js-yaml v5's `load()` throws a `YAMLException` ("expected a document, but
 * the input is empty") when the input contains no node — empty, whitespace-
 * only, or comment-only — where v4 returned `undefined`. Across the semantic
 * layer a document-less file means "nothing here": callers skip it or fall
 * into a non-object guard. `loadYaml` restores v4's `undefined` for that case
 * so the v5 upgrade doesn't turn a benign empty/placeholder YAML file into an
 * uncaught `YAMLException`. Every genuine syntax error still throws.
 *
 * `.trim()` alone is insufficient — a comment-only file (`# todo`) is
 * non-blank yet still document-less in v5 — so emptiness is decided per line.
 */
import * as yaml from "js-yaml";

/** True when `content` has at least one non-blank, non-comment line. */
function hasYamlDocument(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return true;
  }
  return false;
}

/**
 * Parse a YAML document, returning `undefined` for document-less input
 * (empty / whitespace-only / comment-only) instead of throwing — preserving
 * js-yaml v4's behavior under v5. All other parse errors propagate.
 */
export function loadYaml(content: string): unknown {
  if (!hasYamlDocument(content)) return undefined;
  return yaml.load(content);
}
