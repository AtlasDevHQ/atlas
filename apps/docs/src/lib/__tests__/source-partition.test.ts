import { test, expect } from "bun:test";
import { buildSectionSource, type CollectionLike } from "@/lib/compose";
import { classifyByPath } from "@/lib/audience-taxonomy";

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

// ─────────────────────────────────────────────────────────────────────────────
// Slice 3a (#4263) — the SaaS root stays free of self-hosted content.
//
// The saas-only pages enumerated in #4263 (billing & plans, enterprise SSO,
// SCIM, PII masking, data residency, platform-ops, …) STAY at the site root and
// are classified `saas-only` purely by living under `content/docs/`. This block
// re-asserts the "SaaS never muddied by on-prem" guarantee against the taxonomy
// classifier (`classifyByPath`, which reads the `CONTENT_ROOTS` SSOT) rather than
// a bare path substring, and pins a representative set of the enumerated
// saas-only topics into the root URL space. It also carries a negative control
// so the classification assertion is a real leak detector, not a restatement of
// self-hosted-free fixtures.
//
// Scope caveat: the PRODUCTION structural guarantee — that the root source is
// never *wired* a self-hosted collection — lives at the call site in `source.ts`
// (root = `docs + shared`, never `selfHosted`), which is bundler-only and can't
// be loaded by `bun test`. These synthetic-fixture assertions characterize the
// property; the negative control below proves the detector fires if that wiring
// ever regressed.
//
// Uses its own uniquely-named topics fixture + source const (reusing only the
// read-only top-of-file helpers), so sibling slices 3b (#4264) and 3c (#4265),
// which also edit this file, don't collide with this block.
// ─────────────────────────────────────────────────────────────────────────────

// A representative slice of the #4263 saas-only pages. They live under
// content/docs, so the directory taxonomy classifies each as `saas-only`.
const saasOnlyTopics = [
  doc(
    "guides/billing-and-plans.mdx",
    "content/docs/guides/billing-and-plans.mdx",
    "Billing & Plans",
  ),
  doc(
    "guides/enterprise-sso.mdx",
    "content/docs/guides/enterprise-sso.mdx",
    "Enterprise SSO",
  ),
  doc("guides/scim.mdx", "content/docs/guides/scim.mdx", "SCIM"),
  doc(
    "guides/pii-masking.mdx",
    "content/docs/guides/pii-masking.mdx",
    "PII Masking",
  ),
  doc(
    "platform-ops/data-residency.mdx",
    "content/docs/platform-ops/data-residency.mdx",
    "Data Residency",
  ),
];

// The SaaS root source is fed ONLY saas-only + api-reference + shared — never a
// self-hosted collection.
const saasOnlyRoot = buildSectionSource({
  audience: collection([...saasOnlyTopics, ...apiDocs]),
  shared: collection(sharedDocs),
  baseUrl: "/",
});
const saasOnlyRootPages = saasOnlyRoot.getPages();
const saasOnlyRootUrls = saasOnlyRootPages.map((p) => p.url);

test("[#4263] every SaaS-root page classifies saas-only or shared — never self-hosted-only", () => {
  // Cardinality floor FIRST: `.every()` is vacuously true on an empty array, so
  // without this an empty getPages() (the composition regression this guarantee
  // exists to catch) would pass silently. Exact count (5 saas topics + 2 api +
  // 1 shared) also catches a shared page being double-mounted into the root.
  expect(saasOnlyRootPages.length).toBe(
    saasOnlyTopics.length + apiDocs.length + sharedDocs.length,
  );
  // The allow-list is the strong form: `saas-only || shared` implies
  // `!== "self-hosted-only"` AND rejects a `null` class (a missing absolutePath),
  // so it subsumes a separate "never self-hosted-only" check. Via classifyByPath
  // (the taxonomy classifier), not a path substring.
  expect(
    saasOnlyRootPages.every((p) => {
      const cls = classifyByPath(p.absolutePath ?? "");
      return cls === "saas-only" || cls === "shared";
    }),
  ).toBe(true);
});

test("[#4263] leak detector has teeth: a self-hosted doc composed into root IS flagged", () => {
  // Negative control. The test above builds root from only-saas fixtures, so its
  // classifyByPath check is never seen to FAIL. First prove the predicate
  // discriminates a real on-prem path; then prove that if the production wiring
  // (source.ts) ever regressed to compose a self-hosted collection into the root,
  // this seam flags it — so the assertion above is a real guard, not a fixture
  // restatement.
  expect(classifyByPath("content/self-hosted/docker.mdx")).toBe(
    "self-hosted-only",
  );

  const leaky = buildSectionSource({
    audience: collection([
      ...saasOnlyTopics,
      doc("docker.mdx", "content/self-hosted/docker.mdx", "Docker"),
    ]),
    shared: collection(sharedDocs),
    baseUrl: "/",
  });
  expect(
    leaky
      .getPages()
      .some((p) => classifyByPath(p.absolutePath ?? "") === "self-hosted-only"),
  ).toBe(true);
});

test("[#4263] enumerated saas-only topics render at the site root, none under /self-hosted", () => {
  for (const url of [
    "/guides/billing-and-plans",
    "/guides/enterprise-sso",
    "/guides/scim",
    "/guides/pii-masking",
    "/platform-ops/data-residency",
  ]) {
    expect(saasOnlyRootUrls).toContain(url);
  }
  expect(saasOnlyRootUrls.every((u) => !u.startsWith("/self-hosted"))).toBe(
    true,
  );
});
