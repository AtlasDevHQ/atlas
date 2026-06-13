/**
 * Tests for cursor pagination on MCP list operations (#3501).
 *
 * Unit: the opaque cursor codec + `paginate` slicing. End-to-end: a real
 * Client pages through tools / resources / prompts over the in-memory
 * transport with a tiny page size, asserting every item is reached across
 * pages, cursors are opaque, and the final page omits `nextCursor`.
 */

import { describe, expect, it } from "bun:test";
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
