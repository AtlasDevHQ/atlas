import { test, expect } from "bun:test";
import { buildSectionSource, type CollectionLike } from "@/lib/compose";

/**
 * Source-partition test (PRD #4257's highest-value seam).
 *
 * Asserts, on the composed section loaders directly, that the three URL spaces
 * do not cross-leak:
 *   - SaaS root  = saas + api-reference + shared, all under `/`
 *   - Self-hosted = self-hosted + shared, all under `/self-hosted`
 *   - API         = the `/api-reference/*` subset of the root source
 * and, critically, that NO self-hosted-only page appears in the SaaS root
 * source — the machine-checkable form of "SaaS routes are structurally free of
 * self-hosted quirks."
 *
 * Self-contained: it drives the real `buildSectionSource` composition
 * (`toFumadocsSource` concat → `loader({baseUrl})`) with synthetic collection
 * fixtures, so it needs neither the generated `.source/server` (which only the
 * Next bundler can load) nor any network/filesystem access.
 */

type DocEntry = CollectionLike["docs"][number];

// Minimal synthetic doc entry. The composition only reads `info.{path,fullPath}`
// (fullPath becomes the page's `absolutePath`); the cast stands in for the rich
// compiled-MDX fields a real collection carries.
function doc(path: string, fullPath: string, title: string): DocEntry {
  return { info: { path, fullPath }, title } as unknown as DocEntry;
}

function collection(docs: DocEntry[]): CollectionLike {
  return { docs, meta: [] };
}

// saas-only + api-reference live together under content/docs (root source).
const saasDocs = [
  doc("index.mdx", "content/docs/index.mdx", "Introduction"),
  doc("billing.mdx", "content/docs/billing.mdx", "Billing"),
];
const apiDocs = [
  doc("api-reference/index.mdx", "content/docs/api-reference/index.mdx", "API"),
  doc(
    "api-reference/chat/postChat.mdx",
    "content/docs/api-reference/chat/postChat.mdx",
    "POST /chat",
  ),
];
const selfHostedDocs = [
  doc("index.mdx", "content/self-hosted/index.mdx", "Self-Hosted"),
  doc("docker.mdx", "content/self-hosted/docker.mdx", "Docker"),
];
const sharedDocs = [
  doc(
    "single-source-example.mdx",
    "content/shared/single-source-example.mdx",
    "Single-Source Example",
  ),
];

const root = buildSectionSource({
  audience: collection([...saasDocs, ...apiDocs]),
  shared: collection(sharedDocs),
  baseUrl: "/",
});
const selfHosted = buildSectionSource({
  audience: collection(selfHostedDocs),
  shared: collection(sharedDocs),
  baseUrl: "/self-hosted",
});

const rootPages = root.getPages();
const selfHostedPages = selfHosted.getPages();
const rootUrls = rootPages.map((p) => p.url);
const selfHostedUrls = selfHostedPages.map((p) => p.url);

test("SaaS root serves saas + api-reference + shared under /", () => {
  expect(rootUrls).toContain("/");
  expect(rootUrls).toContain("/billing");
  expect(rootUrls).toContain("/api-reference");
  expect(rootUrls).toContain("/api-reference/chat/postChat");
  expect(rootUrls).toContain("/single-source-example");
});

test("no self-hosted-only page leaks into the SaaS root source", () => {
  // URL space: nothing under /self-hosted.
  expect(rootUrls.every((u) => !u.startsWith("/self-hosted"))).toBe(true);
  // Source-file space: no page in the root source is authored under
  // content/self-hosted/.
  expect(
    rootPages.every((p) => !p.absolutePath?.includes("content/self-hosted/")),
  ).toBe(true);
});

test("self-hosted section serves self-hosted + shared under /self-hosted only", () => {
  expect(selfHostedUrls).toContain("/self-hosted");
  expect(selfHostedUrls).toContain("/self-hosted/docker");
  expect(selfHostedUrls).toContain("/self-hosted/single-source-example");
  // Every self-hosted URL is scoped under /self-hosted.
  expect(selfHostedUrls.every((u) => u.startsWith("/self-hosted"))).toBe(true);
});

test("no saas-only or api page leaks into the self-hosted source", () => {
  // No API reference pages.
  expect(selfHostedUrls.every((u) => !u.includes("/api-reference"))).toBe(true);
  // No page authored under content/docs (saas-only or api).
  expect(
    selfHostedPages.every((p) => !p.absolutePath?.includes("content/docs/")),
  ).toBe(true);
});

test("a shared page mounts into BOTH sections from the ONE real source file", () => {
  const rootShared = rootPages.find(
    (p) => p.url === "/single-source-example",
  );
  const selfHostedShared = selfHostedPages.find(
    (p) => p.url === "/self-hosted/single-source-example",
  );

  expect(rootShared).toBeDefined();
  expect(selfHostedShared).toBeDefined();

  // Both mounts resolve the edit target to the SAME real content/shared file
  // (spike #4258 caveat #1 — one place to fix it, no phantom copies).
  expect(rootShared?.absolutePath).toBe(
    "content/shared/single-source-example.mdx",
  );
  expect(selfHostedShared?.absolutePath).toBe(
    "content/shared/single-source-example.mdx",
  );
});
