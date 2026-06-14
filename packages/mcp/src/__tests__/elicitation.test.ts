/**
 * Tests for the elicitation adapter seam (#3499).
 *
 * Two halves:
 *   1. The server-held `requestState` security primitive — HMAC tamper-
 *      evidence, principal binding, TTL, and single-use anti-replay.
 *   2. A masked-field elicitation round-trip over the in-memory Client/Server
 *      transport, asserting the entered value reaches the server WITHOUT
 *      entering the agent/LLM context (it never appears in the tool result).
 */

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  signRequestState,
  verifyRequestState,
  elicitMaskedField,
  elicitMaskedForm,
  NonceStore,
  ElicitationError,
  DEFAULT_REQUEST_STATE_TTL_MS,
} from "../elicitation.js";

const SECRET = "test-elicitation-secret";
const PRINCIPAL = "org_test";

describe("requestState", () => {
  it("round-trips a freshly signed state", () => {
    const token = signRequestState({ principal: PRINCIPAL, purpose: "elicit:apiKey" }, SECRET);
    const result = verifyRequestState(token, { principal: PRINCIPAL, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.principal).toBe(PRINCIPAL);
      expect(result.payload.purpose).toBe("elicit:apiKey");
    }
  });

  it("rejects a tampered body (bad signature)", () => {
    const token = signRequestState({ principal: PRINCIPAL, purpose: "p" }, SECRET);
    const [v, , sig] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, principal: "attacker", purpose: "p", nonce: "x", iat: 0, exp: 9e15 }),
    ).toString("base64url");
    const forged = `${v}.${forgedBody}.${sig}`;
    expect(verifyRequestState(forged, { principal: "attacker", secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a state minted for a different principal", () => {
    const token = signRequestState({ principal: "org_a", purpose: "p" }, SECRET);
    expect(verifyRequestState(token, { principal: "org_b", secret: SECRET })).toEqual({
      ok: false,
      reason: "principal_mismatch",
    });
  });

  it("rejects an expired state", () => {
    const token = signRequestState(
      { principal: PRINCIPAL, purpose: "p", now: 1_000, ttlMs: 100 },
      SECRET,
    );
    expect(
      verifyRequestState(token, { principal: PRINCIPAL, secret: SECRET, now: 2_000 }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a wrong-secret signature", () => {
    const token = signRequestState({ principal: PRINCIPAL, purpose: "p" }, SECRET);
    expect(
      verifyRequestState(token, { principal: PRINCIPAL, secret: "other-secret" }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a malformed token", () => {
    expect(verifyRequestState("not-a-token", { principal: PRINCIPAL, secret: SECRET })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("enforces single-use (anti-replay) against a NonceStore", () => {
    const store = new NonceStore();
    const token = signRequestState({ principal: PRINCIPAL, purpose: "p" }, SECRET);
    const first = verifyRequestState(token, { principal: PRINCIPAL, secret: SECRET, nonceStore: store });
    const second = verifyRequestState(token, { principal: PRINCIPAL, secret: SECRET, nonceStore: store });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "replayed" });
  });

  it("uses the documented default TTL", () => {
    const token = signRequestState({ principal: PRINCIPAL, purpose: "p", now: 0 }, SECRET);
    const result = verifyRequestState(token, { principal: PRINCIPAL, secret: SECRET, now: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.exp).toBe(DEFAULT_REQUEST_STATE_TTL_MS);
  });
});

/**
 * Wire an in-memory client whose elicitation handler returns `reply`, plus a
 * server exposing one test tool that elicits a masked field and stashes the
 * value server-side. Returns the client + the server-side capture closure.
 */
async function wireElicitation(reply: {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string>;
}) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const captured: { value?: string; outcome?: string; error?: string } = {};

  server.registerTool(
    "needsSecret",
    { description: "Elicits a masked secret", inputSchema: {} },
    async (): Promise<CallToolResult> => {
      try {
        const outcome = await elicitMaskedField(server, {
          principal: PRINCIPAL,
          message: "Enter your API key",
          field: { name: "apiKey", title: "API key", description: "never shared with the agent" },
          secret: SECRET,
          nonceStore: new NonceStore(),
        });
        captured.outcome = outcome.action;
        if (outcome.action === "accept") captured.value = outcome.value;
        // Deliberately DO NOT put the secret in the result — it must never
        // re-enter the agent/LLM context.
        return { content: [{ type: "text", text: `done:${outcome.action}` }] };
      } catch (err) {
        captured.error = err instanceof ElicitationError ? err.code : String(err);
        return { content: [{ type: "text", text: "error" }], isError: true };
      }
    },
  );

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => reply);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, captured };
}

describe("elicitMaskedField round-trip", () => {
  it("delivers the entered value to the server without it entering the tool result", async () => {
    const { client, captured } = await wireElicitation({
      action: "accept",
      content: { apiKey: "sk-super-secret" },
    });

    const result = await client.callTool({ name: "needsSecret", arguments: {} });

    // Server received the value out of band.
    expect(captured.outcome).toBe("accept");
    expect(captured.value).toBe("sk-super-secret");

    // The secret NEVER appears in the agent-visible tool result.
    expect(JSON.stringify(result.content)).not.toContain("sk-super-secret");
    expect(result.isError).toBeFalsy();
  });

  it("surfaces a decline without a value", async () => {
    const { client, captured } = await wireElicitation({ action: "decline" });
    await client.callTool({ name: "needsSecret", arguments: {} });
    expect(captured.outcome).toBe("decline");
    expect(captured.value).toBeUndefined();
  });

  it("treats an accept with an empty field as an empty_value error", async () => {
    const { client, captured } = await wireElicitation({
      action: "accept",
      content: { apiKey: "" },
    });
    await client.callTool({ name: "needsSecret", arguments: {} });
    expect(captured.error).toBe("empty_value");
  });
});

async function wireFormElicitation(reply: {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string>;
}) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const captured: { values?: Record<string, string>; outcome?: string } = {};

  server.registerTool(
    "needsForm",
    { description: "Elicits a multi-field credential form", inputSchema: {} },
    async (): Promise<CallToolResult> => {
      const outcome = await elicitMaskedForm(server, {
        principal: PRINCIPAL,
        message: "Enter the connection details",
        fields: [
          { name: "url", title: "URL", required: true },
          { name: "apiKey", title: "API key", required: false, secret: true },
        ],
        secret: SECRET,
        nonceStore: new NonceStore(),
      });
      captured.outcome = outcome.action;
      if (outcome.action === "accept") captured.values = outcome.values;
      // The values must NEVER re-enter the agent/LLM context.
      return { content: [{ type: "text", text: `done:${outcome.action}` }] };
    },
  );

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => reply);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, captured };
}

describe("elicitMaskedForm round-trip", () => {
  it("delivers every entered field to the server without any entering the tool result", async () => {
    const { client, captured } = await wireFormElicitation({
      action: "accept",
      content: { url: "elasticsearch://h:9200", apiKey: "BASE64KEY==" },
    });
    const result = await client.callTool({ name: "needsForm", arguments: {} });
    expect(captured.outcome).toBe("accept");
    expect(captured.values).toEqual({ url: "elasticsearch://h:9200", apiKey: "BASE64KEY==" });
    // No secret in the agent-visible result.
    expect(JSON.stringify(result.content)).not.toContain("BASE64KEY");
  });

  it("omits empty/unprovided optional fields rather than persisting an empty value", async () => {
    const { captured, client } = await wireFormElicitation({
      action: "accept",
      content: { url: "elasticsearch://h:9200", apiKey: "" },
    });
    await client.callTool({ name: "needsForm", arguments: {} });
    expect(captured.values).toEqual({ url: "elasticsearch://h:9200" });
    expect(captured.values).not.toHaveProperty("apiKey");
  });

  it("drops a whitespace-only field rather than persisting it as a present-but-blank value", async () => {
    // A non-compliant client could `accept` with a required field set to only
    // whitespace; that must be dropped (so the caller's presence check rejects
    // it) instead of flowing into the config as a blank credential.
    const { captured, client } = await wireFormElicitation({
      action: "accept",
      content: { url: "   ", apiKey: "BASE64KEY==" },
    });
    await client.callTool({ name: "needsForm", arguments: {} });
    expect(captured.values).toEqual({ apiKey: "BASE64KEY==" });
    expect(captured.values).not.toHaveProperty("url");
  });

  it("preserves a value with significant internal whitespace (only the emptiness test trims)", async () => {
    const { captured, client } = await wireFormElicitation({
      action: "accept",
      content: { url: "elasticsearch://h:9200", apiKey: "key with spaces" },
    });
    await client.callTool({ name: "needsForm", arguments: {} });
    expect(captured.values).toEqual({ url: "elasticsearch://h:9200", apiKey: "key with spaces" });
  });

  it("surfaces a decline with no values", async () => {
    const { captured, client } = await wireFormElicitation({ action: "decline" });
    await client.callTool({ name: "needsForm", arguments: {} });
    expect(captured.outcome).toBe("decline");
    expect(captured.values).toBeUndefined();
  });
});
