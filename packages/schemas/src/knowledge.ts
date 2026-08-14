/**
 * Knowledge-pillar collection sources — the one spelling of the set (#5203).
 *
 * The tuple lives in this package rather than in `@useatlas/types`: the
 * template scaffold installs `@useatlas/types` from the registry, so a new
 * value export there forces a publish-first merge dance on every consuming PR
 * (CLAUDE.md § Publishing). `@useatlas/schemas` is vendored into the scaffold
 * as source, so a tuple here costs nothing.
 *
 * Both `z.enum` consumers — the API's collection list (`admin-knowledge.ts`)
 * and the web admin layer (`admin-schemas.ts`) — import this tuple; #5203 had
 * to remove `"slack-history"` from three hand-synchronized spellings of this
 * set, which is why it is now one.
 */
import type { KnowledgeCollectionSource } from "@useatlas/types";

export const KNOWLEDGE_COLLECTION_SOURCES = [
  "upload",
  "bundle-sync",
  "notion",
  "confluence",
  "confluence-datacenter",
  "gitbook",
  "zendesk",
  "salesforce-knowledge",
  "intercom",
  "front",
  "helpscout",
  "freshdesk",
  "zoom-transcripts",
  "outlook-mail",
] as const satisfies readonly KnowledgeCollectionSource[];

// `satisfies` proves each element is a MEMBER of the union, never that the
// tuple is COMPLETE — the pin below is what makes dropping a union member out
// of the tuple a compile error (same shape as `_BrainFactStatusesCovered` in
// `brain.ts`).
type _KnowledgeCollectionSourcesCovered = [
  Exclude<KnowledgeCollectionSource, (typeof KNOWLEDGE_COLLECTION_SOURCES)[number]>,
] extends [never]
  ? true
  : never;
const _knowledgeCollectionSourcesCovered: _KnowledgeCollectionSourcesCovered = true;
void _knowledgeCollectionSourcesCovered;
