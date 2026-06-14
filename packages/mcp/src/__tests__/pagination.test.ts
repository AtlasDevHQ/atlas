/**
 * Tests for cursor pagination on MCP list operations (#3501).
 *
 * Unit: the opaque cursor codec + `paginate` slicing. End-to-end: a real
 * Client pages through tools / resources / prompts over the in-memory
 * transport with a tiny page size, asserting every item is reached across
 * pages, cursors are opaque, and the final page omits `nextCursor`.
 */

import { describe, expect, it, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  encodeCursor,
  decodeCursor,
  paginate,
  installListPagination,
} from "../pagination.js";

describe("cursor codec", () => {
  it("round-trips an offset", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  it("treats an absent cursor as offset 0", () => {
    expect(decodeCursor(undefined)).toBe(0);
  });

  it("rejects a malformed cursor with InvalidParams", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(McpError);
    // A base64 payload that doesn't match the internal shape is still rejected.
    expect(() => decodeCursor(Buffer.from("garbage").toString("base64url"))).toThrow(McpError);
  });

  it("does not expose the offset as a plain number (opaque)", () => {
    expect(encodeCursor(5)).not.toBe("5");
    expect(encodeCursor(5)).not.toContain("o:");
  });
});

describe("paginate", () => {
  it("returns one page + nextCursor when more remain", () => {
    const { page, nextCursor } = paginate([1, 2, 3, 4, 5], undefined, 2);
    expect(page).toEqual([1, 2]);
    expect(nextCursor).toBeDefined();
    expect(decodeCursor(nextCursor)).toBe(2);
  });

  it("omits nextCursor on the final page", () => {
    const { page, nextCursor } = paginate([1, 2, 3], encodeCursor(2), 2);
    expect(page).toEqual([3]);
    expect(nextCursor).toBeUndefined();
  });
});

/** Drain a paginated list, returning every item name across pages + the page count. */
async function drainTools(client: Client) {
  const names: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await client.listTools(cursor ? { cursor } : {});
    names.push(...r.tools.map((t) => t.name));
    cursor = r.nextCursor;
    pages++;
  } while (cursor && pages < 50);
  return { names, pages };
}

describe("installListPagination end-to-end", () => {
  async function wire(pageSize: number) {
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    for (const n of ["t1", "t2", "t3", "t4", "t5"]) {
      server.registerTool(n, { description: n, inputSchema: {} }, async () => ({
        content: [{ type: "text", text: n }],
      }));
    }
    for (const n of ["r1", "r2", "r3"]) {
      server.registerResource(
        n,
        `atlas://test/${n}`,
        { description: n },
        async (uri) => ({ contents: [{ uri: uri.href, text: n }] }),
      );
    }
    for (const n of ["p1", "p2", "p3", "p4"]) {
      server.registerPrompt(n, { description: n }, () => ({
        messages: [{ role: "user", content: { type: "text", text: n } }],
      }));
    }

    installListPagination(server, { pageSize });

    const client = new Client({ name: "c", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    return client;
  }

  it("pages tools end to end", async () => {
    const client = await wire(2);
    const { names, pages } = await drainTools(client);
    expect(names.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  it("pages resources and omits nextCursor on the last page", async () => {
    const client = await wire(2);
    const first = await client.listResources();
    expect(first.resources).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await client.listResources({ cursor: first.nextCursor });
    expect(second.resources).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it("pages prompts end to end", async () => {
    const client = await wire(3);
    const first = await client.listPrompts();
    expect(first.prompts).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    const second = await client.listPrompts({ cursor: first.nextCursor });
    expect(second.prompts).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it("returns the whole list in one page when it fits", async () => {
    const client = await wire(100);
    const { names, pages } = await drainTools(client);
    expect(names).toHaveLength(5);
    expect(pages).toBe(1);
  });
});

describe("pagination full-list cache — inner handler not re-called on pages 2..N (#3583)", () => {
  // Regression for #3583: `installListPagination` called the inner handler
  // (which for `prompts/list` re-runs a gating DB probe + emits an audit row)
  // on EVERY page request. The fix caches the full list keyed by the
  // `nextCursor` emitted on the first page so pages 2..N serve from cache
  // without invoking the inner handler again.

  async function wireWithSpy(pageSize: number) {
    const server = new McpServer(
      { name: "test", version: "0.0.1" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    // Register at least one tool and resource so installListPagination can
    // wrap all 4 list methods (tools/list, resources/list,
    // resources/templates/list, prompts/list).
    server.registerTool("t1", { description: "t1", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "t1" }],
    }));
    server.registerResource(
      "r1",
      "atlas://test/r1",
      { description: "r1" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "r1" }] }),
    );

    // Register 5 prompts so pagination produces at least 3 pages at pageSize=2.
    for (const n of ["p1", "p2", "p3", "p4", "p5"]) {
      server.registerPrompt(n, { description: n }, () => ({
        messages: [{ role: "user", content: { type: "text", text: n } }],
      }));
    }

    // Replace the SDK handler with a spy that counts invocations, to verify
    // the cache prevents extra inner calls on pages 2+.
    const map = (
      server.server as unknown as { _requestHandlers: Map<string, unknown> }
    )._requestHandlers;
    const sdkHandler = map.get("prompts/list");
    let handlerCallCount = 0;
    // Wrap the SDK handler so we can count calls while still serving real data.
    const spyHandler = mock(async (...args: unknown[]) => {
      handlerCallCount++;
      // @ts-expect-error — calling the captured SDK handler directly
      return sdkHandler!(...args);
    });
    map.set("prompts/list", spyHandler as unknown as (typeof map extends Map<string, infer V> ? V : never));

    installListPagination(server, { pageSize });

    const client = new Client({ name: "spy-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    return { client, getCallCount: () => handlerCallCount };
  }

  it("inner handler is invoked exactly once across a 3-page prompts/list sequence (#3583)", async () => {
    const { client, getCallCount } = await wireWithSpy(2);

    // Page 1 — first page, inner handler must be called once.
    const p1 = await client.listPrompts();
    expect(p1.prompts).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    expect(getCallCount()).toBe(1);

    // Page 2 — should come from cache; inner handler must NOT be called again.
    const p2 = await client.listPrompts({ cursor: p1.nextCursor });
    expect(p2.prompts).toHaveLength(2);
    expect(p2.nextCursor).toBeDefined();
    expect(getCallCount()).toBe(1); // still 1 — cache hit

    // Page 3 — last page, also from cache.
    const p3 = await client.listPrompts({ cursor: p2.nextCursor });
    expect(p3.prompts).toHaveLength(1);
    expect(p3.nextCursor).toBeUndefined();
    expect(getCallCount()).toBe(1); // still 1 — cache hit

    // All 5 prompts are returned across the 3 pages.
    const allNames = [
      ...p1.prompts.map((p) => p.name),
      ...p2.prompts.map((p) => p.name),
      ...p3.prompts.map((p) => p.name),
    ].sort();
    expect(allNames).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("a fresh first-page request (no cursor) always calls the inner handler (#3583)", async () => {
    // A new pagination sequence (cursor=undefined) must always invoke inner
    // so the full list is refreshed. Only pages 2..N serve from cache.
    const { client, getCallCount } = await wireWithSpy(2);

    // Two independent first-page requests — each must call inner once.
    await client.listPrompts();
    await client.listPrompts();
    expect(getCallCount()).toBe(2);
  });
});
