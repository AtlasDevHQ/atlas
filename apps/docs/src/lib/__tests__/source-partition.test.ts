import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildSectionSource, type CollectionLike } from "@/lib/compose";
import { classifyByPath } from "@/lib/audience-taxonomy";
import { MOVED_SELF_HOSTED_SLUGS } from "@/lib/redirects";
import { stripInactiveAudienceBlocks } from "@/lib/audience-markdown";

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

// ── real-content partition (slice #4264: self-hosted-only pages MOVED) ────────
//
// The synthetic assertions above prove the COMPOSITION never cross-leaks. This
// block proves the actual MIGRATION landed: every self-hosted-only page this
// slice moved now lives physically under content/self-hosted/ and no longer
// under content/docs/ (the saas-only tree). It scans the real content directory
// on disk — the taxonomy is directory-based, so a page's physical location IS
// its classification, and re-adding e.g. deploy.mdx to content/docs/ would fail
// here immediately. Self-contained: read-only filesystem walk, no bundler.

const CONTENT_DIR = join(import.meta.dir, "../../../content");

function walk(dir: string): string[] {
  const out: string[] = [];
  // `withFileTypes` avoids a per-entry statSync and does NOT follow directory
  // symlinks, so a stray symlink under content/ can't drive unbounded recursion.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const contentFiles = walk(CONTENT_DIR);
const selfHostedFiles = contentFiles.filter((p) =>
  p.includes(`${join(CONTENT_DIR, "self-hosted")}/`),
);
const saasTreeFiles = contentFiles.filter((p) =>
  p.includes(`${join(CONTENT_DIR, "docs")}/`),
);

// Old-root slug → the self-hosted-only pages relocated by slice #4264. This
// migration-landing assertion and the #4267 redirect-coverage test share ONE
// frozen move set — `MOVED_SELF_HOSTED_SLUGS` in `@/lib/redirects` (the redirect
// SSOT) — so the redirect map and this partition check can never drift apart.
test("every moved self-hosted-only page lives under content/self-hosted/ and NOT content/docs/", () => {
  for (const slug of MOVED_SELF_HOSTED_SLUGS) {
    expect(selfHostedFiles).toContain(
      join(CONTENT_DIR, "self-hosted", `${slug}.mdx`),
    );
    expect(saasTreeFiles).not.toContain(
      join(CONTENT_DIR, "docs", `${slug}.mdx`),
    );
  }
});

test("no known saas-only page leaked into content/self-hosted/", () => {
  // A representative set of pages that MUST stay in the SaaS (root) tree; if any
  // showed up under content/self-hosted/ the migration grabbed the wrong page.
  const SAAS_ONLY_TOPICS = [
    "hosted",
    "billing-and-plans",
    "enterprise-sso",
    "scim",
    "white-labeling",
    "pii-masking",
    "model-routing",
  ];
  for (const f of selfHostedFiles) {
    for (const topic of SAAS_ONLY_TOPICS) {
      expect(f.endsWith(`/${topic}.mdx`)).toBe(false);
    }
  }
});

test("every physical content/self-hosted/ page classifies as self-hosted-only", () => {
  const mdx = selfHostedFiles.filter((p) => p.endsWith(".mdx"));
  expect(mdx.length).toBeGreaterThan(0);
  for (const f of mdx) {
    expect(classifyByPath(f)).toBe("self-hosted-only");
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Slice 3c (#4265) — shared content single-sourced into BOTH human trees.
//
// The audience-agnostic pages (getting-started concepts, the semantic layer,
// plugins, the SDK, the integrations section (chat platforms + action targets
// like Twenty/GitHub/Linear), comparisons, architecture, the reference, and the
// changelog) were MOVED into content/shared/ as ONE file
// each. content/shared/ is concatenated into BOTH the root (SaaS) and the
// /self-hosted loaders (compose.ts), so each shared file renders at `/<slug>`
// AND `/self-hosted/<slug>` from the one real source — full presence, single
// source (PRD #4257).
//
// This block proves what #4265 asks for, self-contained (synthetic composition
// + a read-only content/ walk — no bundler, no network):
//   1. Dual-mount presence — a shared page mounts at both URLs and BOTH mounts
//      resolve `editOnGithub` (via absolutePath) to the SAME real content/shared
//      file.
//   2. Migration landing — every 3c-moved page now lives under content/shared/
//      and NOT content/docs/ (the taxonomy is directory-based, so a page's
//      physical location IS its classification), while the saas-only pages that
//      STAYED (hosted onboarding, the SaaS integrations console, sub-processor
//      feed, BYOT provider guides) are absent from content/shared/.
//   3. Cross-link integrity — no shared page links to a path that #3b moved out
//      to /self-hosted (those old roots now 404 on BOTH mounts); the repointed
//      cross-refs land on real self-hosted pages; and the shared→shared link
//      targets are real shared pages, present at both mounts.
//
// Uses uniquely-named fixtures/consts (reusing only the read-only top-of-file
// helpers + the #3b filesystem consts), so it doesn't disturb the 3a/3b blocks.
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_ROOT = join(CONTENT_DIR, "shared");
const sharedMdxFiles = contentFiles.filter(
  (p) => p.startsWith(`${SHARED_ROOT}/`) && p.endsWith(".mdx"),
);

// A real shared source file → its root-mount URL (baseUrl "/"): drop the content
// root and `.mdx`, and collapse a trailing `/index` (a folder landing renders at
// the folder URL). Because a shared page mounts at both `/<slug>` and
// `/self-hosted/<slug>`, membership in this set means the target resolves on both.
function sharedRootUrl(absPath: string): string {
  const rel = absPath.slice(`${SHARED_ROOT}/`.length).replace(/\.mdx$/i, "");
  const noIndex = rel.replace(/(^|\/)index$/i, "");
  return noIndex === "" ? "/" : `/${noIndex}`;
}
const sharedRootUrls = new Set(sharedMdxFiles.map(sharedRootUrl));

// Synthetic fixtures mirroring the REAL moved files (one per moved section) —
// bun test can't load compiled MDX, so the composition is exercised with these
// stand-ins whose `fullPath` equals the on-disk file.
const shared3c = [
  doc(
    "getting-started/concepts.mdx",
    "content/shared/getting-started/concepts.mdx",
    "Semantic Layer Concepts",
  ),
  doc(
    "semantic-layer/index.mdx",
    "content/shared/semantic-layer/index.mdx",
    "The Semantic Layer",
  ),
  doc("plugins/overview.mdx", "content/shared/plugins/overview.mdx", "Plugins"),
  doc("sdk/mcp.mdx", "content/shared/sdk/mcp.mdx", "MCP"),
  doc(
    "integrations/telegram.mdx",
    "content/shared/integrations/telegram.mdx",
    "Telegram",
  ),
  doc(
    "comparisons/index.mdx",
    "content/shared/comparisons/index.mdx",
    "Comparisons",
  ),
  doc(
    "architecture/sandbox.mdx",
    "content/shared/architecture/sandbox.mdx",
    "Sandbox",
  ),
  doc("reference/config.mdx", "content/shared/reference/config.mdx", "Config"),
  doc("changelog.mdx", "content/shared/changelog.mdx", "Changelog"),
];
const saas3cAudience = [
  doc("index.mdx", "content/docs/index.mdx", "Introduction"),
  doc(
    "getting-started/hosted.mdx",
    "content/docs/getting-started/hosted.mdx",
    "Hosted Quick Start",
  ),
];
const selfHosted3cAudience = [
  doc("index.mdx", "content/self-hosted/index.mdx", "Self-Hosted"),
  doc(
    "getting-started/quick-start.mdx",
    "content/self-hosted/getting-started/quick-start.mdx",
    "Quick Start",
  ),
];

const root3c = buildSectionSource({
  audience: collection(saas3cAudience),
  shared: collection(shared3c),
  baseUrl: "/",
});
const selfHosted3c = buildSectionSource({
  audience: collection(selfHosted3cAudience),
  shared: collection(shared3c),
  baseUrl: "/self-hosted",
});
const root3cPages = root3c.getPages();
const selfHosted3cPages = selfHosted3c.getPages();

test("[#4265] every shared page mounts at BOTH root and /self-hosted from the ONE real file", () => {
  // Cardinality floor: a composition regression that dropped the shared
  // collection would otherwise let the `.find` lookups return undefined without
  // the count catching it.
  expect(root3cPages.length).toBe(saas3cAudience.length + shared3c.length);
  expect(selfHosted3cPages.length).toBe(
    selfHosted3cAudience.length + shared3c.length,
  );

  for (const s of shared3c) {
    const slug = s.info.path.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
    const rootUrl = slug === "" ? "/" : `/${slug}`;
    const selfHostedUrl = slug === "" ? "/self-hosted" : `/self-hosted/${slug}`;

    const onRoot = root3cPages.find((p) => p.url === rootUrl);
    const onSelfHosted = selfHosted3cPages.find((p) => p.url === selfHostedUrl);
    expect(onRoot).toBeDefined();
    expect(onSelfHosted).toBeDefined();

    // Both mounts resolve edit / last-updated to the SAME real content/shared
    // file (spike #4258 caveat #1 — one place to fix it), and it classifies
    // `shared`.
    expect(onRoot?.absolutePath).toBe(s.info.fullPath);
    expect(onSelfHosted?.absolutePath).toBe(s.info.fullPath);
    expect(onRoot?.absolutePath).toBe(onSelfHosted?.absolutePath);
    expect(classifyByPath(onRoot?.absolutePath ?? "")).toBe("shared");
  }
});

// Old-root slug → shared pages relocated by this slice (#4265). FROZEN to this
// slice's scope — a migration-landing assertion, not a live inventory of the
// shared tree.
const MOVED_SHARED_SLUGS = [
  "getting-started/concepts",
  "getting-started/connect-your-data",
  "getting-started/semantic-layer",
  "getting-started/demo-datasets",
  "semantic-layer/index",
  "semantic-layer/yaml-format",
  "plugins/overview",
  "plugins/authoring-guide",
  "plugins/composition",
  "sdk/mcp",
  "sdk/starter-prompts",
  "integrations/telegram",
  "integrations/twenty",
  "comparisons/index",
  "comparisons/raw-mcp",
  "architecture/sandbox",
  "reference/config",
  "reference/error-codes",
  "changelog",
];

const saasTree3c = contentFiles.filter((p) =>
  p.includes(`${join(CONTENT_DIR, "docs")}/`),
);

test("[#4265] every moved shared page lives under content/shared/ and NOT content/docs/", () => {
  for (const slug of MOVED_SHARED_SLUGS) {
    expect(sharedMdxFiles).toContain(join(SHARED_ROOT, `${slug}.mdx`));
    expect(saasTree3c).not.toContain(join(CONTENT_DIR, "docs", `${slug}.mdx`));
  }
});

test("[#4265] saas-only pages that stayed at the root are NOT single-sourced into content/shared/", () => {
  // Mixed dirs (getting-started, integrations) kept their saas-only members at
  // the root; grabbing one into shared would wrongly expose it under /self-hosted.
  const STAYED_SAAS_ONLY = [
    "getting-started/hosted",
    "integrations/admin-console",
    "integrations/sub-processor-feed",
    "integrations/llm-providers/bedrock",
  ];
  for (const slug of STAYED_SAAS_ONLY) {
    expect(sharedMdxFiles).not.toContain(join(SHARED_ROOT, `${slug}.mdx`));
    expect(saasTree3c).toContain(join(CONTENT_DIR, "docs", `${slug}.mdx`));
  }
});

test("[#4265] every physical content/shared/ page classifies as shared", () => {
  expect(sharedMdxFiles.length).toBeGreaterThan(0);
  for (const f of sharedMdxFiles) {
    expect(classifyByPath(f)).toBe("shared");
  }
});

// The old ROOT locations of the pages slice #3b moved to /self-hosted. A shared
// page still linking to one of these would 404 on BOTH mounts (the page no
// longer exists at the root), so the single source must not carry a stale link.
const STALE_MOVED_LINK =
  /\]\(\/(?:deployment\/(?:deploy|authentication|cache-configuration)|getting-started\/quick-start|frameworks\/|contributing\/|guides\/self-hosted-models)/;

test("[#4265] no shared page links to a path #3b moved out (would 404 on both mounts)", () => {
  // Self-guarding floor: `filter` over an empty array yields `[]`, which would
  // pass `toEqual([])` vacuously — assert we actually scanned shared files.
  expect(sharedMdxFiles.length).toBeGreaterThan(0);
  const offenders = sharedMdxFiles.filter((f) =>
    STALE_MOVED_LINK.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});

const selfHostedFiles3c = contentFiles.filter((p) =>
  p.includes(`${join(CONTENT_DIR, "self-hosted")}/`),
);

test("[#4265] shared cross-refs into /self-hosted resolve to real self-hosted pages", () => {
  const targets = new Set<string>();
  for (const f of sharedMdxFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /\]\((\/self-hosted\/[a-z0-9/-]+)/g,
    )) {
      targets.add(m[1]); // char class already excludes the #anchor / ?query
    }
  }
  // We repointed at least the deploy/auth/quick-start refs, so this must be
  // non-empty — otherwise the assertion is vacuous.
  expect(targets.size).toBeGreaterThan(0);
  for (const url of targets) {
    const rel = url.replace(/^\/self-hosted\//, "");
    const asPage = join(CONTENT_DIR, "self-hosted", `${rel}.mdx`);
    const asIndex = join(CONTENT_DIR, "self-hosted", rel, "index.mdx");
    expect(
      selfHostedFiles3c.includes(asPage) || selfHostedFiles3c.includes(asIndex),
    ).toBe(true);
  }
});

test("[#4265] curated shared→shared link targets are real shared pages (dual-mounted)", () => {
  // A curated set of intra-shared link targets that recur across the moved
  // pages. Each must be a real page in the shared collection — which mounts at
  // BOTH `/<slug>` and `/self-hosted/<slug>` — so the target page itself is
  // present on both mounts and can never 404 (PRD user-story 22/25). NOTE: these
  // links are authored root-absolute (`](/reference/config)`), so on the
  // self-hosted mount they navigate to the SaaS-root copy rather than the
  // in-section `/self-hosted/...` one; that resolves (no 404) but is a
  // cross-section jump. The exhaustive dangling-link guard below covers ALL
  // shared links; this one pins that these representative targets are shared.
  const sharedTargets = [
    "/plugins/overview",
    "/reference/config",
    "/reference/cli",
    "/semantic-layer",
    "/getting-started/concepts",
    "/getting-started/semantic-layer",
    "/comparisons",
    "/architecture/sandbox",
    "/changelog",
    "/sdk/mcp",
    "/integrations/telegram",
  ];
  for (const t of sharedTargets) {
    expect(sharedRootUrls).toContain(t);
  }
});

/**
 * Does a root-absolute doc URL resolve to a real page on disk? A page renders at
 * `/<p>` from `content/docs/<p>.mdx` (saas-only/api) or `content/shared/<p>.mdx`
 * (shared, dual-mounted), or from `<p>/index.mdx` when it is a folder landing.
 * `/` is the docs root landing. Mirrors how fumadocs turns a slug into a page.
 */
function rootPageExists(url: string): boolean {
  const p = url.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return existsSync(join(CONTENT_DIR, "docs", "index.mdx"));
  return [
    join(CONTENT_DIR, "docs", `${p}.mdx`),
    join(CONTENT_DIR, "shared", `${p}.mdx`),
    join(CONTENT_DIR, "docs", p, "index.mdx"),
    join(CONTENT_DIR, "shared", p, "index.mdx"),
  ].some((c) => existsSync(c));
}

test("[#4265] every root-absolute link in a shared page resolves to a real page (no dangling → no 404)", () => {
  // The exhaustive form of cross-link integrity (the curated check above is the
  // spot-check). Enumerate EVERY root-absolute markdown link across all shared
  // pages and assert each target is a real page under content/docs/ or
  // content/shared/. A shared page mounts at both `/` and `/self-hosted/`, so a
  // dangling target 404s on BOTH mounts — this catches a typo link, or a later
  // slice moving a still-referenced page out from under a shared link. The
  // `/self-hosted/*` links are validated separately (they resolve against the
  // self-hosted tree, not the root URL space).
  const targets = new Set<string>();
  for (const f of sharedMdxFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/\]\((\/[^)\s]+)/g)) {
      const url = m[1];
      if (url.startsWith("/self-hosted/")) continue;
      targets.add(url.split(/[#?]/)[0]); // drop #anchor / ?query
    }
  }
  expect(targets.size).toBeGreaterThan(0);
  const dangling = [...targets].filter((u) => !rootPageExists(u));
  expect(dangling).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// #4282 — the six saas-only pages that carried embedded self-hosted operator
// SECTIONS are resolved so NO self-hosted operator content reaches the SaaS-root
// emitted HTML. Two mechanisms, per-page judgment along the PRD #4257 ladder:
//
//   - rung-2 (shared + `<WhenSelfHosted>`): multi-tenancy, plugin-marketplace,
//     onboarding-emails single-source into BOTH trees; each on-prem section is
//     wrapped in the SERVER `<WhenSelfHosted>` conditional, which renders null on
//     the SaaS mount (its children never enter the RSC flight payload — see
//     audience-conditionals.tsx + its test).
//   - rung-4 (extract): billing-and-plans, signup, mcp-load-test-tokens keep the
//     SaaS page saas-only and move the on-prem section to a dedicated
//     `/self-hosted/*` page, so the SaaS page no longer contains it at all.
//
// This is the finer-grained companion to the page-level partition tests above:
// those prove no self-hosted-only PAGE reaches the SaaS source; this proves no
// self-hosted SECTION reaches a SaaS page's emitted output.
//
// The shared-page assertions drive the REAL `stripInactiveAudienceBlocks` — the
// same strip behind the `.mdx` twin / `llms-full.txt` SaaS surface and the
// string-level mirror of the server `<WhenSelfHosted>` render (returns null). A
// leak would surface identically in both. Fixtures use uniquely-named consts, so
// they don't disturb the 3a/3b/3c blocks above.
// ─────────────────────────────────────────────────────────────────────────────

const DOCS_ROOT_4282 = join(CONTENT_DIR, "docs");
const SELF_HOSTED_ROOT_4282 = join(CONTENT_DIR, "self-hosted");

// rung-2: the ONE real shared source file, the self-hosted tokens that must be
// ABSENT on the SaaS mount (all inside a `<WhenSelfHosted>` block), and a
// shared-body token that must SURVIVE (so the strip isn't just deleting the page).
const SHARED_WRAPPED_4282 = [
  {
    file: join(SHARED_ROOT, "guides/multi-tenancy.mdx"),
    absent: [
      "Org-scoped connections (Self-Hosted)",
      "with organizations (Self-Hosted)",
      "Self-hosted prerequisites",
      "per-org pool isolation",
      "ATLAS_ORG_ID",
    ],
    present: ["Member management", "Org switcher UI"],
  },
  {
    file: join(SHARED_ROOT, "guides/plugin-marketplace.mdx"),
    absent: ["import bigquery from", "does not offer an uninstall button"],
    present: ["What the page shows for each plugin"],
  },
  {
    file: join(SHARED_ROOT, "guides/onboarding-emails.mdx"),
    absent: ["Configuration (Self-Hosted)", "ATLAS_ONBOARDING_EMAILS_ENABLED"],
    present: ["Email Sequence", "Unsubscribe & Resubscribe"],
  },
] as const;

test("[#4282] every shared page's self-hosted section is absent from the SaaS-mount markdown (kept on self-hosted)", () => {
  for (const page of SHARED_WRAPPED_4282) {
    const raw = readFileSync(page.file, "utf8");
    // Sanity: the on-prem content really is in the single source (so the strip
    // is doing work, not passing vacuously).
    for (const tok of page.absent) expect(raw).toContain(tok);

    // SaaS mount: the self-hosted section is gone; the shared body survives.
    const saas = stripInactiveAudienceBlocks(raw, "saas");
    for (const tok of page.absent) expect(saas).not.toContain(tok);
    for (const tok of page.present) expect(saas).toContain(tok);

    // Self-hosted mount: the on-prem section is preserved (no content lost).
    const selfHosted = stripInactiveAudienceBlocks(raw, "self-hosted");
    for (const tok of page.absent) expect(selfHosted).toContain(tok);
  }
});

// rung-4: the on-prem section was EXTRACTED to a dedicated /self-hosted page.
const EXTRACTED_4282 = [
  {
    saas: join(DOCS_ROOT_4282, "guides/billing-and-plans.mdx"),
    extract: join(SELF_HOSTED_ROOT_4282, "guides/self-hosted-billing.mdx"),
    tokens: ["Stripe Setup", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    saas: join(DOCS_ROOT_4282, "guides/signup.mdx"),
    extract: join(SELF_HOSTED_ROOT_4282, "guides/self-serve-signup.mdx"),
    tokens: ["Enabling Social Login", "GOOGLE_CLIENT_SECRET"],
  },
  {
    saas: join(DOCS_ROOT_4282, "platform-ops/mcp-load-test-tokens.mdx"),
    extract: join(SELF_HOSTED_ROOT_4282, "deployment/load-testing.mdx"),
    tokens: ["ATLAS_PUBLIC_API_URL"],
  },
] as const;

test("[#4282] extracted self-hosted sections are gone from the SaaS page and live on a /self-hosted page (no content lost)", () => {
  for (const page of EXTRACTED_4282) {
    expect(existsSync(page.extract)).toBe(true);
    const saas = readFileSync(page.saas, "utf8");
    const extract = readFileSync(page.extract, "utf8");
    for (const tok of page.tokens) {
      expect(saas).not.toContain(tok);
      expect(extract).toContain(tok);
    }
  }
});
