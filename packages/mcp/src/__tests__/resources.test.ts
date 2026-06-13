import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerResources, semanticFileToResourceUri } from "../resources.js";

// We test against the actual semantic/ directory in the repo root.
// The test assumes cwd is the repo root (which bun test uses by default).
const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

/** Extract text from the first resource content entry. */
function getText(contents: Array<Record<string, unknown>>): string {
  const first = contents[0];
  return (first as { text?: string }).text ?? "";
}

async function createTestClient() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const handle = registerResources(server);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, handle };
}

describe("MCP resources", () => {
  // Check if the semantic directory exists (tests may run in CI without it)
  const hasSemanticDir = fs.existsSync(SEMANTIC_ROOT);

  it("lists static resources (catalog and glossary)", async () => {
    const { client } = await createTestClient();
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("atlas://semantic/catalog");
    expect(uris).toContain("atlas://semantic/glossary");
  });

  it("lists entity resource templates", async () => {
    const { client } = await createTestClient();
    const result = await client.listResourceTemplates();
    const uriTemplates = result.resourceTemplates.map((t) => t.uriTemplate);
    expect(uriTemplates).toContain("atlas://semantic/entities/{name}");
    expect(uriTemplates).toContain("atlas://semantic/metrics/{name}");
  });

  if (hasSemanticDir && fs.existsSync(path.join(SEMANTIC_ROOT, "catalog.yml"))) {
    it("reads catalog.yml resource", async () => {
      const { client } = await createTestClient();
      const result = await client.readResource({
        uri: "atlas://semantic/catalog",
      });
      expect(result.contents.length).toBe(1);
      expect(result.contents[0].mimeType).toBe("text/yaml");
      expect(getText(result.contents as Array<Record<string, unknown>>)).toBeTruthy();
    });
  }

  it("returns not-found for missing entity", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "atlas://semantic/entities/nonexistent_table_xyz",
    });
    expect(getText(result.contents as Array<Record<string, unknown>>)).toContain("not found");
  });

  it("returns not-found for missing metric", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "atlas://semantic/metrics/nonexistent_metric_xyz",
    });
    expect(getText(result.contents as Array<Record<string, unknown>>)).toContain("not found");
  });

  it("rejects path traversal in entity name", async () => {
    const { client } = await createTestClient();
    // The MCP SDK resolves ../.. in URIs before matching against templates.
    // atlas://semantic/entities/../../etc/passwd → atlas://semantic/etc/passwd
    // which doesn't match the entities/{name} template, so the SDK throws.
    await expect(
      client.readResource({
        uri: "atlas://semantic/entities/../../etc/passwd",
      }),
    ).rejects.toThrow();
  });

  it("rejects path traversal in metric name", async () => {
    const { client } = await createTestClient();
    await expect(
      client.readResource({
        uri: "atlas://semantic/metrics/../../../etc/passwd",
      }),
    ).rejects.toThrow();
  });

  it("rejects entity name containing slash via inline guard", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "atlas://semantic/entities/foo%2Fbar",
    });
    const text = getText(result.contents as Array<Record<string, unknown>>);
    expect(text).toMatch(/Invalid entity name|not found/);
  });

  it("rejects entity name containing .. via inline guard", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "atlas://semantic/entities/foo%2E%2Ebar",
    });
    const text = getText(result.contents as Array<Record<string, unknown>>);
    expect(text).toMatch(/Invalid entity name|not found/);
  });

  it("rejects metric name containing slash via inline guard", async () => {
    const { client } = await createTestClient();
    const result = await client.readResource({
      uri: "atlas://semantic/metrics/foo%2Fbar",
    });
    const text = getText(result.contents as Array<Record<string, unknown>>);
    expect(text).toMatch(/Invalid metric name|not found/);
  });
});

describe("semanticFileToResourceUri (#3502)", () => {
  it("maps semantic files to their resource URIs", () => {
    expect(semanticFileToResourceUri("catalog.yml")).toBe("atlas://semantic/catalog");
    expect(semanticFileToResourceUri("glossary.yml")).toBe("atlas://semantic/glossary");
    expect(semanticFileToResourceUri("entities/orders.yml")).toBe(
      "atlas://semantic/entities/orders",
    );
    expect(semanticFileToResourceUri("metrics/revenue.yml")).toBe(
      "atlas://semantic/metrics/revenue",
    );
  });

  it("returns null for non-resource files", () => {
    expect(semanticFileToResourceUri("README.md")).toBeNull();
    expect(semanticFileToResourceUri("entities/nested/deep.yml")).toBeNull();
    expect(semanticFileToResourceUri("metrics/foo.txt")).toBeNull();
  });
});

describe("resource subscriptions (#3502)", () => {
  /** Resolve once the client receives an `updated` for `uri` (or reject on timeout). */
  function waitForUpdate(client: Client, uri: string, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for update")), timeoutMs);
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        if (n.params.uri === uri) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  it("advertises the resources.subscribe capability", async () => {
    const { client } = await createTestClient();
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it("delivers notifications/resources/updated to a subscriber", async () => {
    const { client, handle } = await createTestClient();
    const uri = "atlas://semantic/entities/orders";
    const updated = waitForUpdate(client, uri);
    await client.subscribeResource({ uri });
    expect(handle.subscriptionCount()).toBe(1);

    // Simulate a semantic-layer change through the seam (what a regeneration
    // / the fs watcher calls).
    await handle.notifyResourceUpdated(uri);
    await updated; // resolves only if the notification arrived
  });

  it("stops delivering after unsubscribe", async () => {
    const { client, handle } = await createTestClient();
    const uri = "atlas://semantic/entities/orders";
    await client.subscribeResource({ uri });
    await client.unsubscribeResource({ uri });
    expect(handle.subscriptionCount()).toBe(0);

    let received = false;
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
      received = true;
    });
    await handle.notifyResourceUpdated(uri); // no-op: not subscribed
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);
  });
});

describe("lazy semantic root (#3502)", () => {
  it("resolves the semantic root per read, honoring ATLAS_SEMANTIC_ROOT set after import", async () => {
    const original = process.env.ATLAS_SEMANTIC_ROOT;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sem-"));
    try {
      fs.writeFileSync(path.join(tmp, "catalog.yml"), "lazy-root-marker: true\n");
      process.env.ATLAS_SEMANTIC_ROOT = tmp;
      const { client } = await createTestClient();
      const result = await client.readResource({ uri: "atlas://semantic/catalog" });
      const text = getText(result.contents as Array<Record<string, unknown>>);
      // Proves the root was read at request time (from the env set above),
      // not captured at module-load time.
      expect(text).toContain("lazy-root-marker");
    } finally {
      if (original === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
      else process.env.ATLAS_SEMANTIC_ROOT = original;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
