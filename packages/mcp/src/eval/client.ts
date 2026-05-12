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
 * Phase 2 (#2119) replaces the mocked verifier with the real DCR + PKCE
 * flow against an in-process Better Auth instance + JWKS, closing the
 * JWT-signature gap.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Drop trailing `/` characters. Non-regex to keep the polynomial-ReDoS checker happy. */
function stripTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s[i - 1] === "/") i--;
  return i === s.length ? s : s.slice(0, i);
}

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
  /**
   * JSON Schema for the tool's input. Surfaced verbatim from the MCP
   * `tools/list` response so callers binding these tools as Vercel AI
   * SDK `tool({ inputSchema: jsonSchema(...) })` definitions (the
   * `--mcp-llm` eval mode in #2119) get the exact shape the server
   * advertises. Keep optional in case a tool registers without one;
   * `jsonSchema({})` accepts an empty object.
   */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
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
    const url = new URL(`${stripTrailingSlashes(opts.baseUrl)}/mcp/${opts.workspaceId}/sse`);
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
    // Server-initiated close (session cap, server shutdown, route 503)
    // would otherwise leave `connected = true` with a dead transport.
    // The next `callTool` would reject from inside the SDK rather than
    // tripping `ensureConnected` — losing the typed precondition error.
    // Listening here flips the flag so callers see the right surface.
    this.transport.onclose = () => {
      this.connected = false;
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<readonly ToolListEntry[]> {
    this.ensureConnected("listTools");
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      // The SDK types `inputSchema` as `unknown`; pass it through as a
      // readonly record so callers can hand it to AI SDK's `jsonSchema()`
      // helper without re-asserting. A missing schema (older SDK build /
      // mis-registered tool) surfaces as `undefined` rather than `{}` so
      // the LLM-mode binder can pick a sensible fallback.
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Readonly<Record<string, unknown>>)
          : undefined,
    }));
  }

  async listPrompts(): Promise<readonly PromptListEntry[]> {
    this.ensureConnected("listPrompts");
    // `prompts/list` may not be implemented if the server didn't register
    // any prompts. The MCP SDK surfaces "method not found" as JSON-RPC
    // error code -32601 — narrow on the code, not on a string match. A
    // server-side 500 whose body happens to mention `prompts/list` is a
    // real bug and must propagate, not be silently coerced to `[]`.
    try {
      const res = await this.client.listPrompts();
      return res.prompts.map((p) => ({ name: p.name, description: p.description }));
    } catch (err) {
      if (isMethodNotFoundError(err)) return [];
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
    // The SDK's `client.close()` already closes the underlying transport,
    // so the explicit `transport.close()` below is the duplicate-close
    // path. We log a debug line on `client.close` failure so genuine
    // teardown bugs (malformed-response handlers, abort-controller leaks)
    // leave a trail; the transport double-close is matched against a
    // narrow signature so EPIPE / socket teardown failures still surface.
    try {
      await this.client.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp-eval] client.close threw: ${message}\n`);
    }
    try {
      await this.transport.close();
    } catch (err) {
      if (!isAlreadyClosedError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[mcp-eval] transport.close threw (not idempotent close): ${message}\n`,
        );
      }
    }
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
 * Shape of the typed error envelope emitted by the MCP semantic tools
 * (`AtlasMcpToolError`). The error arm of {@link ExtractedToolJson}
 * carries one of these — exposed as a named type so consumers (the
 * `--mcp-llm` grader, the deterministic eval) don't each re-narrow
 * `unknown` with `as { code?: unknown }` casts at every read site.
 *
 * Fields are optional because we don't trust upstream invariants at
 * the boundary: a malformed envelope should still be a well-typed
 * value the consumer can reason about.
 */
export interface ToolErrorEnvelope {
  readonly code?: string;
  readonly hint?: string;
  readonly possible_mappings?: readonly string[];
  /** Pass-through for envelope fields the consumer doesn't pin (e.g. `details`). */
  readonly [key: string]: unknown;
}

/**
 * Discriminated return type of {@link extractToolJson}. Promoted to a
 * named export so consumers (notably the `--mcp-llm` recorder type
 * `RecordedToolCall.result`) reference the shape by name rather than
 * structurally duplicating it. A future fourth arm added here surfaces
 * as a TS error in every consumer's switch / branch — not a silent
 * fall-through.
 */
export type ExtractedToolJson =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "error"; readonly envelope: ToolErrorEnvelope }
  | { readonly kind: "unparseable"; readonly raw: string };

/**
 * MCP `tools/call` returns content as an array of items (text / image /
 * resource). The semantic-layer tools always return a single text item
 * containing JSON (success path) or the `AtlasMcpToolError` envelope
 * (failure path). Extract that JSON so callers compare structured data
 * instead of pattern-matching on prose.
 */
export function extractToolJson(result: CallToolResult): ExtractedToolJson {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (!text) return { kind: "unparseable", raw: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // intentionally ignored: malformed JSON is a category of result, not
    // an error. The eval branches on `kind` and reports `unparseable` as
    // a `protocol` regression artifact rather than throwing.
    return { kind: "unparseable", raw: text };
  }
  if (result.isError === true) {
    // Boundary narrow: the MCP server may emit a primitive error body
    // (string / number) rather than an object. Wrap any non-object
    // payload as `{ code: "<stringified>" }` so the typed envelope
    // contract holds — consumers can trust `envelope.code` is at least
    // a string when present.
    const envelope: ToolErrorEnvelope =
      parsed && typeof parsed === "object"
        ? (parsed as ToolErrorEnvelope)
        : { code: String(parsed) };
    return { kind: "error", envelope };
  }
  return { kind: "ok", data: parsed };
}

// ── Internal error classifiers ────────────────────────────────────────

/**
 * JSON-RPC `Method not found` is error code `-32601` (per the JSON-RPC
 * 2.0 spec, mirrored by MCP). The SDK exposes the code on the rejection
 * payload; fall back to a tightly-anchored prose check for older SDK
 * builds that don't set `.code`. Anything else is a real failure and
 * must propagate — a 500 whose body happens to mention `prompts/list`
 * is exactly the regression class this eval exists to catch.
 */
function isMethodNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown };
    if (e.code === -32601) return true;
  }
  if (err instanceof Error) {
    return /^Method not found\b/.test(err.message);
  }
  return false;
}

/**
 * Detect the harmless duplicate-close case: `Client.close()` already
 * tears the transport down, so a follow-on `transport.close()` may hit
 * an "already closed" guard. We accept those quietly. Anything else
 * (EPIPE, socket-leak signatures, generic TypeError from a mis-wired
 * transport) propagates as a stderr line so test cleanup regressions
 * are visible.
 */
function isAlreadyClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /already (closed|disposed)|transport.* (closed|terminated)/i.test(
    err.message,
  );
}
