import {
  BookMarked,
  BookText,
  Cloud,
  FileUp,
  Globe,
  Headset,
  Inbox,
  LifeBuoy,
  MessageCircle,
  NotebookText,
  type LucideIcon,
} from "lucide-react";
import type { KnowledgeCollectionSource } from "@/ui/lib/types";

/* ────────────────────────────────────────────────────────────────────────
 *  Presentation + wiring metadata for the Knowledge Base "New collection"
 *  connector picker (#4619).
 *
 *  The picker itself is DATA-DRIVEN: it renders one tile per row of the
 *  `?pillar=knowledge` catalog (`BUILTIN_KNOWLEDGE_CATALOG_ROWS` server-side)
 *  and collects each connector's credentials from its `config_schema`. Nothing
 *  here gates which connectors appear — a new catalog row surfaces in the UI
 *  with no picker edit. This module only carries:
 *    - the slug → wire `source` map, so the post-install follow-up (kick a
 *      first sync vs open the upload dialog) can be decided;
 *    - per-connector icons + a short label (pure presentation), both with a
 *      generic fallback so an unmapped future connector still renders.
 * ──────────────────────────────────────────────────────────────────────── */

/** The upload slug — the one source with the upload-&-publish follow-up. */
export const OKF_UPLOAD_SLUG = "okf-upload";

/**
 * Client mirror of the server-side `sourceOf` (admin-knowledge.ts), keyed by
 * catalog SLUG rather than id. Maps a picked connector back to the wire
 * `source` discriminator that `/admin/knowledge` branches on after install.
 * `upload` is the only non-synced source; every connector is synced.
 */
const SLUG_TO_SOURCE: Readonly<Record<string, KnowledgeCollectionSource>> = {
  [OKF_UPLOAD_SLUG]: "upload",
  "bundle-sync": "bundle-sync",
  "notion-knowledge": "notion",
  confluence: "confluence",
  "confluence-datacenter": "confluence-datacenter",
  gitbook: "gitbook",
  zendesk: "zendesk",
  "salesforce-knowledge": "salesforce-knowledge",
  intercom: "intercom",
  front: "front",
  helpscout: "helpscout",
  freshdesk: "freshdesk",
};

/**
 * The wire `source` for a picked catalog slug. Falls back to `bundle-sync` for
 * any unmapped connector: every non-upload source is synced, so this only ever
 * decides "kick a first sync" — the correct follow-up for a future connector
 * that landed a catalog row before this map was extended.
 */
export function knowledgeSourceForSlug(slug: string): KnowledgeCollectionSource {
  return SLUG_TO_SOURCE[slug] ?? "bundle-sync";
}

/** Every slug this module maps to a source — exported for the parity guard. */
export const KNOWLEDGE_SOURCE_SLUGS: readonly string[] = Object.keys(SLUG_TO_SOURCE);

/** Per-connector tile icon (presentation only). */
const CONNECTOR_ICONS: Readonly<Record<string, LucideIcon>> = {
  [OKF_UPLOAD_SLUG]: FileUp,
  "bundle-sync": Globe,
  "notion-knowledge": NotebookText,
  confluence: BookText,
  "confluence-datacenter": BookText,
  gitbook: BookMarked,
  zendesk: LifeBuoy,
  "salesforce-knowledge": Cloud,
  intercom: MessageCircle,
  front: Inbox,
  helpscout: LifeBuoy,
  freshdesk: Headset,
};

/** Tile icon for a slug; a future connector falls back to the generic glyph. */
export function iconForKnowledgeSlug(slug: string): LucideIcon {
  return CONNECTOR_ICONS[slug] ?? BookText;
}

/**
 * A short tile label from the verbose catalog name:
 * "Knowledge Base (Confluence Cloud)" → "Confluence Cloud". Falls back to the
 * full name for any row that doesn't follow the parenthesized convention.
 */
export function shortConnectorLabel(name: string): string {
  const match = name.match(/^Knowledge Base \((.+)\)$/);
  return match ? match[1]! : name;
}

/** The two picker sections. `manual` = upload/endpoint arms; everything else
 *  is a scheduled `connector`. */
export type KnowledgeConnectorGroup = "manual" | "connector";

const MANUAL_SLUGS: ReadonlySet<string> = new Set([OKF_UPLOAD_SLUG, "bundle-sync"]);

export function groupForKnowledgeSlug(slug: string): KnowledgeConnectorGroup {
  return MANUAL_SLUGS.has(slug) ? "manual" : "connector";
}

/**
 * Display order for the picker — the familiar manual arms first, then the
 * vendor connectors. Slugs not listed (a future connector) sort last but still
 * render, so the picker never hides a catalog row.
 */
export const KNOWLEDGE_DISPLAY_ORDER: readonly string[] = [
  OKF_UPLOAD_SLUG,
  "bundle-sync",
  "notion-knowledge",
  "confluence",
  "confluence-datacenter",
  "gitbook",
  "zendesk",
  "salesforce-knowledge",
  "intercom",
  "front",
  "helpscout",
  "freshdesk",
];
