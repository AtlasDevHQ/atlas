/**
 * The content-mode lifecycle vocabulary for knowledge documents — the CHECK
 * constraint on `knowledge_documents.status` (migration 0162) admits exactly
 * these values. Lives here (not inside any single consumer) so it names the
 * pillar's status vocabulary once; `searchKnowledge` narrows DB read-backs
 * through it today, while the ingest core and admin routes carry their own
 * inline fail-closed comparisons against the same literals.
 */

export const KNOWLEDGE_DOCUMENT_STATUSES = ["draft", "published", "archived"] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

/**
 * Fail-closed narrowing for a DB `status` read-back: a value outside the
 * vocabulary (only reachable if the CHECK constraint is widened without
 * updating this tuple) maps to `fallback` instead of flowing through a cast.
 * Pick the fallback that under-privileges: `"draft"` where published implies
 * trust, `"archived"` where visibility is the risk.
 */
export function narrowKnowledgeStatus(
  value: unknown,
  fallback: KnowledgeDocumentStatus,
): KnowledgeDocumentStatus {
  return (KNOWLEDGE_DOCUMENT_STATUSES as readonly unknown[]).includes(value)
    ? (value as KnowledgeDocumentStatus)
    : fallback;
}
