/**
 * Unit tests for the knowledge ingest core (#4207) — the upsert-by-path +
 * review-gate rules (create-as-draft, demote-changed-published, update-draft,
 * resurrect-archived, leave-unchanged) and the link-graph rewrite.
 *
 * Uses an in-memory fake `IngestClient` that emulates `knowledge_documents` +
 * `knowledge_links` by dispatching on the SQL text, so the real ingest logic
 * runs end-to-end without a database.
 */

import { describe, expect, it } from "bun:test";
import {
  ingestBundleIntoCollection,
  docChanged,
  type IngestClient,
} from "@atlas/api/lib/knowledge/ingest";
import type { LenientDoc } from "@atlas/api/lib/knowledge/parse-lenient";

interface StoredDoc {
  id: string;
  status: string;
  body: string;
  type: string | null;
  title: string | null;
  description: string | null;
  resource: string | null;
  tags: unknown;
  timestamp: string | null;
}

/** Build a fake transactional client over in-memory doc + link stores. */
function makeFakeClient(seed: Record<string, StoredDoc> = {}) {
  const docs = new Map<string, StoredDoc>(Object.entries(seed));
  const byId = new Map<string, string>(); // id → path
  for (const [path, d] of docs) byId.set(d.id, path);
  const links: { source: string; target: string; anchor: string | null }[] = [];
  let nextId = 1;

  const client: IngestClient = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      if (sql.includes("SELECT id, status, body") && sql.includes("FROM knowledge_documents")) {
        const path = params[2] as string;
        const existing = docs.get(path);
        return { rows: (existing ? [existing] : []) as T[] };
      }
      if (sql.startsWith("INSERT INTO knowledge_documents") || sql.includes("INSERT INTO knowledge_documents")) {
        const [, , path, type, title, description, tagsJson, timestamp, resource, body] =
          params as [string, string, string, string, string, string | null, string, string | null, string | null, string];
        const id = `doc-${nextId++}`;
        docs.set(path, {
          id,
          status: "draft",
          body,
          type,
          title,
          description,
          resource,
          tags: JSON.parse(tagsJson),
          timestamp,
        });
        byId.set(id, path);
        return { rows: [{ id }] as T[] };
      }
      if (sql.includes("UPDATE knowledge_documents")) {
        const [id, type, title, description, tagsJson, timestamp, resource, body] = params as [
          string, string, string, string | null, string, string | null, string | null, string,
        ];
        const path = byId.get(id);
        if (path) {
          const d = docs.get(path)!;
          docs.set(path, {
            ...d,
            status: "draft",
            type,
            title,
            description,
            resource,
            tags: JSON.parse(tagsJson),
            timestamp,
            body,
          });
        }
        return { rows: [] as T[] };
      }
      if (sql.includes("DELETE FROM knowledge_links")) {
        const src = params[0] as string;
        for (let i = links.length - 1; i >= 0; i--) if (links[i].source === src) links.splice(i, 1);
        return { rows: [] as T[] };
      }
      if (sql.includes("INSERT INTO knowledge_links")) {
        const [source, target, anchor] = params as [string, string, string | null];
        links.push({ source, target, anchor });
        return { rows: [] as T[] };
      }
      throw new Error(`unexpected SQL in fake client: ${sql.slice(0, 60)}`);
    },
  };

  return { client, docs, links };
}

function makeDoc(overrides: Partial<LenientDoc> & { path: string }): LenientDoc {
  return {
    type: "Document",
    title: "T",
    description: null,
    resource: null,
    tags: [],
    timestamp: null,
    body: "body",
    links: [],
    ...overrides,
  };
}

function storedFrom(doc: LenientDoc, id: string, status: string): StoredDoc {
  return {
    id,
    status,
    body: doc.body,
    type: doc.type,
    title: doc.title,
    description: doc.description,
    resource: doc.resource,
    tags: doc.tags,
    timestamp: doc.timestamp,
  };
}

const BASE = { workspaceId: "org-1", collectionId: "runbooks", source: "upload" as const };

describe("ingestBundleIntoCollection — upsert lifecycle", () => {
  it("inserts a new path as draft and writes its links", async () => {
    const { client, docs, links } = makeFakeClient();
    const doc = makeDoc({
      path: "a.md",
      links: [{ targetPath: "b.md", anchorText: "B" }],
    });
    const report = await ingestBundleIntoCollection({ ...BASE, client, docs: [doc] });
    expect(report).toMatchObject({ created: 1, unchanged: 0, documents: 1, linksWritten: 1 });
    expect(docs.get("a.md")?.status).toBe("draft");
    expect(links).toHaveLength(1);
  });

  it("leaves an unchanged published document published (no write, no demote)", async () => {
    const doc = makeDoc({ path: "a.md", body: "same" });
    const { client, docs } = makeFakeClient({ "a.md": storedFrom(doc, "doc-1", "published") });
    const report = await ingestBundleIntoCollection({ ...BASE, client, docs: [doc] });
    expect(report).toMatchObject({ unchanged: 1, demoted: 0, created: 0 });
    expect(docs.get("a.md")?.status).toBe("published");
  });

  it("demotes a changed published document back to draft", async () => {
    const published = makeDoc({ path: "a.md", body: "old" });
    const { client, docs } = makeFakeClient({ "a.md": storedFrom(published, "doc-1", "published") });
    const changed = makeDoc({ path: "a.md", body: "NEW", links: [{ targetPath: "b.md", anchorText: null }] });
    const report = await ingestBundleIntoCollection({ ...BASE, client, docs: [changed] });
    expect(report).toMatchObject({ demoted: 1, created: 0, unchanged: 0 });
    expect(docs.get("a.md")).toMatchObject({ status: "draft", body: "NEW" });
  });

  it("updates a changed draft, staying draft", async () => {
    const draft = makeDoc({ path: "a.md", body: "old" });
    const { client, docs } = makeFakeClient({ "a.md": storedFrom(draft, "doc-1", "draft") });
    const report = await ingestBundleIntoCollection({
      ...BASE,
      client,
      docs: [makeDoc({ path: "a.md", body: "new" })],
    });
    expect(report).toMatchObject({ updated: 1, demoted: 0 });
    expect(docs.get("a.md")).toMatchObject({ status: "draft", body: "new" });
  });

  it("resurrects an archived document to draft on explicit re-upload (even if unchanged)", async () => {
    const doc = makeDoc({ path: "a.md", body: "same" });
    const { client, docs } = makeFakeClient({ "a.md": storedFrom(doc, "doc-1", "archived") });
    const report = await ingestBundleIntoCollection({ ...BASE, client, docs: [doc] });
    expect(report).toMatchObject({ resurrected: 1, unchanged: 0 });
    expect(docs.get("a.md")?.status).toBe("draft");
  });

  it("rewrites a document's links on every content change (delete + reinsert)", async () => {
    const old = makeDoc({ path: "a.md", body: "old", links: [{ targetPath: "x.md", anchorText: "x" }] });
    const { client, links } = makeFakeClient({ "a.md": storedFrom(old, "doc-1", "draft") });
    await ingestBundleIntoCollection({
      ...BASE,
      client,
      docs: [makeDoc({ path: "a.md", body: "new", links: [{ targetPath: "y.md", anchorText: "y" }] })],
    });
    expect(links).toEqual([{ source: "doc-1", target: "y.md", anchor: "y" }]);
  });
});

describe("docChanged", () => {
  const existing = {
    id: "doc-1",
    status: "published",
    body: "b",
    type: "Runbook",
    title: "T",
    description: "D",
    resource: "R",
    tags: ["a"],
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const same = makeDoc({
    path: "a.md",
    body: "b",
    type: "Runbook",
    title: "T",
    description: "D",
    resource: "R",
    tags: ["a"],
    timestamp: "2026-01-01T00:00:00.000Z",
  });

  it("returns false when every mirrored field matches", () => {
    expect(docChanged(existing, same)).toBe(false);
  });
  it("detects a body change", () => {
    expect(docChanged(existing, { ...same, body: "x" })).toBe(true);
  });
  it("detects a tags change", () => {
    expect(docChanged(existing, { ...same, tags: ["a", "b"] })).toBe(true);
  });
  it("detects a title change", () => {
    expect(docChanged(existing, { ...same, title: "T2" })).toBe(true);
  });
  it("detects type / description / resource changes", () => {
    expect(docChanged(existing, { ...same, type: "Other" })).toBe(true);
    expect(docChanged(existing, { ...same, description: "D2" })).toBe(true);
    expect(docChanged(existing, { ...same, resource: "R2" })).toBe(true);
    expect(docChanged(existing, { ...same, description: null })).toBe(true);
  });
  it("detects a differing / cleared timestamp", () => {
    expect(docChanged(existing, { ...same, timestamp: "2027-01-01T00:00:00.000Z" })).toBe(true);
    expect(docChanged(existing, { ...same, timestamp: null })).toBe(true);
  });
  it("treats a Date-typed stored timestamp as equal to its ISO string", () => {
    expect(docChanged({ ...existing, timestamp: new Date("2026-01-01T00:00:00Z") }, same)).toBe(false);
  });
});
