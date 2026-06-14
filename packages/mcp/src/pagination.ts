/**
 * Cursor pagination for MCP list operations (#3501, spec 2025-11-25).
 *
 * `tools/list`, `resources/list`, `resources/templates/list`, and
 * `prompts/list` listings shouldn't balloon as config tools + entities grow.
 * The high-level `McpServer` list handlers return the full set and ignore
 * `params.cursor`, so this wraps each registered handler: it calls the inner
 * handler for the full list, then returns one page + an opaque `nextCursor`
 * when more remain.
 *
 * Wrapping (rather than reimplementing) keeps the SDK as the single source of
 * the item shapes — tool input/output JSON schemas, resource templates,
 * prompt arguments — so pagination can't drift from registration. It also
 * means the custom `prompts/list` handler in `prompts/registry.ts` is paged
 * the same way without that file knowing about pagination.
 *
 * Cursors are opaque to clients (base64url of an internal offset). They are
 * NOT a stable contract — a client must only ever echo back the `nextCursor`
 * it received, never construct or interpret one.
 *
 * Forward-compat: the 2026-07-28 draft keeps cursor pagination, so this needs
 * no migration seam beyond the cursor codec living in one place.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Default page size. Deliberately generous — pagination exists to bound
 * worst-case growth, not to chunk today's small lists. No env knob: the
 * value is an internal detail, and cursors are opaque so it can change
 * without breaking clients.
 */
export const DEFAULT_PAGE_SIZE = 50;

const CURSOR_PREFIX = "o:";

/** Encode an internal offset as an opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor to its offset. `undefined` (first page) → 0. A
 * malformed cursor is a client error → `McpError(InvalidParams)`, matching
 * how the spec treats an invalid cursor.
 */
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "Invalid pagination cursor");
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid pagination cursor");
  }
  const offset = Number(decoded.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid pagination cursor");
  }
  return offset;
}

/** Slice `items` to the page at `cursor`, returning a `nextCursor` if more remain. */
export function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE,
): { page: T[]; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  return { page, ...(next < items.length ? { nextCursor: encodeCursor(next) } : {}) };
}

/** A request handler as stored in the SDK's internal handler map. */
type RawListHandler = (
  request: { params?: { cursor?: string } },
  extra: unknown,
) => Promise<Record<string, unknown>>;

/**
 * Read the handler the high-level server registered for `method`. Reaches
 * into the SDK's `_requestHandlers` map (no public accessor) via a narrowly
 * typed `unknown` cast — the {@link installListPagination} guard test asserts
 * each handler is found so an SDK upgrade that renames the map fails CI
 * loudly rather than silently dropping pagination.
 */
function captureHandler(server: McpServer, method: string): RawListHandler {
  const map = (
    server.server as unknown as {
      _requestHandlers: Map<string, RawListHandler>;
    }
  )._requestHandlers;
  const handler = map.get(method);
  if (!handler) {
    throw new Error(
      `installListPagination: no registered handler for "${method}" to wrap — register tools/resources/prompts first`,
    );
  }
  return handler;
}

const LIST_METHODS = [
  { schema: ListToolsRequestSchema, method: "tools/list", itemsKey: "tools" },
  { schema: ListResourcesRequestSchema, method: "resources/list", itemsKey: "resources" },
  {
    schema: ListResourceTemplatesRequestSchema,
    method: "resources/templates/list",
    itemsKey: "resourceTemplates",
  },
  { schema: ListPromptsRequestSchema, method: "prompts/list", itemsKey: "prompts" },
] as const;

/**
 * Short-lived full-list cache for paginated list operations (#3583).
 *
 * Problem: `installListPagination` calls the inner handler for the FULL list
 * on every page request (to get all items, then slices). For handlers with
 * costly side effects — notably `prompts/list`, which re-runs a gating DB
 * probe and emits an audit row on every call — this re-fires the side effects
 * on pages 2..N.
 *
 * Fix: on the first page (cursor === undefined) we call inner, cache the
 * `{ items, rest }` keyed by the `nextCursor` we are about to emit, and
 * keep it for `ttlMs`. On pages 2..N the cursor is a key into this cache
 * (the client must echo back the cursor we gave it), so we serve from the
 * cache without calling inner again. A cache miss (TTL expired, different
 * client) falls through to inner as a safe fallback — correctness is
 * preserved, the side-effect de-duplication only applies when the cache
 * is warm.
 */
interface CacheEntry {
  readonly items: unknown[];
  /** All fields from the inner result except `[itemsKey]` (forwarded verbatim). */
  readonly rest: Record<string, unknown>;
  readonly expiresAt: number;
}

/** TTL for the full-list cache (default 30s — generous for any human-paced client). */
const LIST_CACHE_TTL_MS = 30_000;

/**
 * Wrap every registered list handler with cursor pagination. Call once after
 * all tools/resources/prompts are registered (so the handlers exist).
 *
 * #3583 — the prompts/list handler (and any future handler with expensive
 * side effects) is shielded by a short-lived full-list cache: the inner
 * handler's gate probe + audit run exactly once per cursor sequence, not
 * once per page.
 */
export function installListPagination(
  server: McpServer,
  opts?: { pageSize?: number },
): void {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  for (const { schema, method, itemsKey } of LIST_METHODS) {
    const inner = captureHandler(server, method);
    // Per-method cache: nextCursor → CacheEntry. A Map is fine (one per
    // method, entries are evicted lazily on the next first-page request,
    // TTL keeps memory bounded — at most O(concurrent pagination sessions)).
    const cache = new Map<string, CacheEntry>();

    server.server.setRequestHandler(schema, async (request, extra) => {
      const cursor = request.params?.cursor;
      const now = Date.now();

      if (cursor !== undefined) {
        // Pages 2..N — look up in cache by the cursor the client echoed back.
        const cached = cache.get(cursor);
        if (cached && cached.expiresAt > now) {
          const { page, nextCursor } = paginate(cached.items, cursor, pageSize);
          // Propagate the cached entry to the NEXT cursor so page 3, 4, …
          // also hit the cache (not just page 2). Without this, page 3 would
          // miss — it echoes the cursor emitted by page 2, but that cursor
          // was computed during a cache-hit path that didn't populate the map.
          if (nextCursor !== undefined) {
            cache.set(nextCursor, { ...cached, expiresAt: cached.expiresAt });
          }
          return { ...cached.rest, [itemsKey]: page, ...(nextCursor ? { nextCursor } : {}) };
        }
        // Cache miss (TTL expired or unknown cursor) — fall through to inner.
        // The inner call re-runs the side effects, but correctness is preserved.
      }

      // First page (cursor === undefined) or cache miss — call inner.
      // Evict stale entries lazily so the map doesn't accumulate indefinitely
      // when many clients start pagination sequences but never finish.
      for (const [k, v] of cache) {
        if (v.expiresAt <= now) cache.delete(k);
      }

      const full = await inner(request, extra);
      const items = Array.isArray(full[itemsKey]) ? (full[itemsKey] as unknown[]) : [];
      const rest: Record<string, unknown> = { ...full };
      delete rest[itemsKey];

      const { page, nextCursor } = paginate(items, cursor, pageSize);

      // Cache the full list keyed by the nextCursor we are about to emit.
      // Pages 2..N will look this up by the cursor the client echoes back.
      // Only cache when there IS a nextCursor (single-page results don't need
      // caching — the client has the whole list already).
      if (nextCursor !== undefined) {
        cache.set(nextCursor, { items, rest, expiresAt: now + LIST_CACHE_TTL_MS });
      }

      return { ...rest, [itemsKey]: page, ...(nextCursor ? { nextCursor } : {}) };
    });
  }
}
