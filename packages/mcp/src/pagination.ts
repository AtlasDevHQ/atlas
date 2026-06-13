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
 * Wrap every registered list handler with cursor pagination. Call once after
 * all tools/resources/prompts are registered (so the handlers exist).
 */
export function installListPagination(
  server: McpServer,
  opts?: { pageSize?: number },
): void {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  for (const { schema, method, itemsKey } of LIST_METHODS) {
    const inner = captureHandler(server, method);
    server.server.setRequestHandler(schema, async (request, extra) => {
      const full = await inner(request, extra);
      const items = Array.isArray(full[itemsKey]) ? (full[itemsKey] as unknown[]) : [];
      const { page, nextCursor } = paginate(items, request.params?.cursor, pageSize);
      return { ...full, [itemsKey]: page, ...(nextCursor ? { nextCursor } : {}) };
    });
  }
}
