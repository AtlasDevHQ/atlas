/**
 * The content-mode lifecycle vocabulary for knowledge documents — the CHECK
 * constraint on `knowledge_documents.status` (migration 0162) admits exactly
 * these values. Lives here (not inside any single consumer) because the
 * ingest core, the admin routes, and the searchKnowledge tool all narrow DB
 * read-backs against it.
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
