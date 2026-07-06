/**
 * The Notion `ConnectorVendorClient` (#4378) — enumerate + fetch, behind the
 * per-vendor interface the shared engine (`connector-sync.ts`) drives. The
 * engine owns scheduling, high-water marks, 429 backoff, caps, and ingest; this
 * client owns ONLY Notion's two documented awkwardnesses:
 *
 *   ENUMERATION is non-trivial because Notion search is officially
 *   non-exhaustive and visibility is opt-in per shared subtree. So:
 *     - `fetchAll` (RECONCILIATION, the correctness anchor) unions SEARCH with a
 *       RECURSIVE DESCENT of every shared root's block tree — a page reachable
 *       only by inheritance (its parent was shared, but search never returned
 *       it) is still found via its parent's `child_page`/`child_database`
 *       blocks. Deletions/unshares surface here as paths absent from the full
 *       set; the engine archives them. An INCOMPLETE enumeration must THROW
 *       (never return a partial set) — a silent under-count would let the engine
 *       archive live pages.
 *     - `fetchChanges` (INCREMENTAL, cheap) walks SEARCH sorted by
 *       `last_edited_time` descending and stops once older than `since`. The
 *       engine's overlap window absorbs Notion's minute-granularity timestamps;
 *       inheritance-only pages and deletions are reconciliation's job, not this
 *       cycle's.
 *
 *   CONTENT is the official page-markdown endpoint (one request per page). A
 *   `truncated` page (over Notion's ~20k-block limit) is completed by
 *   re-fetching its `unknown_block_ids` as page ids; a page the endpoint can't
 *   serve falls back to a block-walk render. Both are COUNTED and logged, never
 *   silent (AC). Expiring media URLs are replaced with the stable page link by
 *   the normalizer.
 *
 * Every network call is the injected {@link NotionHttpClient}; no test reaches
 * Notion.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getIngestMaxDocs } from "../ingest-limits";
import { ConnectorRateLimitError } from "../connectors";
import type {
  ConnectorChanges,
  ConnectorDocument,
  ConnectorFetchSince,
  ConnectorVendorClient,
} from "../connectors";
import { NotionHttpClient } from "./http";
import { normalizeNotionMarkdown } from "./markdown";
import { buildNotionConnectorDocument, compactPageId, type NotionPageDocument } from "./document";

const log = createLogger("knowledge.notion.client");

/**
 * Hard ceiling on pages enumerated in one reconciliation — a runaway guard well
 * above the ingest doc cap (which produces the actionable "narrow scope" error
 * first). Hitting THIS throws rather than truncating: a capped enumeration is
 * incomplete, and an incomplete reconciliation must never archive the overflow.
 */
const MAX_ENUMERATED_PAGES = 10_000;

/** Bound the truncation continuation so a pathological page can't fan out unboundedly. */
const MAX_TRUNCATION_CONTINUATIONS = 50;

/**
 * Bound block-walk recursion depth — governs BOTH the enumeration
 * container-descent (`walkBlocks`, where exceeding it is logged, since a missed
 * subpage could be archived) and the fallback content render
 * (`blockWalkMarkdown`). Tune with both in mind.
 */
const MAX_BLOCK_WALK_DEPTH = 6;

// ---------------------------------------------------------------------------
// Narrowing helpers for the untyped Notion JSON (the read sites own the shape)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A Notion list/query response must be a JSON object — a 2xx body that isn't
 * (proxy HTML, an edge hiccup, a contract violation) is NOT "no more pages". In
 * an enumeration loop, treating "couldn't understand the response" as "done"
 * returns a partial set, and a partial reconciliation set makes the engine
 * archive the pages we never reached. Throw instead — the engine turns it into
 * the collection's sync error (exactly as {@link MAX_ENUMERATED_PAGES} does).
 */
function requireResponseObject(value: unknown, what: string): Record<string, unknown> {
  const obj = asRecord(value);
  if (obj === null) {
    throw new Error(
      `Notion ${what} returned an unexpected non-object response — refusing to treat enumeration as complete (a partial set would archive live pages).`,
    );
  }
  return obj;
}

/**
 * Advance a Notion pagination cursor, or return null when the vendor says the
 * listing is complete (`has_more !== true`). THROWS when the vendor reports
 * more pages (`has_more === true`) but returns no usable `next_cursor` — that is
 * a known-incomplete listing, and stopping silently would archive live pages.
 */
function advancePageCursor(res: Record<string, unknown>, what: string): string | null {
  if (res.has_more !== true) return null;
  const next = asString(res.next_cursor);
  if (next === "") {
    throw new Error(
      `Notion ${what} reported more results (has_more) but returned no next_cursor — enumeration is incomplete; refusing to archive on a partial set.`,
    );
  }
  return next;
}

/** A page's title from its `properties` (the one `type: "title"` property). */
function extractTitle(properties: unknown): string {
  const props = asRecord(properties);
  if (props === null) return "";
  for (const key of Object.keys(props)) {
    const prop = asRecord(props[key]);
    if (prop?.type === "title") {
      return asArray(prop.title)
        .map((rt) => asString(asRecord(rt)?.plain_text))
        .join("");
    }
  }
  return "";
}

/** A page's stable URL from its object, or a canonical fallback from the id. */
function pageUrl(pageObject: Record<string, unknown>, id: string): string {
  const url = asString(pageObject.url);
  return url !== "" ? url : `https://www.notion.so/${compactPageId(id)}`;
}

/** The vendor-neutral page reference the enumerator accumulates. */
interface NotionPageRef {
  readonly id: string;
  readonly title: string;
  readonly lastEditedTime: string;
  readonly url: string;
}

/** True for a page object that is trashed/archived (treat as absent). */
function isArchived(pageObject: Record<string, unknown>): boolean {
  return pageObject.archived === true || pageObject.in_trash === true;
}

export interface NotionVendorClientOptions {
  readonly http: NotionHttpClient;
  /** Test-only override of the ingest doc cap (defaults to the settings value). */
  readonly maxDocs?: number;
}

export class NotionVendorClient implements ConnectorVendorClient {
  private readonly http: NotionHttpClient;
  private readonly maxDocs: number;

  constructor(options: NotionVendorClientOptions) {
    this.http = options.http;
    this.maxDocs = options.maxDocs ?? getIngestMaxDocs();
  }

  /** INCREMENTAL: search walk-until-older. */
  async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
    // The engine only routes here with a non-null `since`; a defensive null
    // means "treat everything as changed" (equivalent to a reconciliation of
    // the search-visible set) rather than silently fetching nothing.
    const since = params.since;
    const changed: NotionPageRef[] = [];
    let newestSeen: string | null = null;

    await this.searchPages({
      direction: "descending",
      onPage: (ref) => {
        if (newestSeen === null || ref.lastEditedTime > newestSeen) newestSeen = ref.lastEditedTime;
        if (since === null || ref.lastEditedTime >= since) {
          changed.push(ref);
          return "continue";
        }
        // Sorted descending: the first page older than `since` means every
        // remaining result is older too — stop paginating.
        return "stop";
      },
    });

    const documents = await this.buildDocuments(changed);
    return { documents, highWaterMark: newestSeen, cursor: null };
  }

  /** RECONCILIATION: search ∪ recursive descent — the exhaustive set. */
  async fetchAll(): Promise<ConnectorChanges> {
    const refs = new Map<string, NotionPageRef>();
    const addRef = (ref: NotionPageRef): void => {
      if (!refs.has(ref.id)) refs.set(ref.id, ref);
      if (refs.size > MAX_ENUMERATED_PAGES) {
        // Incomplete-by-cap: throwing keeps the engine from archiving the pages
        // we never reached. Actionable — the operator narrows the shared scope.
        throw new Error(
          `This Notion integration shares more than ${MAX_ENUMERATED_PAGES} pages — narrow what is shared with the integration, or split it across collections.`,
        );
      }
    };

    // Roots: everything search returns (pages + data-source rows). Descent then
    // fills in the inheritance-only pages search missed.
    const roots: string[] = [];
    await this.searchPages({
      direction: "descending",
      onPage: (ref) => {
        addRef(ref);
        roots.push(ref.id);
        return "continue";
      },
    });
    await this.enumerateDataSources(addRef, roots);
    await this.descend(roots, addRef);

    const highWaterMark = [...refs.values()].reduce<string | null>(
      (max, ref) => (max === null || ref.lastEditedTime > max ? ref.lastEditedTime : max),
      null,
    );

    // Reject an over-cap set BEFORE fetching content (the engine's ingest cap is
    // the backstop, but checking here saves thousands of markdown fetches).
    if (refs.size > this.maxDocs) {
      throw new Error(
        `This Notion integration shares ${refs.size} pages, over the ${this.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow what is shared with the integration, or raise the cap.`,
      );
    }

    const documents = await this.buildDocuments([...refs.values()]);
    return { documents, highWaterMark, cursor: null };
  }

  // ── Enumeration ────────────────────────────────────────────────────────────

  /**
   * Page every `POST /v1/search` result of type `page`, invoking `onPage` per
   * live page. `onPage` returns `"stop"` to end pagination (the incremental
   * walk-until-older). Archived/trashed pages are skipped.
   */
  private async searchPages(opts: {
    readonly direction: "ascending" | "descending";
    readonly onPage: (ref: NotionPageRef) => "continue" | "stop";
  }): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        sort: { direction: opts.direction, timestamp: "last_edited_time" },
        page_size: 100,
        ...(cursor !== null ? { start_cursor: cursor } : {}),
      };
      const res = requireResponseObject(await this.http.post("/search", body), "page search");
      for (const raw of asArray(res.results)) {
        const obj = asRecord(raw);
        if (obj === null || obj.object !== "page" || isArchived(obj)) continue;
        const id = asString(obj.id);
        if (id === "") continue;
        const ref: NotionPageRef = {
          id,
          title: extractTitle(obj.properties),
          lastEditedTime: asString(obj.last_edited_time),
          url: pageUrl(obj, id),
        };
        if (opts.onPage(ref) === "stop") return;
      }
      const next = advancePageCursor(res, "page search");
      if (next === null) return;
      cursor = next;
    }
  }

  /**
   * Search for data sources and enqueue each of their pages as a root — search
   * for `object: "page"` does not surface database rows, so a shared database's
   * pages arrive here (and via `child_database` descent).
   */
  private async enumerateDataSources(
    addRef: (ref: NotionPageRef) => void,
    roots: string[],
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "data_source" },
        page_size: 100,
        ...(cursor !== null ? { start_cursor: cursor } : {}),
      };
      const res = requireResponseObject(await this.http.post("/search", body), "data-source search");
      for (const raw of asArray(res.results)) {
        const ds = asRecord(raw);
        const dsId = asString(ds?.id);
        if (dsId !== "") await this.queryDataSourcePages(dsId, addRef, roots);
      }
      const next = advancePageCursor(res, "data-source search");
      if (next === null) return;
      cursor = next;
    }
  }

  /** Query every page in one data source, enqueueing each as a root to descend. */
  private async queryDataSourcePages(
    dataSourceId: string,
    addRef: (ref: NotionPageRef) => void,
    roots: string[],
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const body: Record<string, unknown> = {
        page_size: 100,
        ...(cursor !== null ? { start_cursor: cursor } : {}),
      };
      const res = requireResponseObject(
        await this.http.post(`/data_sources/${dataSourceId}/query`, body),
        "data-source query",
      );
      for (const raw of asArray(res.results)) {
        const obj = asRecord(raw);
        if (obj === null || obj.object !== "page" || isArchived(obj)) continue;
        const id = asString(obj.id);
        if (id === "") continue;
        addRef({
          id,
          title: extractTitle(obj.properties),
          lastEditedTime: asString(obj.last_edited_time),
          url: pageUrl(obj, id),
        });
        roots.push(id);
      }
      const next = advancePageCursor(res, "data-source query");
      if (next === null) return;
      cursor = next;
    }
  }

  /**
   * Recursively descend the block tree of each root, collecting nested
   * `child_page` (→ a page, recurse) and `child_database` (→ query its pages).
   * A visited set keeps a cyclic/shared tree from looping; container blocks
   * (`has_children`) are traversed so a subpage nested inside a toggle/column is
   * still found.
   */
  private async descend(
    roots: readonly string[],
    addRef: (ref: NotionPageRef) => void,
  ): Promise<void> {
    const visited = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const pageId = queue.shift()!;
      if (visited.has(pageId)) continue;
      visited.add(pageId);
      await this.walkBlocks(pageId, addRef, queue, 0);
    }
  }

  /** Walk one block subtree, collecting subpages/databases. */
  private async walkBlocks(
    blockId: string,
    addRef: (ref: NotionPageRef) => void,
    pageQueue: string[],
    depth: number,
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const path =
        `/blocks/${blockId}/children?page_size=100` +
        (cursor !== null ? `&start_cursor=${encodeURIComponent(cursor)}` : "");
      const res = requireResponseObject(await this.http.get(path), `block children of ${blockId}`);
      for (const raw of asArray(res.results)) {
        const block = asRecord(raw);
        if (block === null) continue;
        const type = asString(block.type);
        const id = asString(block.id);
        if (type === "child_page" && id !== "") {
          const child = asRecord(block.child_page);
          addRef({
            id,
            title: asString(child?.title),
            lastEditedTime: asString(block.last_edited_time),
            url: `https://www.notion.so/${compactPageId(id)}`,
          });
          // Enqueue unconditionally — the `descend` visited-set dedupes; a page
          // already in `refs` may still have un-walked subpages of its own.
          pageQueue.push(id);
        } else if (type === "child_database" && id !== "") {
          await this.enumerateDatabaseBlock(id, addRef, pageQueue);
        } else if (block.has_children === true && id !== "") {
          if (depth < MAX_BLOCK_WALK_DEPTH) {
            // A container block (toggle, column, callout, …) may hold a subpage —
            // recurse into it, bounded by depth.
            await this.walkBlocks(id, addRef, pageQueue, depth + 1);
          } else {
            // Counted, never silent (matches the truncation/fallback logging): a
            // subpage buried past the depth cap could be an inheritance-only page
            // the reconciliation would then archive — surface the coverage gap.
            log.warn(
              { blockId: id, depth },
              "Notion block descent hit the depth cap — a subpage nested this deep in one page is not enumerated",
            );
          }
        }
      }
      const next = advancePageCursor(res, `block children of ${blockId}`);
      if (next === null) return;
      cursor = next;
    }
  }

  /** Resolve a `child_database` block to its data sources and enqueue their pages. */
  private async enumerateDatabaseBlock(
    databaseId: string,
    addRef: (ref: NotionPageRef) => void,
    pageQueue: string[],
  ): Promise<void> {
    const db = requireResponseObject(
      await this.http.get(`/databases/${databaseId}`),
      `database ${databaseId}`,
    );
    const dataSources = asArray(db.data_sources);
    if (dataSources.length === 0) return;
    for (const raw of dataSources) {
      const dsId = asString(asRecord(raw)?.id);
      if (dsId !== "") await this.queryDataSourcePages(dsId, addRef, pageQueue);
    }
  }

  // ── Content ──────────────────────────────────────────────────────────────

  /** Fetch + normalize content for each ref into a `ConnectorDocument`. */
  private async buildDocuments(refs: readonly NotionPageRef[]): Promise<ConnectorDocument[]> {
    const documents: ConnectorDocument[] = [];
    let truncatedCount = 0;
    let fallbackCount = 0;
    for (const ref of refs) {
      const content = await this.fetchContent(ref.id);
      if (content.truncated) truncatedCount++;
      if (content.usedFallback) fallbackCount++;
      const page: NotionPageDocument = {
        id: ref.id,
        title: ref.title,
        lastEditedTime: ref.lastEditedTime,
        url: ref.url,
        body: normalizeNotionMarkdown(content.markdown, { pageUrl: ref.url }),
      };
      documents.push(buildNotionConnectorDocument(page));
    }
    if (truncatedCount > 0 || fallbackCount > 0) {
      // Counted, never silent (AC): a page that needed continuation or the
      // block-walk fallback is reported so an operator can see coverage gaps.
      log.info(
        { pages: refs.length, truncatedCompleted: truncatedCount, blockWalkFallback: fallbackCount },
        "Notion content fetch used truncation continuation / block-walk fallback",
      );
    }
    return documents;
  }

  /**
   * One page's markdown via the official endpoint, completing a `truncated`
   * page by re-fetching its `unknown_block_ids` as page ids. If the endpoint
   * cannot serve the page at all, fall back to a block-walk render.
   */
  private async fetchContent(
    pageId: string,
  ): Promise<{ markdown: string; truncated: boolean; usedFallback: boolean }> {
    let root: Record<string, unknown> | null;
    try {
      root = asRecord(await this.http.get(`/pages/${pageId}/markdown`));
    } catch (err) {
      // A 429 must propagate to the engine's backoff — re-throw it untouched.
      if (err instanceof ConnectorRateLimitError) throw err;
      log.warn(
        { pageId, err: err instanceof Error ? err.message : String(err) },
        "Notion page-markdown endpoint failed — falling back to block-walk",
      );
      return { markdown: await this.blockWalkMarkdown(pageId, 0), truncated: false, usedFallback: true };
    }

    // A 2xx body that isn't an object (contract violation) would otherwise
    // narrow to an empty, uncounted body — treat it as an endpoint failure and
    // fall back to the block-walk (counted), never a silently blank page.
    if (root === null) {
      log.warn(
        { pageId },
        "Notion page-markdown endpoint returned a non-object body — falling back to block-walk",
      );
      return { markdown: await this.blockWalkMarkdown(pageId, 0), truncated: false, usedFallback: true };
    }

    const parts = [asString(root.markdown)];
    let truncated = root.truncated === true;
    const seen = new Set<string>([pageId]);
    let queue = uniqueStrings(root.unknown_block_ids).filter((id) => !seen.has(id));
    let continuations = 0;

    while (truncated && queue.length > 0 && continuations < MAX_TRUNCATION_CONTINUATIONS) {
      const blockId = queue.shift()!;
      if (seen.has(blockId)) continue;
      seen.add(blockId);
      continuations++;
      try {
        const sub = asRecord(await this.http.get(`/pages/${blockId}/markdown`));
        parts.push(asString(sub?.markdown));
        const more = uniqueStrings(sub?.unknown_block_ids).filter((id) => !seen.has(id));
        queue = [...queue, ...more];
        // A subtree that itself reports not-truncated has been fully retrieved;
        // `truncated` stays true only while some subtree remains unresolved.
        if (queue.length === 0 && sub?.truncated !== true) truncated = false;
      } catch (err) {
        if (err instanceof ConnectorRateLimitError) throw err;
        // A subtree we cannot fetch stays a gap — logged via the fallback count.
        log.warn(
          { pageId, blockId, err: err instanceof Error ? err.message : String(err) },
          "Notion truncation continuation sub-fetch failed — leaving the subtree out",
        );
      }
    }
    return { markdown: parts.join("\n\n"), truncated, usedFallback: false };
  }

  /**
   * Minimal block-walk render — the fallback when the markdown endpoint can't
   * serve a page. Extracts prose from the common text block types; text-first,
   * so non-text blocks degrade to a note rather than being mirrored.
   */
  private async blockWalkMarkdown(blockId: string, depth: number): Promise<string> {
    if (depth > MAX_BLOCK_WALK_DEPTH) return "";
    const out: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const path =
        `/blocks/${blockId}/children?page_size=100` +
        (cursor !== null ? `&start_cursor=${encodeURIComponent(cursor)}` : "");
      const res = asRecord(await this.http.get(path));
      for (const raw of asArray(res?.results)) {
        const block = asRecord(raw);
        if (block === null) continue;
        const rendered = renderBlock(block);
        if (rendered !== null) out.push(rendered);
        if (block.has_children === true && asString(block.type) !== "child_page") {
          const nested = await this.blockWalkMarkdown(asString(block.id), depth + 1);
          if (nested.trim() !== "") out.push(indent(nested));
        }
      }
      if (res?.has_more !== true) break;
      const next = asString(res.next_cursor);
      if (next === "") break;
      cursor = next;
    }
    return out.join("\n\n");
  }
}

/** Dedup + string-narrow an unknown array (the `unknown_block_ids` field). */
function uniqueStrings(value: unknown): string[] {
  const seen = new Set<string>();
  for (const item of asArray(value)) {
    const s = asString(item);
    if (s !== "") seen.add(s);
  }
  return [...seen];
}

/** Plain text of a block's `rich_text` array. */
function richText(value: unknown): string {
  return asArray(value)
    .map((rt) => asString(asRecord(rt)?.plain_text))
    .join("");
}

/** Render one block to markdown, or null when it carries no prose. */
function renderBlock(block: Record<string, unknown>): string | null {
  const type = asString(block.type);
  const data = asRecord(block[type]);
  if (data === null) return null;
  const text = richText(data.rich_text);
  switch (type) {
    case "paragraph":
      return text === "" ? null : text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked === true ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${text}`;
    case "code":
      return `\`\`\`${asString(data.language)}\n${text}\n\`\`\``;
    default:
      return text === "" ? null : text;
  }
}

/** Indent a nested block-walk render one list level. */
function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}
