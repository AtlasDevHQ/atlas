/**
 * Thin wrapper around `@modelcontextprotocol/sdk`'s `Client` +
 * `StreamableHTTPClientTransport` for the canonical-question MCP eval
 * harness (#2074).
 *
 * The eval drives every canonical question through the real MCP
 * Streamable-HTTP transport so a regression in tool dispatch, error
 * envelope shape, prompts/list format, or recovery contract is caught
 * before it ships. The wrapper exposes only the surface the harness
 * needs (connect / listTools / listPrompts / callTool / close) so test
 * files do not have to learn the SDK's full API.
 *
 * ── Auth (Phase 1) ─────────────────────────────────────────────────
 *
 * Phase 1 mocks `verifyAccessToken` at the module boundary in the test
 * file (matches `packages/mcp/src/__tests__/hosted.test.ts`) — the
 * bearer threaded into the `Authorization` header is opaque and the
 * route accepts it because the verifier is stubbed. This covers the
 * MCP **protocol** layer end-to-end (transport, dispatch, envelope,
 * prompts, recovery) but NOT the JWT signature path.
 *
 * Phase 2 (follow-up issue) replaces the mocked verifier with the real
 * DCR + PKCE flow against an in-process Better Auth instance + JWKS,
 * closing the JWT-signature gap.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface EvalMcpClientOptions {
  /** Base URL of the in-process MCP server, e.g. `http://localhost:54321`. */
  readonly baseUrl: string;
  /** Workspace id path segment — token's `workspace_id` claim must match. */
  readonly workspaceId: string;
  /** Opaque bearer threaded into `Authorization`. The route's verifier resolves it. */
  readonly bearer: string;
  /** Optional client metadata so server logs distinguish eval sessions from production probes. */
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface ToolListEntry {
  readonly name: string;
  readonly description?: string;
}

export interface PromptListEntry {
  readonly name: string;
  readonly description?: string;
}

/**
 * Open a session against the hosted MCP route, dispatch tool/prompt
 * calls, and close cleanly. The lifecycle mirrors `Client` exactly —
 * `connect` is required before any other call, `close` must run in a
 * `finally` so a failed dispatch never leaks a session past the test.
 */
export class EvalMcpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(opts: EvalMcpClientOptions) {
    const url = new URL(`${opts.baseUrl.replace(/\/+$/, "")}/mcp/${opts.workspaceId}/sse`);
    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${opts.bearer}` },
      },
    });
    this.client = new Client(
      {
        name: opts.clientName ?? "atlas-canonical-mcp-eval",
        version: opts.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<readonly ToolListEntry[]> {
    this.ensureConnected("listTools");
    const res = await this.client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  async listPrompts(): Promise<readonly PromptListEntry[]> {
    this.ensureConnected("listPrompts");
    // `prompts/list` may not be implemented if the server didn't register
    // any prompts. The SDK throws; surface it as an empty list so the
    // eval can still distinguish "no prompts" from "method missing".
    try {
      const res = await this.client.listPrompts();
      return res.prompts.map((p) => ({ name: p.name, description: p.description }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Method not found|prompts\/list/.test(message)) return [];
      throw err;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    this.ensureConnected("callTool");
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    return result;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    // Closing the SDK client also closes the transport — the redundant
    // transport.close() below catches the case where `client.close`
    // throws before reaching the transport tear-down.
    try {
      await this.client.close();
    } catch (err) {
      // intentionally ignored: best-effort teardown — surface only via
      // the transport close below if that also fails.
      void err;
    }
    await this.transport.close().catch(() => {
      // intentionally ignored: see above. Logging here would spam every
      // eval run with the duplicate-close path that's expected.
    });
  }

  private ensureConnected(op: string): void {
    if (!this.connected) {
      throw new Error(
        `EvalMcpClient.${op} called before connect(). Call connect() first.`,
      );
    }
  }
}

/**
 * MCP `tools/call` returns content as an array of items (text / image /
 * resource). The semantic-layer tools always return a single text item
 * containing JSON (success path) or the `AtlasMcpToolError` envelope
 * (failure path). Extract that JSON so callers compare structured data
 * instead of pattern-matching on prose.
 */
export function extractToolJson(
  result: CallToolResult,
): { kind: "ok"; data: unknown } | { kind: "error"; envelope: unknown } | { kind: "unparseable"; raw: string } {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (!text) return { kind: "unparseable", raw: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparseable", raw: text };
  }
  if (result.isError === true) return { kind: "error", envelope: parsed };
  return { kind: "ok", data: parsed };
}
