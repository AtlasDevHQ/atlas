/**
 * Build the OKF `ConnectorDocument` (path + full markdown) for one Notion page
 * (#4378). PURE — the vendor client fetches + normalizes; this shapes the
 * result the ingest seam stores.
 *
 * PATH — `<title-slug>-<compact-page-id>.md`, flat. Requirements the
 * `ConnectorDocument` contract places on it: deterministic per vendor page (the
 * upsert-by-path diff and the reconciliation subtractive archive both key on
 * it) and collision-free. Notion page titles are non-unique and its search is
 * non-exhaustive, so a purely title-derived path would (a) collide between two
 * same-titled pages and (b) differ between an incremental subset and a full
 * reconciliation if it encoded ancestry. Appending the page's own stable id
 * makes the path a pure function of the page ALONE — collision-free and
 * batch-independent — while the leading title slug keeps it readable in the
 * agent's explore mirror. A title edit reads as archive-old + fresh-draft, the
 * same documented rename posture as bundle-sync. (Full ancestry-mirroring paths
 * are a deferred follow-up: Notion's partial-sharing model makes a page's
 * ancestor chain resolvable only with extra, sometimes-forbidden reads.)
 *
 * PROVENANCE — the frontmatter carries `atlas:` (connector, page id,
 * last_edited_time), plus top-level `resource` (the stable page URL) and
 * `timestamp` (last_edited_time). The lenient ingest parser strips ALL
 * frontmatter into columns/discard before the change comparison, which runs on
 * the BODY + mirrored fields only — so provenance never causes re-review churn,
 * and a page re-fetched unchanged no-ops in the upsert. Sync time lives in the
 * `atlas_ingested_at` column the ingest stamps, deliberately NOT in the body,
 * so content stays a pure function of the page version.
 */

import { ATLAS_EXTENSION_KEY, renderOkfDocument } from "@atlas/okf-bundle";
import type { ConnectorDocument } from "../connectors";

/** The vendor-neutral projection of a Notion page the document layer consumes. */
export interface NotionPageDocument {
  /** Notion page id (dashed UUID). */
  readonly id: string;
  /** Plain-text page title (may be empty for an untitled page). */
  readonly title: string;
  /** ISO-8601 `last_edited_time` from the page object. */
  readonly lastEditedTime: string;
  /** The page's stable Notion URL (from the page object's `url`). */
  readonly url: string;
  /** The normalized (plain) markdown body. */
  readonly body: string;
}

const SLUG_MAX = 80;

/** Compact a Notion id (dashed UUID) to bare lowercase hex — the path token. */
export function compactPageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * Slugify a title to `[a-z0-9-]`, collapsed and trimmed, capped at
 * {@link SLUG_MAX}. Empty / punctuation-only titles fall back to `untitled` so
 * the path is never just the id token.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

/** The deterministic, collision-free archive path for a page. */
export function notionArchivePath(id: string, title: string): string {
  return `${slugifyTitle(title)}-${compactPageId(id)}.md`;
}

/**
 * Render the full OKF document for a page via the shared `renderOkfDocument`
 * (the single frontmatter encoder every bundle builder + connector uses), with
 * the `atlas:` provenance carried as its extension block. No provenance `tags`:
 * `tags` is a mirrored column in the lenient parser's change comparison, so
 * stamping one would re-draft every already-ingested Notion document; the
 * extension block stays outside the comparison.
 */
export function renderNotionOkfDocument(page: NotionPageDocument): string {
  const title = page.title.trim();
  return renderOkfDocument(
    {
      ...(title !== "" ? { title } : {}),
      resource: page.url,
      timestamp: page.lastEditedTime,
    },
    [],
    page.body,
    {
      key: ATLAS_EXTENSION_KEY,
      fields: {
        connector: "notion",
        page_id: page.id,
        last_edited_time: page.lastEditedTime,
      },
    },
  );
}

/** Assemble the `ConnectorDocument` (path + content) for one page. */
export function buildNotionConnectorDocument(page: NotionPageDocument): ConnectorDocument {
  return {
    path: notionArchivePath(page.id, page.title),
    content: renderNotionOkfDocument(page),
  };
}
